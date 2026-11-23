'use strict'

// The repair of a house that stands on an island: the ground round it dug away (src/modes/house/house-entry.js,
// house-build.js `run`).
// Real Realm 2026-11-23 20:05:32-20:16 JST, the starter house (origin 9877,64,10138), its repair reviewed after an
// hour's hold with 6 hands left (glass 2, oak_slab 3, the door, which the repair had taken down at 18:54). The Bot
// stood in the pit south-east of the door (9886.4, 59.0, 10148.5), five under the floor:
//   プレイヤーモード: 拠点の家の前まで歩けません（あと 9m、No safe route found）   20:07:03
//   プレイヤーモード: 拠点の家の前まで歩けません（あと 8m、No safe route found）   20:09:53, 20:13:33, 20:15:53
// and not one block was placed. At 19:05 the same repair had ended with
//   oak_slab を用意できません: (9878, 65, 10141) へ歩けません: No safe route found
// Blocks: test/fixtures/house-moat.json, as the PC received them at 16:20-16:23 JST (y 55..68, every cell known),
// with the door taken down and one roof slab over the room missing. Before the fix, on them: the same line from the
// south-east pit (あと 8m) and from the north pit (あと 10m), nothing placed. With the door still standing (open) the
// approach from the south-east pit walks to the pit bottom under the porch (9880, 61, 10146), three under the door
// step, counts it as at the house, and no walk from there reaches a stand of the house.
// Real: the house's run (house-build.js: the approach, the steps, their stands), the entrance approach
// (house-entry.js), the walk that digs and stacks (player-build-walk.js with the house protection), the scaffold's
// hands, the navigation and its physics.
// Stand-in: the server (test/helpers/dig-world.js) and the placement's answer: a click is taken where its face is
// within reach of the eye along received open cells, and the block is received there. Its success is not the game's.
//
// 21:32:19-21:32:36 JST, the same repair (glass 2, oak_slab 3, the door; planks 3, logs 2, sand 2 in the pack): the Bot
// stood on the ground left outside the west wall, 7 m from the porch, and the run took that for "at the house":
//   拠点の家: 0 個置きました（残り 6 個）
//   拠点の家: 置けなかった理由 oak_slab を用意できません: 作業台への既知の視線がありません。安全な足場から再確認してください。（3回、oak_slab (98…
// Blocks: test/fixtures/house-moat-west.json, as the PC received them at 21:40:35 JST. Before the fix, on them from
// (9875, 64, 10141): the same two lines, the table opened three times through the wall, no walk and no way begun.
// There the table's answer is the real one (actions/action-access.js stationVisibleFace, as interactions.js asks it);
// the craft behind it is a stand-in.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDigWorld } = require('./helpers/dig-world')
const { createBuildWalk, createMemo } = require('../src/modes/player-build-walk')
const { createHouseBuild } = require('../src/modes/house/house-build')
const { placements, remaining } = require('../src/modes/house/house-blueprint')
const { toEntrance } = require('../src/modes/house/house-entry')
const { stationVisibleFace } = require('../src/actions/action-access')
const received = require('./fixtures/house-moat.json')
const west = require('./fixtures/house-moat-west.json')

const origin = received.house.origin
const DOOR = { x: 9880, y: 65, z: 10144 }, STEP = { x: 9880, y: 65, z: 10145 }
const SLAB = placements(origin).find(step => step.id === 'p_154') // the roof slab over the middle of the room
const SOUTH_EAST = { x: 9886.438, y: 59, z: 10148.486 } // the feet at 20:16 JST
const NORTH = { x: 9879.5, y: 63, z: 10136.5 } // the pit of 16:14 JST, two cells north of the wall
const inHouse = cell => cell.x >= origin.x && cell.x <= origin.x + 6 && cell.z >= origin.z && cell.z <= origin.z + 6 && cell.y >= origin.y && cell.y <= origin.y + 4
const NORMAL = { 0: [0, -1, 0], 1: [0, 1, 0], 2: [0, 0, -1], 3: [0, 0, 1], 4: [-1, 0, 0], 5: [1, 0, 0] }

