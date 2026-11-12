'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDashboardControl } = require('../src/dashboard-control')
const { createDashboardManager } = require('../scripts/lib/dashboard-control')
const { observedScope } = require('../src/server-position-verifier')
const { normalizeChunkArea } = require('../src/chunk-area')
const area = { x1: 0, z1: 0, x2: 0, z2: 0 }
const copy = value => structuredClone(value)

function fixture () {
  const state = { profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'one', startedAt: '2026-11-07T00:00:00Z', runtimeEntityId: '1', lifecycle: { deathId: 0 }, phase: 'spawned', loadingScreenEnded: true, health: 20, inventory: { known: true }, position: { x: 8, y: 65.62, z: 8 } }
  const calls = []; let clock = 1000, generation = 3, job = null, doc = null, storageBusy = false
  const proof = { confirmed: true, feet: { x: 8, y: 64, z: 8 }, radius: 0.12, scope: observedScope(state), generation: 7, observedAt: clock, source: 'server_position_witness', raw: 'private-proof' }
  let move = { busy: false, phase: 'idle', operationId: null, area: null }, resetBusy = false
  const q = { status: () => job, document: () => doc, controlPosition: () => copy(proof), chunkMoveStatus: () => ({ ...copy(move), raw: 'private-move' }),
    moveToChunk: input => { calls.push(['move', copy(input)]); move = { busy: true, phase: 'running', operationId: 'move_1', area: copy(input.area), serverConfirmed: false }; return copy(move) },
    cancelChunkMove: id => { calls.push(['cancelMove', id]); move.busy = false; move.phase = 'cancelled' },
    pause: async () => calls.push(['pause']), emergencyStop: async () => calls.push(['emergencyStop']), cancel: async () => calls.push(['cancel']), plan: () => assert.fail('movement never plans a quarry') }
  const reset = { status: () => ({ busy: resetBusy }), preview: async input => { calls.push(['preview', copy(input)]); return { token: 'reset_1', expiresAt: 121000 } },
    start: input => { calls.push(['reset', copy(input)]); return { busy: true } }, cancel: () => calls.push(['resetCancel']) }
  let currentQ = q, currentReset = reset
  const control = createDashboardControl({ getState: () => state, getQuarry: () => currentQ, getReset: () => currentReset,
    getStorage: () => ({ status: () => ({ busy: storageBusy }) }), getGeneration: () => generation, now: () => clock, disconnect: () => calls.push(['disconnect']) })
  const request = value => ({ session: control.snapshot().session, ...value })
  const preview = () => control.execute(request({ command: 'resetPreview', area }))
  return { state, q, reset, control, proof, calls, request, preview,
    job: (value, document = null) => { job = value; doc = document }, storageBusy: () => { storageBusy = true }, resetBusy: () => { resetBusy = true },
    expire: () => { clock += 120001 }, reload: () => { generation++ }, replaceReset: () => { currentReset = { ...reset } }, replaceQuarry: () => { currentQ = { ...q } } }
}

test('chunk control status is passive and publishes scoped proof without assuming Host and Runtime generations equal', () => {
  const f = fixture(), status = f.control.snapshot()
  assert.equal(status.positionProof.generation, 7); assert.equal(status.chunkMove.available, true)
  assert.equal(status.positionProof.session, status.session)
  assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(status).includes('private-'))
  f.proof.scope = 'old'; assert.equal(f.control.snapshot().positionProof, null)
  delete f.q.controlPosition; assert.equal(f.control.snapshot().chunkMove.available, false)
})

test('only the normalized fixed area reaches the synchronous movement method and repeated move is refused', async () => {
  const f = fixture(), result = await f.control.execute(f.request({ command: 'moveToChunk', area }))
  assert.deepEqual(f.calls, [['move', { area: normalizeChunkArea(area) }]])
  assert.equal(result.chunkMove.busy, true); assert.equal(result.chunkMove.serverConfirmed, false)
  await assert.rejects(f.control.execute(f.request({ command: 'moveToChunk', area })), { code: 'CONTROL_BUSY' })
  await assert.rejects(f.control.execute(f.request({ command: 'cancelChunkMove', operationId: 'old' })), { code: 'STALE_CHUNK_MOVE' })
  await f.control.execute(f.request({ command: 'cancelChunkMove', operationId: 'move_1' }))
  assert.deepEqual(f.calls.at(-1), ['cancelMove', 'move_1'])
})

