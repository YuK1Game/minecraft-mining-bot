'use strict'

// The return to the base, end to end, over a simulated Realm
// (helpers/player-return-sim.js says what is real and what is simulated).
// S1-S14 are the acceptance scenarios of docs/player-return.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')

const KIT = [[0, 'diamond_pickaxe', 1], [1, 'diamond_sword', 1]]
const done = value => value === true
const lines = (sim, pattern) => sim.log.filter(line => pattern.test(line))

test('S1 an ordinary return: two travel legs, the last approach, the deposit by received slots, then the work planned again', async () => {
  const sim = createReturnSim({ feet: { x: 150.5, y: GROUND, z: 0.5 }, items: [...KIT, [2, 'diamond', 40], [3, 'emerald', 5]] })
  sim.shared.playerBase = sim.placeChest(5, GROUND, 0)
  sim.agent.running = true
  // The first trip stops short at a zone it cannot cross; the second starts from where it ended.
  sim.travel.zones.push({ x1: 79, x2: 81, z1: -1, z2: 2, code: 'CHUNK_TRAVEL_DANGER_ZONE', once: true })
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.trips, 2, 'two long trips')
  assert.ok(sim.events.some(event => event.kind === 'walk'), 'the last approach is a walk of its own')
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.stored(sim.shared.playerBase, 'emerald'), 5)
  assert.equal(sim.held('diamond'), 3, 'the kit stays in hand')
  assert.equal(sim.agent.stops.length, 1)
  assert.equal(sim.agent.starts.length, 1, 'the work starts again once, after the goal is met')
  assert.deepEqual(sim.agent.starts[0].options, { objective: 'diamond' }, 'planned again from the objective, not from a saved operation')
  assert.ok(sim.agent.starts[0].at >= sim.server.requests.at(-1).at)
  assert.equal(sim.goal(runtime), null)
  assert.equal(runtime.base.status().banked, 42)
})

const CARGO = [...KIT, [2, 'diamond', 40], [3, 'emerald', 5]]
const far = (items = CARGO, feet = { x: 150.5, y: GROUND, z: 0.5 }) => {
  const sim = createReturnSim({ feet, items })
  sim.shared.playerBase = sim.placeChest(5, GROUND, 0)
  sim.agent.running = true
  return sim
}
const failures = sim => lines(sim, /に失敗/)
const ids = sim => new Set(sim.log.map(line => /帰還\[(\w+)\]/.exec(line)?.[1]).filter(Boolean))
// A wall three high around the chest at (5, GROUND, 0): nothing walks in.
function wall (sim, gap = null) {
  for (let x = -2; x <= 12; x++) for (let z = -7; z <= 7; z++) {
    if (x !== -2 && x !== 12 && z !== -7 && z !== 7) continue
    if (gap && gap.x === x && gap.z === z) continue
    for (let y = GROUND; y < GROUND + 3; y++) sim.setBlock(x, y, z, 'minecraft:stone')
  }
}

test('S2 a fight and a meal on the way: the goal waits, starts nothing, and goes on from where the Bot is', async () => {
  const sim = far()
  const runtime = sim.mount()
  sim.later(12000, () => sim.fight(15000))
  sim.later(40000, () => sim.eat(8000))
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.events.filter(event => event.combat).length, 0, 'nothing begins while the fight holds the controls')
  assert.ok(lines(sim, /中断して待ちます（戦闘）/).length === 1 && lines(sim, /中断して待ちます（食事）/).length === 1, sim.log.join('\n'))
  assert.equal(ids(sim).size, 1, 'one goal from the decision to the end')
  assert.equal(failures(sim).length, 0, 'an interruption is not a failure')
  assert.ok(sim.trips >= 3, 'the trip is planned again after each interruption')
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.agent.starts.length, 1, 'the work is not started while the goal waits')
})

test('S3 the stop is waited for: nothing starts while the autonomy is still ending', async () => {
  const sim = far()
  sim.stopLagMs = 5000
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.events.filter(event => event.stopping).length, 0)
  assert.ok(sim.events[0].at >= sim.agent.stops[0].at + 5000)
})

