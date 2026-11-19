'use strict'

// The expedition looks for a material by walking a few blocks at a time to a place it can stand (explore in
// dragon-supply-gather.js). Where no such place is in reach, every heading failed, the heading turned, and the
// same nothing happened on the next tick: no step, no log line (live 2026-11-19 16:54-17:01 JST: in its own
// tunnel at y47, with raw iron to smelt and no fuel, the search for a log turned its heading about once every
// two seconds for seven minutes, `supplySearch.log` 274 -> 1673, feet unchanged).
// After MISSES headings in a row with no step, the search leaves by the long trip instead: 48 m along the
// next heading in turn. The long trip is the one way to "go to a place": it comes up from underground first and digs or
// stacks where there is no walk (travel-detour.js). The trip ends early when the material comes into view.
const MISSES = 4, ROAM_M = 48, SAY_MS = 60000
const HEADINGS = [[1, 0], [0, 1], [-1, 0], [0, -1]]

async function roam (ctx, resource, step, feet, inView, { now = Date.now } = {}) {
  const key = resource + ':miss'
  step[key] = Number(step[key] ?? 0) + 1
  if (step[key] < MISSES || ctx.cancelled() || typeof ctx.travelTo !== 'function' || ctx.runtime?.raw?.().dimension !== 'overworld') return false
  step[key] = 0
  // Each trip takes the next heading, so a trip that could not go is not asked for again at once.
  const turn = Number(step[resource + ':roam'] ?? 0)
  step[resource + ':roam'] = turn + 1
  const direction = HEADINGS[turn % 4]
  const destination = { x: Math.floor(feet.x) + direction[0] * ROAM_M, z: Math.floor(feet.z) + direction[1] * ROAM_M }
  const said = ctx.shared.supplyRoamSaid ??= {}
  if (now() - Number(said[resource] ?? 0) >= SAY_MS) {
    said[resource] = now()
    ctx.log?.(`プレイヤーモード: ${resource} を探して歩ける場所がまわりにないため、長距離移動で場所を変えます（目的地 (${destination.x}, ${destination.z})）`)
  }
  try {
    await ctx.travelTo({ destination }, { aborted: ctx.cancelled, until: inView })
    return true
  } catch (error) {
    ctx.log?.(`プレイヤーモード: ${resource} を探す長距離移動を始められません（${String(error?.message ?? error).slice(0, 80)}）`)
    return false
  }
}

module.exports = { roam, MISSES, ROAM_M }
