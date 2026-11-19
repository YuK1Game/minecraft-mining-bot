'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createDashboardControl } = require('../src/host/dashboard-control')
const { createDashboardManager } = require('../scripts/lib/dashboard-control')
const { commandText } = require('../src/host/dashboard-debug')

const state = () => ({ profile: 'bot', realm: { id: '42', name: 'Test Realm' }, dimension: 'overworld', connectionId: 'one', startedAt: '2026-11-19T00:00:00Z', lifecycle: { deathId: 0 },
  phase: 'spawned', loadingScreenEnded: true, health: 20, inventory: { known: true }, position: { x: 0.5, y: 65.62, z: 0.5 } })
// The runtime's diagnostics.command / commandOutput pair, answered by a fake server.
function server (answer) {
  const sent = [], outputs = new Map()
  return { sent, diagnostics: {
    command: text => { const uuid = 'u' + sent.length; sent.push(text); outputs.set(uuid, { command: text, output: answer ? answer(text) : null }); return { sent: true, uuid } },
    commandOutput: uuid => outputs.get(uuid) ?? null } }
}
function fixture (answer, extra = {}) {
  const s = state(), srv = server(answer), lines = []
  let clock = 1000
  const control = createDashboardControl({ getState: () => s, getQuarry: () => null, getDiagnostics: () => srv.diagnostics, log: line => lines.push(line), now: () => clock, debugWait: async ms => { clock += ms }, disconnect () {}, ...extra })
  const request = body => ({ session: control.snapshot().session, ...body })
  return { s, srv, lines, control, request }
}
const ok = id => () => ({ success_count: 1, output: [{ success: true, message_id: id, parameters: ['HouchiChan'] }] })

test('dashboard-debug: spawn point and clear send fixed self-targeted commands and report the server answer', async () => {
  const f = fixture(ok('commands.spawnpoint.success.single'))
  const spawn = await f.control.execute(f.request({ command: 'debugSpawn' }))
  assert.deepEqual(f.srv.sent, ['/spawnpoint @s ~ ~ ~'])
  assert.equal(spawn.debug.ok, true)
  assert.match(spawn.debug.message, /commands\.spawnpoint\.success\.single \[HouchiChan\]/)
  await f.control.execute(f.request({ command: 'debugClear' }))
  assert.equal(f.srv.sent[1], '/clear @s')
  assert.ok(f.lines.some(line => /\/clear @s → 成功/.test(line)))
})

test('dashboard-debug: a typed command runs as one line; a refusal or silence is a failure, never done', async () => {
  const refused = fixture(() => ({ success_count: 0, output: [{ success: false, message_id: 'commands.generic.unknown', parameters: ['foo'] }] }))
  await assert.rejects(refused.control.execute(refused.request({ command: 'debugCommand', text: 'foo bar' })), err => err.code === 'DEBUG_REFUSED' && /commands\.generic\.unknown \[foo\]/.test(err.message))
  assert.deepEqual(refused.srv.sent, ['/foo bar'])
  const silent = fixture(null, {})
  await assert.rejects(silent.control.execute(silent.request({ command: 'debugCommand', text: '/time set day' })), { code: 'DEBUG_NO_ANSWER' })
  assert.ok(silent.lines.some(line => /応答がありません/.test(line)))
  assert.throws(() => commandText('/a\n/b'), { code: 'INVALID_COMMAND_TEXT' })
  assert.throws(() => commandText('   '), { code: 'INVALID_COMMAND_TEXT' })
  assert.throws(() => commandText('/' + 'x'.repeat(512)), { code: 'INVALID_COMMAND_TEXT' })
})

test('dashboard-debug: needs the current session, extra fields are refused, clear waits for a reset or storage', async () => {
  const f = fixture(ok('x'))
  await assert.rejects(f.control.execute({ command: 'debugSpawn', session: 'old' }), { code: 'STALE_SESSION' })
  await assert.rejects(f.control.execute(f.request({ command: 'debugSpawn', text: '/kill @e' })), { code: 'INVALID_INPUT' })
  const busy = fixture(ok('x'), { getReset: () => ({ status: () => ({ busy: true }) }) })
  await assert.rejects(busy.control.execute(busy.request({ command: 'debugClear' })), { code: 'RESET_BUSY' })
  assert.deepEqual([...f.srv.sent, ...busy.srv.sent], [])
  const none = fixture(ok('x'), { getDiagnostics: () => null })
  await assert.rejects(none.control.execute(none.request({ command: 'debugSpawn' })), { code: 'DEBUG_UNAVAILABLE' })
})

test('dashboard-debug: the dashboard server passes only the three debug commands to the Bot', async () => {
  const sent = []
  const manager = createDashboardManager({ workspaceRoot: __dirname, apiPort: 3999, requestBot: async ({ payload }) => { sent.push(payload); return { ok: true } }, occupied: async () => false })
  await manager.execute('debug', { command: 'debugCommand', session: 's', text: '/time set day' })
  await assert.rejects(manager.execute('debug', { command: 'plan', session: 's' }), { code: 'INVALID_COMMAND' })
  await assert.rejects(manager.execute('debug', { command: 'debugSpawn', session: 's', group: 'x' }), { code: 'INVALID_INPUT' })
  assert.deepEqual(sent, [{ command: 'debugCommand', session: 's', text: '/time set day' }])
})