test('S3 a stop that is never confirmed: no operation, the goal is held, and it goes on once the stop is confirmed', async () => {
  const sim = far()
  sim.stopLagMs = 3600000
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 300000 })
  const goal = sim.goal(runtime)
  assert.equal(goal?.state, 'held', sim.log.join('\n'))
  assert.equal(goal.hold.code, 'STOP_UNCONFIRMED')
  assert.equal(sim.events.length, 0, 'not one operation was started')
  assert.equal(runtime.base.status().active, false, 'a held goal does not hold the other jobs')
  assert.equal(sim.agent.starts.length, 1, 'the work goes on while the goal is held')
  sim.stopLagMs = 400; sim.agent.stopUntil = 0
  assert.equal(await sim.run(runtime, { until: done, ms: 1500000 }), true, sim.log.join('\n'))
  assert.equal(ids(sim).size, 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

function pond (sim, cx, cz) {
  for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) sim.water(x, GROUND - 1, z)
}

test('S4 from a pond: out of the water first, by the received position, and only then the long trip', async () => {
  const sim = far(CARGO, { x: 150.5, y: GROUND - 1, z: 0.5 })
  pond(sim, 150, 0)
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const trip = sim.events.find(event => event.kind === 'travel')
  assert.equal(trip.wet, false, 'the trip starts on dry land')
  assert.ok(sim.events.indexOf(trip) > sim.events.findIndex(event => event.kind === 'walk'))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

// Live 2026-11-18 16:44-17:03 JST: a body that is not swimming sinks. On the bottom of a lake two
// blocks deep the ledge search looked at the level of the feet, found no shore 1.7 m away, and the
// return failed four times with WATER_EXIT_FAILED NO_LEDGE.
test('S4 sunk to the bottom where the pond is two blocks deep: the shore is found from the surface, and the trip starts on land', async () => {
  const sim = far(CARGO, { x: 150.5, y: GROUND - 2, z: 0.5 })
  pond(sim, 150, 0); sim.water(150, GROUND - 2, 0)
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(failures(sim).filter(line => /WATER_EXIT_FAILED/.test(line)).length, 0, sim.log.join('\n'))
  assert.equal(sim.events.find(event => event.kind === 'travel').wet, false, 'the trip starts on dry land')
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S4 the water exit fails: no long trip from the water, the goal is held and wakes when the Bot stands elsewhere', async () => {
  const sim = far(CARGO, { x: 150.5, y: GROUND - 1, z: 0.5 })
  pond(sim, 150, 0)
  sim.fail.waterExit = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 600000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'WATER_EXIT_FAILED', sim.log.join('\n'))
  assert.equal(sim.trips, 0, 'no long trip was started from the water')
  assert.equal(failures(sim).filter(line => /WATER_EXIT_FAILED/.test(line)).length, 3, 'three tries, not more')
  // The work moved the Bot out (the autonomy's own shore route).
  Object.assign(sim.body, { x: 100.5, y: GROUND, z: 0.5 }); sim.fail.waterExit = false
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.ok(lines(sim, /再開します（POSITION_CHANGED/).length === 1)
  assert.equal(ids(sim).size, 1)
})

test('S5 the house: the door is opened before the chest, and a trip from inside leaves through the door first', async () => {
  const sim = createReturnSim({ feet: { x: 60.5, y: GROUND, z: 40.5 }, items: CARGO })
  const house = sim.buildHouse({ x: 0, y: GROUND, z: 0 })
  const chestA = { x: house.origin.x + 3, y: house.origin.y + 1, z: house.origin.z + 1 }
  sim.shared.playerBase = chestA
  sim.agent.running = true
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const kinds = sim.events.map(event => event.kind)
  assert.ok(kinds.indexOf('door') >= 0 && kinds.indexOf('door') < kinds.indexOf('open'), 'door before chest')
  assert.equal(sim.stored(chestA, 'diamond'), 37)
  assert.equal(sim.events.find(event => event.kind === 'open').indoors, true)
  // A second base far away, up a slope; the Bot is inside the house with new cargo.
  for (let step = 1; step <= 3; step++) for (let x = 190 + step * 2; x <= 215; x++) for (let z = 35; z <= 45; z++) sim.setBlock(x, GROUND + step - 1, z, 'minecraft:stone')
  const hill = sim.placeChest(205, GROUND + 3, 40)
  sim.shared.playerBase = hill
  sim.give(2, 'diamond', 43)
  await sim.sleep(31000)
  const from = sim.events.length
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.slice(-30).join('\n'))
  const trip = sim.events.slice(from).find(event => event.kind === 'travel')
  assert.equal(trip.indoors, false, 'the long trip starts outside the house')
  assert.equal(sim.stored(hill, 'diamond'), 40, 'banked up the slope')
})