for (const mode of ['active', 'stopping', 'draining', 'persistence', 'supply', 'portable', 'loadout', 'totem']) test(`${mode} work cannot be abandoned by chunk movement`, async () => {
  const f = fixture(), job = { jobId: 'q', state: mode === 'active' ? 'MINE' : mode === 'stopping' ? 'STOPPING' : 'PAUSED' }, doc = {}
  if (mode === 'draining') job.draining = true
  if (mode === 'persistence') job.persistence = { status: 'failed' }
  if (mode === 'supply') doc.supplyRestock = { checkpoint: {} }
  if (mode === 'portable') doc.portableStorage = { checkpoint: { stage: 'awaiting_recovery' } }
  if (mode === 'loadout') doc.loadout = { checkpoint: { index: 11 } }
  if (mode === 'totem') doc.pendingTotemEquip = { stage: 'accepted' }
  f.job(job, doc)
  await assert.rejects(f.control.execute(f.request({ command: 'moveToChunk', area })), { code: 'QUARRY_BUSY' }); assert.equal(f.calls.length, 0)
})

for (const busy of ['storageBusy', 'resetBusy']) test(`${busy} prevents another movement owner`, async () => {
  const f = fixture(); f[busy]()
  await assert.rejects(f.control.execute(f.request({ command: 'moveToChunk', area })), { code: busy === 'storageBusy' ? 'STORAGE_BUSY' : 'RESET_BUSY' })
  assert.equal(f.calls.length, 0)
})

test('stopping controls cancel only the current owned move while preserving existing stop behavior', async () => {
  for (const command of ['pause', 'emergencyStop', 'cancel', 'disconnect']) {
    const f = fixture(); await f.control.execute(f.request({ command: 'moveToChunk', area }))
    await f.control.execute(f.request({ command, jobId: null })); await new Promise(setImmediate)
    assert.deepEqual(f.calls[1], ['cancelMove', 'move_1'])
    assert.ok(f.calls.some(row => row[0] === (command === 'disconnect' ? 'disconnect' : command)))
  }
})

test('moving prevents planning, storage and initial chest operations until it settles', async () => {
  const f = fixture(); await f.control.execute(f.request({ command: 'moveToChunk', area }))
  for (const command of ['plan', 'start', 'resume', 'storagePreview', 'storageStart', 'resetPreview', 'resetStart']) {
    await assert.rejects(f.control.execute(f.request({ command, ...(['resetPreview', 'resetStart'].includes(command) ? { area } : {}) })), { code: 'CHUNK_MOVE_BUSY' })
  }
  assert.equal(f.calls.length, 1)
})

test('fixed movement inputs reject arbitrary destinations, commands and malformed areas without dispatch', async () => {
  const f = fixture()
  for (const payload of [{ command: 'action', group: 'movement' }, ...['target', 'options', 'commandText', 'checkpoint', 'args', 'jobId'].map(key => ({ command: 'moveToChunk', area, [key]: 'unexpected' })),
    ...[undefined, { x1: 0.1, z1: 0 }, { x1: 1875000, z1: 0 }, { ...area, y: 64 }].map(value => ({ command: 'moveToChunk', area: value }))]) await assert.rejects(f.control.execute(f.request(payload)))
  assert.equal(f.calls.length, 0)
})

for (const mode of ['missing', 'outside', 'boundaryCircle', 'scope', 'unconfirmed', 'prediction']) test(`${mode} position cannot enable initial chest creation`, async () => {
  const f = fixture()
  if (mode === 'missing') f.q.controlPosition = () => null
  if (mode === 'outside') f.proof.feet.x = 40
  if (mode === 'boundaryCircle') f.proof.feet.x = 15.99
  if (mode === 'scope') f.proof.scope = 'old'
  if (mode === 'unconfirmed') f.proof.confirmed = false
  if (mode === 'prediction') f.proof.source = 'client_position_prediction'
  await assert.rejects(f.preview(), { code: 'CHUNK_POSITION_UNCONFIRMED' }); assert.equal(f.calls.length, 0)
})

