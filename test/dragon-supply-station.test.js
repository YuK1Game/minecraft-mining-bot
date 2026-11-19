'use strict'

// A furnace standing nearby that cannot be opened is not asked for ever (src/modes/dragon-supplies.js `station`).
// Real Realm 2026-11-20 02:55-03:03 JST (main d0e390f): underground at y 56-68, a furnace in the bag, raw iron
// and fuel in hand, and a furnace within eight blocks that no walk reached. The smelt was asked of that furnace
// every two seconds and refused (「iron_pickaxe を準備しています（1/2）。（かまど: 操作対象が手の届く範囲外です。）」)
// for eight minutes, until the pinned item ran out. The held furnace was never put down.
// Real here: dragon-supplies.js (acquire, station), open-stand.js and actions/open-face.js (where the open click
// has a line), station-room.js, player-storage-ports.js (the placement), house/house-ports.js (the smelt) and the
// goal's ledger (goal/goal-ledger.js). Stand-ins: the blocks, the walk, the furnace window, the placement's answer.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createDragonSupplies } = require('../src/modes/dragon-supplies')
const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
const { openAccess } = require('../src/actions/open-face')

const EYE = 1.62, FLOOR = 63
const full = name => 'minecraft:' + name

// walled: the furnace that stands is shut in by rock on every side (no face to click). Otherwise it stands free.
function world ({ walled = true, heldFurnace = true } = {}) {
  const blocks = new Map(), key = (x, y, z) => `${x},${y},${z}`
  let id = 100
  const solid = name => ({ known: true, name, boundingBox: 'block', runtimeId: ++id, extra: [] })
  const AIR = { known: true, name: 'minecraft:air', boundingBox: 'empty', runtimeId: 1, extra: [] }, STONE = solid('minecraft:stone')
  const getBlock = (x, y, z) => blocks.get(key(x, y, z)) ?? (y <= FLOOR ? STONE : AIR)
  const old = { x: 5, y: FLOOR + 1, z: 0 }
  blocks.set(key(old.x, old.y, old.z), solid('minecraft:furnace'))
  if (walled) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) blocks.set(key(old.x + dx, old.y + dy, old.z + dz), solid('minecraft:stone'))
  const w = { at: 1e9, lines: [], opened: [], refused: [], placed: [], cooks: 0, old, feet: { x: 0.5, y: FLOOR + 1, z: 0.5 }, getBlock,
    items: [{ slot: 0, name: full('raw_iron'), count: 2 }, { slot: 1, name: full('coal'), count: 2 }, { slot: 2, name: full('iron_pickaxe'), count: 1 }, ...(heldFurnace ? [{ slot: 3, name: full('furnace'), count: 1 }] : [])],
    furnace: [0, 1, 2].map(slot => ({ slot, name: null, count: 0 })) }
  const rows = () => w.items.filter(item => item.count > 0)
  const give = (name, count) => { const row = rows().find(item => item.name === name); if (row) row.count += count; else w.items.push({ slot: Math.max(-1, ...rows().map(item => item.slot)) + 1, name, count }) }
  const take = (slot, count) => { const row = rows().find(item => item.slot === slot); row.count -= count; return row.name }
  const free = (x, y, z) => getBlock(x, y, z).boundingBox !== 'block'
  const standable = (x, y, z) => !free(x, y - 1, z) && free(x, y, z) && free(x, y + 1, z)
  const goto = to => { w.feet = { x: Number.isInteger(to.x) ? to.x + 0.5 : to.x, y: to.y, z: Number.isInteger(to.z) ? to.z + 0.5 : to.z } }
  const hands = {
    why: () => null,
    walk: async to => { if (!standable(Math.floor(to.x), Math.floor(to.y), Math.floor(to.z))) return false; goto(to); w.at += 1000; return true },
    // Beside the target when a cell next to it can be stood on; a block shut in by rock has none.
    approach: async target => {
      const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: target.x + dx, y: target.y, z: target.z + dz })).find(cell => standable(cell.x, cell.y, cell.z))
      if (!beside) return false
      goto(beside); w.at += 1000
      return true
    },
    canMine: () => false
  }
  const operations = {
    crafting: { closeContainer () {} },
    inventory: { equip: async slot => ({ phase: 'completed', slot }) },
    quarry: { travelStatus: () => ({ busy: false }) },
    interactions: {
      // The open click's own rule (actions/open-face.js): reach and a clear line to a face.
      openFurnace: async at => {
        const no = openAccess(pos => getBlock(pos.x, pos.y, pos.z), { x: w.feet.x, y: w.feet.y + EYE, z: w.feet.z }, at)
        if (no) { w.refused.push([at.x, at.y, at.z, no.code]); throw new Error(no.message) }
        w.opened.push([at.x, at.y, at.z])
      },
      // An ordinary placement: the block is received and the item leaves the hand.
      placeBlock: async ({ position, slot }) => { const name = take(slot, 1); blocks.set(key(position.x, position.y, position.z), solid(name)); w.placed.push([name, position.x, position.y, position.z]) }
    },
    furnace: {
      snapshot: () => ({ contentsKnown: true, slots: w.furnace }),
      putInput: async (slot, count) => { const name = take(slot, count); Object.assign(w.furnace[0], { name, count }) },
      putFuel: async (slot, count) => { const name = take(slot, count); Object.assign(w.furnace[1], { name, count }) },
      waitOutput: async output => { Object.assign(w.furnace[2], { name: output, count: w.furnace[0].count }); Object.assign(w.furnace[0], { name: null, count: 0 }); Object.assign(w.furnace[1], { name: null, count: 0 }); w.cooks++; w.at += 10000 },
      takeOutput: async ({ count }) => { give(w.furnace[2].name, count); Object.assign(w.furnace[2], { name: null, count: 0 }) }
    }
  }
  const shared = {}
  const ledger = createGoalLedger({ shared, now: () => w.at, world: () => 'w', restore: () => null })
  ledger.open('early.home_reserve')
  ledger.look({ scope: 's' })
  const runtime = { raw: () => ({ dimension: 'overworld' }), inventory: () => ({ known: true, items: rows().map(item => ({ ...item })) }), armor: () => ({ known: true, worn: [] }) }
  w.held = name => rows().filter(item => item.name === full(name)).reduce((sum, item) => sum + item.count, 0)
  // One look of the expedition's two-second timer: a new step with the same goal.
  w.look = async () => {
    const ctx = { operations, runtime, getBlock, cancelled: () => false, getFeet: () => w.feet, hands, shared, memory: { early: {} }, log: line => w.lines.push(line),
      goal: { fail: (failure, options) => ledger.fail(failure, options), spent: failure => ledger.spent(failure) }, now: () => w.at, sleep: async ms => { w.at += ms } }
    const out = await createDragonSupplies(ctx).acquire('iron_ingot', 1)
    w.at += 2000
    return out
  }
  return w
}

