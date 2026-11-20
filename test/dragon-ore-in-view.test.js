'use strict'

// The expedition's gathering reaches ore that is in view through rock (src/modes/dragon-early-quarry.js `approachOre`,
// called by `collect` in dragon-supply-gather.js).
// Real Realm 2026-11-20 14:28:24-14:28:35 JST (main ad1b4fc): in its own one-wide tunnel at feet (9912.5, 20, 10120.6),
// with raw iron to smelt and no fuel, coal ore stood 5-6 blocks away. On every tick, about every 0.2 s:
// 「掘る・積む道もありません（BUILD_ROUTE_SEARCH_LIMIT・調べたマス 1100）」 12-13 times (two sides of six ores), then
// 「歩ける道がないため、掘る・積む道で進みます（3 歩・掘る 8 個…）」 along the heading of the mine instead. In the 13:00 hour
// the first line was logged 1,108 times; an iron pickaxe with 241 uses was gone in 33 minutes.
// The blocks are the ones received there (test/fixtures/mine-tunnel-ore-in-view.json: GET /blocks 14:28:34 JST,
// x 9905..9919, y 14..24, z 10113..10127, every cell received, no liquid).
// Real here: the caller (`collect`), the route to the ore's side (`approachOre`), the mine's heading (`searchMine`),
// the dig-and-stack walk and its planner (player-build-walk.js, movement/build-route.js), the scaffold's hands
// (player-scaffold-ports.js) and the navigation's planner and physics (movement/navigation.js).
// Stand-in: the server (helpers/dig-world.js). Outside what was read: stone.
const test = require('node:test')
const assert = require('node:assert/strict')
const { collect } = require('../src/modes/dragon-supply-gather')
const { planBuildRoute } = require('../src/movement/build-route')
const { createDigWorld } = require('./helpers/dig-world')
const received = require('./fixtures/mine-tunnel-ore-in-view.json')

// As at 14:28:32 JST: an iron pickaxe, raw iron to smelt, no coal.
const scene = () => createDigWorld(received, { items: [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 200 }, { slot: 1, name: 'minecraft:raw_iron', count: 3 }] })
const LIMIT = /BUILD_ROUTE_SEARCH_LIMIT/

test('the received tunnel: coal ore 5-6 blocks away through rock, none of it open to the tunnel', () => {
  const w = scene()
  assert.deepEqual(w.cell(), { x: 9912, y: 20, z: 10120 })
  assert.equal(w.getBlock(9909, 18, 10116).name, 'minecraft:coal_ore')
  assert.equal(w.ctx.hands.canMine({ x: 9909, y: 18, z: 10116 }), false)
  // The route to the side of the nearest coal ore, with the mine's box and node limit: the plain guide ends on the
  // limit (the line of the live log), the same search with room finds a route of six steps.
  const start = { x: 9912, y: 20, z: 10120 }, target = { x: 9909, y: 18, z: 10117 }, done = cell => cell.x === target.x && cell.y === target.y && cell.z === target.z
  const box = { getBlock: w.getBlock, start, target, done, pad: 4, rise: 3, allowShaft: false, blocks: 0 }
  const plain = planBuildRoute({ ...box, maxNodes: 550, maxMs: 2000 })
  assert.equal(plain.ok, false)
  assert.equal(plain.code, 'BUILD_ROUTE_SEARCH_LIMIT')
  const roomy = planBuildRoute({ ...box, maxNodes: 12000, maxMs: 2000 })
  assert.equal(roomy.ok, true)
  assert.equal(roomy.steps.length, 6)
  // Leaning toward the target: the same six steps, the same blocks mined, within the mine's node limit.
  const lean = planBuildRoute({ ...box, maxNodes: 550, maxMs: 2000, greed: 8 })
  assert.equal(lean.ok, true, lean.code)
  assert.equal(lean.steps.length, roomy.steps.length)
  assert.equal(lean.dig, roomy.dig)
  assert.ok(lean.expanded < 200, String(lean.expanded))
})

test('one tick of the gathering digs to the coal in view and mines it; no route ends on the search limit', async () => {
  const w = scene()
  assert.equal(w.count('coal'), 0)
  await collect(w.ctx, 'coal')
  const log = w.lines.join('\n')
  assert.equal(w.lines.filter(line => LIMIT.test(line)).length, 0, log)
  assert.equal(w.count('coal'), 1, log)
  assert.ok(w.minedNames.includes('coal_ore'), w.minedNames.join(' '))
  // The way there was dug toward the ore, not along the heading of the mine.
  assert.ok(w.minedNames.length <= 16, w.minedNames.join(' '))
  assert.equal(w.ctx.memory.early.mine?.direction, undefined)
})

test('the next ticks take the rest of the vein', async () => {
  const w = scene()
  for (let i = 0; i < 4; i++) await collect(w.ctx, 'coal')
  assert.ok(w.count('coal') >= 3, `${w.count('coal')}\n${w.lines.join('\n')}`)
  assert.equal(w.lines.filter(line => LIMIT.test(line)).length, 0, w.lines.join('\n'))
})
