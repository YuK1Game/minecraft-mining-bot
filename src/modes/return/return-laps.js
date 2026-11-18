'use strict'

// A step back to an earlier stage is not progress by itself.
// The stages answer each other without a wait: 「チェストへ接近」 said TOO_FAR
// (the chosen chest more than 20 m away) and 「拠点へ移動」 said NEAR_BASE (the
// base chest within 20 m), each at once and each completed, so nothing was
// counted as a failure and nothing let the process breathe. Real Realm
// 2026-11-18 17:18:00 JST: the Bot stood 17 m from the base chest and 21 m
// from the chosen chest 7 m behind it; the two stages turned without end, the
// process used a whole core, wrote no log line, answered no request and grew
// by 29 MB every 10 s until it was restarted.
// - The same step back (stages, code, chosen chest) from the same place
//   (4-block cell) LAPS times within LAP_MS is a loop: the goal is held.
// - Every step back also waits a moment (the runner), so the stages can never
//   turn inside one instant, whatever they answer.
const ORDER = ['observe', 'surface', 'travel', 'approach', 'container', 'store', 'verify', 'replan']
const LAPS = 3, LAP_MS = 60000, KEPT = 32

const place = point => point && [point.x, point.y, point.z].every(Number.isFinite) ? `${Math.floor(point.x / 4)},${Math.floor(point.y / 4)},${Math.floor(point.z / 4)}` : '?'
const chest = at => at ? `${at.x},${at.y},${at.z}` : '-'

const isBack = (from, to) => ORDER.indexOf(to) < ORDER.indexOf(from)

function createLaps ({ now = Date.now } = {}) {
  let seen = new Map()
  // Counts one step back; true when it is the LAPS-th of the same kind in a row within LAP_MS.
  function back ({ from, to, code, target = null, position = null }) {
    if (!isBack(from, to)) return false
    const key = `${from}>${to}:${code}:${chest(target)}@${place(position)}`, at = now()
    const times = (seen.get(key) ?? []).filter(time => at - time < LAP_MS)
    times.push(at)
    if (seen.size >= KEPT && !seen.has(key)) seen = new Map()
    seen.set(key, times)
    return times.length >= LAPS
  }
  return { back, clear: () => { seen = new Map() } }
}

module.exports = { createLaps, isBack, LAPS, LAP_MS }
