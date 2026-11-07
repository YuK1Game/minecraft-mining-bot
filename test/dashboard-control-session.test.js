'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDashboardSession, CHANNEL, publicAuth, publicRealms } = require('../src/dashboard-session')
const turn = () => new Promise(setImmediate)
const realms = [{ id: 1, name: 'A', state: 'OPEN', accessToken: 'secret' }, { id: 2, name: 'B', state: 'CLOSED' }, { id: 3, name: 'C', state: 'OPEN', expired: true }]
function fixture (t) {
  const channel = new EventEmitter(), sent = [], stops = []
  channel.connected = true; channel.send = (m, cb) => { sent.push(m); cb?.() }
  const session = createDashboardSession({ channel, onStop: () => stops.push('stop'), getRealms: async () => realms })
  t.after(() => session.dispose())
  return { channel, sent, stops, session, send: data => channel.emit('message', { channel: CHANNEL, ...data }) }
}
test('dashboard-control-session: unrecognized channel and invalid/closed/expired world do not connect', async t => {
  const f = fixture(t); let selected = false
  const promise = f.session.selectRealm(realms).then(r => { selected = true; return r })
  f.channel.emit('message', { type: 'connect', realmId: '1' }); f.send({ type: 'connect', realmId: '999' }); f.send({ type: 'connect', realmId: '2' }); f.send({ type: 'connect', realmId: '3' })
  await turn(); assert.equal(selected, false)
  f.send({ type: 'connect', realmId: '1' }); assert.equal((await promise).id, 1)
  assert.ok(!JSON.stringify(f.sent).includes('secret'))
})
test('dashboard-control-session: device login publishes only temporary code and fixed Microsoft URL', t => {
  const f = fixture(t)
  f.session.auth({ user_code: 'ABCD-EFGH', verification_uri: 'https://evil.invalid', access_token: 'secret', expires_in: 200 })
  const a = f.sent.at(-1).auth
  assert.equal(a.url, 'https://www.microsoft.com/link'); assert.equal(a.code, 'ABCD-EFGH')
  assert.ok(!JSON.stringify(f.sent).includes('secret')); assert.ok(!JSON.stringify(f.sent).includes('evil'))
  assert.equal(publicAuth({ user_code: '<script>' }), null)
  assert.equal(publicRealms(realms).length, 3)
})
test('dashboard-control-session: parent loss cancels pending world selection instead of auto-selecting env Realm', async t => {
  const f = fixture(t), pending = f.session.selectRealm(realms)
  const rejected = assert.rejects(pending, /中止/)
  f.channel.emit('disconnect'); await rejected; await turn()
  assert.equal(f.stops.length, 1)
})
test('dashboard-control-session: list refresh never joins a world', async t => {
  const f = fixture(t), pending = f.session.selectRealm(realms)
  f.send({ type: 'refresh' }); await turn()
  assert.equal(f.sent.filter(m => m.type === 'realms').length, 2)
  assert.equal(f.sent.filter(m => m.type === 'connecting').length, 0)
  const rejected = assert.rejects(pending); f.send({ type: 'stop' }); await rejected
})
