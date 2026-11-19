'use strict'

// The long trip's own way on when no walk leads on.
//
// A long trip plans walks only (one block up or down, open surface). Where no
// walk leads on it failed the same pass from the same feet, and every caller
// grew its own answer for its own place: a dug way out of the house, off the
// door step, home from the overhang, up from a cave before an expedition trip
// (2026-11-18/19, the user: 「Aを修正したらBでルート探索失敗…不毛な修正繰り返して
// いたりしないですか？」). The answer belongs to the trip itself:
// - a pass in which neither the relay point nor a chunk leg moved the Bot
//   asks here once before it counts as failed;
// - under received natural ground: the shared way up (`climb`) first;
// - otherwise: a received cell to stand on, AHEAD_MIN..AHEAD_MAX cells toward
//   the destination (straight on first, then to either side), is reached by
//   the route that walks, digs, stacks and bridges (`build`, received terrain
//   only, bounded search). Up to TRIES cells are tried.
// - Moved counts by the feet only (MOVED_M or more). A cell the detour could
//   not leave is not tried again for REST_MS.
const AHEAD_MIN = 6, AHEAD_MAX = 12, UP = 6, DOWN = 10, TRIES = 3, MOVED_M = 3, REST_MS = 60000
const ANGLES = [0, 30, -30, 60, -60, 90, -90]
const PASSABLE = /^minecraft:(?:air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|snow)$/

const solid = block => block?.known === true && block.boundingBox === 'block' && !/water|lava|leaves|_door$|chest|_bed$/.test(block.name ?? '')
const open = block => block?.known === true && (block.boundingBox === 'empty' && !/water|lava|fire|cobweb|powder_snow|portal/.test(block.name ?? '') || PASSABLE.test(block.name ?? ''))

// Received cells to stand on toward the destination, best first.
function standpoints (getBlock, feet, destination) {
  const heading = Math.atan2(destination.z - feet.z, destination.x - feet.x)
  const left = Math.hypot(destination.x - feet.x, destination.z - feet.z)
  const fy = Math.floor(feet.y + 0.001), seen = new Set(), found = []
  for (const angle of ANGLES) for (const far of [AHEAD_MAX, 9, AHEAD_MIN]) {
    if (far > left + 2) continue
    const a = heading + angle * Math.PI / 180
    const x = Math.floor(feet.x + Math.cos(a) * far), z = Math.floor(feet.z + Math.sin(a) * far)
    if (seen.has(`${x},${z}`)) continue
    seen.add(`${x},${z}`)
    for (let y = fy + UP; y >= fy - DOWN; y--) {
      if (!solid(getBlock(x, y - 1, z)) || !open(getBlock(x, y, z)) || !open(getBlock(x, y + 1, z))) continue
      found.push({ x, y, z, score: Math.abs(angle) / 15 + Math.abs(y - fy) - far / 4 })
      break
    }
  }
  return found.sort((a, b) => a.score - b.score)
}

function createTravelDetour ({ getFeet, getBlock, covered = () => false, climb = null, build, log = () => {}, now = Date.now, restMs = REST_MS } = {}) {
  let rested = null
  const cellOf = feet => `${Math.floor(feet.x)},${Math.floor(feet.y + 0.001)},${Math.floor(feet.z)}`
  const movedFrom = start => { const feet = getFeet(); return !!feet && Math.hypot(feet.x - start.x, feet.y - start.y, feet.z - start.z) >= MOVED_M }
  return async function detour (destination, { aborted = () => false } = {}) {
    const start = getFeet()
    if (!start || !destination || ![destination.x, destination.z].every(Number.isFinite)) return { ok: false, code: 'DETOUR_NO_POSITION' }
    const here = cellOf(start)
    if (rested?.at === here && now() < rested.until) return { ok: false, code: 'DETOUR_RESTING' }
    const fail = code => { rested = { at: cellOf(getFeet() ?? start), until: now() + restMs }; return { ok: false, code } }
    if (typeof climb === 'function' && covered() === true) {
      log(`長距離移動: 歩く道がなく地下（y=${Math.floor(start.y)}）にいるため、地上へ出ます`)
      try { await climb(aborted) } catch (error) { log(`長距離移動: 地上へ出られませんでした（${String(error?.message ?? error).slice(0, 100)}）`) }
      if (covered() !== true || movedFrom(start)) return { ok: true, code: 'DETOUR_CLIMBED' }
      return fail('DETOUR_CLIMB_FAILED')
    }
    const spots = standpoints(getBlock, start, destination).slice(0, TRIES)
    if (!spots.length) { log('長距離移動: 歩く道がなく、掘る・積む道の行き先（受信した立てるマス）も見つかりません'); return fail('DETOUR_NO_STANDPOINT') }
    let last = null
    for (const spot of spots) {
      if (aborted()) return { ok: false, code: 'DETOUR_CANCELLED' }
      log(`長距離移動: 歩く道がないため、掘る・積む道で (${spot.x}, ${spot.y}, ${spot.z}) へ進みます`)
      const done = cell => Math.abs(cell.x - spot.x) <= 1 && Math.abs(cell.z - spot.z) <= 1 && Math.abs(cell.y - spot.y) <= 1
      try { last = await build(spot, { done, aborted }) } catch (error) { last = { ok: false, code: String(error?.code ?? error?.message ?? 'BUILD_FAILED').slice(0, 60) } }
      if (movedFrom(start)) return { ok: true, code: 'DETOUR_BUILT' }
    }
    log(`長距離移動: 掘る・積む道でも進めませんでした（${last?.code ?? '不明'}）`)
    return fail(last?.code ?? 'DETOUR_FAILED')
  }
}

module.exports = { createTravelDetour, standpoints, AHEAD_MIN, AHEAD_MAX, REST_MS }
