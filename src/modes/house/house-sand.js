'use strict'

// Player mode: the starter house's glass takes sand, and none may lie in the
// received terrain (real Realm 2026-11-17 07:23-07:30 JST: 167 of 184 placed,
// the glass waiting on sand with none in sight, and nothing went to look).
// When the house still needs sand, its logs and cobblestone are in hand and
// the Bot stands under open sky:
// - received sand 24-128 m away: long travel to it, and the house supply
//   (house-supply.js) digs it on the next plans;
// - no received sand: long travel along a spiral around the house (96 m, then
//   192 m ... out to 480 m, 60 degrees on each trip) to receive new terrain.
// Sand nearer than 24 m is left to the house supply. Not while a hostile is
// within 12 m, another job runs or the Bot travels. A minute between trips.
// Under cover (a tunnel), it first climbs out the recovery's way (tunnel walk
// back, else straight up), then searches (real Realm 2026-11-17 10:31-10:40
// JST: the trip was cut short by a fight, the agent went down 30 blocks for
// iron, and no sand search ran again with 8 house steps left).
const { normalizeMode } = require('../bot-mode')
const { pending, needsNow } = require('./house-supply')
const { nearestKnownLog } = require('../player-recovery')
const { underCover } = require('../player-surface')

const SAND = /^(?:minecraft:)?(?:red_)?sand$/
const OPEN = /^minecraft:(?:air|cave_air|short_grass|tall_grass|fern|dead_bush|leaf_litter)$/
// Only sand with received open air on top: the planner digs no sand under
// water or under gravel (live 2026-11-17 09:41-09:48 JST: the 100 received
// sand blocks near the house all lay under a pool, gravel or dirt; every trip
// went there and none was dug).
const exposed = getBlock => (x, y, z) => { const up = getBlock(x, y + 1, z); return up?.known === true && OPEN.test(up.name ?? '') }
// The plan only sees blocks within 12 m and 3 below to 12 above the feet
// (runner observe): sand beyond that is walked to first (live 2026-11-17
// 13:03-13:09 JST: sand 16 m away and 15 above the feet was left to the plan,
// which never saw it and tunnelled down again every minute).
const SEEN_M = 10, SEEN_BELOW = 3, SEEN_ABOVE = 10
const NEAR_M = 24, STEP_M = 96, RINGS = 5, AGAIN_MS = 60000, TRIP_MS = 240000, AVOID_M = 24, FORGET_MS = 1800000, CLIMB_AGAIN_MS = 300000

function spiralPoint (center, trip) {
  const ring = 1 + Math.floor(trip / 6) % RINGS, angle = trip * Math.PI / 3
  return { x: Math.round(center.x + Math.cos(angle) * STEP_M * ring), z: Math.round(center.z + Math.sin(angle) * STEP_M * ring) }
}

function createHouseSand ({ getMode, shared, agent, travel, climb = null, approach = null, getState, getBlock, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), scan = nearestKnownLog }) {
  let busy = false, waitUntil = 0, trips = 0, failed = []
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  async function tick () {
    if (!live() || busy || blocked() || now() < waitUntil || travel.status()?.busy) return null
    const state = getState()
    if (!state?.position || !pending({ mode: getMode(), playing: shared.playerWanted === true, shared, state })) return null
    const needs = needsNow({ shared, state, getBlock })
    if (!needs || needs.need.sand <= 0 || needs.need.logs > 0 || needs.need.cobblestone > 0) return null
    const covered = underCover(getBlock, state.position)
    if (covered && !climb) return null
    busy = true
    waitUntil = now() + AGAIN_MS
    let stopped = false
    try {
      if (covered) {
        log(`プレイヤーモード: 拠点の家のガラスにする砂を探すため、地上へ出ます（あと${needs.need.sand}個）`)
        agent.stop('拠点の家の砂を探しに地上へ出ます。')
        stopped = true
        await settle()
        let out
        try { out = await climb(() => !live()) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 100) } }
        if (!live()) return null
        if (!out?.ok || underCover(getBlock, getState()?.position)) { waitUntil = now() + CLIMB_AGAIN_MS; log(`プレイヤーモード: 砂を探しに地上へ出られません（${out?.reason ?? '屋根の下のまま'}）`); return false }
      }
      failed = failed.filter(point => now() - point.at < FORGET_MS)
      const here = covered ? getState()?.position ?? state.position : state.position
      const sand = await scan({ getBlock, position: here, match: SAND, accept: exposed(getBlock), min: 0, step: 2, below: 24, avoid: failed, avoidM: AVOID_M })
      if (!live()) return null
      const seen = (point, from) => { if (!from) return false; const feetY = Math.floor(from.y - 1.62 + 0.001); return Math.hypot(point.x + 0.5 - from.x, point.z + 0.5 - from.z) <= SEEN_M && point.y - feetY >= -SEEN_BELOW && point.y - feetY <= SEEN_ABOVE }
      if (sand && seen(sand, here)) { const k = `${sand.x},${sand.y},${sand.z}`; if (shared.houseSandNote !== k) { shared.houseSandNote = k; log(`プレイヤーモード: 砂 (${sand.x}, ${sand.y}, ${sand.z}) は見える範囲にあるので、材料集めに任せます`) } return null }
      if (sand && sand.distance < NEAR_M && !approach) return null
      const origin = shared.playerHouse?.origin
      const center = origin ?? { x: Math.floor(here.x), z: Math.floor(here.z) }
      const destination = sand ? { x: sand.x, z: sand.z } : spiralPoint(center, trips++)
      log(`プレイヤーモード: ${sand ? `拠点の家のガラスにする砂が見える (${destination.x}, ${destination.z}) へ移動します` : `拠点の家のガラスにする砂を探しに (${destination.x}, ${destination.z}) へ移動します`}（あと${needs.need.sand}個）`)
      if (!stopped) { agent.stop('拠点の家の砂を探します。'); stopped = true; await settle() }
      if (!sand || sand.distance >= NEAR_M) {
        try { await travel.to({ destination }) } catch (error) { log(`プレイヤーモード: 砂を探す移動を始められません ${String(error?.message ?? error).slice(0, 100)}`); return false }
        const until = now() + TRIP_MS
        while (live() && now() < until && travel.status()?.busy) await sleep(1000)
        if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
      }
      // Close enough for the plan to see it (long travel stops 20 m short).
      if (sand && approach && live()) { try { await approach({ x: sand.x + 0.5, y: sand.y + 1, z: sand.z + 0.5 }, 4) } catch {} }
      // Sand the trip could not reach (live 2026-11-17 09:33-09:37 JST: the
      // same sand by a pool full of drowned, 「危険地帯の中のチャンクへは移動しません」
      // eight times) is passed over for half an hour; the next trip goes elsewhere.
      const at = getState()?.position
      if (sand && (!at || (approach ? !seen(sand, at) : Math.hypot(at.x - destination.x, at.z - destination.z) > NEAR_M))) {
        failed.push({ x: destination.x, z: destination.z, at: now() })
        log(`プレイヤーモード: 砂 (${destination.x}, ${destination.z}) へ行けなかったため、しばらく別の砂を探します`)
      }
      return true
    } finally {
      busy = false
      if (stopped) await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '拠点の家の砂を探しています。' : null }) }
}

module.exports = { createHouseSand, spiralPoint }