// Real timers inside the ports (short waits for a received count) are short here: the counts are there at once.
test('a furnace that cannot be opened is left after three tries: the held furnace is put down and the iron is smelted', async () => {
  const w = world()
  let out = null, looks = 0
  for (; looks < 40 && !(out?.done); looks++) out = await w.look()
  const log = w.lines.join('\n')
  assert.equal(out?.done, true, `the ingot came in ${looks} looks: ${out?.reason}\n${log}`)
  assert.equal(w.held('iron_ingot'), 1)
  assert.equal(w.refused.length, 0, 'no open click was sent at the furnace with no face to click')
  assert.equal(w.lines.filter(line => /を開けられる場所に 3 回立てなかったため、このかまどは使いません/.test(line)).length, 1, log)
  assert.equal(w.placed.length, 1, 'the held furnace was put down once')
  assert.deepEqual(w.opened.map(([x, y, z]) => [x, y, z]), [w.placed[0].slice(1)], 'and the smelt used it')
  assert.ok(looks <= 25, `${looks} looks`)
})

test('until then the reason is shown, and nothing is put down', async () => {
  const w = world()
  const first = await w.look()
  assert.equal(first.done, false)
  assert.match(first.reason, /かまど \(5, 64, 0\) を開けられる場所に立てません/)
  assert.equal(w.placed.length, 0)
})

test('a furnace that stands free is used as before, from a place its open click reaches', async () => {
  const w = world({ walled: false })
  let out = null
  for (let looks = 0; looks < 6 && !(out?.done); looks++) out = await w.look()
  assert.equal(out?.done, true, out?.reason)
  assert.deepEqual(w.opened, [[5, 64, 0]])
  assert.equal(w.placed.length, 0, 'the held furnace stays in the bag')
  assert.equal(w.refused.length, 0)
})
