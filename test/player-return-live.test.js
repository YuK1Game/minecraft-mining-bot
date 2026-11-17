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

// Live 2026-11-18 03:12-03:20 JST, the first return under the goal: 112 items of
// rubble went into the base chest until it was full, the 17 diamonds stayed in
// the hands; the chests outside the south wall were then clicked from inside
// the house (out of reach, no line), 27 tries from one place; the held goal was
// woken every 20 s by the mining below the base and given up after 3 minutes.
const opens = (sim, at) => sim.events.filter(event => event.kind === 'open' && event.detail.x === at.x && event.detail.y === at.y && event.detail.z === at.z).length
const refusedOpens = sim => sim.events.filter(event => event.kind === 'open_refused').length

test('diamonds go in first: a base chest with one free slot takes them, the rubble goes to the next chest (live 2026-11-18 03:16 JST)', async () => {
  const rubble = Array.from({ length: 6 }, (_, index) => [index + 2, 'tuff', 64])
  const { sim, A, B } = home([...KIT, ...rubble, [20, 'diamond', 25]])
  sim.placeChest(A.x, A.y, A.z, { fill: sim.storeOf(A).length - 1 })
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done, ms: 900000 }), true, sim.log.join('\n'))
  assert.equal(sim.stored(A, 'diamond'), 22, 'the one free slot of the base chest holds the diamonds')
  assert.equal(sim.stored(B, 'tuff'), 6 * 64)
  assert.equal(sim.held('tuff'), 0)
})

test('the house chests full, a chest outside the wall: not clicked from inside, out through the door, opened from beside it (live 2026-11-18 03:16-03:20 JST)', async () => {
  const rubble = Array.from({ length: 6 }, (_, index) => [index + 2, 'tuff', 64])
  const { sim, A, B, o } = home([...KIT, ...rubble, [20, 'diamond', 25], [30, 'chest', 2]])
  fill(sim, A); fill(sim, B)
  const outside = sim.placeChest(o.x + 5, GROUND, o.z + 8)
  sim.indoorWalkM = 3
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done, ms: 900000 }), true, sim.log.join('\n'))
  assert.equal(refusedOpens(sim), 0, 'no click is sent from a place the chest does not open from')
  assert.equal(sim.stored(outside, 'diamond'), 22)
  assert.equal(sim.stored(outside, 'tuff'), 6 * 64)
  assert.equal(lines(sim, /家のドアから外へ出ました/).length, 1)
  assert.equal(sim.events.filter(event => event.kind === 'place_chest').length, 0, 'a chest standing there is used; none is built')
  assert.equal(sim.held('chest'), 2)
  assert.equal(lines(sim, /に失敗/).length, 0, sim.log.join('\n'))
  // Standing by chest B, the chest outside is one of the chests near the Bot (as on the
  // Realm): it is chosen from inside, and the approach goes out through the door to it.
  const second = home([...KIT, ...rubble, [20, 'diamond', 25]])
  fill(second.sim, second.A); fill(second.sim, second.B)
  second.sim.shared.playerBase = second.B
  const near = second.sim.placeChest(second.o.x + 5, GROUND, second.o.z + 8)
  second.sim.indoorWalkM = 3
  const other = second.sim.mount()
  assert.equal(await second.sim.run(other, { until: done, ms: 900000 }), true, second.sim.log.join('\n'))
  assert.equal(lines(second.sim, /チェストの確認 → チェストへ接近（CHEST_CHOSEN）/).length >= 1, true, second.sim.log.join('\n'))
  assert.equal(refusedOpens(second.sim), 0)
  assert.equal(lines(second.sim, /家のドアから外へ出ました/).length, 1)
  assert.equal(second.sim.stored(near, 'diamond'), 22)
  assert.equal(lines(second.sim, /に失敗/).length, 0, second.sim.log.join('\n'))
})

test('a chest that opens from nowhere is never clicked and never called full; beside a chest confirmed full a new one is placed', async () => {
  const sim = createReturnSim({ feet: { x: 10.5, y: GROUND, z: 0.5 }, items: [...KIT, [2, 'diamond', 40], [3, 'chest', 2]] })
  const old = sim.placeChest(5, GROUND, 0, { fill: 27 })
  // Walled in on four sides and from above: no cell beside it has a line to the face the click goes to.
  const buried = sim.placeChest(7, GROUND, 3)
  for (const [x, y, z] of [[6, GROUND, 3], [8, GROUND, 3], [7, GROUND, 2], [7, GROUND, 4], [7, GROUND + 1, 3]]) sim.setBlock(x, y, z, 'minecraft:stone')
  sim.shared.playerBase = old
  sim.agent.running = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done, ms: 1800000 }), true, sim.log.join('\n'))
  assert.equal(opens(sim, buried) + refusedOpens(sim), 0, 'never clicked')
  assert.equal(lines(sim, /満杯です/).length, 1, 'only the chest whose received slots showed it')
  assert.equal(lines(sim, /CHEST_UNREACHED/).length >= 3, true)
  assert.equal(sim.events.filter(event => event.kind === 'place_chest').length, 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.stored(buried, 'diamond'), 0)
})