function scene (feet, { build = true, door = false, from = null } = {}) {
  // As at 20:05: the door down (both halves air), one roof slab gone. `from`: the blocks as they were received, untouched.
  const rows = JSON.parse(JSON.stringify((from ?? received).rows))
  const clear = at => { const row = rows[at.y][at.z - received.z0]; rows[at.y][at.z - received.z0] = `${row.slice(0, at.x - received.x0)}.${row.slice(at.x - received.x0 + 1)}` }
  if (!from) clear(SLAB.position)
  if (!from && !door) { clear(DOOR); clear({ ...DOOR, y: DOOR.y + 1 }) }
  const states = from ? from.states : door ? received.states : Object.fromEntries(Object.entries(received.states).filter(([at]) => at !== `${DOOR.x},${DOOR.y},${DOOR.z}` && at !== `${DOOR.x},${DOOR.y + 1},${DOOR.z}`))
  const items = from
    ? [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 35 }, { slot: 1, name: 'minecraft:cobblestone', count: 65 }, { slot: 2, name: 'minecraft:oak_planks', count: 3 }, { slot: 3, name: 'minecraft:oak_log', count: 2 }, { slot: 4, name: 'minecraft:sand', count: 2 }]
    : [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 67 }, { slot: 1, name: 'minecraft:cobblestone', count: 37 }, { slot: 2, name: 'minecraft:oak_slab', count: 1 }, { slot: 3, name: 'minecraft:wooden_door', count: 1 }]
  const w = createDigWorld({ ...(from ?? received), rows, states, feet }, { outside: () => null, items })
  w.crafts = []
  w.log = []
  w.put_ = []
  const open = (x, y, z) => { const found = w.getBlock(x, y, z); return found.known === true && found.boundingBox === 'empty' }
  let why = null
  const ports = {
    smelt: async () => false, mine: async () => false, reset () { why = null }, why: () => why, placementRetrySafe: () => true,
    // The table opens where interactions.js would open it: a face of it seen from the eye. Then six slabs for three planks.
    craft: async (output, times, table = null) => {
      const at = w.ctx.hands.feet(), planks = items.find(item => item.name === 'minecraft:oak_planks')
      w.crafts.push({ output, from: w.cell(), seen: !table || !!stationVisibleFace({ eye: { x: at.x, y: at.y + 1.62, z: at.z }, target: table, world: { getBlock: w.getBlock } }) })
      if (!w.crafts.at(-1).seen) { why = '作業台への既知の視線がありません。安全な足場から再確認してください。'; return false }
      if (output !== 'minecraft:oak_slab' || !planks || planks.count < 3 * times) return false
      planks.count -= 3 * times
      items.push({ slot: items.length, name: output, count: 6 * times })
      return true
    },
    inspectChest: async () => ({ status: 'completed', evidence: { slotCount: 54 } }),
    // The click's face within reach of the eye, along received open cells.
    place: async (name, plan) => {
      const row = items.find(item => item.name === name && item.count > 0), at = w.ctx.hands.feet()
      const n = NORMAL[plan.face], eye = { x: at.x, y: at.y + 1.62, z: at.z }
      const to = { x: plan.clicked.x + 0.5 + n[0] * 0.5, y: plan.clicked.y + (n[1] ? 0.5 + n[1] * 0.5 : plan.clickY ?? 0.5), z: plan.clicked.z + 0.5 + n[2] * 0.5 }
      const far = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z)
      if (!row) { why = '持っていません'; return false }
      if (far > 4.5) { why = '操作対象が手の届く範囲外です。'; return false }
      for (let i = 1, steps = Math.ceil(far / 0.05); i < steps; i++) {
        const x = Math.floor(eye.x + (to.x - eye.x) * i / steps), y = Math.floor(eye.y + (to.y - eye.y) * i / steps), z = Math.floor(eye.z + (to.z - eye.z) * i / steps)
        if (!(x === plan.clicked.x && y === plan.clicked.y && z === plan.clicked.z) && !open(x, y, z)) { why = '操作対象への視線が遮られているか、未取得です。'; return false }
      }
      row.count--
      w.put(plan.position, name.replace('minecraft:', ''))
      if (/door/.test(name)) w.put({ ...plan.position, y: plan.position.y + 1 }, name.replace('minecraft:', ''))
      w.put_.push({ ...plan.position, name, from: w.cell() })
      return true
    }
  }
  w.shared = { playerWanted: true, playerHouse: { origin, done: false, spawn: true, built: true, repair: { state: 'running', since: 1 } } }
  const say = line => w.log.push(line)
  w.build = createBuildWalk({ hands: w.ctx.hands, getHouse: () => w.shared.playerHouse, log: say, memo: createMemo() })
  w.house = createHouseBuild({
    getMode: () => 'player', shared: w.shared, ports, hands: w.ctx.hands, build: build ? w.build : null, log: say,
    getBlock: w.getBlock, getFeet: () => w.ctx.hands.feet(), getPosition: () => { const at = w.ctx.hands.feet(); return { ...at, y: at.y + 1.62 } },
    getInventory: () => ({ known: true, items: items.filter(item => item.count > 0) }),
    agent: { objective: {}, stop () {}, start: async () => {}, settled: () => true }, climb: async () => ({ ok: true }),
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} }, now: () => 1e6 + w.at, sleep: async ms => { w.at += ms }
  })
  w.left = () => remaining(w.getBlock, origin).map(step => step.id)
  return w
}

