'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { createDashboard, requestLocalStatus, readJson, writeAtomicJson, apiPortNumber } = require('../scripts/dashboard')
const { sanitizeStatus } = require('../scripts/lib/dashboard-state')
const at = '2026-10-31T02:35:43.191Z'
const later = '2026-10-31T03:00:00.000Z'
const live = () => ({ phase: 'spawned', health: 19, playerName: 'HouchiChan', position: { x: -39.5, y: 71.62, z: 24.43 }, positionSource: 'client_prediction', inventory: { known: true, items: [{ name: 'minecraft:dirt', count: 12 }] } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }

function fixture ({ seed = null, request = async () => live(), mission = null, writeFailure = false } = {}) {
  const reads = []; const writes = []; const requests = []
  let now = at
  const dashboard = createDashboard({ workspaceRoot: path.resolve('dashboard-test-workspace'), clock: () => now,
    requestStatus: options => { requests.push(options); return request(options) },
    readJsonFile: async (filename, maximum) => { reads.push({ filename, maximum }); if (filename.endsWith('dashboard-last.json') && seed) return seed; if (filename.endsWith('mission-status.json') && mission) return mission; throw new Error('No saved file') },
    writeSnapshot: async (filename, value) => { if (writeFailure) throw new Error('Disk unavailable'); writes.push({ filename, value: structuredClone(value) }) },
    readHtml: async filename => { reads.push({ filename }); return Buffer.from('<!doctype html><title>Bot progress</title>') }
  })
  return { dashboard, reads, writes, requests, setTime: value => { now = value } }
}

async function call (dashboard, { method = 'GET', url = '/api/status', host = '127.0.0.1:3001', origin, fetchSite } = {}) {
  const result = { resumed: false }
  const request = { method, url, headers: { host, ...(origin === undefined ? {} : { origin }), ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}) }, resume: () => { result.resumed = true } }
  const response = { writeHead: (status, headers) => { result.status = status; result.headers = headers }, end: body => { result.body = body?.toString('utf8') ?? ''; result.json = result.body.startsWith('{') ? JSON.parse(result.body) : null } }
  await dashboard.handler(request, response)
  return result
}

test('construction is passive and a missing offline cache stays unknown without starting a server or Bot', async t => {
  const f = fixture({ request: async () => { throw new Error('offline') } })
  t.after(() => f.dashboard.stop())
  assert.equal(f.dashboard.server.listening, false)
  assert.equal(f.reads.length, 0)
  assert.equal(f.requests.length, 0)
  await f.dashboard.initialize()
  const initial = await call(f.dashboard)
  assert.equal(initial.status, 200)
  assert.equal(initial.json.apiAvailable, false)
  assert.equal(initial.json.online, false)
  assert.equal(initial.json.stale, true)
  assert.equal(initial.json.inventoryKnown, false)
  assert.equal(initial.json.health, null)
  assert.equal(initial.json.observedAt, null)
  await f.dashboard.pollOnce()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].apiPort, 3000)
  assert.equal(f.requests[0].timeoutMs, 800)
  assert.equal(f.writes.length, 0)
})

test('live observations are sanitized/persisted and offline keeps the last good snapshot with a new checkedAt', async t => {
  let available = true
  const f = fixture({ request: async () => { if (!available) throw new Error('private-connection-error'); const status = live(); status.auth = { token: 'private-token' }; return status } })
  t.after(() => f.dashboard.stop())
  await f.dashboard.pollOnce()
  assert.equal(f.dashboard.snapshot().online, true)
  assert.equal(f.dashboard.snapshot().position.y, 70)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].value.observedAt, at)
  assert.ok(!JSON.stringify(f.writes).includes('private-token'))
  available = false; f.setTime(later)
  await f.dashboard.pollOnce()
  const offline = f.dashboard.snapshot()
  assert.equal(offline.apiAvailable, false)
  assert.equal(offline.online, false)
  assert.equal(offline.stale, true)
  assert.equal(offline.health, 19)
  assert.equal(offline.inventory[0].count, 12)
  assert.equal(offline.observedAt, at)
  assert.equal(offline.checkedAt, later)
  assert.equal(f.writes.length, 1)
  assert.ok(!JSON.stringify(offline).includes('private-connection-error'))
})