test('S6 a chest confirmed full by its received slots: a new one is placed and used', async () => {
  const sim = far([...CARGO, [4, 'chest', 2]], { x: 40.5, y: GROUND, z: 0.5 })
  const old = sim.placeChest(5, GROUND, 0, { fill: 27 })
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /満杯です（受信した空き 0 枠）/).length, 1)
  assert.notDeepEqual(sim.shared.playerBase, old)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.stored(old, 'diamond'), 0)
})

test('S6 a chest whose contents never arrive is unknown, not full', async () => {
  const sim = far(CARGO, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.contents = 'none'
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 600000 })
  assert.equal(lines(sim, /満杯です/).length, 0, sim.log.join('\n'))
  assert.ok(failures(sim).every(line => /CONTAINER_CONTENTS_UNKNOWN|NO_CHEST_MATERIAL/.test(line)), failures(sim).join('\n'))
  assert.equal(sim.shared.playerReturn.full.length, 0)
  assert.equal(sim.server.requests.length, 0, 'nothing is sent into a chest that was not read')
  assert.equal(sim.held('diamond'), 40)
  // The contents arrive: the same goal banks into the same chest.
  sim.server.contents = 'send'
  assert.equal(await sim.run(runtime, { until: done, ms: 1500000 }), true, sim.log.join('\n'))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(ids(sim).size, 1)
})

test('S6 the halves of a full large chest are one container: the other half is not opened', async () => {
  const sim = far([...CARGO, [4, 'chest', 2]], { x: 40.5, y: GROUND, z: 0.5 })
  sim.placeChest(6, GROUND, 0)
  sim.placeChest(5, GROUND, 0, { fill: 54 })
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  const opened = sim.events.filter(event => event.kind === 'open').map(event => `${event.detail.x},${event.detail.z}`)
  assert.equal(opened.filter(at => at === '5,0' || at === '6,0').length, 1, opened.join(' '))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S6 a chest that cannot be walked to is unreached: not full, not opened, and no new chest is placed for it', async () => {
  const sim = far([...CARGO, [4, 'chest', 2]], { x: 40.5, y: GROUND, z: 0.5 })
  wall(sim)
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 900000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'CHEST_UNREACHED', sim.log.join('\n'))
  assert.equal(sim.events.filter(event => event.kind === 'open' || event.kind === 'place_chest').length, 0)
  assert.equal(lines(sim, /満杯です/).length, 0)
  assert.equal(sim.held('diamond'), 40)
})

test('S7 a transfer the server never answers: the inventory is received again first, and nothing is sent twice', async () => {
  const sim = far(CARGO, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.transfer = n => { if (n !== 1) return 'ok'; sim.later(6000, () => sim.resync()); return 'drop' }
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.ok(failures(sim).some(line => /TRANSFER_UNCONFIRMED/.test(line)))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.held('diamond'), 3)
  assert.equal(runtime.base.status().banked, 42, 'counted once')
  const first = sim.server.requests[0], second = sim.server.requests[1]
  assert.ok(second.at >= first.at + 6000, 'nothing was sent while the inventory was uncertain')
})

test('S7 a transfer applied without an answer: the received inventory decides, the stack is not sent again', async () => {
  const sim = far(CARGO, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.transfer = n => { if (n !== 1) return 'ok'; sim.later(6000, () => sim.resync()); return 'apply_silent' }
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37, 'exactly once in the chest')
  assert.equal(sim.held('diamond'), 3)
  assert.equal(sim.stored(sim.shared.playerBase, 'emerald'), 5)
  assert.ok(runtime.base.status().banked <= 42, 'an unconfirmed transfer is not counted as banked')
})

test('S7 a rejected transfer: 0 stored is not success, and the requests are bounded', async () => {
  const sim = far(CARGO, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.transfer = 'reject'
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 900000 })
  assert.equal(sim.goal(runtime)?.state, 'held', sim.log.join('\n'))
  assert.equal(lines(sim, /完了しました/).length, 0)
  assert.equal(runtime.base.status().banked, 0)
  assert.equal(sim.held('diamond'), 40)
  assert.ok(sim.server.requests.length <= 12, `${sim.server.requests.length} requests`)
})

test('S7 a transfer answered by the stack response alone counts: the response is received data', async () => {
  const sim = far(CARGO, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.transfer = 'ack_only'
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.server.requests.length, 2)
})

