'use strict'

// Names the code that blocked the event loop. The stall watch only knows that
// the loop stopped; with the Bot between actions it logged 作業=null for every
// long stall (2026-11-16: 43 stalls of a second or more, none attributed).
// A sampling CPU profile runs in short windows; when a stall is reported the
// current window is read and the samples inside the stall are summed per
// function, so the log says which search to speed up. Measurement only.
const path = require('node:path')

// Inclusive time per function over the samples that fall in the last `lastMs`.
function summarize (profile, lastMs, { limit = 6, root = null } = {}) {
  if (!profile?.nodes?.length || !profile.samples?.length) return []
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const from = profile.endTime - lastMs * 1000
  const totals = new Map()
  let at = profile.startTime, total = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const delta = profile.timeDeltas?.[index] ?? 0
    at += delta
    if (at < from) continue
    const seen = new Set()
    let own = true
    for (let id = profile.samples[index]; id != null; id = parent.get(id)) {
      const frame = nodes.get(id)?.callFrame
      if (!frame?.url || !frame.functionName || frame.url.startsWith('node:') || frame.url.includes('node_modules')) { own = false; continue }
      const file = root && frame.url.includes(root) ? frame.url.slice(frame.url.indexOf(root) + root.length + 1) : path.basename(frame.url)
      const name = `${frame.functionName} ${file.replace(/\\/g, '/')}:${frame.lineNumber + 1}`
      if (seen.has(name)) { own = false; continue }
      seen.add(name)
      const entry = totals.get(name) ?? { name, totalUs: 0, selfUs: 0 }
      entry.totalUs += delta
      if (own) entry.selfUs += delta
      own = false
      totals.set(name, entry)
    }
    total += delta
  }
  if (!total) return []
  const share = us => Math.round(us / total * 100)
  const all = [...totals.values()]
  const inclusive = [...all].sort((a, b) => b.totalUs - a.totalUs).slice(0, limit)
  const self = [...all].sort((a, b) => b.selfUs - a.selfUs).slice(0, 3).filter(entry => entry.selfUs > 0 && !inclusive.includes(entry))
  return [...inclusive, ...self].map(entry => ({ name: entry.name, total: share(entry.totalUs), self: share(entry.selfUs) }))
}

function createStallProfile ({ windowMs = 8000, samplingUs = 5000, minStallMs = 400, root = null, log = () => {}, inspector = require('node:inspector'), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let session = null, timer = null, running = false
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)))
  async function begin () { await post('Profiler.start'); running = true }
  async function end () { if (!running) return null; running = false; return (await post('Profiler.stop'))?.profile ?? null }
  async function start () {
    if (session) return
    try {
      session = new inspector.Session()
      session.connect()
      await post('Profiler.enable')
      await post('Profiler.setSamplingInterval', { interval: samplingUs })
      await begin()
      // A fresh window keeps the profile small; an old one is simply dropped.
      timer = setTimer(() => { void end().then(begin).catch(() => {}) }, windowMs)
      timer?.unref?.()
    } catch (error) { log(`処理の停止の内訳を記録できません: ${String(error?.message ?? error).slice(0, 120)}`); await stop() }
  }
  async function stop () {
    if (timer) { clearTimer(timer); timer = null }
    const closing = session
    session = null
    if (!closing) return
    try { if (running) { running = false; closing.post('Profiler.stop', () => {}) } closing.disconnect() } catch {}
  }
  // Called from the stall report: the stall ended a moment ago.
  async function explain (stallMs) {
    if (!session || stallMs < minStallMs) return null
    try {
      const profile = await end()
      await begin()
      const top = summarize(profile, stallMs + 150, { root })
      if (top.length) log(`処理の停止の内訳 ${stallMs}ms: ${top.map(entry => `${entry.name} ${entry.total}%${entry.self >= 5 ? `(自身${entry.self}%)` : ''}`).join(' / ')}`)
      return top
    } catch { return null }
  }
  return { start, stop, explain }
}

module.exports = { createStallProfile, summarize }
