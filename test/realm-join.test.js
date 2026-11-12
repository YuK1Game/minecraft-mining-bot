'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { installRealmJoinHandling } = require('../src/realm-join')

const URL = 'https://pocket.realms.minecraft.net/worlds/12345/join'
function response (status, { retryAfter = null, type = 'application/json', data = { address: 'server:19132' } } = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => name === 'Retry-After' ? retryAfter : name === 'Content-Type' ? type : null },
    body: { destroy () {} }, json: async () => data, text: async () => type === 'application/json' ? JSON.stringify(data) : data }
}
function fixture (t, settings = {}) {
  const delegated = [], requests = [], events = [], waits = []
  let time = 0
  class Rest {
    constructor (platform = 'bedrock') { this.platform = platform; this.maxRetries = 4 }
    execRequest (...args) { delegated.push({ receiver: this, args }); return Promise.resolve('delegated') }
  }
  const original = Rest.prototype.execRequest
  const fetch = async (...args) => { requests.push(args); return response(200) }
  const restore = installRealmJoinHandling({ Rest, fetch, now: () => time, sleep: async milliseconds => { waits.push(milliseconds); time += milliseconds }, onAttempt: event => events.push(event), ...settings })
  t.after(restore)
  return { Rest, original, restore, requests, events, waits, delegated, advance: milliseconds => { time += milliseconds }, run: (options = { method: 'get' }) => new Rest().execRequest(URL, options) }
}

test('realm-join: retries 503 after Retry-After and preserves request headers and JSON success', async t => {
  const requests = [], responses = [response(503, { retryAfter: '3' }), response(200)]
  const f = fixture(t, { fetch: async (...args) => { requests.push(args); return responses.shift() } })
  const headers = { Authorization: 'secret-token', 'Client-Version': '1.26.60' }
  assert.deepEqual(await f.run({ method: 'get', headers }), { address: 'server:19132' })
  assert.deepEqual(f.waits, [3000]); assert.equal(requests.length, 2)
  assert.equal(requests[0][0], URL)
  assert.equal(requests[1][0], requests[0][0])
  assert.equal(requests[0][1].headers, headers)
  assert.deepEqual(f.events, [
    { status: 503, attempt: 1, elapsedMs: 0, waitMs: 3000, retryAfterMs: 3000 },
    { status: 200, attempt: 2, elapsedMs: 3000, waitMs: null, retryAfterMs: null }
  ])
})

test('realm-join: Retry-After HTTP dates and zero are normalized without an early retry', async t => {
  const start = Date.parse('2026-11-12T00:00:00Z')
  let time = start, attempt = 0
  const f = fixture(t, { now: () => time, sleep: async milliseconds => { f.waits.push(milliseconds); time += milliseconds },
    fetch: async () => ++attempt === 1 ? response(503, { retryAfter: new Date(start + 5000).toUTCString() }) : attempt === 2 ? response(503, { retryAfter: '0' }) : response(200, { type: 'text/plain', data: 'ready' }) })
  assert.equal(await f.run(), 'ready'); assert.deepEqual(f.waits, [5000, 0])
})

test('realm-join: attempt limit bounds 503 retries and fallback backoff', async t => {
  let calls = 0
  const f = fixture(t, { maxAttempts: 7, fetch: async () => { calls++; return response(503, { retryAfter: 'invalid-secret-value' }) } })
  await assert.rejects(f.run(), error => error.code === 'REALM_JOIN_UNAVAILABLE' && error.statusCode === 503 && error.attempts === 7 && error.retryAfterMs === null)
  assert.equal(calls, 7); assert.deepEqual(f.waits, [1000, 2000, 4000, 8000, 15000, 15000])
  assert.equal(f.events.at(-1).waitMs, null)
})

test('realm-join: malformed numeric Retry-After values use fallback backoff', async t => {
  const responses = [response(503, { retryAfter: '-1' }), response(503, { retryAfter: '1.5' }), response(200)]
  const f = fixture(t, { fetch: async () => responses.shift() })
  await f.run()
  assert.deepEqual(f.waits, [1000, 2000])
})

test('realm-join: Retry-After beyond the remaining budget fails without sleeping', async t => {
  let calls = 0
  const f = fixture(t, { maxWaitMs: 2000, fetch: async () => { calls++; return response(503, { retryAfter: '3' }) } })
  await assert.rejects(f.run(), error => error.code === 'REALM_JOIN_UNAVAILABLE' && error.retryAfterMs === 3000)
  assert.equal(calls, 1); assert.deepEqual(f.waits, [])
  const g = fixture(t, { fetch: async () => response(503, { retryAfter: '9'.repeat(400) }) })
  await assert.rejects(g.run(), error => error.retryAfterMs === Number.MAX_SAFE_INTEGER)
  assert.deepEqual(g.waits, [])
})

test('realm-join: other 5xx retain four retries and all 4xx fail immediately', async t => {
  for (const status of [500, 502, 401, 403, 429]) {
    let calls = 0
    const f = fixture(t, { fetch: async () => { calls++; return response(status) } })
    await assert.rejects(f.run(), error => error.code === 'REALM_JOIN_FAILED' && error.statusCode === status)
    assert.equal(calls, status >= 500 ? 5 : 1)
    assert.deepEqual(f.waits, status >= 500 ? [1000, 2000, 4000, 8000] : [])
  }
})

