'use strict'

const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')

// Self samples, including idle time, are reported against the same total as
// the profiler. These percentages are not OS CPU usage or inclusive time.
function summarizeCpuProfile (profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const functions = new Map(), files = new Map()
  let total = 0
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const frame = nodes.get(id)?.callFrame ?? {}
    const file = (frame.url ?? '').split(/[\\/]/).pop()
    const label = `${frame.functionName || '(anon)'} ${file}:${(frame.lineNumber ?? -1) + 1}`
    const sample = profile.timeDeltas?.[index] ?? 0
    const duration = Number.isFinite(sample) && sample > 0 ? sample : 0
    total += duration
    functions.set(label, (functions.get(label) ?? 0) + duration)
    files.set(file, (files.get(file) ?? 0) + duration)
  }
  const top = values => [...values].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, duration]) => ({ k, ms: Math.round(duration / 1000), pct: total ? +(100 * duration / total).toFixed(1) : 0 }))
  return { totalMs: Math.round(total / 1000), topFunctions: top(functions), topFiles: top(files) }
}

// No inspector session, timer or file is created until this explicit command.
async function profileCpu (ms = 30000, { outputDir = path.join(__dirname, '..', '.local'), createSession = () => new (require('node:inspector').Session)(), sleep = delay, writeFile = require('node:fs/promises').writeFile, now = Date.now } = {}) {
  const session = createSession()
  session.connect()
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)))
  try {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 1000 })
    await post('Profiler.start')
    await sleep(Math.min(Math.max(1000, ms), 60000))
    const { profile } = await post('Profiler.stop')
    const file = path.join(outputDir, `cpu-${now()}.cpuprofile`)
    await writeFile(file, JSON.stringify(profile))
    return { file, ...summarizeCpuProfile(profile) }
  } finally {
    try { await post('Profiler.disable') } catch {}
    session.disconnect()
  }
}

function measureSnapshots (parts, { now = () => performance.now() } = {}) {
  const out = {}
  for (const [name, read] of Object.entries(parts)) {
    const started = now()
    try {
      const value = read()
      // Preserve the existing diagnostic's length metric and timing boundary:
      // serialization is checked, but is not included in the snapshot time.
      out[name] = { ms: +(now() - started).toFixed(1), bytes: JSON.stringify(value ?? null).length }
    } catch (error) { out[name] = { error: String(error?.message ?? error).slice(0, 80) } }
  }
  return out
}

module.exports = { summarizeCpuProfile, profileCpu, measureSnapshots }
