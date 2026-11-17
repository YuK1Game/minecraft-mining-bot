'use strict'

// The live cases of the trip to the base (each title names the day it was
// seen on the Realm), moved from player-base.test.js when the trip became one
// goal (return/return-runner.js). They run over the simulated Realm of
// helpers/player-return-sim.js instead of hand-written answers, and keep what
// each case expected.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')

const KIT = [[0, 'diamond_pickaxe', 1], [1, 'diamond_sword', 1]]
const done = value => value === true
const lines = (sim, pattern) => sim.log.filter(line => pattern.test(line))
const kinds = sim => sim.events.map(event => event.kind)
// A pocket in the stone, deep under the surface.
function pocket (sim, x, y, z) {
  for (const dy of [0, 1]) sim.setBlock(x, y + dy, z, 'minecraft:air', { passable: true })
  Object.assign(sim.body, { x: x + 0.5, y, z: z + 0.5 })
}

test('underground with no base: climbs out, makes the base chest there and banks', async () => {
  const sim = createReturnSim({ items: [...KIT, [2, 'diamond', 40], [3, 'chest', 2]] })
  pocket(sim, 0, GROUND - 12, 0)
  sim.agent.running = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const order = kinds(sim).filter(kind => ['climb', 'place_chest', 'open', 'transfer'].includes(kind))
  assert.deepEqual(order.slice(0, 2), ['climb', 'place_chest'])
  assert.ok(order.includes('transfer'))
  assert.ok(sim.shared.playerBase, 'the new chest is the base')
  assert.deepEqual(sim.files['player-base.json'].chest, sim.shared.playerBase)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.agent.starts.length, 1)
  assert.equal(sim.trips, 0, 'no long trip without a base to go to')
})