test('realm-join: cancellation during retry delay prevents further requests', async t => {
  const controller = new AbortController()
  let calls = 0, enterDelay
  const entered = new Promise(resolve => { enterDelay = resolve })
  const f = fixture(t, { signal: controller.signal, fetch: async () => { calls++; return response(503) }, sleep: async () => { enterDelay(); await new Promise(() => {}) } })
  const pending = f.run()
  await entered; controller.abort(new Error('secret cancellation reason'))
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'REALM_JOIN_UNAVAILABLE')
  assert.equal(calls, 1)
})

test('realm-join: caller signal cancels an inflight fetch even if fetch ignores abort', async t => {
  const controller = new AbortController()
  let entered, requestSignal
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(t, { fetch: async (url, options) => { requestSignal = options.signal; entered(); await new Promise(() => {}) } })
  const pending = f.run({ method: 'get', signal: controller.signal })
  await started; controller.abort(new Error('secret reason'))
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'REALM_JOIN_FAILED' && error.attempts === 1)
  assert.equal(requestSignal.aborted, true)
})

test('realm-join: cancellation before the fetch microtask does not start a request', async t => {
  const controller = new AbortController()
  const f = fixture(t, { signal: controller.signal })
  const pending = f.run()
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'REALM_JOIN_FAILED')
  assert.equal(f.requests.length, 0)
})

test('realm-join: request timeout includes successful body reading and total deadline includes waiting', async t => {
  const f = fixture(t, { requestTimeoutMs: 15, fetch: async () => ({ ...response(200), json: async () => new Promise(() => {}) }) })
  await assert.rejects(f.run(), error => error.code === 'REALM_JOIN_FAILED' && error.statusCode === 200)
  const g = fixture(t, { maxWaitMs: 20, requestTimeoutMs: 15, fetch: async () => response(503, { retryAfter: '0' }), sleep: async () => new Promise(() => {}) })
  await assert.rejects(g.run(), error => error.code === 'REALM_JOIN_UNAVAILABLE')
})

test('realm-join: non-matching routes, platforms and methods delegate unchanged', async t => {
  const f = fixture(t)
  for (const [platform, url, method] of [
    ['java', URL, 'get'], ['bedrock', URL + '?secret=x', 'get'], ['bedrock', 'https://pocket.realms.minecraft.net/worlds', 'get'],
    ['bedrock', 'https://other.example/worlds/1/join', 'get'], ['bedrock', 'https://pocket.realms.minecraft.net/worlds/0/join', 'get'], ['bedrock', URL, 'post']
  ]) {
    const rest = new f.Rest(platform), options = { method }
    assert.equal(await rest.execRequest(url, options, 2), 'delegated')
    const delegated = f.delegated.at(-1)
    assert.equal(delegated.receiver, rest); assert.deepEqual(delegated.args, [url, options, 2])
  }
  assert.equal(f.requests.length, 0); assert.equal(f.events.length, 0)
})

test('realm-join: observations and errors exclude response bodies, URLs, headers and thrown secrets', async t => {
  const secret = 'sensitive-secret-value'
  let discarded = 0
  const f = fixture(t, { fetch: async () => ({ status: 403, statusText: secret, ok: false,
    headers: { get: () => secret }, body: { destroy () { discarded++ } }, text () { throw new Error(secret) }, json () { throw new Error(secret) } }) })
  await assert.rejects(f.run({ method: 'get', headers: { Authorization: secret } }), error => {
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, events: f.events }), new RegExp(secret + '|12345|https:|Authorization'))
    assert.deepEqual(Object.keys(error).sort(), ['attempts', 'code', 'name', 'retryAfterMs', 'statusCode'])
    assert.deepEqual(Object.keys(f.events[0]).sort(), ['attempt', 'elapsedMs', 'retryAfterMs', 'status', 'waitMs'])
    return true
  })
  assert.equal(discarded, 1)
  const g = fixture(t, { fetch: async () => { throw new Error(secret) } })
  await assert.rejects(g.run(), error => error.code === 'REALM_JOIN_FAILED' && !error.message.includes(secret))
  const forged = fixture(t, { fetch: async () => { throw Object.assign(new Error(secret), { name: 'RealmJoinError' }) } })
  await assert.rejects(forged.run(), error => error.code === 'REALM_JOIN_FAILED' && !error.message.includes(secret))
  const forgedAbort = fixture(t, { fetch: async () => { throw Object.assign(new Error(secret), { name: 'AbortError', code: 'REALM_JOIN_FAILED' }) } })
  await assert.rejects(forgedAbort.run(), error => error.code === 'REALM_JOIN_FAILED' && error.name === 'RealmJoinError' && !error.message.includes(secret))
  const h = fixture(t, { onAttempt: () => { throw new Error(secret) } })
  assert.deepEqual(await h.run(), { address: 'server:19132' })
})

test('realm-join: restore is idempotent and preserves an unrelated outer wrapper', async t => {
  const f = fixture(t), installed = f.Rest.prototype.execRequest
  let outerCalls = 0
  const outer = function (...args) { outerCalls++; return installed.apply(this, args) }
  f.Rest.prototype.execRequest = outer
  f.restore(); f.restore()
  assert.equal(f.Rest.prototype.execRequest, outer)
  assert.equal(await f.run(), 'delegated'); assert.equal(outerCalls, 1); assert.equal(f.requests.length, 0)
  const g = fixture(t)
  g.restore(); g.restore(); assert.equal(g.Rest.prototype.execRequest, g.original)
})