test('S7 a fight in the middle of the deposit: the rest goes in afterwards, each stack once', async () => {
  const stacks = [...KIT, [2, 'diamond', 40], [3, 'emerald', 5], [4, 'tuff', 64], [5, 'tuff', 64], [6, 'tuff', 64], [7, 'tuff', 64]]
  const sim = far(stacks, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.transfer = n => { if (n === 2) sim.fight(9000); return 'ok' }
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.events.filter(event => event.combat).length, 0)
  assert.equal(sim.stored(sim.shared.playerBase, 'tuff'), 256)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(runtime.base.status().banked, 37 + 5 + 256)
  assert.equal(sim.server.requests.length, 6, 'six stacks, six transfers')
})

test('S8 a death on the way: the old trip is not continued, and the work starts again without a chest being opened', async () => {
  const sim = far()
  const runtime = sim.mount()
  sim.later(10000, () => sim.die({ x: 300.5, y: GROUND, z: 0.5 }))
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /接続・次元・生存回が変わったため/).length, 1)
  assert.equal(sim.events.filter(event => event.kind === 'open').length, 0)
  assert.equal(sim.trips, 1, 'no second trip for a cargo that is gone')
  assert.equal(runtime.base.status().banked, 0)
  assert.equal(sim.agent.starts.length, 1)
})

test('S8 a reconnection in the middle of the deposit: the answer of the old connection is not used, the rest is banked once', async () => {
  const stacks = [...KIT, [2, 'diamond', 40], [3, 'emerald', 5], [4, 'tuff', 64], [5, 'tuff', 64]]
  const sim = far(stacks, { x: 40.5, y: GROUND, z: 0.5 })
  sim.server.transfer = n => { if (n === 2) sim.later(100, () => sim.reconnect()); return 'ok' }
  const runtime = sim.mount()
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(sim.shared.playerBase, 'tuff'), 128)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(sim.held('tuff'), 0)
  assert.equal(ids(sim).size, 1)
})

test('S8 in another dimension the goal is held at once, and goes on back in the overworld', async () => {
  const sim = far()
  sim.state.dimension = 'nether'
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 60000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'BASE_IN_OTHER_DIMENSION', sim.log.join('\n'))
  assert.equal(sim.events.length, 0)
  sim.state.dimension = 'overworld'
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S9 a hot reload on the way: the new runtime takes the same goal over, the old one changes nothing', async () => {
  const sim = far()
  const old = sim.mount()
  let next = null
  sim.later(10000, () => { old.dispose(); next = sim.mount() })
  await sim.run(old, { until: () => next !== null, ms: 60000 })
  const before = sim.agent.starts.length
  assert.equal(await sim.run(next, { until: done }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /を引き継ぎました/).length, 1)
  assert.equal(ids(sim).size, 1)
  assert.equal(sim.agent.starts.length, before + 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
  assert.equal(await old.base.tick(), null, 'the old runtime is finished')
})

