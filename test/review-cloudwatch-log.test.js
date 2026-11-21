'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { hostname } = require('node:os')
const { createCloudWatchLog } = require('../src/host/cloudwatch-log')

// Deliberately fictitious credentials. Every enabled logger below receives a
// transport double; neither the SDK nor a real AWS endpoint is used here.
const credentials = {
  CLOUDWATCH_ACCESS_KEY_ID: 'fixture-access-key-only',
  CLOUDWATCH_SECRET_ACCESS_KEY: 'fixture-secret-key-only',
  CLOUDWATCH_SESSION_TOKEN: 'fixture-session-token-only'
}
const NOW = Date.UTC(2026, 10, 21, 0, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const deferred = () => Promise.withResolvers()
const bytes = event => Buffer.byteLength(event.message, 'utf8') + 26

function fixture (t, options = {}) {
  const calls = [], reports = []
  let closes = 0
  const send = options.send ?? (async () => ({}))
  const transport = {
    send: async (input, { signal }) => {
      calls.push({ input: structuredClone(input), signal })
      return send(input, { signal }, calls.length)
    },
    close: () => { closes++; return options.transportClose?.() }
  }
  const { send: ignoredSend, transportClose, ...config } = options
  const log = createCloudWatchLog({
    env: { ...credentials, BOT_PROFILE: 'fixture-bot' }, transport,
    now: () => NOW, report: (...args) => reports.push(args),
    flushIntervalMs: 60000, requestTimeoutMs: 500, shutdownTimeoutMs: 100,
    retryBaseMs: 20, retryMaxMs: 20, ...config
  })
  t.after(() => bounded(log.close()))
  return { log, calls, reports, get closes () { return closes } }
}

// Production timers may be unref'd so logging cannot keep the Bot alive.
// This test-only deadline also keeps the event loop alive while awaiting them.
async function bounded (promise, message = 'CloudWatch logger did not settle', limitMs = 1500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), limitMs) })
    ])
  } finally { clearTimeout(timer) }
}

test('review: CloudWatch is disabled without both dedicated keys, including ordinary AWS credentials', async t => {
  const configurations = [
    {},
    { CLOUDWATCH_ACCESS_KEY_ID: credentials.CLOUDWATCH_ACCESS_KEY_ID },
    { CLOUDWATCH_SECRET_ACCESS_KEY: credentials.CLOUDWATCH_SECRET_ACCESS_KEY },
    { AWS_ACCESS_KEY_ID: 'unrelated-access', AWS_SECRET_ACCESS_KEY: 'unrelated-secret', AWS_REGION: 'us-east-1' }
  ]
  for (const env of configurations) {
    const f = fixture(t, { env })
    assert.equal(f.log.write('Bot operation continues'), false)
    await f.log.flush()
    await f.log.close()
    assert.equal(f.calls.length, 0)
    assert.equal(f.log.snapshot().enabled, false)
    assert.equal(f.log.write('after shutdown'), false)
  }
})

test('review: CloudWatch uses its configured destination and epoch milliseconds, not local log prefixes', async t => {
  const f = fixture(t)
  assert.equal(f.log.write('既定の送信先'), true)
  await f.log.flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].input.logGroupName, '/minecraft-bot/personal')
  assert.equal(f.calls[0].input.logStreamName, `${hostname()}/fixture-bot`)
  assert.deepEqual(f.calls[0].input.logEvents, [{ message: '既定の送信先', timestamp: NOW }])

  const defaultProfile = fixture(t, { env: { ...credentials } })
  defaultProfile.log.write('default profile')
  await defaultProfile.log.close()
  assert.equal(defaultProfile.calls[0].input.logStreamName, `${hostname()}/main`)

  const custom = fixture(t, { env: { ...credentials, CLOUDWATCH_LOG_GROUP: '/fixture/group', CLOUDWATCH_LOG_STREAM: 'fixture/stream' } })
  custom.log.write('later', NOW + 2)
  custom.log.write('earlier', NOW)
  custom.log.write('same timestamp', NOW)
  await custom.log.flush()
  assert.equal(custom.calls[0].input.logGroupName, '/fixture/group')
  assert.equal(custom.calls[0].input.logStreamName, 'fixture/stream')
  assert.deepEqual(custom.calls.flatMap(call => call.input.logEvents), [
    { message: 'earlier', timestamp: NOW },
    { message: 'same timestamp', timestamp: NOW },
    { message: 'later', timestamp: NOW + 2 }
  ])
})