test('authentication is current but cannot erase the last world cache, and a disk failure does not fake offline status', async t => {
  let authentication = true
  const seed = sanitizeStatus(live(), { observedAt: at, apiAvailable: false })
  const f = fixture({ seed, writeFailure: true, request: async () => authentication ? { phase: 'authenticating', auth: { code: 'do-not-expose' } } : live() })
  t.after(() => f.dashboard.stop())
  await f.dashboard.pollOnce()
  assert.equal(f.dashboard.snapshot().apiAvailable, true)
  assert.equal(f.dashboard.snapshot().phase, 'authenticating')
  assert.equal(f.dashboard.snapshot().online, false)
  assert.equal(f.dashboard.snapshot().health, null)
  assert.equal(f.writes.length, 0)
  authentication = false
  await f.dashboard.pollOnce()
  assert.equal(f.dashboard.snapshot().online, true)
  assert.equal(f.dashboard.snapshot().health, 19)
})

test('single-flight polling returns the same pending task and read-only HTTP never adds a Bot request', async t => {
  const pending = deferred()
  const f = fixture({ request: () => pending.promise })
  t.after(() => f.dashboard.stop())
  const first = f.dashboard.pollOnce()
  const second = f.dashboard.pollOnce()
  assert.equal(first, second)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.requests.length, 1)
  await call(f.dashboard); await call(f.dashboard, { url: '/' })
  assert.equal(f.requests.length, 1)
  pending.resolve(live()); await first
  assert.equal(f.dashboard.snapshot().online, true)
})

test('saved public cache is offline/stale and mission descriptions cannot replace real player/items', async t => {
  const seed = sanitizeStatus(live(), { observedAt: at })
  const f = fixture({ seed, mission: { version: 1, work: { title: '石の採取を準備中', state: 'preparing', next: '石を5個集める' }, milestones: [{ id: 'diamond', label: 'ダイヤ', status: 'done' }], health: 20, inventory: [{ name: 'minecraft:diamond', count: 100 }], auth: { token: 'hidden' } } })
  t.after(() => f.dashboard.stop())
  await f.dashboard.initialize()
  const status = f.dashboard.snapshot()
  assert.equal(status.stale, true)
  assert.equal(status.online, false)
  assert.equal(status.health, 19)
  assert.equal(status.position.y, 70)
  assert.equal(status.work.title, '石の採取を準備中')
  assert.equal(status.milestones.find(row => row.id === 'diamond').status, 'pending')
  assert.ok(!JSON.stringify(status).includes('hidden'))
  assert.ok(f.reads.some(row => row.filename.endsWith('mission-status.json') && row.maximum === 64 * 1024))
})

