'use strict'

const JOIN_URL = /^https:\/\/pocket\.realms\.minecraft\.net\/worlds\/[1-9]\d*\/join$/

function abortable (task, signal) {
  if (signal.aborted) return Promise.reject(new Error('中断しました。'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => finish(reject, new Error('中断しました。'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error))
  })
}

async function delay (milliseconds, signal) {
  let timer
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, milliseconds) }), signal) } finally { clearTimeout(timer) }
}

function retryAfter (value, now) {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000
    return Math.min(Number.MAX_SAFE_INTEGER, milliseconds)
  }
  if (!/^[A-Za-z]{3,9}[ ,]/.test(text)) return null
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

function discard (response) {
  try {
    if (typeof response.body?.destroy === 'function') response.body.destroy()
    else response.body?.cancel?.().catch(() => {})
  } catch { /* Error bodies never enter diagnostics or exceptions. */ }
}

class RealmJoinError extends Error {
  constructor (statusCode, attempts, retryAfterMs, reason) {
    super(reason === 'cancelled' ? 'Realmへの参加を中止しました。' : reason === 'timeout' ? 'Realmへの参加確認が時間内に完了しませんでした。' : statusCode === 503 ? 'Realmの参加先を準備できませんでした。時間をおいて再接続してください。' : 'Realmへの参加要求に失敗しました。')
    this.name = reason === 'cancelled' ? 'AbortError' : 'RealmJoinError'
    this.code = statusCode === 503 ? 'REALM_JOIN_UNAVAILABLE' : 'REALM_JOIN_FAILED'
    this.statusCode = statusCode
    this.attempts = attempts
    this.retryAfterMs = retryAfterMs
  }
}

// sleep, when supplied, receives (milliseconds, AbortSignal).
function installRealmJoinHandling ({ Rest, fetch, signal, onAttempt, now = Date.now, sleep = delay, maxWaitMs = 120000, maxAttempts = 16, requestTimeoutMs = 15000 } = {}) {
  if (typeof Rest?.prototype?.execRequest !== 'function' || typeof fetch !== 'function' || typeof now !== 'function' || typeof sleep !== 'function' || onAttempt != null && typeof onAttempt !== 'function' || ![maxWaitMs, requestTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('Realm参加処理の設定が不正です。')
  const original = Rest.prototype.execRequest
  let active = true
  async function wrapped (url, options, ...args) {
    if (!active || this.platform !== 'bedrock' || typeof url !== 'string' || !JOIN_URL.test(url) || typeof options?.method !== 'string' || options.method.toLowerCase() !== 'get') return original.call(this, url, options, ...args)
    const startedAt = now()
    const deadline = new AbortController()
    const sources = [signal, options.signal].filter(Boolean)
    const cancelled = sources.length ? AbortSignal.any(sources) : null
    const runSignal = AbortSignal.any([deadline.signal, ...(cancelled ? [cancelled] : [])])
    const deadlineTimer = setTimeout(() => deadline.abort(), maxWaitMs)
    const elapsed = () => Math.max(0, now() - startedAt)
    let attempts = 0, status = null, retryAfterMs = null
    const failure = reason => new RealmJoinError(status, attempts, retryAfterMs, reason)
    const report = waitMs => {
      try { onAttempt?.({ status, attempt: attempts, elapsedMs: elapsed(), waitMs, retryAfterMs }) } catch { /* Diagnostics cannot change the connection outcome. */ }
    }
    try {
      while (attempts < maxAttempts) {
        if (runSignal.aborted || elapsed() >= maxWaitMs) throw failure(cancelled?.aborted ? 'cancelled' : 'timeout')
        attempts++
        status = null; retryAfterMs = null
        const request = new AbortController()
        const requestSignal = AbortSignal.any([runSignal, request.signal])
        const timer = setTimeout(() => request.abort(), Math.min(requestTimeoutMs, maxWaitMs - elapsed()))
        let waitMs
        try {
          const response = await abortable(Promise.resolve().then(() => { requestSignal.throwIfAborted(); return fetch(url, { ...options, signal: requestSignal }) }), requestSignal)
          status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null
          if (response.ok) {
            report(null)
            const result = await abortable(Promise.resolve().then(() => { requestSignal.throwIfAborted(); return response.headers.get('Content-Type')?.startsWith('application/json') ? response.json() : response.text() }), requestSignal)
            if (runSignal.aborted || elapsed() >= maxWaitMs) throw failure(cancelled?.aborted ? 'cancelled' : 'timeout')
            return result
          }
          discard(response)
          retryAfterMs = retryAfter(response.headers.get('Retry-After'), now())
          const retryable = status === 503 || status >= 500 && status < 600 && attempts <= Math.min(4, this.maxRetries ?? 4)
          waitMs = retryAfterMs ?? Math.min(15000, 1000 * Math.pow(2, attempts - 1))
          const canRetry = retryable && attempts < maxAttempts && waitMs < maxWaitMs - elapsed()
          report(canRetry ? waitMs : null)
          if (!canRetry) throw failure()
        } catch (error) {
          if (error instanceof RealmJoinError) throw error
          throw failure(cancelled?.aborted ? 'cancelled' : runSignal.aborted || request.signal.aborted ? 'timeout' : undefined)
        } finally { clearTimeout(timer) }
        if (runSignal.aborted || elapsed() + waitMs >= maxWaitMs) throw failure(cancelled?.aborted ? 'cancelled' : 'timeout')
        await abortable(Promise.resolve().then(() => { runSignal.throwIfAborted(); return sleep(waitMs, runSignal) }), runSignal)
      }
      throw failure()
    } catch (error) {
      if (error instanceof RealmJoinError) throw error
      throw failure(cancelled?.aborted ? 'cancelled' : runSignal.aborted ? 'timeout' : undefined)
    } finally { clearTimeout(deadlineTimer) }
  }
  Rest.prototype.execRequest = wrapped
  return function restore () {
    if (!active) return
    active = false
    if (Rest.prototype.execRequest === wrapped) Rest.prototype.execRequest = original
  }
}

module.exports = { installRealmJoinHandling }