test('held for a chest, the goal is not woken by the mining below the base; held on the way out of a tunnel, it is', async () => {
  // No chest can be built: held for the supplies. Deeper and farther changes nothing about that.
  const sim = createReturnSim({ feet: { x: 8.5, y: GROUND, z: 3.5 }, items: [...KIT, [2, 'diamond', 40]] })
  sim.shared.playerBase = sim.placeChest(5, GROUND, 0, { fill: 27 })
  sim.agent.running = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 600000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'NO_CHEST_MATERIAL', sim.log.join('\n'))
  assert.deepEqual(sim.goal(runtime).hold.kinds, ['supplies_changed'])
  const before = sim.events.length
  pocket(sim, 40, GROUND - 30, 40)
  await sim.run(runtime, { ms: 300000 })
  assert.equal(sim.goal(runtime)?.state, 'held')
  assert.equal(sim.goal(runtime).wakes, 0)
  assert.equal(sim.events.length, before, 'nothing was tried')
  // The climb fails: held for the place, and eight blocks deeper is another place.
  const deep = createReturnSim({ items: [...KIT, [2, 'diamond', 40], [3, 'chest', 2]] })
  pocket(deep, 0, GROUND - 12, 0)
  deep.agent.running = true
  deep.fail.climb = 'NO_DIRT'
  const other = deep.mount()
  await deep.run(other, { until: () => deep.goal(other)?.state === 'held', ms: 600000 })
  assert.equal(deep.goal(other)?.hold.code, 'CLIMB_FAILED', deep.log.join('\n'))
  assert.ok(deep.goal(other).hold.kinds.includes('position_changed'))
  deep.fail.climb = null
  pocket(deep, 0, GROUND - 22, 0)
  assert.equal(await deep.run(other, { until: done, ms: 600000 }), true, deep.log.join('\n'))
  assert.equal(lines(deep, /再開します（POSITION_CHANGED/).length, 1)
})

test('arrived on the hill over the base with no way down: round to another side and in from there (live 2026-11-18 03:41 JST)', async () => {
  const sim = createReturnSim({ feet: { x: 8.5, y: GROUND + 5, z: -10.5 }, items: [...KIT, [2, 'diamond', 40]] })
  // A plateau five blocks high north of the chest: within 20 m of it, and no walk down.
  for (let x = -5; x <= 25; x++) for (let z = -25; z <= -5; z++) for (let y = GROUND; y < GROUND + 5; y++) sim.setBlock(x, y, z, 'minecraft:stone')
  const chest = sim.placeChest(5, GROUND, 0)
  sim.shared.playerBase = chest
  sim.agent.running = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done, ms: 1800000 }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /別の側から近づきます/).length, 1, sim.log.join('\n'))
  assert.equal(lines(sim, /CHEST_UNREACHED/).length, 3, 'three tries from the hill, then the other side')
  assert.equal(lines(sim, /使えないため/).length, 0, 'the chest is not given up for another')
  assert.equal(sim.stored(chest, 'diamond'), 37)
  assert.equal(sim.events.filter(event => event.kind === 'place_chest').length, 0)
})

test('nothing is decided before the terrain at the Bot is received (live 2026-11-18 03:28:43 JST, before the world was joined)', async () => {
  const sim = createReturnSim({ feet: { x: 30.5, y: GROUND, z: 0.5 }, items: [...KIT, [2, 'diamond', 40]] })
  const chest = sim.placeChest(5, GROUND, 0)
  sim.shared.playerBase = chest
  sim.agent.running = true
  for (let cx = -2; cx <= 3; cx++) for (let cz = -2; cz <= 2; cz++) sim.unknown.add(`${cx},${cz}`)
  sim.later(8000, () => sim.unknown.clear())
  const runtime = sim.mount()
  await sim.run(runtime, { ms: 6000 })
  assert.equal(sim.events.length, 0, 'no walk, no trip, no click while the blocks are not received')
  assert.equal(lines(sim, /TERRAIN_UNKNOWN/).length >= 1, true, sim.log.join('\n'))
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(chest, 'diamond'), 37)
  assert.equal(lines(sim, /保留/).length, 0)
})

