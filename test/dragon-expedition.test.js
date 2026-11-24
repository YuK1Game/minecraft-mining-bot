'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createDragonExpedition } = require('../src/modes/dragon-expedition')
const { createDragonState } = require('../src/modes/dragon-state')
const { playerStages } = require('../src/modes/player-stages')

function fixture (t, action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-expedition-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const raw = { profile: 'bot', realm: { id: 'test' }, connectionId: 'a', startedAt: 't', dimension: 'overworld',
    health: 20, phase: 'spawned', lifecycle: { deathId: 0 }, inventory: { known: true, items: [] } }
  const shared = {}, calls = [], state = createDragonState({ root, shared, getState: () => raw })
  const controls = { legacy: false, idle: true, crew: false, loading: false, finished: false }
  const job = createDragonExpedition({ state, raw: () => raw, active: () => !controls.finished,
    legacyNeeded: () => controls.legacy, legacyBusy: () => controls.crew, legacyIdle: () => controls.idle,
    stopLegacy: (reason, why) => { calls.push('stop'); controls.why = why; controls.idle = true }, finish: () => { controls.finished = true },
    lifeKey: () => [raw.connectionId, raw.dimension, raw.lifecycle.deathId].join('/'), loading: () => controls.loading,
    run: async (...args) => { calls.push('run'); return action(...args) } })
  const tick = async () => { job.tick(); await job.settled() }
  return { state, controls, calls, tick, job, raw }
}

test('the ordinary crew drains before the expedition acts and only confirmed steps advance the durable stage', async t => {
  const f = fixture(t, async record => { record.stage = 'nether'; return { reason: 'ネザー偵察' } })
  f.controls.crew = true
  await f.tick()
  f.controls.crew = false; f.controls.idle = false
  await f.tick()
  assert.deepEqual(f.calls, ['stop'])
  await f.tick()
  assert.equal(f.state.record().stage, 'nether')
  assert.equal(f.job.status().reason, 'ネザー偵察')
})

test('network or user cancellation cannot commit a delayed successful step', async t => {
  let begin, release
  const started = new Promise(resolve => { begin = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const f = fixture(t, async record => { begin(); await hold; record.stage = 'complete'; return { reason: 'stale' } })
  f.job.tick(); await started
  f.job.tick()
  f.raw.dimension = 'end'; f.job.guard()
  release(); await f.job.settled()
  assert.equal(f.state.record().stage, 'early')
  assert.equal(f.controls.finished, false)
  assert.deepEqual(f.calls, ['run', 'stop'])
})

test('transfer, death, and uncertain inventory pause actions; a last-life receipt routes to equipment recovery', async t => {
  const f = fixture(t, async () => ({ reason: '復旧' }))
  f.controls.loading = true; await f.tick()
  f.controls.loading = false; f.raw.inventory.uncertain = true; await f.tick()
  f.raw.inventory.uncertain = false; f.raw.health = 0; f.raw.lifecycle.deathId++; await f.tick()
  assert.equal(f.calls.length, 0)
  f.raw.health = 20; f.controls.legacy = true
  assert.equal(f.job.owns(), true)
  await f.tick()
  assert.equal(f.state.record().recovery.dimension, 'overworld')
  assert.deepEqual(f.calls, ['run'])
})

test('finding borrowed late-game equipment cannot complete a dimension or the fight', () => {
  const inventory = { known: true, items: ['elytra', 'blaze_rod', 'dragon_egg'].map(name => ({ name, count: 1 })) }
  const stages = playerStages(inventory).stages
  assert.ok(stages.every(s => !s.reached))
})

test('a worker resolving between timer ticks cannot complete after losing loading, inventory, or living scope', async t => {
  for (const [name, invalidate] of [
    ['loading', f => { f.controls.loading = true }],
    ['inventory', f => { f.raw.inventory.uncertain = true }],
    ['damage', f => { f.raw.health = 8 }],
    ['dimension', f => { f.raw.dimension = 'end' }],
    ['death signal', f => { f.raw.isDead = true }]
  ]) {
    await t.test(name, async t => {
      let started, release
      const begin = new Promise(resolve => { started = resolve })
      const hold = new Promise(resolve => { release = resolve })
      const f = fixture(t, async record => { started(); await hold; record.stage = 'complete' })
      f.job.tick(); await begin
      invalidate(f)
      release(); await f.job.settled()
      assert.deepEqual(f.calls, ['run', 'stop'])
      assert.equal(f.controls.finished, false)
      assert.equal(f.state.record().stage, 'early')
    })
  }
})

test('stopping during a confirmed checkpoint write does not finish or re-enable the stopped player', async t => {
  let started, release
  const begin = new Promise(resolve => { started = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const f = fixture(t, async record => { record.stage = 'complete'; return { reason: '完了' } })
  const save = f.state.save
  f.state.save = async record => { const result = await save(record); started(); await hold; return result }
  f.job.tick(); await begin
  f.job.cancel()
  release(); await f.job.settled()
  assert.equal(f.controls.finished, false)
  assert.equal(f.job.status(), null)
})

test('a hit alone tells the stop that nothing else changed, so a running fight is kept', async t => {
  let begin, release
  const started = new Promise(resolve => { begin = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const f = fixture(t, async () => { begin(); await hold; return { reason: 'x' } })
  f.job.tick(); await started
  f.raw.health = 11; f.job.guard()
  assert.deepEqual(f.controls.why, { hurtOnly: true })
  release(); await f.job.settled()
})

test('a life or dimension change is not reported as a hit alone', async t => {
  let begin, release
  const started = new Promise(resolve => { begin = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const f = fixture(t, async () => { begin(); await hold; return { reason: 'x' } })
  f.job.tick(); await started
  f.raw.health = 11; f.raw.dimension = 'end'; f.job.guard()
  assert.deepEqual(f.controls.why, { hurtOnly: false })
  release(); await f.job.settled()
})

test('onStepDone fires after a working step and not after a waiting or failed step', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-expedition-fast-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const raw = { profile: 'bot', realm: { id: 'test' }, connectionId: 'a', startedAt: 't', dimension: 'overworld',
    health: 20, phase: 'spawned', lifecycle: { deathId: 0 }, inventory: { known: true, items: [] } }
  const state = createDragonState({ root, shared: {}, getState: () => raw })
  const doneEvents = []
  let nextResult = { phase: 'working', reason: '採掘を進めます' }
  const job = createDragonExpedition({
    state, raw: () => raw, active: () => true,
    legacyNeeded: () => false, legacyBusy: () => false, legacyIdle: () => true,
    stopLegacy: () => {}, finish: () => {},
    lifeKey: () => 'a/overworld/0', loading: () => false,
    onStepDone: info => doneEvents.push(info),
    run: async () => nextResult
  })
  job.tick(); await job.settled()
  assert.equal(doneEvents.length, 1)
  assert.equal(doneEvents[0].phase, 'working')
  nextResult = { phase: 'waiting', reason: '待機', wait: { code: 'OWNER' } }
  job.tick(); await job.settled()
  assert.equal(doneEvents.length, 1, 'waiting step must not trigger fast continuation')
  nextResult = { phase: 'working', reason: '失敗', result: { status: 'failed', code: 'X' } }
  job.tick(); await job.settled()
  assert.equal(doneEvents.length, 1, 'failed outcome must not trigger fast continuation')
})
