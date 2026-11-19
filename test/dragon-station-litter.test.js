'use strict'

// A crafting table is put down on a forest floor covered with leaf litter (src/modes/dragon-supplies.js `station`,
// station-room.js, player-storage-ports.js `place`, actions/interaction-sight.js).
// Real Realm 2026-11-20 03:49-03:55 JST (main 055da21): on the surface at (-4943.9, 71.0, -4955.3), a crafting table,
// raw iron, coal and 401 cobblestone in the bag, the furnace for the iron still to be crafted.
// 「作業台を置ける場所がありません（空いたマス 8・掘れる壁 0）」 once a minute under 「iron_helmet を準備しています（0/2）」
// for six minutes, until the pinned item ran out. Seven of the eight cells were leaf litter (the placement takes air
// only); the eighth was air, and the line from the eye to its floor crossed the Bot's own litter cell.
// The blocks below are the ones received there (GET /blocks, 7 x 7, y 70 and 71, and the log).
// Real here: dragon-supplies.js (acquire, station), station-room.js, player-storage-ports.js (place, the craft at the
// table), actions/mining.js (what may be broken: never litter), actions/interaction-sight.js and actions/open-face.js
// (where a click has a line). Stand-ins: the server (a break and a placement are answered), the crafting window, the walk.
// The placement's stand-in keeps the two rules of actions/interactions.js `placementPlan` this is about: the cell is
// received air, and the click's line to the floor is clear.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createDragonSupplies } = require('../src/modes/dragon-supplies')
const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
const { createMining } = require('../src/actions/mining')
const { interactionSightFailure } = require('../src/actions/interaction-sight')
const { openAccess } = require('../src/actions/open-face')

const EYE = 1.62
const full = name => 'minecraft:' + name
// x -4947..-4941 (left to right), z -4959..-4953 (top to bottom).
const Y71 = [
  'L L L . L . .',
  '. . L L L L .',
  '. . L L . . L',
  '. L L L L L L',
  '. . . . . . .',
  '. . . . . . .',
  '. . . . . . .']
const Y70 = [
  'G G G G G . L',
  'G G G G G G .',
  'G G G G G G G',
  'G G G G G G G',
  'G G . L L L L',
  '. . S . . L .',
  '. . . . . . .']
const NAMES = { L: 'leaf_litter', G: 'grass_block', S: 'short_grass', '.': 'air' }

// litterOnly: the one cell of air beside the feet holds litter as well (litter in all twelve cells tried first).
function world ({ litterOnly = false } = {}) {
  const blocks = new Map(), key = (x, y, z) => `${x},${y},${z}`
  let id = 100
  const made = name => ({ known: true, name: full(name), boundingBox: ['leaf_litter', 'short_grass', 'air'].includes(name) ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : ++id, extra: [] })
  const set = (x, y, z, name) => blocks.set(key(x, y, z), made(name))
  for (const [y, rows] of [[71, Y71], [70, Y70]]) rows.forEach((row, dz) => row.split(' ').forEach((c, dx) => set(-4947 + dx, y, -4959 + dz, NAMES[c])))
  set(-4941, 72, -4957, 'oak_log')
  if (litterOnly) set(-4943, 71, -4957, 'leaf_litter')
  const AIR = made('air'), DIRT = { ...made('dirt'), runtimeId: 7 }
  const getBlock = (x, y, z) => blocks.get(key(x, y, z)) ?? (y <= 69 ? DIRT : AIR)
  const w = { at: 1e9, lines: [], placed: [], swept: [], refusals: [], crafted: 0, getBlock, feet: { x: -4943.9, y: 71, z: -4955.3 },
    items: [{ slot: 0, name: full('iron_pickaxe'), count: 1 }, { slot: 1, name: full('crafting_table'), count: 1 }, { slot: 2, name: full('cobblestone'), count: 64 }, { slot: 3, name: full('coal'), count: 6 }, { slot: 4, name: full('raw_iron'), count: 2 }] }
  const rows = () => w.items.filter(item => item.count > 0)
  const eye = () => ({ x: w.feet.x, y: w.feet.y + EYE, z: w.feet.z })
  const air = (x, y, z) => /air$/.test(getBlock(x, y, z).name)
  // The real mining module decides what may be broken; the server answers a break with received air.
  const input = { lookAt () {}, start () {}, stop () {}, sendAction () {}, stats: () => ({ running: false }) }
  const mining = createMining({ getState: () => ({ phase: 'spawned', dimension: 'overworld', gameMode: 'survival', position: eye(), health: 20, inventory: { known: true, items: rows() }, selectedSlot: null, heldItem: null }),
    world: { getBlock }, getInput: () => input, blockTimeoutMs: 2000 })
  const operations = {
    crafting: { closeContainer () {}, craft: async (output, { times }) => { const stone = rows().find(item => item.name === full('cobblestone')); stone.count -= 8 * times; w.items.push({ slot: 9 + w.crafted, name: output, count: times }); w.crafted += times } },
    inventory: { equip: async slot => ({ phase: 'completed', slot }) },
    quarry: { travelStatus: () => ({ busy: false }) },
    mining: {
      preview: targets => mining.preview(targets),
      start: targets => {
        const out = mining.start(targets)
        setTimeout(() => { for (const at of targets) { w.swept.push([at.x, at.y, at.z, getBlock(at.x, at.y, at.z).name]); set(at.x, at.y, at.z, 'air'); mining.applyPacket('update_block', { position: { x: at.x, y: at.y, z: at.z } }) } }, 10)
        return out
      }
    },
    interactions: {
      placeBlock: async ({ position, slot }) => {
        const no = message => { w.refusals.push([position.x, position.y, position.z, message]); throw new Error(message) }
        if (!air(position.x, position.y, position.z)) no('設置先は取得済みの空気ブロックである必要があります。')
        const support = { x: position.x, y: position.y - 1, z: position.z }
        if (getBlock(support.x, support.y, support.z).boundingBox !== 'block') no('設置先の下に安全な通常の地面ブロックが必要です。')
        const sight = interactionSightFailure(pos => getBlock(pos.x, pos.y, pos.z), eye(), { x: position.x + 0.5, y: position.y, z: position.z + 0.5 }, support)
        if (sight) no(sight.message)
        const row = rows().find(item => item.slot === slot)
        row.count -= 1
        blocks.set(key(position.x, position.y, position.z), { known: true, name: row.name, boundingBox: 'block', runtimeId: ++id, extra: [] })
        w.placed.push([row.name, position.x, position.y, position.z])
      },
      openCraftingTable: async at => { const no = openAccess(pos => getBlock(pos.x, pos.y, pos.z), eye(), at); if (no) throw new Error(no.message) }
    }
  }
  const hands = { why: () => null, walk: async () => false, approach: async () => false,
    canMine: cell => { try { return mining.preview([cell])?.ready === true } catch { return false } }, mine: async () => false }
  const shared = {}
  const ledger = createGoalLedger({ shared, now: () => w.at, world: () => 'w', restore: () => null })
  ledger.open('early.home_reserve')
  ledger.look({ scope: 's' })
  const runtime = { raw: () => ({ dimension: 'overworld' }), inventory: () => ({ known: true, items: rows().map(item => ({ ...item })) }), armor: () => ({ known: true, worn: [] }) }
  w.held = name => rows().filter(item => item.name === full(name)).reduce((sum, item) => sum + item.count, 0)
  // One look of the expedition's two-second timer.
  w.look = async () => {
    const ctx = { operations, runtime, getBlock, cancelled: () => false, getFeet: () => w.feet, hands, shared, memory: { early: {} }, log: line => w.lines.push(line),
      goal: { fail: (failure, options) => ledger.fail(failure, options), spent: failure => ledger.spent(failure) }, now: () => w.at, sleep: async ms => { w.at += ms } }
    const out = await createDragonSupplies(ctx).acquire('furnace', 1)
    w.at += 2000
    return out
  }
  w.stop = () => mining.stop()
  return w
}

