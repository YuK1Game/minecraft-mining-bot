'use strict'

// The expedition's own watch for a goal that is not getting anywhere (指示書 B1〜B3), through the real
// runtime: the expedition, its saved record, the goal ledger and the watcher, over a virtual clock.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorld } = require('./helpers/dragon-goal-world')

const MIN = 60000
const WARN = /分進んでいません/, DECIDE = /決め直します/, HOLD = /保留します/, RELEASE = /保留を解いて/
const minutes = line => Number(/が (\d+) 分進んでいません/.exec(line)?.[1])

test('B1: health that goes down and up, and a walk between two places, are not progress: warned at 5 minutes, decided again 3 times, then held', async t => {
  let flips = 0
  const w = await createWorld(t, { step: async (ctx, w) => {
    // Every four minutes of work the Bot is hit or healed, and stands in the other of two places.
    const turn = Math.floor(w.at / (4 * MIN))
    if (turn !== flips) { flips = turn; w.raw.health = turn % 2 ? 19 : 20; w.raw.position = { x: turn % 2 ? 20.5 : 0.5, y: 70, z: 0.5 } }
    return { done: false, reason: 'iron_helmet を準備しています（0/2）。' }
  } })
  const started = w.at
  await w.pass(4 * MIN + 50000)
  assert.deepEqual(w.said(WARN), [], 'nothing before five minutes')
  await w.pass(20000)
  assert.equal(w.said(WARN).length, 1)
  assert.equal(minutes(w.said(WARN)[0]), 5)
  assert.match(w.said(WARN)[0], /目的 early\.home_reserve#1 .*iron_helmet を準備しています.*最後の成果 なし、最後の動き \d 分前、決め直し 0\/3/)
  assert.equal(w.shared.dragonStall.goal, 'early.home_reserve#1')
  await w.pass(35 * MIN)
  assert.equal(w.said(DECIDE).length, 3, 'one decision per ten minutes without progress')
  assert.deepEqual(w.said(DECIDE).map(line => /決め直し (\d)\/3/.exec(line)[1]), ['1', '2', '3'])
  assert.equal(w.said(HOLD).length, 1)
  assert.match(w.said(HOLD)[0], /NO_PROGRESS。見直し: 10 分後/)
  assert.equal(w.goal().hold.code, 'NO_PROGRESS')
  // Held: the step is not run, and nothing more is decided or said until the hold is looked at again.
  const calls = w.calls, lines = w.lines.length
  await w.pass(8 * MIN)
  assert.equal(w.calls, calls)
  assert.equal(w.lines.filter(line => /^遠征:/.test(line)).length, w.lines.slice(0, lines).filter(line => /^遠征:/.test(line)).length)
  assert.match(w.rt.status().reason, /進まない目的を保留しています/)
  // Its time is up: one decision is given back, and the next hold is longer. Never for good, never without a bound.
  await w.pass(2 * MIN + 20000)
  assert.equal(w.said(RELEASE).length, 1)
  assert.match(w.said(RELEASE)[0], /TIME/)
  assert.ok(w.calls > calls, 'the step runs again')
  await w.pass(128 * MIN)
  assert.equal(w.goal().startedAt, started, 'the same goal all along')
  assert.equal(w.goal().id, 'early.home_reserve#1')
  assert.equal(w.said(DECIDE).length, 6, 'three hours: 3 decisions, then one for each hold that was looked at again (10, 20, 40 minutes)')
  assert.equal(w.said(HOLD).length, 4)
  assert.match(w.said(HOLD).at(-1), /見直し: 60 分後/)
})

test('B2: a reload of the behaviour code every four minutes does not start the clock, the decisions or the hold again', async t => {
  const w = await createWorld(t)
  const started = w.at
  for (let i = 0; i < 11; i++) { await w.pass(4 * MIN); w.boot(w.shared) }
  // 44 minutes, 11 reloads.
  assert.equal(w.goal().id, 'early.home_reserve#1')
  assert.equal(w.goal().startedAt, started)
  assert.equal(minutes(w.said(WARN)[0]), 5)
  assert.equal(w.said(DECIDE).length, 3)
  assert.equal(w.said(HOLD).length, 1)
  assert.equal(w.goal().decisions, 3)
  assert.ok(w.goal().hold)
})

test('B3: a run that throws is an outcome, not a wait; the run after it that never returns is let go at the deadline', async t => {
  const w = await createWorld(t, { step: (ctx, w) => { if (w.calls === 1) throw Error('boom'); return w.never() } })
  await w.pass(10000)
  // Run 1 threw: shown as recovering with its code, and no wait is carried into the next run.
  assert.equal(w.rt.status().phase, 'recovering')
  assert.equal(w.rt.status().reason, 'boom')
  await w.pass(10000)
  assert.equal(w.calls, 2)
  const live = w.rt.runState()
  assert.equal(live.running, true)
  assert.equal(live.n, 2)
  assert.equal(live.wait, null, 'the run that hangs inherits no wait')
  await w.pass(5 * MIN)
  assert.equal(w.said(WARN).length, 1, 'counted as a stall from the start')
  assert.match(w.said(WARN)[0], /boom.*同じ1歩が \d+ 秒/)
  await w.pass(5 * MIN + 10000)
  assert.equal(w.said(DECIDE).length, 1)
  assert.match(w.said(DECIDE)[0], /step・決め直し 1\/3/)
  assert.equal(w.calls, 3, 'the step that never returned was let go and another one began')
  await w.pass(50 * MIN)
  assert.equal(w.said(DECIDE).length, 4)
  assert.ok(w.said(HOLD).length >= 1)
  assert.ok(w.calls <= 8, 'a bounded number of runs in an hour: ' + w.calls)
})

test('a run that throws tells its code to the next look', async t => {
  const w = await createWorld(t, { step: () => { throw Error('boom') } })
  await w.pass(6 * MIN)
  assert.match(w.said(WARN)[0], /boom・結果 failed\/STEP_THREW/)
})

test('a step that never returns is given up: the next tick starts a new one, and the old one cannot clear it', async () => {
  const { createDragonExpedition } = require('../src/modes/dragon-expedition')
  const record = { stage: 'early', early: {} }
  const raw = { phase: 'spawned', health: 20, dimension: 'overworld', inventory: { known: true, items: [] } }
  const stops = [], release = []
  let runs = 0
  const job = createDragonExpedition({ state: { observe: async () => {}, record: () => record, save: async () => true }, raw: () => raw, active: () => true,
    legacyNeeded: () => false, legacyBusy: () => false, legacyIdle: () => true, stopLegacy: reason => stops.push(reason),
    run: (r, signal) => { runs++; return new Promise(resolve => release.push(() => resolve({ reason: 'late ' + signal.aborted }))) } })
  assert.equal(job.tick(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 1)
  assert.equal(job.busy(), true)
  assert.equal(job.abandon('やめます'), true)
  assert.deepEqual(stops, ['やめます'])
  assert.equal(job.busy(), false)
  assert.equal(job.runState().outcome.code, 'STEP_ABANDONED')
  assert.equal(job.abandon('again'), false)
  assert.equal(job.tick(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 2)
  // The abandoned step answers at last: the new step stays the owner.
  release[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(job.busy(), true)
  assert.notEqual(job.status()?.reason, 'late true')
  release[1]()
  await job.settled()
  assert.equal(job.busy(), false)
  assert.equal(job.status().reason, 'late false')
})
