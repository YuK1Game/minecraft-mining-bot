'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createDashboardControl, quarryConfig } = require('../src/dashboard-control')
const state = () => ({ profile: 'bot', realm: { id: '42', name: 'Test Realm' }, dimension: 'overworld', connectionId: 'one', startedAt: '2026-11-07T00:00:00Z', lifecycle: { deathId: 0 }, phase: 'spawned', loadingScreenEnded: true, health: 20, inventory: { known: true }, position: { x: -16.01, y: 65.62, z: -0.01 } })
function fixture () {
  const s = state(), calls = []; let config = null, job = null, now = 1000, generation = 1
  const q = { status: () => job && { ...job }, document: () => config && { config },
    plan: c => { calls.push(['plan', c]); config = c; job = { jobId: 'quarry_test', state: 'IDLE' }; return { ...job, ready: true, chunks: [{ x: c.target.rect.x1, z: c.target.rect.z1 }], yTop: 64, yBottom: -64, issues: [], warnings: [] } },
    start: () => { calls.push(['start']); job.state = 'MINE' },
    pause: async () => { calls.push(['pause']); if (job) job.state = 'PAUSED' },
    emergencyStop: async () => { calls.push(['emergencyStop']); if (job) job.state = 'PAUSED' },
    cancel: async () => { calls.push(['cancel']); if (job) job.state = 'FINISHED' },
    resume: () => { calls.push(['resume']); job.state = 'MINE' } }
  const control = createDashboardControl({ getState: () => s, getQuarry: () => q, getGeneration: () => generation, now: () => now, disconnect: () => calls.push(['disconnect']) })
  const request = extra => ({ session: control.snapshot().session, ...extra })
  const plan = () => control.execute(request({ command: 'plan', config: { x1: -2, z1: -1 } }))
  return { s, calls, q, control, request, plan, editConfig: () => { config.yBottom = 10 }, advance: () => { now += 120001 }, reload: () => { generation++ } }
}
test('dashboard-control: status is passive, bounded and uses floor for negative chunk coordinates', () => {
  const f = fixture(); f.s.auth = { token: 'private-secret' }
  assert.deepEqual(f.control.snapshot().chunk, { x: -2, z: -1 })
  assert.equal(f.calls.length, 0)
  assert.ok(!JSON.stringify(f.control.snapshot()).includes('private-secret'))
})
test('dashboard-control: only explicit plan then confirmed start can start work; token is single use', async () => {
  const f = fixture(), planned = await f.plan()
  assert.deepEqual(f.calls.map(c => c[0]), ['plan'])
  await f.control.execute(f.request({ command: 'start', planToken: planned.planToken }))
  await assert.rejects(f.control.execute(f.request({ command: 'start', planToken: planned.planToken })), /計画/)
  assert.equal(f.calls.filter(c => c[0] === 'start').length, 1)
})
for (const variant of ['realm', 'connection', 'dimension', 'death', 'config', 'expiry', 'reload']) test(`dashboard-control: ${variant} change invalidates start confirmation`, async () => {
  const f = fixture(), p = await f.plan(), session = f.control.snapshot().session
  if (variant === 'realm') f.s.realm.id = '99'
  if (variant === 'connection') f.s.connectionId = 'two'
  if (variant === 'dimension') f.s.dimension = 'nether'
  if (variant === 'death') f.s.lifecycle.deathId++
  if (variant === 'config') f.editConfig()
  if (variant === 'expiry') f.advance()
  if (variant === 'reload') f.reload()
  await assert.rejects(f.control.execute({ command: 'start', session, planToken: p.planToken }))
  assert.ok(!f.calls.some(c => c[0] === 'start'))
})
test('dashboard-control: active or paused jobs cannot be silently replaced', async () => {
  const f = fixture(), p = await f.plan()
  await f.control.execute(f.request({ command: 'start', planToken: p.planToken }))
  await assert.rejects(f.plan(), /既存/)
  await f.control.execute(f.request({ command: 'pause', jobId: p.plan.jobId }))
  await assert.rejects(f.plan(), /既存/)
  await f.control.execute(f.request({ command: 'resume', jobId: p.plan.jobId }))
  await f.control.execute(f.request({ command: 'cancel', jobId: p.plan.jobId }))
  await f.plan()
})
test('dashboard-control: stale job stop and arbitrary commands are rejected', async () => {
  const f = fixture(); await f.plan()
  await assert.rejects(f.control.execute(f.request({ command: 'pause', jobId: 'different' })), /ジョブ/)
  await assert.rejects(f.control.execute(f.request({ command: 'action', group: 'mining' })))
  await assert.rejects(f.control.execute(f.request({ command: 'acceptExceptions' })))
})
test('dashboard-control: missing terrain/life/inventory readiness blocks plans', async () => {
  const f = fixture(); f.s.loadingScreenEnded = false
  await assert.rejects(f.plan(), /受信/)
  f.s.loadingScreenEnded = true; f.s.inventory.known = false
  await assert.rejects(f.plan(), /受信/)
  f.s.inventory.known = true; f.s.inventory.uncertain = true
  await assert.rejects(f.plan(), /受信/)
  f.s.inventory.uncertain = false; f.s.lifecycle.dead = true
  await assert.rejects(f.plan(), /受信/)
  assert.equal(f.calls.length, 0)
})
test('dashboard-control: failed plan cannot issue a start receipt', async () => {
  const f = fixture(), original = f.q.plan
  f.q.plan = config => ({ ...original(config), ready: false, issues: ['NO_STORAGE'] })
  const p = await f.plan()
  assert.equal(p.planToken, null); assert.deepEqual(p.plan.issues, ['NO_STORAGE'])
  await assert.rejects(f.control.execute(f.request({ command: 'start', planToken: null })))
})
test('dashboard-control: stop drains and denies new work while keeping emergency stop available', async () => {
  const f = fixture(), p = await f.plan()
  let resolve; const blocked = new Promise(r => { resolve = r })
  f.q.pause = () => blocked
  const pausing = f.control.execute(f.request({ command: 'pause', jobId: p.plan.jobId }))
  await assert.rejects(f.plan(), /前の操作/)
  await f.control.execute(f.request({ command: 'emergencyStop', jobId: p.plan.jobId }))
  await assert.rejects(f.plan(), /前の操作/)
  resolve(); await pausing
  assert.ok(f.calls.some(c => c[0] === 'emergencyStop'))
})
test('dashboard-control: disconnect waits for pause; failed save does not pretend success', async () => {
  const f = fixture(); await f.plan()
  f.q.pause = async () => { throw new Error('PERSISTENCE_FAILED') }
  await assert.rejects(f.control.execute(f.request({ command: 'disconnect', jobId: 'quarry_test' })), /PERSISTENCE/)
  await new Promise(setImmediate)
  assert.ok(!f.calls.some(c => c[0] === 'disconnect'))
})
test('dashboard-control: input bounds, optional heights, four inclusive chunks and shulker-only storage', () => {
  const s = state()
  const c = quarryConfig({ x1: -1, z1: -1, x2: 0, z2: 0, bottom: -60 }, s)
  assert.equal(c.inventory.depositWhen, 'full'); assert.equal(c.inventory.storage.length, 0)
  assert.throws(() => quarryConfig({ x1: 0, z1: 0, chest: { x: -3, y: 64, z: 3 } }, s), { code: 'SHULKER_ONLY_STORAGE' })
  assert.equal(c.quarryCombat.enabled, true); assert.equal(c.yTop, 'auto')
  for (const extra of [{ x2: 4 }, { x1: 0.2 }, { z1: '0' }, { x1: 1875000 }, { bottom: -65 }, { top: 1, bottom: 2 }, { permissions: {} }, { pickupMode: 'none' }, { chest: { x: 1, y: 2, z: 3, command: 'fill' } }]) {
    assert.throws(() => quarryConfig({ x1: 0, z1: 0, ...extra }, s))
  }
  assert.throws(() => quarryConfig({ x1: 0, z1: 0 }, { ...s, dimension: 'nether' }))
  assert.equal(quarryConfig({ x1: 0, z1: 0, pickupMode: 'active' }, s).inventory.depositWhen, 'capacity')
})
