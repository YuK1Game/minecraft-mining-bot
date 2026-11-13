'use strict'

// Reports when the event loop was blocked long enough to delay the 50 ms
// combat/idle ticks. Measurement only: it never changes behavior. Each report
// names what the bot was doing so the next optimisation is chosen from real
// stalls instead of guesses.
function createEventLoopStallWatch ({ intervalMs = 100, thresholdMs = 200, minReportGapMs = 10000, now = () => performance.now(), wallNow = () => Date.now(), context = () => null, report = () => {}, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let last = now(), timer = null, lastReport = -Infinity
  const stats = { stalls: 0, worstMs: 0, suppressed: 0, lastAt: null }
  function check () {
    const t = now(), stall = t - last - intervalMs
    last = t
    if (stall < thresholdMs) return
    stats.stalls++; stats.worstMs = Math.max(stats.worstMs, Math.round(stall)); stats.lastAt = new Date(wallNow()).toISOString()
    if (t - lastReport < minReportGapMs) { stats.suppressed++; return }
    lastReport = t
    let doing = null
    try { doing = context() } catch {}
    const suppressed = stats.suppressed; stats.suppressed = 0
    try { report({ stallMs: Math.round(stall), doing, suppressed, stalls: stats.stalls, worstMs: stats.worstMs }) } catch {}
  }
  function start () { if (!timer) { last = now(); timer = setTimer(check, intervalMs); timer?.unref?.() } }
  function stop () { if (timer) { clearTimer(timer); timer = null } }
  return { start, stop, check, stats: () => ({ ...stats }) }
}
module.exports = { createEventLoopStallWatch }
