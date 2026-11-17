'use strict'

// Remembered prospecting ores whose cells the received world no longer holds
// (their chunk left) are not offered to the planner: the planner trusted the
// remembered entry and every tunnel refused it as RESOURCE_UNKNOWN (live
// 2026-11-17 12:43-12:55 JST: a tunnel decision every 2 s for 7 minutes; the
// exclusion list filled and was cleared, and the same ores came back).
function liveOres (ores, getBlock) {
  const out = {}
  for (const [resource, list] of Object.entries(ores ?? {})) {
    if (!Array.isArray(list)) { out[resource] = list; continue }
    out[resource] = list.filter(entry => {
      const p = entry?.position ?? entry
      if (![p?.x, p?.y, p?.z].every(Number.isSafeInteger)) return true
      return getBlock(p.x, p.y, p.z)?.known === true
    })
  }
  return out
}

module.exports = { liveOres }