test('review: CloudWatch batches count UTF-8 bytes and per-event overhead, and enforce event and 24-hour limits', async t => {
  const f = fixture(t, { maxBatchBytes: 100, maxBatchEvents: 2 })
  const messages = ['界'.repeat(16), 'x'.repeat(10), '二'.repeat(12), 'a', 'b', 'c', 'd', 'e']
  for (const [index, message] of messages.entries()) assert.equal(f.log.write(message, NOW + index), true)
  await f.log.flush()
  assert.deepEqual(f.calls.flatMap(call => call.input.logEvents).map(event => event.message), messages)
  assert.ok(f.calls.length > 1)
  for (const { input } of f.calls) {
    assert.ok(input.logEvents.length <= 2)
    assert.ok(input.logEvents.reduce((total, event) => total + bytes(event), 0) <= 100)
  }

  const span = fixture(t)
  const times = [NOW - DAY - 1, NOW - 1, NOW]
  for (const [index, timestamp] of times.entries()) span.log.write(`event ${index}`, timestamp)
  await span.log.flush()
  assert.equal(span.calls.length, 2, 'a 24-hour boundary is allowed, a longer batch must split')
  assert.deepEqual(span.calls.flatMap(call => call.input.logEvents).map(event => event.timestamp), times)
  for (const { input } of span.calls) assert.ok(input.logEvents.at(-1).timestamp - input.logEvents[0].timestamp <= DAY)
})

test('review: failed in-flight batches retain their queue budget and retry without losing accepted events', async t => {
  const first = deferred(), started = deferred(), retry = deferred()
  const began = Date.now()
  const f = fixture(t, {
    now: () => NOW + Date.now() - began,
    maxQueueBytes: 100, maxBatchBytes: 100,
    send: async (input, options, attempt) => {
      if (attempt === 1) { started.resolve(); return first.promise }
      retry.resolve()
      return {}
    }
  })
  const a = 'a'.repeat(20), b = 'b'.repeat(20)
  assert.equal(f.log.write(a), true)
  const sending = f.log.flush()
  await bounded(started.promise)
  assert.equal(f.calls.length, 1)
  assert.equal(f.log.write(b, NOW + 1), true)
  assert.equal(f.log.write('c'.repeat(20), NOW + 2), false, 'in-flight bytes cannot be reused before acknowledgement')
  assert.ok(f.log.snapshot().queuedBytes <= 100)
  first.reject(Object.assign(new Error('temporary throttle'), { name: 'ThrottlingException' }))
  await sending
  await bounded(retry.promise, 'retained events were never retried')
  await f.log.flush()
  assert.deepEqual(f.calls.slice(1).flatMap(call => call.input.logEvents).map(event => event.message), [a, b])
  assert.equal(f.log.snapshot().queuedBytes, 0)
  assert.equal(f.log.snapshot().sentEvents, 2)
  assert.equal(f.log.snapshot().droppedEvents, 1)
  assert.equal(f.log.snapshot().failedBatches, 1)
})

test('review: automatic flush sends quiet logs without requiring Bot shutdown', async t => {
  const sent = deferred()
  const f = fixture(t, { flushIntervalMs: 10, send: async () => { sent.resolve(); return {} } })
  assert.equal(f.log.write('a single quiet event'), true)
  await bounded(sent.promise, 'the interval never sent the buffered event')
  await f.log.flush()
  assert.deepEqual(f.calls.flatMap(call => call.input.logEvents).map(event => event.message), ['a single quiet event'])
  assert.equal(f.log.snapshot().queuedBytes, 0)
})

test('review: CloudWatch aborts an unresponsive request and shutdown is bounded and idempotent', async t => {
  const successful = fixture(t)
  successful.log.write('final event before shutdown')
  const firstClose = successful.log.close(), concurrentClose = successful.log.close()
  assert.equal(firstClose, concurrentClose)
  await bounded(Promise.all([firstClose, concurrentClose]))
  assert.deepEqual(successful.calls.flatMap(call => call.input.logEvents).map(event => event.message), ['final event before shutdown'])
  assert.equal(successful.log.snapshot().sentEvents, 1)
  assert.equal(successful.log.snapshot().droppedEvents, 0)
  assert.equal(successful.closes, 1)

  const f = fixture(t, {
    requestTimeoutMs: 25, shutdownTimeoutMs: 25, retryBaseMs: 60000, retryMaxMs: 60000,
    send: async () => new Promise(() => {})
  })
  f.log.write('request timeout')
  await bounded(f.log.flush(), 'an unresponsive transport prevented flush timeout')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].signal.aborted, true)
  assert.ok(f.log.snapshot().queuedBytes > 0, 'a timed-out request was not acknowledged')
  assert.equal(f.log.snapshot().sentEvents, 0)
  assert.equal(f.log.snapshot().failedBatches, 1)

  // Even transport.close() is allowed to be faulty: it must not own Bot exit.
  const started = deferred()
  const shutdown = fixture(t, {
    requestTimeoutMs: 1500, shutdownTimeoutMs: 25,
    send: async () => { started.resolve(); return new Promise(() => {}) }, transportClose: () => new Promise(() => {})
  })
  shutdown.log.write('shutdown deadline')
  const inFlight = shutdown.log.flush()
  await bounded(started.promise)
  const a = shutdown.log.close(), b = shutdown.log.close()
  await bounded(Promise.all([a, b, inFlight]), 'shutdown did not release an unresponsive transport', 500)
  assert.equal(shutdown.calls.length, 1)
  assert.equal(shutdown.calls[0].signal.aborted, true)
  assert.equal(shutdown.closes, 1)
  assert.equal(shutdown.log.write('too late'), false)
  assert.equal(shutdown.log.snapshot().queuedBytes, 0)
  assert.equal(shutdown.log.snapshot().sentEvents, 0)
  assert.equal(shutdown.log.snapshot().closed, true)
  await bounded(shutdown.log.close())
  await shutdown.log.flush()
  assert.equal(shutdown.closes, 1)
  assert.equal(shutdown.calls.length, 1)
})