test('interrupted again and again by a flee: none of it is charged, and the goal ends when the flee stops (live 2026-11-18 04:18-04:22 JST)', async () => {
  // Then: the eleventh flee in a row on the walk to the chest was counted as a failure (INTERRUPTED_REPEATEDLY, 9 of 12 tries).
  const start = { x: 19.5, y: GROUND, z: 0.5 }
  const sim = createReturnSim({ feet: { ...start }, items: [...KIT, [2, 'diamond', 40]] })
  const chest = sim.placeChest(5, GROUND, 0)
  sim.shared.playerBase = chest
  sim.agent.running = true
  sim.fail.approach = true // the hops over the ground do not make it: the walk to a cell beside the chest is what runs
  const runtime = sim.mount()
  // Sixteen flees, each a moment into the walk to the chest; a flee has the movement for 14 s and takes the Bot back to where it was.
  let flees = 0, fleeing = false, seen = 0
  const flee = () => { flees++; fleeing = true; runtime.jobs.other = '敵から離れる'; sim.fight(14000); Object.assign(sim.body, start); sim.later(14000, () => { runtime.jobs.other = null; fleeing = false }) }
  const watch = () => {
    const walking = sim.log.slice(seen).some(line => /チェストへ接近（NEAR_BASE）|計画し直します/.test(line))
    seen = sim.log.length
    if (!fleeing && flees < 16 && walking) sim.later(600, flee)
    sim.later(200, watch)
  }
  watch()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(flees, 16)
  assert.equal(lines(sim, /チェストへ接近を中断して待ちます（敵から離れる）/).length, 16, sim.log.join('\n'))
  assert.equal(lines(sim, /に失敗/).length, 0, sim.log.join('\n'))
  assert.equal(lines(sim, /保留/).length, 0)
  assert.equal(sim.stored(chest, 'diamond'), 37)
})

test('after a death the kit is taken from the chest the Bot does not stand beside; one that gives nothing says why (live 2026-11-18 05:11 JST)', async () => {
  // The base is a chest outside the south wall, with nothing wanted in it;
  // the diamonds are in the house's chest B, out of reach from there.
  const sim = createReturnSim({ feet: { x: 3.5, y: GROUND, z: 16.5 }, items: [[0, 'diamond', 20]] })
  const house = sim.buildHouse({ x: 0, y: GROUND, z: 0 })
  const B = { x: house.origin.x + 5, y: house.origin.y + 1, z: house.origin.z + 3 }
  const base = sim.placeChest(3, GROUND, 14)
  sim.storeOf(B)[0] = structuredClone(sim.bag[0])
  sim.shared.playerBase = base
  sim.worn = { known: true, worn: [] }
  sim.die({ x: 3.5, y: GROUND, z: 16.5 })
  sim.agent.running = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done, ms: 300000 }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /拠点のチェストからダイヤと資材を取り出します/).length, 1, sim.log.join('\n'))
  assert.equal(lines(sim, /RESTOCK_UNCONFIRMED|保留/).length, 0, sim.log.join('\n'))
  assert.equal(sim.bag.filter(item => item.network_id && item.count === 20).length, 1, 'the diamonds are in the inventory by its received slots')
  assert.equal(sim.stored(B, 'diamond'), 0)
  assert.equal(lines(sim, /取り出し 20 個/).length, 1, sim.log.join('\n'))
  // Each chest was opened once: the base beside the Bot, then B after the walk through the door.
  const opened = sim.events.filter(event => event.kind === 'open')
  assert.equal(opened.length, 2, JSON.stringify(opened))
  // Nothing more is wanted from chests whose slots were received: no second goal.
  await sim.sleep(60000)
  assert.equal(await runtime.base.tick(), null)
  assert.equal(sim.events.filter(event => event.kind === 'open').length, 2)
})

test('a chest that is wanted for the kit and gives nothing answers with its own reason, and the goal is held on it', async () => {
  // The base's contents never arrive: unknown, so the kit may be in it.
  const sim = createReturnSim({ feet: { x: 3.5, y: GROUND, z: 16.5 }, items: [] })
  const base = sim.placeChest(3, GROUND, 14)
  sim.shared.playerBase = base
  sim.worn = { known: true, worn: [] }
  sim.server.contents = 'none'
  sim.agent.running = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 600000 })
  assert.equal(sim.goal(runtime)?.state, 'held', sim.log.join('\n'))
  const failed = lines(sim, /に失敗/)
  assert.ok(failed.length >= 1 && failed.every(line => /収納の確認に失敗: CONTAINER_CONTENTS_UNKNOWN/.test(line)), sim.log.join('\n'))
  assert.equal(lines(sim, /RESTOCK_UNCONFIRMED/).length, 0)
  assert.equal(sim.server.requests.length, 0, 'nothing is asked of a chest that was not read')
  // The contents arrive, with nothing wanted in them: the goal ends, and no new one starts.
  sim.server.contents = 'send'
  assert.equal(await sim.run(runtime, { until: done, ms: 1500000 }), true, sim.log.slice(-12).join('\n'))
  await sim.sleep(60000)
  assert.equal(await runtime.base.tick(), null)
})