test('no base and no wood underground: climbs out only, no chest; the base is made once a chest can be built', async () => {
  const sim = createReturnSim({ items: [...KIT, [2, 'diamond', 40]] })
  pocket(sim, 0, GROUND - 12, 0)
  sim.agent.running = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 600000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'NO_CHEST_MATERIAL', sim.log.join('\n'))
  assert.equal(sim.body.y, GROUND, 'out of the tunnel')
  assert.deepEqual([...new Set(kinds(sim))], ['climb'])
  assert.equal(sim.shared.playerBase, null)
  assert.equal(sim.agent.running, true, 'the work goes on: the wood is gathered on the surface')
  sim.give(5, 'chest', 2)
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.ok(lines(sim, /再開します（SUPPLIES_CHANGED/).length === 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

function home (items, feet = { x: 30.5, y: GROUND, z: 30.5 }) {
  const sim = createReturnSim({ feet, items })
  const house = sim.buildHouse({ x: 0, y: GROUND, z: 0 })
  const o = house.origin
  const A = { x: o.x + 3, y: o.y + 1, z: o.z + 1 }, B = { x: o.x + 5, y: o.y + 1, z: o.z + 3 }
  sim.shared.playerBase = A
  sim.agent.running = true
  return { sim, A, B, o }
}
const fill = (sim, at) => { const store = sim.storeOf(at); sim.placeChest(at.x, at.y, at.z, { fill: store.length }) }

test('a full base chest: the house chest B takes the rest before a new chest (live 2026-11-17 15:50 JST)', async () => {
  const { sim, A, B } = home([...KIT, [2, 'diamond', 40], [3, 'chest', 2]])
  fill(sim, A)
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(B, 'diamond'), 37)
  assert.equal(sim.events.filter(event => event.kind === 'place_chest').length, 0)
  assert.equal(sim.held('chest'), 2)
})

test('both house chests full: a new chest skips them, stands outside the door and becomes the base (live 2026-11-17 18:43-18:46 JST)', async () => {
  const { sim, A, B, o } = home([...KIT, [2, 'diamond', 40], [3, 'chest', 2]])
  fill(sim, A); fill(sim, B)
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const placed = sim.events.filter(event => event.kind === 'place_chest')
  assert.equal(placed.length, 1)
  assert.equal(placed[0].indoors, false, 'placed from outside the house')
  const at = placed[0].detail
  assert.ok(!(at.x === o.x + 3 && [8, 9].includes(at.z - o.z)), 'not in the way to the door')
  assert.deepEqual(sim.shared.playerBase, at)
  assert.equal(sim.stored(at, 'diamond'), 37)
})

test('a climb a fight cut short goes on when the fight is over, not ten minutes later (live 2026-11-17 20:16 JST)', async () => {
  const sim = createReturnSim({ items: [...KIT, [2, 'diamond', 40]] })
  sim.shared.playerBase = sim.placeChest(5, GROUND, 0)
  pocket(sim, 0, GROUND - 30, 0)
  sim.agent.running = true
  const runtime = sim.mount()
  let fightEnd = null
  sim.later(8000, () => { sim.fight(20000); fightEnd = sim.clock + 20000 })
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const climbs = sim.events.filter(event => event.kind === 'climb')
  assert.equal(climbs.length, 2)
  assert.ok(climbs[1].at >= fightEnd && climbs[1].at <= fightEnd + 10000, `second climb ${climbs[1].at - fightEnd} ms after the fight`)
  assert.equal(lines(sim, /に失敗/).length, 0)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('a long trip that keeps getting closer is not cut at five minutes (live 2026-11-17 20:41 JST)', async () => {
  const sim = createReturnSim({ feet: { x: 405.5, y: GROUND, z: 0.5 }, items: [...KIT, [2, 'diamond', 40]] })
  sim.shared.playerBase = sim.placeChest(5, GROUND, 0)
  sim.travel.speed = 1 // 1 m every second: past the old five-minute cap
  sim.agent.running = true
  const runtime = sim.mount()
  const start = sim.clock
  assert.equal(await sim.run(runtime, { until: done, ms: 1200000 }), true, sim.log.join('\n'))
  assert.equal(sim.trips, 1)
  assert.ok(sim.clock - start > 300000)
})

test('a trip that stops getting closer is ended after four minutes and tried again at once (live 2026-11-17 21:02 JST)', async () => {
  const sim = createReturnSim({ feet: { x: 405.5, y: GROUND, z: 0.5 }, items: [...KIT, [2, 'diamond', 40]] })
  sim.shared.playerBase = sim.placeChest(5, GROUND, 0)
  sim.fail.travel = 'stall'
  sim.agent.running = true
  const runtime = sim.mount()
  sim.later(260000, () => { sim.fail.travel = null })
  assert.equal(await sim.run(runtime, { until: done, ms: 1200000 }), true, sim.log.join('\n'))
  const trips = sim.events.filter(event => event.kind === 'travel')
  assert.equal(trips.length, 2)
  assert.ok(trips[1].at - trips[0].at >= 235000 && trips[1].at - trips[0].at <= 250000, `${trips[1].at - trips[0].at} ms`)
})

test('a base chest that would not open is not full, and is not waited for: chest B, then a new chest (live 2026-11-18 01:02 JST)', async () => {
  const { sim, A, B } = home([...KIT, [2, 'diamond', 40], [3, 'chest', 2]])
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
  sim.server.contents = at => same(at, A) ? 'none' : 'send'
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(B, 'diamond'), 37, 'chest B takes it')
  assert.equal(lines(sim, /満杯です/).length, 0, 'the unopened chest is never called full')
  // Neither opens: a new chest outside takes everything and becomes the base.
  const second = home([...KIT, [2, 'diamond', 40], [3, 'chest', 2]])
  second.sim.server.contents = at => same(at, second.A) || same(at, second.B) ? 'none' : 'send'
  const other = second.sim.mount()
  assert.equal(await second.sim.run(other, { until: done, ms: 900000 }), true, second.sim.log.join('\n'))
  assert.equal(second.sim.events.filter(event => event.kind === 'place_chest').length, 1)
  assert.equal(second.sim.stored(second.sim.shared.playerBase, 'diamond'), 37)
  assert.ok(!same(second.sim.shared.playerBase, second.A) && !same(second.sim.shared.playerBase, second.B))
})

test('hops that stop at a slope hand over to the house porch walk (live 2026-11-18 01:14-01:15 JST)', async () => {
  const { sim, A } = home([...KIT, [2, 'diamond', 40]], { x: 3.5, y: GROUND, z: 28.5 })
  sim.fail.approach = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const order = kinds(sim).filter(kind => ['porch', 'door', 'open'].includes(kind))
  assert.deepEqual(order.slice(0, 3), ['porch', 'door', 'open'])
  assert.equal(sim.stored(A, 'diamond'), 37)
})

test('a new chest that fills too: another new chest takes the rest (live 2026-11-18 01:54 JST)', async () => {
  const rubble = Array.from({ length: 30 }, (_, index) => [index + 2, 'tuff', 64])
  const sim = createReturnSim({ feet: { x: 8.5, y: GROUND, z: 3.5 }, items: [...KIT, ...rubble, [32, 'chest', 3]] })
  const first = sim.placeChest(5, GROUND, 0, { fill: 27 })
  sim.shared.playerBase = first
  sim.agent.running = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done, ms: 900000 }), true, sim.log.join('\n'))
  const placed = sim.events.filter(event => event.kind === 'place_chest').map(event => event.detail)
  assert.equal(placed.length, 2, sim.log.join('\n'))
  assert.equal(sim.stored(placed[0], 'tuff') + sim.stored(placed[1], 'tuff'), 30 * 64)
  assert.equal(sim.held('tuff'), 0)
  assert.deepEqual(sim.shared.playerBase, placed[1])
  assert.equal(runtime.base.status().banked, 30 * 64)
})
