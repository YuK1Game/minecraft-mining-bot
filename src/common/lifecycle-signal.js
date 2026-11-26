'use strict'

// Generation-scoped cancellation token & bounded condition waiter.
// Replaces ad-hoc `setInterval` / `while (Date.now() < until)` watch loops with
// one `AbortSignal` tied to `shared-scopes` (`session` / `life` / `mode`),
// runtime disposal, optional parent signals, and explicit timeouts.
const { onScopeReset } = require('./shared-scopes')

function abortError (code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

function createLifecycleSignal ({
  shared = null,
  scopes = ['session', 'life', 'mode'],
  parentSignal = null,
  timeoutMs = null,
  isDisposed = null,
  reasonPrefix = 'LIFECYCLE',
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  const controller = new AbortController()
  const cleanups = []
  let timer = null

  function trigger (code, message) {
    if (controller.signal.aborted) return
    release()
    controller.abort(abortError(code, message))
  }

  function release () {
    if (timer !== null) {
      clearTimeoutImpl(timer)
      timer = null
    }
    while (cleanups.length) {
      const fn = cleanups.pop()
      try { fn() } catch {}
    }
  }

  if (typeof isDisposed === 'function' && isDisposed() === true) {
    controller.abort(abortError(`${reasonPrefix}_DISPOSED`, 'Runtime is already disposed'))
    return { signal: controller.signal, abort: trigger, release, aborted: () => true, reasonCode: () => controller.signal.reason?.code ?? null }
  }

  if (parentSignal) {
    if (parentSignal.aborted) {
      const parentReason = parentSignal.reason instanceof Error
        ? parentSignal.reason
        : abortError(`${reasonPrefix}_PARENT_ABORTED`, String(parentSignal.reason ?? 'Parent signal aborted'))
      controller.abort(parentReason)
      return { signal: controller.signal, abort: trigger, release, aborted: () => true, reasonCode: () => controller.signal.reason?.code ?? null }
    }
    const onParent = () => {
      const parentReason = parentSignal.reason instanceof Error
        ? parentSignal.reason
        : abortError(`${reasonPrefix}_PARENT_ABORTED`, String(parentSignal.reason ?? 'Parent signal aborted'))
      release()
      controller.abort(parentReason)
    }
    parentSignal.addEventListener('abort', onParent, { once: true })
    cleanups.push(() => parentSignal.removeEventListener('abort', onParent))
  }

  if (shared && typeof shared === 'object' && Array.isArray(scopes)) {
    for (const scope of scopes) {
      const off = onScopeReset(shared, scope, detail => {
        trigger(`${reasonPrefix}_${scope.toUpperCase()}_CHANGED`, `Lifecycle scope '${scope}' changed (${detail?.previous ?? 'none'} -> ${detail?.next ?? 'none'})`)
      })
      cleanups.push(off)
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeoutImpl(() => {
      trigger(`${reasonPrefix}_TIMEOUT`, `Operation timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    signal: controller.signal,
    abort: trigger,
    release,
    aborted: () => controller.signal.aborted || (typeof isDisposed === 'function' && isDisposed() === true),
    reasonCode: () => controller.signal.reason?.code ?? (typeof isDisposed === 'function' && isDisposed() === true ? `${reasonPrefix}_DISPOSED` : null)
  }
}

async function waitForCondition (predicate, {
  pollMs = 200,
  timeoutMs = 15000,
  shared = null,
  scopes = ['session', 'life', 'mode'],
  signal = null,
  isDisposed = null,
  reasonPrefix = 'WAIT',
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const token = createLifecycleSignal({
    shared,
    scopes,
    parentSignal: signal,
    isDisposed,
    reasonPrefix
  })
  const deadline = now() + timeoutMs
  try {
    for (;;) {
      if (token.aborted()) {
        return { ok: false, aborted: true, timedOut: false, code: token.reasonCode() ?? `${reasonPrefix}_ABORTED` }
      }
      if (predicate()) {
        return { ok: true, aborted: false, timedOut: false, code: 'SATISFIED' }
      }
      const remaining = deadline - now()
      if (remaining <= 0) {
        return { ok: false, aborted: false, timedOut: true, code: `${reasonPrefix}_TIMEOUT` }
      }
      await sleep(Math.min(pollMs, remaining))
    }
  } finally {
    token.release()
  }
}

module.exports = {
  createLifecycleSignal,
  waitForCondition,
  abortError
}