test('standing in leaf litter, the crafting table goes into the cell of air beside the feet and the furnace is crafted', async t => {
  const w = world()
  t.after(() => w.stop())
  let out = null, looks = 0
  for (; looks < 4 && !(out?.done); looks++) out = await w.look()
  const log = [...w.lines, ...w.refusals.map(String)].join('\n')
  assert.equal(out?.done, true, `the furnace came in ${looks} looks: ${out?.reason}\n${log}`)
  assert.deepEqual(w.placed, [[full('crafting_table'), -4943, 71, -4957]], 'the one cell of air with a solid floor')
  assert.deepEqual(w.swept, [], 'nothing was broken while a cell of air would do')
  assert.equal(w.held('furnace'), 1)
  assert.equal(w.lines.filter(line => /置ける場所がありません/.test(line)).length, 0, log)
})

test('with litter in every cell beside the feet, the table goes into a cell of air a step further; no litter is broken', async t => {
  const w = world({ litterOnly: true })
  t.after(() => w.stop())
  let out = null, looks = 0
  for (; looks < 4 && !(out?.done); looks++) out = await w.look()
  const log = [...w.lines, ...w.refusals.map(String)].join('\n')
  assert.equal(out?.done, true, `the furnace came in ${looks} looks: ${out?.reason}\n${log}`)
  assert.equal(w.placed.length, 1, log)
  const [, x, y, z] = w.placed[0]
  assert.equal(y, 71)
  assert.ok(Math.max(Math.abs(x + 4944), Math.abs(z + 4956)) <= 3, `within three of the feet: ${x}, ${z}`)
  assert.deepEqual(w.swept, [], 'leaves and litter are never broken')
  assert.equal(w.refusals.filter(row => /空気ブロック/.test(row[3])).length, 0, 'no placement was asked of a cell that is not air')
  assert.equal(w.held('furnace'), 1)
})

// The line of a click and the litter: only the part of a line that is low in a litter cell touches it.
test('a click line passes over leaf litter and is stopped by it at the floor; other plants stop it as before', () => {
  const litter = { known: true, name: full('leaf_litter'), boundingBox: 'empty', extra: [] }, air = { known: true, name: full('air'), boundingBox: 'empty', extra: [] }
  const read = cells => pos => cells[`${pos.x},${pos.y},${pos.z}`] ?? air
  const eye = { x: 0.5, y: 1 + EYE, z: 0.5 }, floor = { x: 1.5, y: 1, z: 0.5 }, clicked = { x: 1, y: 0, z: 0 }
  assert.equal(interactionSightFailure(read({ '0,1,0': litter }), eye, floor, clicked), null, 'the own litter cell, crossed high')
  assert.equal(interactionSightFailure(read({ '1,1,0': litter }), eye, floor, clicked)?.code, 'SIGHT_BLOCKED', 'litter in the cell whose floor is clicked')
  assert.equal(interactionSightFailure(read({ '0,1,0': { ...litter, name: full('short_grass') } }), eye, floor, clicked)?.code, 'SIGHT_BLOCKED')
  assert.equal(interactionSightFailure(read({ '0,1,0': { ...litter, extra: [{ name: full('water') }] } }), eye, floor, clicked)?.code, 'SIGHT_BLOCKED', 'waterlogged litter')
  assert.equal(interactionSightFailure(read({ '0,1,0': { known: false } }), eye, floor, clicked)?.code, 'SIGHT_BLOCKED', 'not received')
})
