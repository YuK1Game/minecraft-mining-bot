'use strict'
// The expedition keeps a long trip until it ends (src/modes/dragon-trip.js).
// Live 2026-11-18 20:30-20:35 JST: the food step started a trip and returned; its
// next two-second step hunted between two legs of that trip, and each refused the other.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { expeditionTrip } = require('../src/modes/dragon-trip')
const { createLongTravel } = require('../src/travel/long-travel')
const { createDragonExpedition } = require('../src/modes/dragon-expedition')
const { createDragonState } = require('../src/modes/dragon-state')
const { provisionFood } = require('../src/modes/dragon-early-food')

const tickOf = () => new Promise(resolve => setImmediate(resolve))

// A trip that stays busy until the test ends it.
function fakeTrip ({ id = 'trip-1', remaining = 100 } = {}) {
  const trip = { busy: false, operationId: null, remaining: null }
  const calls = []
  return {
    trip, calls,
    start: async () => { calls.push('start'); Object.assign(trip, { busy: true, operationId: id, remaining }); return { ...trip } },
    status: () => ({ ...trip }),
    cancel: async () => { calls.push('cancel'); trip.busy = false }
  }
}

test('the step waits until its own trip has ended', async () => {
  const f = fakeTrip()
  let done = false
  const waiting = expeditionTrip({ ...f, sleep: tickOf }).then(result => { done = true; return result })
  for (let i = 0; i < 20; i++) await tickOf()
  assert.equal(done, false, 'still waiting while the trip is walking')
  f.trip.busy = false
  const result = await waiting
  assert.equal(result.ended, 'finished')
  assert.deepEqual(f.calls, ['start'], 'a trip that ended by itself is not cancelled')
})

test('a cancelled step cancels its trip once', async () => {
  const f = fakeTrip()
  let cancelled = false
  const waiting = expeditionTrip({ ...f, cancelled: () => cancelled, sleep: tickOf })
  for (let i = 0; i < 5; i++) await tickOf()
  cancelled = true
  assert.equal((await waiting).ended, 'cancelled')
  assert.deepEqual(f.calls, ['start', 'cancel'])
})

test('a trip nobody is watching is cancelled before the new one starts', async () => {
  const f = fakeTrip()
  Object.assign(f.trip, { busy: true, operationId: 'left-over' })
  const waiting = expeditionTrip({ ...f, sleep: tickOf })
  for (let i = 0; i < 5; i++) await tickOf()
  assert.deepEqual(f.calls, ['cancel', 'start'])
  f.trip.busy = false
  await waiting
})

test('a trip that comes no closer for the stall time is cancelled; progress and the night pit keep it', async () => {
  const f = fakeTrip({ remaining: 200 })
  const logs = []
  let clock = 0, resting = false
  const waiting = expeditionTrip({ ...f, resting: () => resting, log: m => logs.push(m), now: () => clock, sleep: async () => { clock += 1000; await tickOf() }, stallMs: 240000 })
  const run = async ms => { const until = clock + ms; while (clock < until && f.trip.busy) await tickOf() }
  await run(200000)
  f.trip.remaining = 150 // 50 m closer: the stall time starts again.
  await run(200000)
  assert.equal(f.trip.busy, true, 'still walking 400 s after the start')
  resting = true
  await run(600000)
  assert.equal(f.trip.busy, true, 'the night in the pit is not a stall')
  resting = false
  f.trip.remaining = 147 // Less than 8 m closer does not count.
  const result = await waiting
  assert.equal(result.ended, 'stalled')
  assert.deepEqual(f.calls, ['start', 'cancel'])
  assert.ok(logs.some(m => /4 分進まない/.test(m) && /残り 147m/.test(m)), logs.join('\n'))
})

test('the trip ends when what it was looking for comes into view', async () => {
  const f = fakeTrip()
  let seen = false
  const logs = []
  const waiting = expeditionTrip({ ...f, until: () => seen, log: m => logs.push(m), sleep: tickOf })
  for (let i = 0; i < 5; i++) await tickOf()
  assert.equal(f.trip.busy, true)
  seen = true
  assert.equal((await waiting).ended, 'found')
  assert.deepEqual(f.calls, ['start', 'cancel'])
  assert.ok(logs.some(m => /見つかった/.test(m)))
})

test('a newer trip of another owner is left alone', async () => {
  const f = fakeTrip()
  let cancelled = false
  const waiting = expeditionTrip({ ...f, cancelled: () => cancelled, sleep: tickOf })
  for (let i = 0; i < 5; i++) await tickOf()
  f.trip.operationId = 'someone-else' // The first ended and another owner started its own.
  cancelled = true
  assert.equal((await waiting).ended, 'finished')
  assert.deepEqual(f.calls, ['start'])
})