const houseUntouched = w => {
  assert.equal(w.minedNames.some(name => /door|planks|log|slab|glass|cobblestone|chest|bed|furnace|crafting/.test(name)), false, `nothing of the house is mined: ${w.minedNames.join(',')}`)
  assert.equal(w.placed.some(inHouse), false, `no pillar or bridge block in the house: ${JSON.stringify(w.placed.filter(inHouse))}`)
}

test('20:16 JST: from the pit south-east of the door the repair goes up to the door step, in, and places the roof slab', async () => {
  const w = scene(SOUTH_EAST)
  assert.deepEqual(w.left().sort(), ['p_154', 'p_172'], 'the slab and the door are what is left')
  for (let i = 0; i < 4 && w.left().includes('p_154'); i++) await w.house.tick()
  assert.equal(w.left().includes('p_154'), false, `the slab stands: ${w.log.join(' / ')}`)
  const slab = w.put_.find(one => /slab/.test(one.name))
  assert.ok(inHouse(slab.from) && slab.from.y === 65, `placed from the floor of the house: ${JSON.stringify(slab.from)}`)
  assert.ok(w.log.some(line => /掘る・積む道で着きました/.test(line)), w.log.join(' / '))
  assert.equal(w.log.some(line => /拠点の家の前まで歩けません/.test(line)), false, w.log.join(' / '))
  houseUntouched(w)
})

test('16:14 JST: from the pit north of the wall, ten metres from the porch with no walk to it, the same', async () => {
  const w = scene(NORTH)
  for (let i = 0; i < 4 && w.left().includes('p_154'); i++) await w.house.tick()
  assert.equal(w.left().includes('p_154'), false, `the slab stands: ${w.log.join(' / ')}`)
  assert.equal(w.log.some(line => /拠点の家の前まで歩けません/.test(line)), false, w.log.join(' / '))
  houseUntouched(w)
})

test('the door standing open: the pit bottom under the porch does not count as at the house', async () => {
  const w = scene(SOUTH_EAST, { door: true })
  assert.deepEqual(w.left(), ['p_154'])
  for (let i = 0; i < 4 && w.left().length; i++) await w.house.tick()
  assert.deepEqual(w.left(), [], w.log.join(' / '))
  assert.ok(w.log.some(line => /掘る・積む道で着きました/.test(line)), w.log.join(' / '))
  assert.equal(w.getBlock(DOOR.x, DOOR.y, DOOR.z).name, 'minecraft:wooden_door', 'the door stands')
  houseUntouched(w)
})

test('the entrance approach by itself: the door step by the way that digs and stacks, and at once from inside', async () => {
  const w = scene(SOUTH_EAST)
  const ask = () => toEntrance({ origin, getBlock: w.getBlock, getFeet: () => w.ctx.hands.feet(), hands: w.ctx.hands, build: w.build })
  const out = await ask()
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.how, 'build')
  assert.deepEqual(w.cell(), STEP)
  assert.equal(await w.ctx.hands.walk(out.entry), true, 'the plain walk goes in through the doorway')
  const walks = w.placed.length
  assert.deepEqual(await ask(), { ok: true, how: 'inside' })
  assert.equal(w.placed.length, walks)
  houseUntouched(w)
})

test('with no way that digs and stacks handed in, the line of the walk and nothing sent beyond it', async () => {
  const w = scene(NORTH, { build: false })
  await w.house.tick()
  assert.deepEqual(w.left().sort(), ['p_154', 'p_172'])
  assert.ok(w.log.some(line => /拠点の家の前まで歩けません（あと 10m/.test(line)), w.log.join(' / '))
  assert.equal(w.placed.length, 0)
  assert.equal(w.minedNames.length, 0)
})

test('21:32 JST: outside the west wall, 7 m from the porch and 3 m from the table through the wall, is not at the house', async () => {
  const w = scene({ x: 9875.5, y: 64, z: 10141.5 }, { from: west })
  assert.deepEqual(w.left().sort(), ['p_119', 'p_121', 'p_151', 'p_158', 'p_165', 'p_172'], 'two panes, three roof slabs and the door are what is left')
  await w.house.tick()
  assert.ok(w.crafts.length > 0, 'the slabs are asked of the table')
  assert.equal(w.crafts.some(one => !inHouse(one.from)), false, `the table is not opened from outside the walls: ${JSON.stringify(w.crafts)}`)
  assert.equal(w.log.some(line => /作業台への既知の視線がありません/.test(line)), false, w.log.join(' / '))
  assert.ok(w.log.some(line => /掘る・積む道で着きました/.test(line)), w.log.join(' / '))
  const slabs = w.put_.filter(one => /slab/.test(one.name))
  assert.ok(slabs.length >= 2 && slabs.every(one => inHouse(one.from)), `roof slabs placed from inside the house: ${JSON.stringify(slabs)} / ${w.log.join(' / ')}`)
  houseUntouched(w)
})
