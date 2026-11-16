'use strict'

// Cheap timing of the synchronous work that can hold the event loop, so a
// reported stall can name its cause without the CPU profiler (starting the
// profiler itself stalls the loop for hundreds of ms). A span is one call of a
// wrapped function: only its synchronous part is timed (for an async function,
// the part before its first await), and only spans of 5 ms or more are kept,
// in a ring of the last 256. Measurement only: results and errors pass through.
// One recorder per process, shared across hot reloads.
const KEY = Symbol.for('minecraft-realms-bot.work-spans')
const MIN_MS = 5
const LIMIT = 256

function createRecorder ({ now = () => performance.now(), minMs = MIN_MS, limit = LIMIT } = {}) {
  const ring = []
  let depth = 0
  function note (name, started, ended, level) {
    if (ended - started < minMs) return
    ring.push({ name, started, ms: ended - started, depth: level })
    if (ring.length > limit) ring.splice(0, ring.length - limit)
  }
  function wrap (name, fn) {
    if (typeof fn !== 'function') return fn
    return function (...args) {
      const started = now(), level = depth++
      try { return fn.apply(this, args) } finally { depth = level; note(name, started, now(), level) }
    }
  }
  // Wraps every function of an exports object; other values pass through.
  const wrapAll = (prefix, exported) => Object.fromEntries(Object.entries(exported).map(([key, value]) => [key, typeof value === 'function' ? wrap(`${prefix}.${key}`, value) : value]))
  // Spans that ended within the last `windowMs`, summed by name, longest first.
  // `covered` counts outermost spans only, so nested calls are not added twice.
  function recent (windowMs, { top = 4 } = {}) {
    const since = now() - windowMs, byName = new Map()
    let covered = 0
    for (const span of ring) {
      if (span.started + span.ms < since) continue
      const entry = byName.get(span.name) ?? { name: span.name, ms: 0, calls: 0 }
      entry.ms += span.ms; entry.calls++
      byName.set(span.name, entry)
      if (span.depth === 0) covered += span.ms
    }
    return { covered: Math.round(covered), spans: [...byName.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map(entry => ({ ...entry, ms: Math.round(entry.ms) })) }
  }
  return { wrap, wrapAll, recent }
}

const shared = globalThis[KEY] ??= createRecorder()
// 「nav.plan 180ms×2 / planner.nextDiamondAction 90ms」; null when nothing was timed.
function describeRecent (windowMs, recorder = shared) {
  const { covered, spans } = recorder.recent(windowMs)
  return spans.length ? `${spans.map(span => `${span.name} ${span.ms}ms${span.calls > 1 ? `×${span.calls}` : ''}`).join(' / ')}（計測した処理の合計 ${covered}ms）` : null
}

module.exports = { createRecorder, describeRecent, wrap: shared.wrap, wrapAll: shared.wrapAll, recent: shared.recent }
