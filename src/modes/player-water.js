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
// - No ledge within five blocks (open water): the Bot first swims toward the
//   nearest shore of the received water (movement/water-swim.js) in legs of at
//   most eight blocks, up to twelve legs; each leg counts only when the working
//   position moved, and two legs without progress end the try. Then the
//   ordinary exit. No shore in the received water: said once a minute.
// - Not while a hostile is within 12 m or another job runs. 30 s between tries.
const { normalizeMode } = require('./bot-mode')
const { ledges, wetColumn } = require('../movement/water-ledges')
const { way } = require('../movement/water-swim')

const STUCK_MS = 15000, AGAIN_MS = 30000, MOVED_M = 1, TRIES = 8, LEGS = 12, SAY_MS = 60000

const finite = p => !!p && [p.x, p.y, p.z].every(Number.isFinite)

// In water: the own column, or a column the body reaches into (movement/water-ledges.js).
const wet = (getBlock, feet) => finite(feet) && wetColumn(getBlock, feet) !== null

function createPlayerWater ({ getMode, shared, agent, getPosition, getBlock, start, moving, why = () => null, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, since = null, anchor = null, said = -Infinity
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  async function tick () {
    if (!live() || busy) return null
    const feet = getPosition()
    if (!wet(getBlock, feet)) { since = null; anchor = null; return null }
    if (!anchor || Math.hypot(feet.x - anchor.x, feet.z - anchor.z) > MOVED_M) { anchor = { x: feet.x, z: feet.z }; since = now(); return null }
    if (now() - since < STUCK_MS || now() < waitUntil || blocked()) return null
    const found = ledges(getBlock, feet)[0] ?? way(getBlock, feet)?.shore
    waitUntil = now() + AGAIN_MS
    if (!found) { none(); return false }
    busy = true
    try {
      log(`プレイヤーモード: 水の中で止まっているため、岸 (${Math.floor(found.x)}, ${found.y}, ${Math.floor(found.z)}) へ上がります`)
      agent.stop('水から上がります。')
      await settle()
      const out = await exit(() => !live())
      return out.ok
    } finally {
      busy = false
      await restart()
    }
  }

  function none () {
    if (now() - said < SAY_MS) return
    said = now()
    log('プレイヤーモード: 水の中で止まっていますが、受信した水面の先に上がれる岸が見つかりません')
  }

  // Open water: toward the nearest shore of the received water until a ledge is within reach.
  async function swim (aborted) {
    let stalls = 0
    for (let leg = 0; leg < LEGS; leg++) {
      const feet = getPosition()
      if (!wet(getBlock, feet) || ledges(getBlock, feet).length) return { ok: true }
      const far = way(getBlock, feet)
      if (!far) { none(); return { ok: false, reason: 'NO_LEDGE' } }
      if (aborted() || disposed()) return { ok: false, reason: 'INTERRUPTED' }
      if (leg === 0) log(`プレイヤーモード: 岸 (${Math.floor(far.shore.x)}, ${far.shore.y}, ${Math.floor(far.shore.z)}) まで水面を約 ${far.cells} マス泳ぎます`)
      let refused = null
      try { start(far.leg, { allowWater: true, allowLowHealth: true, waterExit: true, maxDistance: 12 }) } catch (error) { refused = String(error?.message ?? error).slice(0, 80) }
      if (!refused) {
        await sleep(300)
        for (let i = 0; i < 75 && moving() && !disposed(); i++) await sleep(200)
      }
      const after = getPosition()
      if (Math.hypot(after.x - feet.x, after.z - feet.z) >= 1) { stalls = 0; continue }
      if (++stalls >= 2) {
        const reason = refused ?? why() ?? '泳いでも進みませんでした'
        log(`プレイヤーモード: 岸へ泳げません（${reason}）`)
        return { ok: false, reason }
      }
      await sleep(1000)
    }
    return { ok: false, reason: 'SWIM_LIMIT' }
  }

  // Swim onto the nearest ledge; the caller has stopped the autonomy.
  async function exit (aborted = () => false) {
    const feet = getPosition()
    if (!wet(getBlock, feet)) return { ok: false, reason: 'NOT_IN_WATER' }
    let found = ledges(getBlock, feet).slice(0, TRIES)
    if (!found.length) {
      const swum = await swim(aborted)
      if (!swum.ok) return swum
      if (!wet(getBlock, getPosition())) { log('プレイヤーモード: 水から上がりました'); since = null; anchor = null; return { ok: true } }
      found = ledges(getBlock, getPosition()).slice(0, TRIES)
      if (!found.length) { none(); return { ok: false, reason: 'NO_LEDGE' } }
    }
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