test('S9 a restart on the way: the goal is read back from the file, with its failures', async () => {
  const { loadReturnSync } = require('../src/modes/return/return-goal')
  const sim = far()
  sim.travel.zones.push({ x1: 79, x2: 81, z1: -1, z2: 2, code: 'CHUNK_TRAVEL_DANGER_ZONE' })
  const old = sim.mount()
  let killed = false
  sim.later(34000, () => { old.dispose(); killed = true })
  await sim.run(old, { until: () => killed, ms: 120000 })
  const saved = loadReturnSync('player-return.json', { io: { readFileSync: () => JSON.stringify(sim.files['player-return.json']) } })
  assert.ok(saved.goal && saved.failures.entries.length >= 1, JSON.stringify(sim.files['player-return.json']))
  assert.equal(saved.goal.stage, 'observe', 'the stage is observed again, not trusted')
  // A new process: nothing but the file.
  sim.shared.playerReturn = saved.goal; sim.shared.playerReturnFailures = saved.failures
  sim.travel.zones.length = 0; sim.travel.busy = false
  sim.agent.running = true // the restarted process plays on (player-resume.js)
  const next = sim.mount()
  assert.equal(await sim.run(next, { until: done }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /を引き継ぎました/).length, 1)
  assert.equal(ids(sim).size, 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S9 a save that fails is said once and the goal goes on; a goal restored for a player who stopped is dropped', async () => {
  const sim = far()
  sim.writeFails = true
  const old = sim.mount()
  let saved = null, killed = false
  sim.later(8000, () => { saved = sim.goal(old)?.saved; old.dispose(); sim.shared.playerWanted = false; killed = true })
  await sim.run(old, { until: () => killed, ms: 60000 })
  assert.equal(lines(sim, /帰還の記録を保存できません/).length, 1, sim.log.join('\n'))
  assert.equal(saved, false)
  assert.ok(sim.shared.playerReturn, 'kept in shared for the next runtime')
  const events = sim.events.length, starts = sim.agent.starts.length
  const next = sim.mount()
  await sim.run(next, { ms: 60000 })
  assert.equal(sim.goal(next), null)
  assert.equal(sim.events.length, events)
  assert.equal(sim.agent.starts.length, starts, 'nothing is started for a player who stopped')
})

test('S10 a manual stop on the way: the goal is cancelled, the step that ends later changes nothing and starts nothing', async () => {
  const sim = far()
  const runtime = sim.mount()
  let stoppedAt = null
  sim.later(10000, () => { sim.shared.playerWanted = false; runtime.base.cancel('MANUAL_STOP'); stoppedAt = sim.clock })
  await sim.run(runtime, { ms: 120000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.events.filter(event => event.at > stoppedAt).length, 0, 'no operation after the stop')
  assert.equal(sim.agent.starts.length, 0, 'the work is not started again after a manual stop')
  assert.equal(sim.travel.busy, false, 'the trip of the cancelled goal was cancelled')
  assert.equal(lines(sim, /取り消しました（MANUAL_STOP/).length, 1)
})

test('S10 a stop during the deposit, and a change of mode: nothing more is sent', async () => {
  const stacks = [...KIT, [2, 'diamond', 40], [3, 'emerald', 5], [4, 'tuff', 64], [5, 'tuff', 64]]
  const sim = far(stacks, { x: 40.5, y: GROUND, z: 0.5 })
  let runtime = null
  sim.server.transfer = n => { if (n === 2) { sim.shared.playerWanted = false; runtime.base.cancel('MANUAL_STOP') } return 'ok' }
  runtime = sim.mount()
  await sim.run(runtime, { ms: 120000 })
  assert.equal(sim.server.requests.length, 2)
  assert.equal(sim.agent.starts.length, 0)
  const other = far()
  const second = other.mount()
  other.later(10000, () => { other.mode = 'quarry' })
  await other.run(second, { ms: 120000 })
  assert.equal(lines(other, /取り消しました（MODE_CHANGED/).length, 1, other.log.join('\n'))
  assert.equal(other.agent.starts.length, 0)
})

test('S11 the same failure is tried three times, then held; it is tried again when the place changes', async () => {
  const sim = far(CARGO, { x: 40.5, y: GROUND, z: 0.5 })
  wall(sim)
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 900000 })
  const walks = sim.events.length, tried = failures(sim).length
  await sim.run(runtime, { ms: 300000 })
  assert.equal(sim.events.length, walks, 'held: nothing is tried while nothing changed')
  assert.equal(failures(sim).length, tried)
  assert.equal(sim.agent.running, true, 'the work goes on meanwhile')
  // A way in opens and the work carries the Bot somewhere else.
  for (let y = GROUND; y < GROUND + 3; y++) sim.setBlock(12, y, 0, 'minecraft:air', { passable: true })
  Object.assign(sim.body, { x: 80.5, y: GROUND, z: 0.5 })
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(ids(sim).size, 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S12 a trip that never gets closer: detours, a hold, a few re-evaluations, then given up; the work is never stalled', async () => {
  const sim = far()
  sim.fail.travel = 'stall'
  const runtime = sim.mount()
  let heldSeen = 0, activeWhileHeld = 0
  await sim.run(runtime, { until: () => { if (sim.goal(runtime)?.state === 'held') { heldSeen++; if (runtime.base.status().active) activeWhileHeld++ } return lines(sim, /をあきらめます/).length > 0 }, ms: 6 * 3600000 })
  assert.equal(lines(sim, /をあきらめます/).length, 1, sim.log.filter(line => /保留|再開|あきらめ|回り道/.test(line)).join('\n'))
  assert.ok(lines(sim, /回り道をします/).length >= 2)
  assert.ok(heldSeen > 0 && activeWhileHeld === 0)
  assert.ok(sim.trips <= 40, `${sim.trips} trips`)
  assert.equal(sim.agent.running, true, 'the work goes on after the goal is given up')
  // A new goal for the same base starts with the remembered failures: it does not get three fresh tries.
  const trips = sim.trips
  await sim.run(runtime, { until: () => sim.goal(runtime)?.state === 'held', ms: 3600000 })
  assert.ok(sim.trips - trips <= 3, `${sim.trips - trips} trips for the new goal`)
})

test('S12 an owner that never lets go: the goal is held after five minutes, starts nothing, and goes on when the controls are free (live 2026-11-18 05:49-06:07 JST)', async () => {
  const sim = far()
  const runtime = sim.mount()
  // Another job takes the controls on the way and does not end.
  sim.later(12000, () => { runtime.jobs.other = 'ほかの作業' })
  const starts = () => sim.agent.starts.length
  let activeWhileHeld = 0, before = null
  assert.equal(await sim.run(runtime, { until: () => { if (sim.goal(runtime)?.state === 'held') { before ??= { starts: starts(), trips: sim.trips }; if (runtime.base.status().active) activeWhileHeld++ } return lines(sim, /OWNER_NOT_RELEASED/).length > 0 && sim.clock > 12000 + 9 * 60000 }, ms: 3600000 }), null, sim.log.join('\n'))
  assert.equal(lines(sim, /中断して待ちます（ほかの作業）/).length, 1, sim.log.join('\n'))
  assert.equal(lines(sim, /を保留します: ほかの作業が 5 分たっても終わりません（OWNER_NOT_RELEASED・再評価の条件 owner_free/).length, 1, sim.log.join('\n'))
  assert.equal(activeWhileHeld, 0, 'a held goal does not keep the other jobs waiting')
  assert.equal(starts(), before.starts, 'the goal starts nothing while another owner has the controls')
  assert.equal(sim.trips, before.trips, 'no trip while held')
  assert.equal(failures(sim).length, 0, 'waiting for an owner is not a failure')
  assert.equal(ids(sim).size, 1)
  // The owner ends: the same goal wakes and banks.
  runtime.jobs.other = null
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /を再開します（OWNER_FREE/).length, 1, sim.log.join('\n'))
  assert.equal(ids(sim).size, 1, 'one goal from the decision to the end')
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S13 a hostile that only stands nearby delays the start for a minute, not for good; one that appears on the way does not stop the trip', async () => {
  const sim = far()
  sim.hostileNear = true
  const runtime = sim.mount()
  await sim.run(runtime, { ms: 50000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.agent.stops.length, 0, 'the work is not stopped while the start waits')
  assert.equal(await sim.run(runtime, { until: done }), true, sim.log.join('\n'))
  assert.equal(lines(sim, /戦闘にならないため、帰還を始めます/).length, 1)
  assert.equal(sim.stored(sim.shared.playerBase, 'diamond'), 37)
})

