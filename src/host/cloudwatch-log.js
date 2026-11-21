'use strict'

const os = require('node:os')

const EVENT_OVERHEAD = 26
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_MESSAGE_BYTES = 64 * 1024
const ERROR_CODES = new Set([
  'AccessDeniedException', 'UnrecognizedClientException', 'InvalidSignatureException',
  'ExpiredTokenException', 'ResourceNotFoundException', 'InvalidParameterException',
  'ThrottlingException', 'ServiceUnavailableException', 'OperationAbortedException',
  'CredentialsProviderError', 'TimeoutError', 'AbortError', 'NetworkingError',
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'
])

function readConfig (env) {
  const value = (key, fallback = '') => String(env[key] ?? fallback).trim()
  const accessKeyId = value('CLOUDWATCH_ACCESS_KEY_ID')
  const secretAccessKey = value('CLOUDWATCH_SECRET_ACCESS_KEY')
  const sessionToken = value('CLOUDWATCH_SESSION_TOKEN')
  if (!accessKeyId && !secretAccessKey) return { enabled: false, reason: 'NOT_CONFIGURED' }
  if (!accessKeyId || !secretAccessKey) return { enabled: false, reason: 'INCOMPLETE_CREDENTIALS' }
  const region = value('CLOUDWATCH_REGION') || 'ap-northeast-1'
  const logGroupName = value('CLOUDWATCH_LOG_GROUP') || '/minecraft-bot/personal'
  const logStreamName = value('CLOUDWATCH_LOG_STREAM') || `${os.hostname()}/${value('BOT_PROFILE') || 'main'}`
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(region) || !region.includes('-') ||
      !/^[.\-_/#A-Za-z0-9]{1,512}$/.test(logGroupName) ||
      logStreamName.length > 512 || /[:*\x00-\x1f\x7f]/.test(logStreamName)) {
    return { enabled: false, reason: 'INVALID_CONFIGURATION' }
  }
  return { enabled: true, region, logGroupName, logStreamName, accessKeyId, secretAccessKey, sessionToken }
}