test('HTTP accepts only the exact local host/origin and GET/HEAD for its two fixed routes', async t => {
  const f = fixture()
  t.after(() => f.dashboard.stop())
  for (const args of [{ host: 'evil.test:3001' }, { host: 'localhost:3001' }, { host: '127.0.0.1:3000' }, { origin: 'https://evil.test' }, { origin: 'null' }, { fetchSite: 'cross-site' }]) assert.equal((await call(f.dashboard, args)).status, 403)
  const good = await call(f.dashboard, { origin: 'http://127.0.0.1:3001' })
  assert.equal(good.status, 200)
  assert.equal(good.headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(good.headers['Cache-Control'], 'no-store')
  assert.equal((await call(f.dashboard, { method: 'HEAD' })).body, '')
  for (const method of ['POST', 'DELETE', 'PUT', 'OPTIONS']) {
    const rejected = await call(f.dashboard, { method, url: '/disconnect' })
    assert.equal(rejected.status, 405)
    assert.equal(rejected.headers.Allow, 'GET, HEAD')
    assert.equal(rejected.resumed, true)
  }
  assert.equal((await call(f.dashboard, { url: '/' })).headers['Content-Type'], 'text/html; charset=utf-8')
  assert.equal((await call(f.dashboard, { url: '/', method: 'HEAD' })).body, '')
  assert.equal((await call(f.dashboard, { url: '/.auth/private' })).status, 404)
  assert.equal((await call(f.dashboard, { url: 'http://evil.test/' })).status, 400)
  assert.equal((await call(f.dashboard, { url: '//evil.test/' })).status, 400)
  assert.equal((await call(f.dashboard, { url: '/' + 'a'.repeat(2048) })).status, 400)
  assert.equal(f.requests.length, 0)
  assert.ok(f.reads.every(row => row.filename.endsWith('dashboard/index.html') || row.filename.endsWith('dashboard\\index.html')))
})

test('the fixed transport uses only local GET /status and aborts by its total timeout without following redirects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  t.mock.method(http, 'request', (options, receive) => {
    calls.push(options)
    const request = new EventEmitter()
    request.end = () => {}
    request.destroy = error => { if (error) request.emit('error', error) }
    return request
  })
  const promise = requestLocalStatus({ apiPort: 3000, timeoutMs: 800, signal: new AbortController().signal })
  const rejection = assert.rejects(promise, /timed out/)
  t.mock.timers.tick(800)
  await rejection
  assert.deepEqual(calls[0], { hostname: '127.0.0.1', port: 3000, path: '/status', method: 'GET', agent: false, headers: { Host: '127.0.0.1:3000', Accept: 'application/json' } })
  assert.equal(calls.length, 1)
})

test('the status transport refuses redirects, non-JSON, malformed and oversized responses without proxying elsewhere', async t => {
  const calls = []
  let mode = 'redirect'
  t.mock.method(http, 'request', (options, receive) => {
    calls.push(options)
    const request = new EventEmitter()
    request.destroy = error => { if (error) request.emit('error', error) }
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = mode === 'redirect' ? 302 : 200
      response.headers = { 'content-type': mode === 'html' ? 'text/html' : 'application/json', location: 'https://external.invalid/private' }
      response.resume = () => {}
      receive(response)
      if (mode === 'redirect' || mode === 'html') return
      response.emit('data', Buffer.from(mode === 'oversize' ? 'x'.repeat(1024 * 1024 + 1) : '{not json'))
      response.emit('end')
    })
    return request
  })
  for (mode of ['redirect', 'html', 'malformed', 'oversize']) await assert.rejects(requestLocalStatus({ apiPort: 3000, timeoutMs: 800, signal: new AbortController().signal }))
  assert.equal(calls.length, 4)
  assert.ok(calls.every(row => row.hostname === '127.0.0.1' && row.path === '/status' && row.method === 'GET'))
})

test('bounded JSON read and atomic cache replacement store public values only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-dashboard-test-'))
  const filename = path.join(directory, 'dashboard-last.json')
  try {
    await writeAtomicJson(filename, sanitizeStatus(live(), { observedAt: at }))
    assert.equal((await readJson(filename, 256 * 1024)).inventory[0].label, '土')
    const empty = live(); empty.inventory.items = []
    await writeAtomicJson(filename, sanitizeStatus(empty, { observedAt: later }))
    assert.deepEqual((await readJson(filename, 256 * 1024)).inventory, [])
    assert.deepEqual(await fs.readdir(directory), ['dashboard-last.json'])
    await assert.rejects(readJson(filename, 10), /bound/)
    await fs.writeFile(filename, '{broken json')
    await assert.rejects(readJson(filename, 256 * 1024), SyntaxError)
  } finally { await fs.unlink(filename).catch(() => {}); await fs.rmdir(directory) }
})

test('invalid API ports and poll bounds cannot create an arbitrary remote target or excessive poll rate', () => {
  for (const value of [0, 65536, NaN, true, null, '', '3000/status', 'https://evil.test', '3e3']) assert.throws(() => apiPortNumber(value))
  assert.equal(apiPortNumber('3000'), 3000)
  assert.throws(() => createDashboard({ pollIntervalMs: 100 }), /polling bounds/)
  assert.throws(() => createDashboard({ pollTimeoutMs: 801 }), /polling bounds/)
})
