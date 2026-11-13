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
  assert.equal(c.allowCaves, true, "dashboard plans warn about caves instead of refusing them")
  assert.throws(() => quarryConfig({ x1: 0, z1: 0, chest: { x: -3, y: 64, z: 3 } }, s), { code: 'SHULKER_ONLY_STORAGE' })
  assert.equal(c.quarryCombat.enabled, true); assert.equal(c.yTop, 'auto')
  for (const extra of [{ x2: 4 }, { x1: 0.2 }, { z1: '0' }, { x1: 1875000 }, { bottom: -65 }, { top: 1, bottom: 2 }, { permissions: {} }, { pickupMode: 'none' }, { chest: { x: 1, y: 2, z: 3, command: 'fill' } }]) {
    assert.throws(() => quarryConfig({ x1: 0, z1: 0, ...extra }, s))
  }
  assert.throws(() => quarryConfig({ x1: 0, z1: 0 }, { ...s, dimension: 'nether' }))
  assert.equal(quarryConfig({ x1: 0, z1: 0, pickupMode: 'active' }, s).inventory.depositWhen, 'capacity')
})

function storageFixture () {
  const s = state(), calls = [], f = fixture()
  let value = { busy: false, phase: 'idle', operationId: null, serverConfirmed: false, target: null, transferredStacks: 0, remainingStacks: 41, error: null }
  const preview = { token: 'storage-confirmation', expiresAt: 121000, operationId: 'manual_deposit_1', position: { x: 2, y: 64, z: 3 }, slotCount: 54, resume: false,
    stacks: { main: 36, armor: 4, offhand: 1, total: 41 }, target: { position: { x: 2, y: 64, z: 3 }, realm: 'Test Realm', player: 'Bot', dimension: 'overworld' } }
  const storage = {
    status: () => structuredClone(value),
    prepare: async options => { calls.push(['prepare', options]); value = { ...value, phase: 'ready', operationId: preview.operationId }; return structuredClone(preview) },
    start: options => { calls.push(['storageStart', options]); value = { ...value, busy: true, phase: 'running' }; return storage.status() },
    cancel: () => { calls.push(['storageCancel']); value = { ...value, phase: 'paused' }; return storage.status() },
    drain: () => { throw new Error('The HTTP boundary must not wait for transfer completion') }
  }
  const reset = { status: () => ({ busy: false }), preview: async () => { calls.push(['resetPreview']); return {} }, start: () => { calls.push(['resetStart']); return {} }, cancel: () => { calls.push(['resetCancel']); return {} } }
  let currentStorage = storage, currentQuarry = f.q
  const control = createDashboardControl({ getState: () => s, getQuarry: () => currentQuarry, getStorage: () => currentStorage, getReset: () => reset, disconnect: () => calls.push(['disconnect']) })
  const request = extra => ({ session: control.snapshot().session, ...extra })
  return { s, calls, f, storage, reset, preview, control, request,
    setStatus: extra => { value = { ...value, ...extra } }, setStorage: next => { currentStorage = next }, noQuarry: () => { currentQuarry = null } }
}
test('dashboard-control: absent storage remains unavailable and manual calls never create a quarry job', async () => {
  const old = fixture()
  assert.equal(old.control.snapshot().storage.available, false)
  assert.equal(old.control.snapshot().storage.ready, false)
  await assert.rejects(old.control.execute(old.request({ command: 'storagePreview' })), { code: 'STORAGE_UNAVAILABLE' })
  assert.deepEqual(old.calls, [])
  const f = storageFixture(); f.noQuarry()
  assert.equal(f.control.snapshot().storage.available, true)
  assert.deepEqual(f.calls, [])
  await f.control.execute(f.request({ command: 'storagePreview' }))
  assert.deepEqual(f.calls, [['prepare', {}]])
  assert.deepEqual(f.f.calls, [])
})
test('dashboard-control: storage preview and status expose only the explicit safe receipt fields', async () => {
  const f = storageFixture()
  f.setStatus({ operationId: 'manual_deposit_1', checkpoint: { nbt: 'private-nbt' }, raw: 'private-raw', token: 'private-token', scope: 'private-scope', target: { x: 2, y: 64, z: 3, raw: 'private-target' }, error: { code: 'MANUAL_DEPOSIT_TEST', message: 'Safe message', raw: 'private-error' } })
  Object.assign(f.preview, { checkpoint: 'private-preview' }); f.preview.stacks.raw = 'private-stack'
  f.preview.target.scope = 'private-preview-scope'
  const result = await f.control.execute(f.request({ command: 'storagePreview', operationId: 'manual_deposit_1' }))
  assert.deepEqual(f.calls, [['prepare', { operationId: 'manual_deposit_1' }]])
  assert.deepEqual(result.storagePreview, { token: 'storage-confirmation', expiresAt: 121000, operationId: 'manual_deposit_1', position: { x: 2, y: 64, z: 3 }, slotCount: 54, resume: false,
    stacks: { main: 36, armor: 4, offhand: 1, total: 41 }, target: { position: { x: 2, y: 64, z: 3 }, realm: 'Test Realm', player: 'Bot', dimension: 'overworld' } })
  assert.deepEqual(result.state.storage.error, { code: 'MANUAL_DEPOSIT_TEST', message: 'Safe message' })
  assert.ok(!JSON.stringify(result).includes('private-'))
  assert.deepEqual(f.f.calls, [])
})
test('dashboard-control: storage start requires exact confirmation and returns running status without draining', async () => {
  const f = storageFixture()
  for (const extra of [{}, { storageToken: 't' }, { storageToken: '', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }, { storageToken: 't', confirm: 'RESET' }, { storageToken: 'x'.repeat(257), confirm: 'STORE_ALL_IN_EMPTY_CHEST' }]) {
    await assert.rejects(f.control.execute(f.request({ command: 'storageStart', ...extra })), { code: 'INVALID_INPUT' })
  }
  assert.deepEqual(f.calls, [])
  const result = await f.control.execute(f.request({ command: 'storageStart', storageToken: 'storage-confirmation', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }))
  assert.deepEqual(f.calls, [['storageStart', { token: 'storage-confirmation', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }]])
  assert.equal(result.storage.phase, 'running'); assert.equal(result.storage.busy, true)
  assert.deepEqual(f.f.calls, [])
})
test('dashboard-control: stale session or replaced controller cannot return a prepared storage confirmation', async () => {
  for (const changed of ['session', 'controller']) {
    const f = storageFixture(); let finish
    f.storage.prepare = () => new Promise(resolve => { finish = resolve })
    const preparing = f.control.execute(f.request({ command: 'storagePreview' }))
    if (changed === 'session') f.s.connectionId = 'two'
    else f.setStorage({ status: () => ({ busy: false }) })
    finish(f.preview)
    await assert.rejects(preparing, { code: changed === 'session' ? 'STALE_SESSION' : 'STALE_STORAGE_OPERATION' })
    assert.deepEqual(f.calls, [])
  }
})
test('dashboard-control: storage cancellation needs the current operation and remains available without inventory readiness', async () => {
  const f = storageFixture(); f.noQuarry()
  f.setStatus({ busy: true, phase: 'running', operationId: 'manual_deposit_1' }); f.s.inventory.uncertain = true
  for (const extra of [{}, { operationId: 'other' }, { operationId: '../checkpoint' }, { operationId: 'manual_deposit_1', session: 'old' }]) {
    await assert.rejects(f.control.execute(f.request({ command: 'storageCancel', ...extra })))
  }
  assert.deepEqual(f.calls, [])
  await f.control.execute(f.request({ command: 'storageCancel', operationId: 'manual_deposit_1' }))
  assert.deepEqual(f.calls, [['storageCancel']])
})
test('dashboard-control: storage delegates uncertain inventory recovery to its receipt controller but refuses dead or loading sessions', async () => {
  const f = storageFixture(); f.s.inventory.known = false; f.s.inventory.uncertain = true
  assert.equal(f.control.snapshot().ready, false, 'normal work retains full inventory readiness')
  assert.equal(f.control.snapshot().storage.ready, true, 'manual storage can acquire its read-only receipt recovery lease')
  await f.control.execute(f.request({ command: 'storagePreview', operationId: 'manual_deposit_1' }))
  await f.control.execute(f.request({ command: 'storageStart', storageToken: 'storage-confirmation', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }))
  assert.deepEqual(f.calls.map(call => call[0]), ['prepare', 'storageStart'])
  for (const change of [{ phase: 'connecting' }, { loadingScreenEnded: false }, { dead: true }, { isDead: true }, { lifecycle: { dead: true } }, { spawnPending: true }, { health: 0 }]) {
    const blocked = storageFixture(); Object.assign(blocked.s, change)
    assert.equal(blocked.control.snapshot().storage.ready, false)
    await assert.rejects(blocked.control.execute(blocked.request({ command: 'storagePreview' })), { code: 'NOT_READY' })
    assert.deepEqual(blocked.calls, [])
  }
})
test('dashboard-control: storage readiness requires a current valid session and ignores untrusted controller readiness', async () => {
  for (const change of [{ connectionId: null }, { realm: null }, { profile: '' }, { dimension: null }]) {
    const f = storageFixture(); Object.assign(f.s, change); f.setStatus({ ready: true })
    assert.equal(f.control.snapshot().session, null)
    assert.equal(f.control.snapshot().storage.ready, false)
    await assert.rejects(f.control.execute(f.request({ command: 'storagePreview' })), { code: 'STALE_SESSION' })
    assert.deepEqual(f.calls, [])
  }
  const f = storageFixture(); f.setStatus({ ready: false })
  assert.equal(f.control.snapshot().storage.ready, true)
  const result = await f.control.execute(f.request({ command: 'storageStart', storageToken: 't', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }))
  assert.equal(result.storage.ready, true)
  assert.equal(result.state.storage.ready, true)
})
test('dashboard-control: running storage blocks mining and reset starts but preserves emergency and reset cancellation', async () => {
  const f = storageFixture(); f.setStatus({ busy: true, operationId: 'manual_deposit_1' })
  for (const command of ['plan', 'start', 'resume', 'resetPreview', 'resetStart', 'storagePreview', 'storageStart']) {
    await assert.rejects(f.control.execute(f.request({ command })), { code: 'STORAGE_BUSY' })
  }
  await f.control.execute(f.request({ command: 'resetCancel' }))
  await assert.rejects(f.control.execute(f.request({ command: 'emergencyStop', jobId: 'old' })), { code: 'STALE_JOB' })
  assert.deepEqual(f.calls, [['resetCancel']])
  await f.control.execute(f.request({ command: 'emergencyStop', jobId: null }))
  assert.deepEqual(f.calls, [['resetCancel'], ['storageCancel']])
  assert.deepEqual(f.f.calls, [['emergencyStop']])
})
test('dashboard-control: emergency and disconnect stop storage even with no quarry instance', async () => {
  for (const command of ['emergencyStop', 'disconnect']) {
    const f = storageFixture(); f.noQuarry(); f.setStatus({ busy: true, operationId: 'manual_deposit_1' })
    await assert.rejects(f.control.execute(f.request({ command, jobId: 'old' })), { code: 'NOT_READY' })
    assert.deepEqual(f.calls, [])
    const result = await f.control.execute(f.request({ command, jobId: null }))
    await new Promise(setImmediate)
    assert.deepEqual(f.calls, command === 'disconnect' ? [['storageCancel'], ['disconnect']] : [['storageCancel']])
    if (command === 'disconnect') assert.equal(result.disconnecting, true)
    assert.deepEqual(f.f.calls, [])
  }
})
test('dashboard-control: reset work and unfinished control calls exclude new storage work', async () => {
  const f = storageFixture()
  f.reset.status = () => ({ busy: true })
  await assert.rejects(f.control.execute(f.request({ command: 'storagePreview' })), { code: 'RESET_BUSY' })
  f.reset.status = () => ({ busy: false })
  let finish; f.storage.prepare = () => new Promise(resolve => { finish = resolve })
  const preparing = f.control.execute(f.request({ command: 'storagePreview' }))
  for (const command of ['storageStart', 'resetPreview', 'resetStart', 'plan']) {
    await assert.rejects(f.control.execute(f.request({ command })), { code: 'CONTROL_BUSY' })
  }
  finish(f.preview); await preparing
  assert.deepEqual(f.calls, [])
})
test('dashboard-control: storage rejects malformed previews and extra action fields before starting transfers', async () => {
  const f = storageFixture()
  for (const input of [
    { command: 'storagePreview', operationId: '../checkpoint' },
    { command: 'storagePreview', storageToken: 't' },
    { command: 'storageStart', operationId: 'manual_deposit_1' },
    { command: 'storageCancel', confirm: 'STORE_ALL_IN_EMPTY_CHEST' },
    { command: 'storagePreview', group: 'mining' },
    { command: 'storagePreview', config: {} },
    { command: 'storagePreview', jobId: null }
  ]) await assert.rejects(f.control.execute(f.request(input)), { code: 'INVALID_INPUT' })
  assert.deepEqual(f.calls, [])
  for (const change of [{ slotCount: 27 }, { stacks: { main: 36, armor: 4, offhand: 1, total: 40 } }, { position: { x: NaN, y: 64, z: 3 } }, { operationId: '../../secret' }]) {
    f.storage.prepare = async () => ({ ...f.preview, ...change })
    await assert.rejects(f.control.execute(f.request({ command: 'storagePreview' })), { code: 'INVALID_STORAGE_PREVIEW' })
  }
  assert.deepEqual(f.calls, [])
})