// The real scheduler, the real food step and the real long travel together.
// Legs take a while and leave a gap between them, as on the Realm; a sheep comes
// into view after the second leg.
function world (t, { own }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-trip-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const raw = { profile: 'bot', realm: { id: 'test' }, connectionId: 'a', startedAt: 't', dimension: 'overworld', health: 20, phase: 'spawned',
    lifecycle: { deathId: 0 }, position: { x: 100.5, y: 65.62, z: 100.5 }, inventory: { known: true, items: [] } }
  const shared = { playerHouse: { origin: { x: 0, y: 64, z: 0 }, done: true } }
  const events = []
  let leg = null, legs = 0, hunting = false, sheep = false
  const chunkTravel = {
    async start ({ area }) {
      if (hunting) { events.push('leg refused: hunting'); leg = null; return { phase: 'failed', busy: false, error: { code: 'CHUNK_TRAVEL_BUSY' } } }
      legs++
      leg = { area, ends: Date.now() + 12 }
      return { phase: 'moving', busy: true }
    },
    status () {
      if (!leg) return { phase: 'idle', busy: false }
      if (Date.now() < leg.ends) return { phase: 'moving', busy: true }
      raw.position = { x: leg.area.x1 * 16 + 8, y: 65.62, z: leg.area.z1 * 16 + 8 }
      leg = null
      if (legs >= 2) sheep = true
      return { phase: 'arrived', serverConfirmed: true, busy: false }
    },
    cancel: async () => { leg = null }
  }
  const moving = () => !!leg && Date.now() < leg.ends
  // A pause between two legs, as the real trip has (terrain requests, planning).
  const travel = createLongTravel({ getState: () => raw, chunkTravel, log: () => {}, save: async () => {}, damagePauseMs: 0, pollMs: 2, stopWhenBlocked: true,
    // The gap is several scheduler ticks long, so that a tick always falls inside it (Windows timers are ~15 ms coarse:
    // with an 8 ms gap every tick could land on a walking leg, and the hunt then started only after the trip).
    beforeLeg: () => new Promise(resolve => setTimeout(resolve, 60)) })
  const quarry = { travelStatus: () => travel.status(), cancelTravel: () => travel.cancel('MANUAL_STOP') }
  const foraging = {
    preview: () => sheep ? { ready: true } : { ready: false, code: 'NO_KNOWN_FOOD_SOURCE' },
    stop: () => {},
    async execute () {
      events.push(travel.status().busy ? 'hunt during the trip' : 'hunt')
      hunting = true
      await new Promise(resolve => setTimeout(resolve, 10))
      hunting = false
      raw.inventory = { known: true, items: [{ name: 'minecraft:bread', count: 32, slot: 0 }] }
    }
  }
  const state = createDragonState({ root, shared, getState: () => raw })
  const job = createDragonExpedition({ state, raw: () => raw, active: () => true, legacyNeeded: () => false, legacyIdle: () => true, stopLegacy: () => {},
    // As mode-runtime.js: a walking leg holds the expedition; the gap between two legs does not.
    legacyBusy: () => moving(),
    lifeKey: () => 'life',
    run: async (record, signal) => {
      const cancelled = () => signal.aborted
      const start = input => Promise.resolve(travel.start({ destination: input.destination }))
      const ctx = { cancelled, signal, shared, memory: record, runtime: { raw: () => raw, inventory: () => raw.inventory },
        getFeet: () => ({ x: raw.position.x, y: raw.position.y - 1.62, z: raw.position.z }), getBlock: () => ({ known: false }),
        operations: { foraging, quarry, perception: { entities: () => [] } },
        travelTo: own
          ? (input, options = {}) => expeditionTrip({ start: () => start(input), status: quarry.travelStatus, cancel: quarry.cancelTravel, cancelled, until: options.until, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))) })
          : start }
      return provisionFood(ctx, 32)
    } })
  const play = async () => {
    const until = Date.now() + 4000
    while (Date.now() < until && !events.some(event => /^hunt/.test(event))) { job.tick(); await new Promise(resolve => setTimeout(resolve, 3)) }
    await job.settled()
    for (let i = 0; i < 20 && (travel.status().busy || job.busy()); i++) { job.tick(); await new Promise(resolve => setTimeout(resolve, 5)) }
    try { await travel.cancel() } catch {}
  }
  return { events, play, travel, count: () => legs }
}

