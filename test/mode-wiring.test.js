'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os'), fs = require('node:fs'), path = require('node:path')
const { attachModeOperations } = require('../src/modes/mode-runtime')
const { createDashboardControl } = require('../src/host/dashboard-control')
const { createDashboardManager } = require('../scripts/lib/dashboard-control')
const { modeState, playerActivity } = require('../scripts/lib/player-activity')

function runtime ({ auto = false } = {}) {
  const calls = [], root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-rt-'))
  let job = null, running = false
  const operations = {
    quarry: { status: () => job, start: () => { calls.push('quarry.start'); job = { jobId: 'q', state: 'MINE' } }, resume: () => { calls.push('quarry.resume'); job.state = 'MINE' }, pause: () => { job.state = 'PAUSED' } },
    agent: { start: options => { calls.push('agent.start:' + options.objective); running = true }, stop: () => { calls.push('agent.stop'); running = false } },
    safety: { start: () => calls.push('safety.start') }
  }
  const host = { shared: { autoWanted: auto }, log: () => {} }
  const rt = { host: () => host, autonomy: () => ({ snapshot: () => ({ running, phase: running ? 'working' : 'idle', reason: '' }) }),
    chunkMoveHeld: () => false, resetHeld: () => false, manualChestStorage: () => null, raw: () => ({ inventory: { known: true, items: [] } }) }
  return { operations, rt, calls, root, mode: attachModeOperations(operations, rt, { root }) }
}

test('runtime wiring: quarry work refuses in player mode and player work refuses in quarry mode', async () => {
  const f = runtime()
  assert.equal(f.mode.get(), 'quarry')
  assert.throws(() => f.mode.startPlayer(), { code: 'MODE_MISMATCH' })
  f.operations.quarry.start()
  assert.throws(() => f.mode.set('player'), { code: 'QUARRY_RUNNING' })
  f.operations.quarry.pause()
  f.mode.set('player')
  assert.throws(() => f.operations.quarry.resume(), { code: 'MODE_MISMATCH' })
  assert.equal(f.rt.host().shared.quarryRestoreDisabled, true)
  assert.equal(f.mode.startPlayer().running, true)
  assert.throws(() => f.mode.set('quarry'), { code: 'PLAYER_RUNNING' })
  await f.mode.stopPlayer()
  f.mode.set('quarry')
  f.operations.quarry.resume()
  assert.deepEqual(f.calls, ['quarry.start', 'safety.start', 'agent.start:diamond', 'agent.stop', 'quarry.resume'])
})

test('runtime wiring: the saved mode is used by the next process; npm run auto means player mode', async () => {
  const f = runtime()
  f.mode.set('player')
  await new Promise(resolve => setTimeout(resolve, 50))
  const operations = { quarry: { status: () => null, start () {}, resume () {} }, agent: { start () {}, stop () {} }, safety: { start () {} } }
  assert.equal(attachModeOperations(operations, { ...f.rt, host: () => ({ shared: {}, log: () => {} }) }, { root: f.root }).get(), 'player')
  assert.equal(runtime({ auto: true }).mode.get(), 'player')
})

const state = () => ({ profile: 'bot', realm: { id: '42', name: 'Test' }, dimension: 'overworld', connectionId: 'one', startedAt: '2026-11-07T00:00:00Z', lifecycle: { deathId: 0 }, phase: 'spawned', loadingScreenEnded: true, health: 20, inventory: { known: true, items: [] } })
test('dashboard boundary: only the three fixed mode commands reach the Bot, with a live session', async () => {
  const f = runtime(), control = createDashboardControl({ getState: state, getQuarry: () => f.operations.quarry, getMode: () => f.mode, disconnect () {} })
  const session = control.snapshot().session
  assert.equal(control.snapshot().mode.current, 'quarry')
  await assert.rejects(control.execute({ command: 'setMode', session: 'stale', mode: 'player' }), { code: 'STALE_SESSION' })
  await assert.rejects(control.execute({ command: 'setMode', session, mode: 'player', extra: 1 }), { code: 'INVALID_INPUT' })
  await assert.rejects(control.execute({ command: 'setMode', session, mode: 'creative' }), { code: 'INVALID_MODE' })
  await assert.rejects(control.execute({ command: 'playerStart', session }), { code: 'MODE_MISMATCH' })
  assert.equal((await control.execute({ command: 'setMode', session, mode: 'player' })).state.mode.current, 'player')
  assert.equal((await control.execute({ command: 'playerStart', session })).state.mode.player.running, true)
  assert.equal((await control.execute({ command: 'playerStop', session })).state.mode.player.running, false)
  const old = createDashboardControl({ getState: state, getQuarry: () => f.operations.quarry, disconnect () {} })
  assert.equal(old.snapshot().mode, null)
  await assert.rejects(old.execute({ command: 'setMode', session, mode: 'player' }), { code: 'MODE_UNAVAILABLE' })
})

test('dashboard server: the mode route forwards only its own commands and fields', async () => {
  const sent = [], manager = createDashboardManager({ workspaceRoot: process.cwd(), apiPort: 3999, requestBot: async ({ payload }) => { sent.push(payload); return { state: {} } }, occupied: async () => false })
  await manager.execute('mode', { command: 'setMode', session: 's', mode: 'player' })
  await assert.rejects(manager.execute('mode', { command: 'start', session: 's' }), { code: 'INVALID_COMMAND' })
  await assert.rejects(manager.execute('mode', { command: 'playerStart', session: 's', mode: 'player' }), { code: 'INVALID_INPUT' })
  assert.deepEqual(sent, [{ command: 'setMode', session: 's', mode: 'player' }])
})

test('activity band: player mode says what it is doing; quarry mode leaves the quarry lines', () => {
  const stages = [{ id: 'wood', label: '木の道具', implemented: true, reached: true }, { id: 'stone', label: '石の道具', implemented: true, reached: false }]
  assert.equal(playerActivity(modeState({ mode: 'quarry', player: {} })), null)
  assert.equal(modeState({ mode: 'other' }), null)
  assert.deepEqual(playerActivity(modeState({ mode: 'player', player: { running: false, current: 'stone', stages } })), { kind: 'idle', label: '待機中: プレイヤーモードの開始待ち', detail: '目標: 石の道具', code: null })
  assert.equal(playerActivity(modeState({ mode: 'player', player: { running: true, phase: 'acting', reason: '木を集めています。', stages } })).detail, '木を集めています。')
})
