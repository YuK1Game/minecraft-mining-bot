'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDashboardManager, profileName } = require('../scripts/lib/dashboard-control')
const { CHANNEL } = require('../src/dashboard-session')
function fixture (t, options = {}) {
  const spawns = [], children = [], requests = []
  const manager = createDashboardManager({ workspaceRoot: '/test/work', apiPort: 3000, occupied: async () => false,
    requestBot: async r => { requests.push(r); if (r.payload) return { accepted: true }; throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) },
    spawnBot: (...args) => {
      spawns.push(args); const child = new EventEmitter(); children.push(child)
      child.connected = true; child.messages = []
      child.send = (message, cb) => { child.messages.push(message); cb?.(); if (message.type === 'stop') setImmediate(() => child.emit('close', 0)) }
      child.kill = () => { child.emit('close', 1) }
      return child
    }, ...options })
  t.after(() => manager.stop())
  return { manager, spawns, children, requests, emit: value => children[0].emit('message', { channel: CHANNEL, ...value }) }
}
test('dashboard-control-manager: reading status never spawns; explicit list starts one shell-free child with selected profile', async t => {
  const f = fixture(t); await f.manager.snapshot(); assert.equal(f.spawns.length, 0)
  const started = await f.manager.execute('realms', { profile: 'my-bot' })
  await f.manager.execute('realms', { profile: 'my-bot' })
  assert.equal(f.spawns.length, 1); assert.ok(started.processId)
  const [entry, args, settings] = f.spawns[0]
  assert.ok(entry.replaceAll('\\', '/').endsWith('src/main.js')); assert.deepEqual(args, ['--dashboard'])
  assert.equal(settings.env.REALM_ID, ''); assert.equal(settings.env.BOT_PROFILE, 'my-bot'); assert.equal(settings.shell, undefined)
})
test('dashboard-control-manager: port occupied and profile injection never spawn', async t => {
  const f = fixture(t, { occupied: async () => true })
  await assert.rejects(f.manager.execute('realms', { profile: 'bot' }), /二重起動/)
  await assert.rejects(f.manager.execute('realms', { profile: '../.auth' }))
  await assert.rejects(f.manager.execute('realms', { profile: 'bot; touch secret' }))
  assert.equal(f.spawns.length, 0); assert.throws(() => profileName('a'.repeat(65)))
})
test('dashboard-control-manager: concurrent launches cannot create two children', async t => {
  let release; const gate = new Promise(r => { release = r }), f = fixture(t, { occupied: () => gate })
  const first = f.manager.execute('realms', {})
  await assert.rejects(f.manager.execute('realms', {}), /起動/)
  release(false); await first; assert.equal(f.spawns.length, 1)
})
test('dashboard-control-manager: selecting requires current child ID and an available listed Realm', async t => {
  const f = fixture(t), s = await f.manager.execute('realms', {})
  f.emit({ type: 'realms', realms: [{ id: '1', name: 'world', state: 'OPEN' }, { id: '2', state: 'CLOSED' }] })
  await assert.rejects(f.manager.execute('connect', { processId: 'old', realmId: '1' }))
  await assert.rejects(f.manager.execute('connect', { processId: s.processId, realmId: '2' }))
  await f.manager.execute('connect', { processId: s.processId, realmId: '1' })
  assert.equal(f.children[0].messages.at(-1).type, 'connect')
  await assert.rejects(f.manager.execute('connect', { processId: s.processId, realmId: '1' }))
})
test('dashboard-control-manager: explicit stop and restart ignores late old-child messages', async t => {
  const f = fixture(t), first = await f.manager.execute('realms', {}), old = f.children[0]
  await assert.rejects(f.manager.execute('disconnect', { processId: 'different' }))
  await f.manager.execute('disconnect', { processId: first.processId })
  const second = await f.manager.execute('realms', {})
  old.emit('message', { channel: CHANNEL, type: 'realms', realms: [{ id: '9', name: 'STALE', state: 'OPEN' }] })
  const s = await f.manager.snapshot()
  assert.notEqual(first.processId, second.processId); assert.equal(s.realms.length, 0)
})
test('dashboard-control-manager: ordinary API-started Bot can be operated but not implicitly terminated', async t => {
  const f = fixture(t)
  await f.manager.execute('quarry', { command: 'plan', session: 's', config: { x1: 1, z1: 1 } })
  await f.manager.stop()
  assert.equal(f.spawns.length, 0)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].payload.command, 'plan')
})
test('dashboard-control-manager: no raw proxy or arbitrary operations', async t => {
  const f = fixture(t)
  await assert.rejects(f.manager.execute('quarry', { command: 'acceptExceptions' }))
  await assert.rejects(f.manager.execute('quarry', { command: 'start', url: 'http://external.invalid' }))
  await assert.rejects(f.manager.execute('action', { group: 'mining', method: 'start' }))
  assert.equal(f.requests.length, 0)
})
test('dashboard-control-manager: only fixed storage commands use the existing loopback control transport without spawning', async t => {
  const f = fixture(t)
  const payloads = [{ command: 'storagePreview', session: 's' }, { command: 'storagePreview', session: 's', operationId: 'manual_deposit_1' },
    { command: 'storageStart', session: 's', storageToken: 't', confirm: 'STORE_ALL_IN_EMPTY_CHEST' }, { command: 'storageCancel', session: 's', operationId: 'manual_deposit_1' }]
  for (const payload of payloads) assert.deepEqual(await f.manager.execute('storage', payload), { accepted: true })
  assert.deepEqual(f.requests, payloads.map(payload => ({ apiPort: 3000, payload, timeoutMs: 30000 })))
  assert.equal(f.spawns.length, 0)
})
test('dashboard-control-manager: storage route cannot tunnel arbitrary commands or extra destination and action fields', async t => {
  const f = fixture(t)
  for (const payload of [{ command: 'plan' }, { command: 'resetStart' }, { command: 'action' },
    ...['url', 'path', 'group', 'method', 'args', 'config', 'jobId', 'resetToken', 'profile', 'checkpoint'].map(key => ({ command: 'storagePreview', [key]: 'unexpected' }))]) {
    await assert.rejects(f.manager.execute('storage', payload), { code: ['plan', 'resetStart', 'action'].includes(payload.command) ? 'INVALID_COMMAND' : 'INVALID_INPUT' })
  }
  assert.deepEqual(f.requests, []); assert.deepEqual(f.spawns, [])
})
