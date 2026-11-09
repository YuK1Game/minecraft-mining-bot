'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const http = require('node:http')
const { createDashboard } = require('../scripts/dashboard')
const { createApi } = require('../src/api')
const { requestControl } = require('../scripts/lib/dashboard-control')
function fixture (t) {
  const calls = [], states = []
  const dashboard = createDashboard({ controls: { snapshot: async () => { states.push(1); return { auth: { code: 'ABCD' } } }, execute: async (route, data) => { calls.push([route, data]); return { ok: true } }, stop: async () => {} }, requestStatus: async () => { throw new Error('offline') } })
  t.after(() => dashboard.stop())
  async function call ({ method = 'GET', url = '/api/control/session', token, origin, body = '{}', contentType = 'application/json', host = '127.0.0.1:3001', site } = {}) {
    const request = Readable.from([Buffer.from(body)]); Object.assign(request, { method, url, headers: { host, 'content-type': contentType, ...(origin ? { origin } : {}), ...(token ? { 'x-bot-control': token } : {}), ...(site ? { 'sec-fetch-site': site } : {}) } })
    let status, value
    const response = { writeHead: n => { status = n }, end: data => { value = JSON.parse(data.toString()) } }
    await dashboard.handler(request, response)
    return { status, value }
  }
  return { dashboard, call, calls, states }
}
test('dashboard-control-http: session handshake does not authenticate, start or expose a device code', async t => {
  const f = fixture(t), r = await f.call()
  assert.equal(r.status, 200); assert.ok(r.value.token); assert.equal(f.calls.length, 0); assert.equal(f.states.length, 0)
  assert.ok(!JSON.stringify(r.value).includes('ABCD'))
})
test('dashboard-control-http: control writes require exact origin, JSON and token', async t => {
  const f = fixture(t), token = (await f.call()).value.token
  const valid = { method: 'POST', url: '/api/control/realms', token, origin: 'http://127.0.0.1:3001' }
  for (const extra of [{ token: null }, { token: 'old' }, { origin: null }, { origin: 'https://evil.invalid' }, { host: 'evil.invalid:3001' }, { site: 'cross-site' }]) assert.equal((await f.call({ ...valid, ...extra })).status, 403)
  assert.equal((await f.call({ ...valid, contentType: 'text/plain' })).status, 415)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.call(valid)).status, 200); assert.equal(f.calls.length, 1)
})
test('dashboard-control-http: device codes require same-origin token even on GET; no GET can mutate', async t => {
  const f = fixture(t), token = (await f.call()).value.token
  assert.equal((await f.call({ url: '/api/control/state' })).status, 403)
  assert.equal((await f.call({ url: '/api/control/state', token })).status, 200)
  assert.equal((await f.call({ url: '/api/control/connect', token })).status, 404)
  assert.equal(f.calls.length, 0)
})
test('dashboard-control-http: unknown routes, oversized/invalid bodies and query tricks are rejected', async t => {
  const f = fixture(t), token = (await f.call()).value.token, base = { method: 'POST', url: '/api/control/quarry', token, origin: 'http://127.0.0.1:3001' }
  assert.equal((await f.call({ ...base, url: '/api/control/action' })).status, 404)
  assert.equal((await f.call({ ...base, url: '/api/control/quarry?command=start' })).status, 404)
  assert.equal((await f.call({ ...base, body: 'x'.repeat(4097) })).status, 413)
  assert.equal((await f.call({ ...base, body: '{oops' })).status, 400)
  assert.equal(f.calls.length, 0)
})
test('dashboard-control-http: loopback transport and host command endpoint work together without relaxing Origin checks', async t => {
  const received = []
  const server = createApi({ dashboardControl: { snapshot: () => ({ protocol: 1, phase: 'spawned' }), execute: async data => { received.push(data); return { ok: true } } }, snapshot: () => ({}) })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)))
  const port = server.address().port
  assert.equal((await requestControl({ apiPort: port })).protocol, 1)
  assert.equal((await requestControl({ apiPort: port, payload: { command: 'plan' } })).ok, true)
  const forbidden = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/dashboard/action', headers: { Host: `127.0.0.1:${port}`, Origin: 'http://127.0.0.1:3001', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode) })
    req.end('{}')
  })
  assert.equal(forbidden, 403); assert.equal(received.length, 1)
})

test('dashboard-control-http: reset writes use the same strict JSON, token, Host and Origin boundary as quarry writes', async t => {
  const f = fixture(t), token = (await f.call()).value.token
  const valid = { method: 'POST', url: '/api/control/loadout', token, origin: 'http://127.0.0.1:3001', body: JSON.stringify({ command: 'resetPreview', session: 's' }) }
  for (const extra of [{ token: null }, { origin: null }, { origin: 'https://evil.invalid' }, { host: 'evil.invalid:3001' }]) assert.equal((await f.call({ ...valid, ...extra })).status, 403)
  assert.equal((await f.call({ ...valid, method: 'GET' })).status, 404)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.call(valid)).status, 200)
  assert.deepEqual(f.calls, [['loadout', { command: 'resetPreview', session: 's' }]])
})