function redact (message, secrets) {
  let text = String(message)
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:["']?\b(?:aws_)?(?:secret_?access_?key|access_?key_?id|session_?token|access_?token|refresh_?token|id_?token|password)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"[REDACTED]"')
    .replace(/((?:["']?\b(?:aws_)?(?:secret_?access_?key|access_?key_?id|session_?token|access_?token|refresh_?token|id_?token|password)["']?)\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
}

function truncateUtf8 (text, limit) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  const marker = ' [truncated]'
  let end = Math.max(0, limit - Buffer.byteLength(marker))
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8') + (limit >= marker.length ? marker : '')
}

function sdkTransport (config, requestTimeoutMs) {
  let client
  return {
    async send (input, { signal }) {
      // Do not load the SDK, consult shared profiles, or contact AWS until a
      // configured logger actually has events. Only the dedicated keys apply.
      const { CloudWatchLogsClient, PutLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs')
      client ??= new CloudWatchLogsClient({
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          ...(config.sessionToken ? { sessionToken: config.sessionToken } : {})
        },
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
        requestHandler: { connectionTimeout: requestTimeoutMs, requestTimeout: requestTimeoutMs, throwOnRequestTimeout: true }
      })
      return client.send(new PutLogEventsCommand(input), { abortSignal: signal })
    },
    close () { client?.destroy() }
  }
}

// This publisher owns no game state. All network work runs after write returns;
// its bounded queue includes the in-flight batch, measured in API event bytes.
function createCloudWatchLog ({
  env = process.env, transport, now = Date.now, report = () => {},
  flushIntervalMs = 5000, requestTimeoutMs = 2000, shutdownTimeoutMs = 3000,
  maxQueueBytes = 1024 * 1024, maxBatchBytes = 256 * 1024, maxBatchEvents = 1000,
  maxAttempts = 3, retryBaseMs = 1000, retryMaxMs = 60000
} = {}) {
  const config = readConfig(env)
  const secrets = [config.accessKeyId, config.secretAccessKey, config.sessionToken].filter(Boolean).sort((a, b) => b.length - a.length)
  const batchLimit = Math.min(maxBatchBytes, 1048576)
  const eventLimit = Math.min(maxBatchEvents, 10000)
  const messageLimit = Math.min(MAX_MESSAGE_BYTES, batchLimit - EVENT_OVERHEAD)
  const queue = []
  let inFlight = [], queuedBytes = 0, task = null, timer = null, controller = null
  let closing = false, closed = false, closeTask = null, transportCloseTask = null
  let sentEvents = 0, droppedEvents = 0, rejectedEvents = 0, failedBatches = 0
  let lastError = null, lastSuccessAt = null, failures = 0
  let lastReportAt = -Infinity, lastReportCode = null
  const sender = config.enabled ? (transport ?? sdkTransport(config, requestTimeoutMs)) : null

  function diagnose (code, force = false) {
    lastError = code
    const timestamp = now()
    if (!force && code === lastReportCode && timestamp - lastReportAt < 60000) return
    lastReportAt = timestamp; lastReportCode = code
    // No server error text, request objects, credentials, or endpoints here.
    try { report(`CloudWatch Logs: ${code}（ローカルのログ記録は継続します）`) } catch {}
  }

  function clearTimer () {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedule (delay) {
    if (closing || closed || timer || !queue.length) return
    timer = setTimeout(() => { timer = null; void flush() }, delay)
    timer.unref?.()
  }

  function discard (events) {
    for (const event of events) queuedBytes -= event.bytes
    droppedEvents += events.length
  }

  function takeBatch () {
    queue.sort((a, b) => a.timestamp - b.timestamp)
    const batch = []
    let bytes = 0
    while (queue.length && batch.length < eventLimit) {
      const event = queue[0]
      if (batch.length && (bytes + event.bytes > batchLimit || event.timestamp - batch[0].timestamp > DAY_MS)) break
      batch.push(queue.shift()); bytes += event.bytes
    }
    return batch
  }

  async function send (batch) {
    const activeController = new AbortController()
    controller = activeController
    let deadline, onAbort
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => {
        const error = new Error('CloudWatch delivery aborted')
        error.name = 'AbortError'
        reject(error)
      }
      activeController.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timeout = new Promise((resolve, reject) => {
      deadline = setTimeout(() => {
        const error = new Error('CloudWatch delivery timed out')
        error.name = 'TimeoutError'
        reject(error)
        activeController.abort()
      }, requestTimeoutMs)
    })
    try {
      return await Promise.race([
        Promise.resolve().then(() => sender.send({
          logGroupName: config.logGroupName,
          logStreamName: config.logStreamName,
          logEvents: batch.map(({ message, timestamp }) => ({ message, timestamp }))
        }, { signal: activeController.signal })),
        timeout,
        aborted
      ])
    } finally {
      clearTimeout(deadline)
      activeController.signal.removeEventListener('abort', onAbort)
      if (controller === activeController) controller = null
    }
  }

  function countRejected (info, length) {
    if (!info) return 0
    const indices = new Set()
    for (const key of ['tooOldLogEventEndIndex', 'expiredLogEventEndIndex']) {
      if (Number.isInteger(info[key])) {
        for (let i = 0; i <= Math.min(info[key], length - 1); i++) indices.add(i)
      }
    }
    if (Number.isInteger(info.tooNewLogEventStartIndex)) {
      for (let i = Math.max(0, info.tooNewLogEventStartIndex); i < length; i++) indices.add(i)
    }
    return indices.size
  }

  async function drain () {
    while (!closed && queue.length) {
      inFlight = takeBatch()
      const batch = inFlight
      try {
        const response = await send(batch)
        if (closed) return
        const rejected = countRejected(response?.rejectedLogEventsInfo, batch.length)
        for (const event of batch) queuedBytes -= event.bytes
        sentEvents += batch.length - rejected
        rejectedEvents += rejected; droppedEvents += rejected
        failures = 0
        if (rejected) diagnose('REJECTED_LOG_EVENTS')
        else lastError = null
        if (rejected < batch.length) lastSuccessAt = now()
      } catch (error) {
        if (closed) return
        failedBatches++; failures++
        const code = [error?.name, error?.code].find(value => ERROR_CODES.has(value)) || 'DELIVERY_FAILED'
        diagnose(code)
        const retry = []
        for (const event of batch) {
          event.attempts++
          if (event.attempts < maxAttempts) retry.push(event)
          else discard([event])
        }
        queue.unshift(...retry)
        inFlight = []
        schedule(Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures - 1, 20)))
        return
      }
      inFlight = []
    }
  }

  function write (message, timestamp = now()) {
    if (!config.enabled || closing || closed) return false
    try {
      if (!Number.isSafeInteger(timestamp) || messageLimit < 1 || eventLimit < 1) {
        droppedEvents++; diagnose('INVALID_LOG_EVENT'); return false
      }
      const text = truncateUtf8(redact(message, secrets), messageLimit)
      const bytes = Buffer.byteLength(text, 'utf8') + EVENT_OVERHEAD
      if (!text || bytes > batchLimit || queuedBytes + bytes > maxQueueBytes) {
        droppedEvents++; diagnose('QUEUE_FULL'); return false
      }
      queue.push({ message: text, timestamp, bytes, attempts: 0 })
      queuedBytes += bytes
      // An active drain will pick up new events itself. A normal flush timer
      // here would otherwise hide the shorter retry timer after a failure.
      if (!task) schedule(flushIntervalMs)
      return true
    } catch {
      droppedEvents++; diagnose('INVALID_LOG_EVENT'); return false
    }
  }

  function flush () {
    if (closed || !config.enabled) return Promise.resolve()
    clearTimer()
    if (task) return task
    // Schedule drain in a microtask so a synchronous failure cannot race task.
    const work = Promise.resolve().then(drain)
    task = work
    void work.then(() => {
      if (task === work) task = null
      schedule(flushIntervalMs)
    }, () => {
      if (task === work) task = null
      diagnose('DELIVERY_FAILED')
      schedule(flushIntervalMs)
    })
    return work
  }

  function close () {
    if (closeTask) return closeTask
    closing = true
    clearTimer()
    closeTask = (async () => {
      let deadline
      const timeout = new Promise(resolve => { deadline = setTimeout(resolve, shutdownTimeoutMs) })
      try {
        await Promise.race([
          (async () => { await flush(); await closeTransport() })(),
          timeout
        ])
      } catch { diagnose('CLOSE_FAILED') } finally {
        clearTimeout(deadline)
        closed = true
        controller?.abort()
        // destroy is synchronous in the SDK. A custom transport may be late;
        // observe its rejection without letting it extend the shutdown bound.
        void closeTransport().catch(() => {})
        if (queue.length || inFlight.length) {
          discard([...queue, ...inFlight])
          diagnose('UNSENT_LOG_EVENTS', true)
        }
        queue.length = 0; inFlight = []; queuedBytes = 0
      }
    })()
    return closeTask
  }

  function closeTransport () {
    transportCloseTask ??= Promise.resolve().then(() => sender?.close?.())
    return transportCloseTask
  }

  function snapshot () {
    return {
      enabled: config.enabled, reason: config.reason ?? null,
      queuedBytes, queuedEvents: queue.length + inFlight.length,
      sentEvents, droppedEvents, rejectedEvents, failedBatches, lastError,
      lastSuccessAt, closing, closed
    }
  }

  if (!config.enabled && config.reason !== 'NOT_CONFIGURED') diagnose(config.reason)
  if (config.enabled) {
    try { report('CloudWatch Logs: 追加送信を有効にしました。') } catch {}
  }
  return { write, flush, close, snapshot }
}

module.exports = { createCloudWatchLog }