test('an initial chest token is area-bound and single-use even while another area also contains the current player', async () => {
  const f = fixture(); await f.preview()
  await assert.rejects(f.control.execute(f.request({ command: 'resetStart', area: { ...area, x2: 1 }, resetToken: 'reset_1', confirm: 'CONFIRM' })), { code: 'STALE_RESET' })
  await f.preview()
  await f.control.execute(f.request({ command: 'resetStart', area, resetToken: 'reset_1', confirm: 'CONFIRM' }))
  assert.deepEqual(f.calls.at(-1), ['reset', { token: 'reset_1', confirm: 'CONFIRM', area: normalizeChunkArea(area) }])
  await assert.rejects(f.control.execute(f.request({ command: 'resetStart', area, resetToken: 'reset_1', confirm: 'CONFIRM' })), { code: 'STALE_RESET' })
})

for (const mode of ['hostGeneration', 'runtimeGeneration', 'resetInstance', 'expiry', 'outside']) test(`${mode} invalidates a previously prepared reset`, async () => {
  const f = fixture(); await f.preview()
  if (mode === 'hostGeneration') f.reload()
  if (mode === 'runtimeGeneration') f.proof.generation++
  if (mode === 'resetInstance') f.replaceReset()
  if (mode === 'expiry') f.expire()
  if (mode === 'outside') f.proof.feet.x = 40
  await assert.rejects(f.control.execute(f.request({ command: 'resetStart', area, resetToken: 'reset_1', confirm: 'CONFIRM' })))
  assert.ok(!f.calls.some(row => row[0] === 'reset'))
  if (mode === 'outside') {
    f.proof.feet.x = 8
    await assert.rejects(f.control.execute(f.request({ command: 'resetStart', area, resetToken: 'reset_1', confirm: 'CONFIRM' })), { code: 'STALE_RESET' })
  }
})

for (const mode of ['session', 'resetInstance', 'quarryInstance', 'runtimeGeneration', 'outside', 'cancel']) test(`${mode} change during async reset preview cannot return an actionable token`, async () => {
  const f = fixture(); let finish
  f.reset.preview = () => new Promise(resolve => { finish = resolve })
  const pending = f.preview()
  if (mode === 'session') f.state.connectionId = 'two'
  if (mode === 'resetInstance') f.replaceReset()
  if (mode === 'quarryInstance') f.replaceQuarry()
  if (mode === 'runtimeGeneration') f.proof.generation++
  if (mode === 'outside') f.proof.feet.x = 40
  if (mode === 'cancel') await f.control.execute(f.request({ command: 'resetCancel' }))
  finish({ token: 'reset_1', expiresAt: 121000 }); await assert.rejects(pending)
  assert.ok(!f.calls.some(row => row[0] === 'reset'))
})

test('manager forwards only the fixed new payload shapes without starting a Bot or providing an arbitrary proxy', async t => {
  const requests = [], manager = createDashboardManager({ workspaceRoot: '/test/work', apiPort: 3000, spawnBot: () => assert.fail('no process launch'), requestBot: async input => { requests.push(copy(input)); return { accepted: true } } })
  t.after(() => manager.stop())
  for (const [route, payload] of [['quarry', { command: 'moveToChunk', session: 's', area }], ['quarry', { command: 'cancelChunkMove', session: 's', operationId: 'move_1' }], ['loadout', { command: 'resetPreview', session: 's', area }], ['loadout', { command: 'resetStart', session: 's', area, resetToken: 'r', confirm: 'CONFIRM' }]]) await manager.execute(route, payload)
  assert.equal(requests.length, 4)
  for (const payload of [{ command: 'moveToChunk', session: 's', area, target: {} }, { command: 'cancelChunkMove', session: 's', operationId: 'move_1', area }, { command: 'give', session: 's' }]) await assert.rejects(manager.execute('quarry', payload))
  await assert.rejects(manager.execute('loadout', { command: 'resetPreview', session: 's', area, commandText: '/tp' }))
  assert.equal(requests.length, 4)
})
