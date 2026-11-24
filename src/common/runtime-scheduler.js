'use strict'

// Centralized interval scheduler bound to a runtime lifecycle.
// Prevents overlapping async ticks, catches errors so timers never crash the
// process, optionally wraps ticks with work-spans, and clears every timer on dispose.

function createScheduler ({
  isDisposed = () => false,
  log = () => {},
  wrapSpan = null,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  let disposed = false
  const entries = new Set()

  const stopped = () => disposed || isDisposed() === true

  function every (name, intervalMs, fn, {
    unref = true,
    preventOverlap = true,
    requireActive = null,
    onError = null,
    errorThrottleMs = 60000
  } = {}) {
    if (typeof fn !== 'function') throw new Error('scheduler callback must be a function')
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('scheduler intervalMs must be positive')
    if (stopped()) {
      return { name, intervalMs, stop: () => {}, active: () => false, runs: () => 0, errors: () => 0 }
    }

    const label = String(name || 'timer')
    const wrapped = typeof wrapSpan === 'function' ? wrapSpan(`timer.${label}`, fn) : fn
    let running = false
    let active = true
    let runs = 0
    let errors = 0
    let lastErrorLogAt = -Infinity
    let timer = null

    const entry = {
      name: label,
      intervalMs,
      stop () {
        if (!active) return
        active = false
        if (timer !== null) { clearIntervalImpl(timer); timer = null }
        entries.delete(entry)
      },
      active: () => active && !stopped(),
      runs: () => runs,
      errors: () => errors
    }

    const reportError = error => {
      errors++
      if (typeof onError === 'function') {
        try { onError(error) } catch {}
        return
      }
      const at = now()
      if (at - lastErrorLogAt >= errorThrottleMs) {
        lastErrorLogAt = at
        try { log(`定期処理(${label})に失敗: ${String(error?.message ?? error).slice(0, 140)}`) } catch {}
      }
    }

    const tick = () => {
      if (!active || stopped()) { entry.stop(); return }
      if (preventOverlap && running) return
      if (typeof requireActive === 'function') {
        let ok = false
        try { ok = requireActive() === true } catch { ok = false }
        if (!ok) return
      }
      running = true
      runs++
      try {
        const result = wrapped()
        if (result && typeof result.then === 'function') {
          result.then(() => { running = false }, error => { running = false; reportError(error) })
        } else {
          running = false
        }
      } catch (error) {
        running = false
        reportError(error)
      }
    }

    timer = setIntervalImpl(tick, intervalMs)
    if (unref && typeof timer?.unref === 'function') timer.unref()
    entries.add(entry)
    return entry
  }

  function disposeAll () {
    disposed = true
    for (const entry of [...entries]) entry.stop()
    entries.clear()
  }

  function snapshot () {
    return [...entries].map(entry => ({
      name: entry.name,
      intervalMs: entry.intervalMs,
      active: entry.active(),
      runs: entry.runs(),
      errors: entry.errors()
    }))
  }

  return { every, disposeAll, snapshot, isDisposed: stopped }
}

module.exports = { createScheduler }
