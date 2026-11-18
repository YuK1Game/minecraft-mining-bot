'use strict'

// The server says the body stands where the received world has nothing to
// stand on: the received world is behind the server there, and the terrain
// under the feet is asked for again.
// Every planner reads the received world. When a block under the feet is
// missing from it, the prediction falls through the block, the server puts
// the body back, and the landing, the step off a low block, the pillar step
// and every route are refused for want of support, for as long as the world
// stays wrong (real Realm 2026-11-18 07:09-09:48 JST: after a pillar climb
// that combat interrupted, the server kept the feet at y 65.0 with onGround
// true while the received world had air at y 64 and y 63 in that column; the
// Bot did not move for two and a half hours, the return to the base was given
// up on CLIMB_FAILED).
// Only the server's own words are used: three corrections with onGround true
// at the same place, each while the received cells under the body are air.
// Then the sub-chunks around the feet are requested again (at most twice, then
// ten minutes of rest), and what arrives replaces what was held. Nothing is
// assumed: a block counts only once the server sent it.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const EYE = 1.62
const HALF = 0.3
const DIMENSIONS = ['overworld', 'nether', 'end']
const NEED = 3 // corrections that say "standing" over received air
const FRESH_MS = 60000 // the corrections counted are no older than this
const ANSWER_MS = 10000 // time for the requested terrain to arrive
const MAX_ASKS = 2
const REST_MS = 600000

const finite = point => !!point && [point.x, point.y, point.z].every(Number.isFinite)

// The cells that would carry the body the server reported, when every one of them is received air; null otherwise.
function standingOnNothing (correction, getBlock) {
  if (correction?.onGround !== true || !finite(correction.position)) return null
  const feet = correction.position.y - EYE
  const y = Math.floor(feet - 0.02)
  const cells = []
  for (let x = Math.floor(correction.position.x - HALF + 1e-6); x <= Math.floor(correction.position.x + HALF - 1e-6); x++) {
    for (let z = Math.floor(correction.position.z - HALF + 1e-6); z <= Math.floor(correction.position.z + HALF - 1e-6); z++) {
      const found = getBlock(x, y, z)
      if (found?.known !== true || !AIR.test(found.name ?? '')) return null
      // A fence or a wall carries the body half a block above its own cell.
      if (Math.abs(feet - y - 0.5) < 0.1) { const under = getBlock(x, y - 1, z); if (under?.known !== true || under.boundingBox === 'block') return null }
      cells.push({ x, y, z })
    }
  }
  return cells.length ? { feet, y, cells, centre: { x: Math.floor(correction.position.x), y, z: Math.floor(correction.position.z) } } : null
}

// The request for the sub-chunks that hold the cells from one under the support to the head.
function refreshRequest (spot, dimension) {
  const id = DIMENSIONS.indexOf(dimension)
  if (id < 0) return null
  const origin = { x: Math.floor(spot.centre.x / 16), y: Math.floor(spot.y / 16), z: Math.floor(spot.centre.z / 16) }
  const seen = new Set(), requests = []
  for (const cell of spot.cells) {
    for (const y of [spot.y, spot.y - 1, spot.y + 2]) {
      const offset = { x: Math.floor(cell.x / 16) - origin.x, y: Math.floor(y / 16) - origin.y, z: Math.floor(cell.z / 16) - origin.z }
      const key = `${offset.x},${offset.y},${offset.z}`
      if (!seen.has(key)) { seen.add(key); requests.push(offset) }
    }
  }
  return { dimension: id, origin, requests }
}

// getCorrection: the last server correction ({ position (eyes), onGround, receivedAt }); send: queues one subchunk_request.
function createGroundRefresh ({ getCorrection, getBlock, getDimension, send, log = () => {}, now = Date.now }) {
  let watch = null // { key, stamps, asks, askedAt, restUntil, told }
  const name = cell => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true ? String(found.name ?? '?').replace(/^minecraft:/, '') : '未受信' }
  const at = cell => `(${cell.x}, ${cell.y}, ${cell.z})`
  function tick () {
    const correction = getCorrection()
    const stamp = Date.parse(correction?.receivedAt ?? '')
    const spot = Number.isFinite(stamp) && now() - stamp <= FRESH_MS ? standingOnNothing(correction, getBlock) : null
    if (!spot) {
      // Asked, and the cell under the body is no longer air: say what arrived.
      const found = watch?.askedAt != null ? getBlock(watch.centre.x, watch.centre.y, watch.centre.z) : null
      if (found?.known === true && !AIR.test(found.name ?? '')) {
        log(`地形: 受信し直した地形で、足元 ${at(watch.centre)} は ${name(watch.centre)} でした。ここから続けます`)
        watch = null
      } else if (watch && now() - watch.seenAt > FRESH_MS) watch = null
      return null
    }
    const key = `${spot.centre.x},${spot.y},${spot.centre.z}`
    if (watch?.key !== key) watch = { key, centre: spot.centre, stamps: new Set(), asks: 0, askedAt: null, restUntil: 0, told: false }
    watch.seenAt = now()
    watch.stamps.add(stamp)
    if (watch.stamps.size < NEED) return null
    if (watch.askedAt != null && now() - watch.askedAt < ANSWER_MS) return null
    if (watch.asks >= MAX_ASKS) {
      if (!watch.told) { watch.told = true; log(`地形: 受信し直しても足元 ${at(spot.centre)} は空気のままです（サーバーは立っていると伝えています）。${Math.round(REST_MS / 60000)} 分後に見直します`) }
      if (now() < watch.restUntil) return null
      watch.asks = 0; watch.told = false
    }
    const request = refreshRequest(spot, getDimension())
    if (!request) return null
    try { send(request) } catch { return null }
    watch.asks++
    watch.askedAt = now()
    if (watch.asks >= MAX_ASKS) watch.restUntil = now() + REST_MS
    log(`地形: サーバーは足 ${Math.round(spot.feet * 100) / 100} で立っていると伝えていますが、受信した地形では足元 ${at(spot.centre)} が空気です。この場所の地形を受信し直します（${watch.asks} 回目）`)
    return request
  }
  return { tick, status: () => watch ? { key: watch.key, corrections: watch.stamps.size, asks: watch.asks } : null }
}

module.exports = { createGroundRefresh, standingOnNothing, refreshRequest }