test('review: credentials, bearer tokens and JWTs do not enter CloudWatch messages or failure diagnostics', async t => {
  const bearer = 'fixture-private-bearer', jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.signature'
  const spacePassword = 'space-prefix fixture-space-suffix'
  const escapedPassword = 'quote-prefix "fixture-quote-secret" fixture-escape-suffix'
  const camelSecret = 'fixtureCamelCaseSecret'
  const secrets = [
    ...Object.values(credentials), bearer, jwt, camelSecret,
    'space-prefix', 'fixture-space-suffix', 'quote-prefix', 'fixture-quote-secret', 'fixture-escape-suffix'
  ]
  const message = `operation ${Object.values(credentials).join(' ')} Bearer ${bearer} ${jwt} password="${spacePassword}" ${JSON.stringify({ password: escapedPassword, secretAccessKey: camelSecret })}`
  const f = fixture(t, {
    maxAttempts: 1,
    send: async () => { throw Object.assign(new Error(message), { name: 'AccessDeniedException' }) }
  })
  assert.equal(f.log.write(message), true)
  await f.log.flush()
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].input.logEvents[0].message.includes('operation'))
  assert.ok(f.reports.some(args => args.some(value => typeof value === 'string' && value.includes('AccessDeniedException'))), 'failure is observable even though logging remains non-fatal')
  assert.equal(f.log.snapshot().lastError, 'AccessDeniedException')
  const publicValues = JSON.stringify({ input: f.calls[0].input, snapshot: f.log.snapshot(), reports: f.reports })
  for (const secret of secrets) assert.equal(publicValues.includes(secret), false, 'a secret escaped the logging boundary')
  assert.equal(f.log.snapshot().sentEvents, 0)
  assert.equal(f.log.snapshot().droppedEvents, 1)
  assert.equal(f.log.snapshot().failedBatches, 1)
  assert.equal(f.log.snapshot().queuedBytes, 0, 'maxAttempts=1 must release a permanently failing batch')
  await f.log.close()
})

test('review: HTTP 200 rejected events are reported, and acknowledged events are never retried with them', async t => {
  const f = fixture(t, {
    send: async () => ({
      $metadata: { httpStatusCode: 200 },
      rejectedLogEventsInfo: { tooOldLogEventEndIndex: 0, expiredLogEventEndIndex: 1, tooNewLogEventStartIndex: 4 }
    })
  })
  for (let i = 0; i < 5; i++) f.log.write(`service event ${i}`, NOW - 4 + i)
  await f.log.flush()
  assert.equal(f.calls.length, 1)
  assert.ok(f.reports.some(args => args.some(value => typeof value === 'string' && value.includes('REJECTED_LOG_EVENTS'))), 'HTTP success must not conceal event rejection')
  assert.equal(f.log.snapshot().queuedBytes, 0, 'rejected timestamps are dropped, not retried indefinitely')
  assert.equal(f.log.snapshot().sentEvents, 2)
  assert.equal(f.log.snapshot().rejectedEvents, 3, 'overlapping too-old and expired ranges count once')
  assert.equal(f.log.snapshot().droppedEvents, 3)
  await f.log.flush()
  await f.log.close()
  assert.equal(f.calls.length, 1, 'the accepted part of a partial response must not be sent again')
})

test('review: malformed writes are rejected, oversized UTF-8 is bounded, and throwing diagnostics stay non-fatal', async t => {
  const f = fixture(t, {
    maxBatchBytes: 100, maxAttempts: 1,
    report: () => { throw new Error('diagnostic observer failure') },
    send: async () => { throw new Error('service unavailable') }
  })
  const invalid = { toString () { throw new Error('cannot stringify') } }
  for (const [message, timestamp] of [[invalid, NOW], ['invalid time', NaN]]) {
    let accepted
    assert.doesNotThrow(() => { accepted = f.log.write(message, timestamp) })
    assert.equal(accepted, false)
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.log.write('界'.repeat(100)), true)
  await assert.doesNotReject(f.log.flush())
  assert.equal(f.calls.length, 1)
  const event = f.calls[0].input.logEvents[0]
  assert.ok(bytes(event) <= 100)
  assert.ok(event.message.endsWith(' [truncated]'))
  assert.equal(event.message.includes('\ufffd'), false, 'truncation must not split a UTF-8 character')
  await assert.doesNotReject(f.log.close())
})
