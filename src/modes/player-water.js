'use strict'

// Player mode: out of the water onto the nearest received ledge.
// The ordinary walk does not plan in water ("Water prediction is experimental
// and disabled"), and the forage and the planner do not end the run there, so
// the Bot stays afloat (real Realm 2026-11-17 08:48-08:54 JST: in water at
// y=64, hunger 7, food 0, a beef drop 3 m away; the forage waited with
// 「既知の安全な陸上中継を作れないため、別の食料源を待ちます。」 and the planner said
// 「準備に必要な資材や作業場所を既知の範囲で調べます。」 129 times in five minutes).
// - While playing, the feet cell or the one below is received water, and the
//   Bot has moved less than 1 m for 15 s: the autonomy stops, and the Bot
//   swims onto a ledge within five blocks (received solid floor, two received
//   empty dry cells above it, at the level of the water surface above the Bot
//   or one above: movement/water-ledges.js) with the same water exit as the
//   long travel (movement/water-exit.js), nearest first, up to eight ledges.
//   Out of the water counts only from the working position.
// - Not while a hostile is within 12 m or another job runs. 30 s between tries.
const { normalizeMode } = require('./bot-mode')
const { ledges } = require('../movement/water-ledges')

const STUCK_MS = 15000, AGAIN_MS = 30000, MOVED_M = 1, TRIES = 8

const finite = p => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const water = found => /water/.test(found?.name ?? '')

function wet (getBlock, feet) {
  if (!finite(feet)) return false
  const x = Math.floor(feet.x), y = Math.floor(feet.y + 0.2), z = Math.floor(feet.z)
  return water(getBlock(x, y, z)) || water(getBlock(x, y - 1, z))
}

function createPlayerWater ({ getMode, shared, agent, getPosition, getBlock, start, moving, why = () => null, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, since = null, anchor = null
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  async function tick () {
    if (!live() || busy) return null
    const feet = getPosition()
    if (!wet(getBlock, feet)) { since = null; anchor = null; return null }
    if (!anchor || Math.hypot(feet.x - anchor.x, feet.z - anchor.z) > MOVED_M) { anchor = { x: feet.x, z: feet.z }; since = now(); return null }
    if (now() - since < STUCK_MS || now() < waitUntil || blocked()) return null
    const found = ledges(getBlock, feet).slice(0, TRIES)
    waitUntil = now() + AGAIN_MS
    if (!found.length) { log('プレイヤーモード: 水の中で止まっていますが、5マス以内に上がれる岸が見つかりません'); return false }
    busy = true
    try {
      log(`プレイヤーモード: 水の中で止まっているため、岸 (${Math.floor(found[0].x)}, ${found[0].y}, ${Math.floor(found[0].z)}) へ上がります`)
      agent.stop('水から上がります。')
      await settle()
      const out = await exit(() => !live())
      return out.ok
    } finally {
      busy = false
      await restart()
    }
  }

  // Swim onto the nearest ledge; the caller has stopped the autonomy.
  async function exit (aborted = () => false) {
    const feet = getPosition()
    if (!wet(getBlock, feet)) return { ok: false, reason: 'NOT_IN_WATER' }
    const found = ledges(getBlock, feet).slice(0, TRIES)
    if (!found.length) { log('プレイヤーモード: 水の中で止まっていますが、5マス以内に上がれる岸が見つかりません'); return { ok: false, reason: 'NO_LEDGE' } }
    const reasons = []
    for (const ledge of found) {
      if (aborted() || disposed()) return { ok: false, reason: 'INTERRUPTED' }
      try { start(ledge, { allowWater: true, allowLowHealth: true, waterExit: true, maxDistance: 4 }) } catch (error) { reasons.push(String(error?.message ?? error).slice(0, 80)); continue }
      await sleep(300)
      for (let i = 0; i < 50 && moving() && !disposed(); i++) await sleep(200)
      if (!wet(getBlock, getPosition())) { log('プレイヤーモード: 水から上がりました'); since = null; anchor = null; return { ok: true } }
      reasons.push(why() ?? '上がれませんでした')
    }
    const reason = [...new Set(reasons)].slice(0, 2).join(' / ') || '不明'
    log(`プレイヤーモード: 水から上がれません（${reason}）`)
    return { ok: false, reason }
  }

  return { tick, exit, needed: () => wet(getBlock, getPosition()), status: () => ({ active: busy, reason: busy ? '水から上がっています。' : null }) }
}

module.exports = { createPlayerWater, wet, ledges }
