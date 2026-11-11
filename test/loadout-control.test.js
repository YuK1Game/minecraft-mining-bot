'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createDashboardControl } = require('../src/dashboard-control')
const { createDashboardManager } = require('../scripts/lib/dashboard-control')
const { main } = require('../scripts/reset-loadout')
const { fixture } = require('./helpers/loadout-sim')
const { summary } = require('../src/quarry-v22-reset')

test('loadout-control: preview + explicit confirmation are required; one click returns running state without awaiting commands', async () => {
  const f = fixture(), q = { status: () => null }
  const control = createDashboardControl({ getState: () => f.state, getQuarry: () => q, getReset: () => ({ preview: f.reset.prepare, start: f.reset.start, status: f.reset.status, cancel: f.reset.cancel }) })
  const session = control.snapshot().session
  const p = await control.execute({ command: 'resetPreview', session })
  assert.equal(f.commandsSent.length, 0)
  await assert.rejects(control.execute({ command: 'resetStart', session, resetToken: p.resetPreview.token }))
  const again = await control.execute({ command: 'resetPreview', session })
  // A confirmation phrase for the other reset kind never starts this one.
  await assert.rejects(control.execute({ command: 'resetStart', session, resetToken: again.resetPreview.token, confirm: 'REPLACE_SURFACE_CHEST' }))
  assert.equal(f.commandsSent.length, 0)
  const third = await control.execute({ command: 'resetPreview', session })
  const s = await control.execute({ command: 'resetStart', session, resetToken: third.resetPreview.token, confirm: 'REPLACE_INITIAL_INVENTORY' })
  assert.equal(s.reset.busy, true)
  await assert.rejects(control.execute({ command: 'plan', session, config: { x1: 0, z1: 0 } }), { code: 'RESET_BUSY' })
  await control.execute({ command: 'resetCancel', session }); await f.reset.drain()
  assert.equal(f.reset.status().serverConfirmed, false)
})
test('loadout-control: stale session and user-supplied command/manifest fields never reach reset primitives', async () => {
  const f = fixture(), calls = []
  const control = createDashboardControl({ getState: () => f.state, getQuarry: () => ({ status: () => null }), getReset: () => ({ status: () => ({}), preview: () => calls.push(1), start: () => calls.push(2) }) })
  const session = control.snapshot().session
  for (const extra of [{ command: 'clear' }, { session: 'old' }, { manifest: {} }, { target: '@a' }, { commands: ['/clear @a'] }]) await assert.rejects(control.execute({ command: 'resetPreview', session, ...extra }))
  assert.equal(calls.length, 0)
})
test('loadout-control: reset routes have a fixed allowlist and loopback transport, no generic action proxy', async t => {
  const calls = [], manager = createDashboardManager({ workspaceRoot: '/test', apiPort: 3000, requestBot: async input => { calls.push(input); return {} } })
  t.after(() => manager.stop())
  for (const command of ['resetPreview', 'resetStart', 'resetCancel']) await manager.execute('loadout', { command, session: 's' })
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.apiPort === 3000 && c.timeoutMs === 30000))
  for (const input of [{ command: 'clear' }, { command: 'resetStart', url: 'http://elsewhere' }, { command: 'resetPreview', target: '@a' }]) await assert.rejects(manager.execute('loadout', input))
  assert.equal(calls.length, 3)
})
function cli () {
  const requests = [], output = [], state = { session: 's', loadout: { busy: false, operationId: 'op', phase: 'completed', serverConfirmed: true } }
  const opts = { stdin: { isTTY: false }, stdout: { write: s => output.push(s) }, request: async ({ payload }) => {
    requests.push(payload)
    if (!payload) return state
    if (payload.command === 'resetPreview') return { state, resetPreview: { token: 'one-shot', target: { realm: 'Offline Realm', player: 'Bot' }, stage: { x: 2, y: 64, z: 0 }, homeChest: { position: { x: 3, y: 64, z: 0 }, other: { x: 4, y: 64, z: 0 } }, manifest: summary() } }
    if (payload.command === 'resetStart') return { reset: state.loadout, state }
    throw Error('unexpected')
  } }
  return { opts, requests, output, state }
}
test('loadout-cli: preview and non-RESET answers are non-destructive; non-interactive input cannot confirm', async () => {
  const f = cli(); await main(['--preview'], f.opts)
  assert.ok(!f.requests.some(r => r?.command === 'resetStart'))
  await assert.rejects(main([], f.opts), /対話入力/)
  assert.ok(!f.requests.some(r => r?.command === 'resetStart'))
  const result = await main([], { ...f.opts, ask: async () => 'yes' })
  assert.equal(result.cancelled, true); assert.ok(!f.requests.some(r => r?.command === 'resetStart'))
})
test('loadout-cli: exact RESET sends one token-bound command, reports verified completion and never resumes quarry', async () => {
  const f = cli(), result = await main([], { ...f.opts, ask: async () => 'RESET' })
  assert.equal(result.serverConfirmed, true)
  assert.deepEqual(f.requests.filter(r => r?.command === 'resetStart'), [{ command: 'resetStart', session: 's', resetToken: 'one-shot', confirm: 'REPLACE_SURFACE_CHEST' }])
  assert.ok(!f.requests.some(r => r?.command === 'resume' || r?.command === 'start'))
})
test('loadout-cli: failures/session changes are not successes and do not resend the destructive command', async () => {
  const f = cli(); f.state.loadout.phase = 'failed'; f.state.loadout.serverConfirmed = false
  await assert.rejects(main([], { ...f.opts, ask: async () => 'RESET' }), /完了/)
  assert.equal(f.requests.filter(r => r?.command === 'resetStart').length, 1)
})
