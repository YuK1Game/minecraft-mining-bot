'use strict'

// The expedition's search for wood does not walk back into the house it has just left
// (src/modes/house/house-outdoors.js `indoors`, read by dragon-supply-gather.js and dragon-tree.js; the hops are
// player-scaffold-ports.js `approach`, which takes the caller's `avoid`).
// Real Realm 2026-11-23 18:43:16-18:45:18 JST, starter house (origin 9877,64,10138), 「いま用意する物: planks 8/32 ← log 0/1」:
//   「家のドアから外へ出ました」 nine times, 12 to 20 s apart. The gathering leaves the house before it looks for wood,
//   so the Bot stood inside it nine times; no walk, trip or build line in between led back in. The six logs in view
//   were rested (「…を掘れなかったため、しばらくほかを先に試します（射程内の採掘面への視線が…）」), so what ran was the
//   search's walk: hops of up to ten cells, straight or turned half a radian or one to either side.
//   At 18:45:24 a creeper blew up beside the door (17 blocks of the house).
// Blocks: test/fixtures/house-moat.json, as the PC received them at 16:20-16:23 JST (y 55..68). Outside that box the
// test puts plain ground (grass at y 64): a stand-in, not a reading. The ground at 18:43 was not read.
// Real: `explore` and `collect`, the scaffold's hands and their hops, the navigation and its physics (the open door
// passed by its received shape), the house exit.
// Stand-in: the server (test/helpers/dig-world.js). Its success is not the game's.
// Before (main c809484): from the door step the search's walk to (9878, 63, 10145) ends on the house floor at
// (9880, 65, 10142), and the one to (9887, 67, 10145) at (9881, 65, 10141).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { collect, explore } = require('../src/modes/dragon-supply-gather')
const { indoors, enclosedHome } = require('../src/modes/house/house-outdoors')
const { inside } = require('../src/modes/house/house-exit')
const { createDigWorld } = require('./helpers/dig-world')
const received = require('./fixtures/house-moat.json')

const origin = received.house.origin
const outside = (x, y) => y < 64 ? 'stone' : y === 64 ? 'grass_block' : 'air'
const STEP = [9879, 9880, 9881].map(x => ({ x: x + 0.5, y: 65, z: 10145.5 }))

function scene (feet) {
  const w = createDigWorld({ ...received, feet }, { outside, logs: true, items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 75 }] })
  w.ctx.shared.playerHouse = { origin, done: true }
  w.ctx.operations.interactions.useDoor = async () => true
  w.indoors = () => inside(origin, w.ctx.getFeet())
  return w
}

test('the house with its doorway is one to walk out of; its inside is the floor between the walls, not the step or the ground under it', () => {
  const w = scene(STEP[1])
  assert.equal(enclosedHome(w.ctx)?.origin, origin)
  const avoid = indoors(w.ctx)
  assert.equal(avoid({ x: 9880, y: 65, z: 10142 }), true, 'the floor')
  assert.equal(avoid({ x: 9880, y: 65, z: 10144 }), true, 'the doorway')
  assert.equal(avoid({ x: 9880, y: 65, z: 10145 }), false, 'the step')
  assert.equal(avoid({ x: 9878, y: 63, z: 10145 }), false, 'the pit beside the step')
  delete w.ctx.shared.playerHouse
  assert.equal(indoors(w.ctx), null, 'no house, nothing to avoid')
})

test('the hops as they were: from the door step a walk to a place outside ends on the house floor; with the house avoided it does not', async () => {
  for (const [from, to] of [[STEP[2], { x: 9878, y: 63, z: 10145 }], [STEP[0], { x: 9887, y: 67, z: 10145 }]]) {
    const before = scene(from)
    await before.ctx.hands.approach(to, 1.5)
    assert.equal(before.indoors(), true, `the turned hop goes in through the open door: ${JSON.stringify(before.cell())}`)
    const after = scene(from)
    await after.ctx.hands.approach(to, 1.5, { avoid: indoors(after.ctx) })
    assert.equal(after.indoors(), false, JSON.stringify(after.cell()))
  }
})

test('18:43 JST: the search for wood from the door step, on every heading, never ends inside the house', async () => {
  for (const from of STEP) for (const heading of [0, 1, 2, 3]) {
    const w = scene(from)
    w.ctx.memory.early.supplySearch = { log: heading * 7 }
    await explore(w.ctx, 'log')
    assert.equal(w.indoors(), false, `from ${JSON.stringify(from)} on heading ${heading}: ${JSON.stringify(w.cell())}`)
  }
})

test('from inside the house the gathering walks out once and stays out while it looks for wood', async () => {
  const w = scene({ x: 9880.5, y: 65, z: 10142.5 })
  for (let look = 0; look < 16; look++) {
    await collect(w.ctx, 'log')
    assert.equal(w.indoors(), false, `after look ${look}: ${JSON.stringify(w.cell())}\n${w.lines.join('\n')}`)
  }
  assert.equal(w.lines.filter(line => /家のドアから外へ出ました/.test(line)).length, 1, w.lines.join('\n'))
  assert.equal(w.minedNames.some(name => /door|planks|slab|glass|cobblestone|chest|bed|furnace|crafting/.test(name)), false, 'nothing of the house is mined')
})