test('S13 a cell under a low ceiling is not a place to stand beside the chest', () => {
  const { standsBeside } = require('../src/modes/return/return-steps')
  const sim = createReturnSim()
  const chest = sim.placeChest(5, GROUND, 0)
  sim.setBlock(6, GROUND + 1, 0, 'minecraft:stone') // one block high: a body does not fit
  sim.unknown.add('-1,0'); sim.unknown.add('-1,-1') // x < 0 is not received
  const stands = standsBeside(sim.getBlock, chest)
  assert.ok(stands.length > 0)
  assert.ok(!stands.some(stand => Math.floor(stand.x) === 6 && Math.floor(stand.z) === 0))
  assert.deepEqual(standsBeside(sim.getBlock, { x: -3, y: GROUND, z: 0 }), [], 'unreceived cells are not ground')
})

test('S14 the storage chest still gets a count from store(), and the quarry mode makes no goal', async () => {
  const sim = createReturnSim({ feet: { x: 6.5, y: GROUND, z: 1.5 }, items: CARGO })
  const chest = sim.placeChest(5, GROUND, 0)
  const runtime = sim.mount()
  assert.equal(await runtime.storagePorts.store(chest, [{ slot: 3, name: 'minecraft:emerald', count: 5 }]), 5)
  assert.equal(sim.stored(chest, 'emerald'), 5)
  assert.equal(runtime.storagePorts.room(chest), 26)
  sim.shared.playerBase = chest
  sim.mode = 'quarry'
  sim.agent.running = true
  await sim.run(runtime, { ms: 60000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.agent.stops.length, 0)
  assert.equal(sim.held('diamond'), 40)
})