test('before: a trip started and left running is still walking when the next step hunts', async t => {
  const f = world(t, { own: false })
  await f.play()
  assert.ok(f.events.includes('hunt during the trip'), f.events.join(', '))
})

test('the food step keeps its search trip: the hunt starts only after the trip has ended', async t => {
  const f = world(t, { own: true })
  await f.play()
  assert.deepEqual(f.events, ['hunt'], f.events.join(', '))
  assert.equal(f.travel.status().busy, false)
  assert.ok(f.count() >= 2, 'the sheep came into view on the way; the trip ended there')
})

// What a trip tells the goal of the expedition (goal/goal-ledger.js), with the real ledger.
function ledgerGoal () {
  const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
  const clock = { at: 1e9 }
  const shared = {}
  const ledger = createGoalLedger({ shared, now: () => clock.at })
  ledger.open('early.home_reserve')
  ledger.look({ value: 0, scope: 'a/0' })
  return { clock, ledger, goal: { step: key => ledger.step(key), mark: (key, value, by) => ledger.mark(key, value, by), fail: (failure, options) => ledger.fail(failure, options), spent: failure => ledger.spent(failure) }, g: () => shared.dragonGoal }
}

test('closer to the destination than ever is a mark of the goal and the arrival a step; a trip to and fro is neither', async () => {
  const f = fakeTrip({ remaining: 200 }), l = ledgerGoal()
  const waiting = expeditionTrip({ ...f, sleep: tickOf, goal: l.goal, destination: { x: 300, z: 40 }, getFeet: () => ({ x: 100, y: 70, z: 40 }) })
  for (let i = 0; i < 5; i++) await tickOf()
  const first = l.g().progressAt
  for (const [left, moved] of [[190, false], [183, true], [200, false], [170, false], [150, true]]) {
    l.clock.at += 1000
    f.trip.remaining = left
    for (let i = 0; i < 5; i++) await tickOf()
    assert.equal(l.g().progressAt === l.clock.at, moved, `remaining ${left}`)
  }
  assert.ok(l.g().progressAt > first)
  l.clock.at += 1000
  Object.assign(f.trip, { busy: false, phase: 'arrived', remaining: 12 })
  assert.equal((await waiting).ended, 'finished')
  assert.deepEqual(l.g().steps, ['arrived:18,2'])
  assert.equal(l.g().progressAt, l.clock.at)
})

test('B5: a trip that ended short three times from one place is not started from there again; from another place it is', async () => {
  const l = ledgerGoal()
  let feet = { x: 100, y: 70, z: 40 }, starts = 0
  const logs = []
  const once = () => {
    const f = fakeTrip()
    return expeditionTrip({ ...f, start: async () => { starts++; return {} }, sleep: tickOf, goal: l.goal, destination: { x: 300, z: 40 }, getFeet: () => feet, log: line => logs.push(line) })
  }
  // Refused at once and asked again every two seconds: one failure a minute at most.
  for (let i = 0; i < 10; i++) { await once(); l.clock.at += 2000 }
  assert.equal(starts, 10)
  assert.equal(l.ledger.spent({ stage: 'trip', target: '18,2', code: 'TRIP_FAILED', state: { from: '6,2' } }), false)
  l.clock.at += 60000; await once()
  l.clock.at += 60000; await once()
  assert.equal(starts, 12)
  assert.match(logs.at(-1), /300, 40 への長距離移動は、この場所から 3 回とも着かなかったため、場所が変わるまで始めません/)
  // The same step, planned again and again: nothing is started.
  for (let i = 0; i < 5; i++) { l.clock.at += 2000; assert.equal((await once()).ended, 'spent') }
  assert.equal(starts, 12)
  // Another place (another 16-block cell): the way from there is another way.
  feet = { x: 130, y: 70, z: 40 }
  assert.notEqual((await once()).ended, 'spent')
  assert.equal(starts, 13)
})

test('a trip the step cancelled, or one that found what it looked for, is no failure of the way', async () => {
  const l = ledgerGoal()
  for (const options of [{ cancelled: () => true }, { until: () => true }]) {
    for (let i = 0; i < 4; i++) {
      const f = fakeTrip()
      await expeditionTrip({ ...f, ...options, sleep: tickOf, goal: l.goal, destination: { x: 300, z: 40 }, getFeet: () => ({ x: 100, y: 70, z: 40 }) })
      l.clock.at += 61000
    }
  }
  assert.equal(l.ledger.spent({ stage: 'trip', target: '18,2', code: 'TRIP_FAILED', state: { from: '6,2' } }), false)
})
