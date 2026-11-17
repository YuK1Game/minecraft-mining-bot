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
//   empty dry cells above it, at the water level or one above) with the same
//   water exit as the long travel (movement/water-exit.js), nearest first, up
//   to eight ledges. Out of the water counts only from the working position.
// - Not while a hostile is within 12 m or another job runs. 30 s between tries.
const { normalizeMode } = require('./bot-mode')

const STUCK_MS = 15000, AGAIN_MS = 30000, MOVED_M = 1, REACH = 5.5, TRIES = 8

const finite = p => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const water = found => /water/.test(found?.name ?? '')

function wet (getBlock, feet) {
  if (!finite(feet)) return false
  const x = Math.floor(feet.x), y = Math.floor(feet.y + 0.2), z = Math.floor(feet.z)
  return water(getBlock(x, y, z)) || water(getBlock(x, y - 1, z))
}

// Ledges beside the water, nearest first.
function ledges (getBlock, feet) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.2), fz = Math.floor(feet.z)
  const out = []
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      if ((!dx && !dz) || Math.hypot(dx, dz) > REACH) continue
      for (const dy of [0, 1]) {
        const x = fx + dx, y = fy + dy, z = fz + dz
        const floor = getBlock(x, y - 1, z), body = getBlock(x, y, z), head = getBlock(x, y + 1, z)
        if (floor?.known !== true || floor.boundingBox !== 'block' || water(floor)) continue
        if ([body, head].some(cell => cell?.known !== true || cell.boundingBox !== 'empty' || water(cell) || /lava/.test(cell.name ?? ''))) continue
        out.push({ x: x + 0.5, y, z: z + 0.5 })
      }
    }
  }
  return out.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))
}

function createPlayerWater ({ getMode, shared, agent, getPosition, getBlock, start, moving, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
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
    const reasons = []
    try {
      log(`プレイヤーモード: 水の中で止まっているため、岸 (${Math.floor(found[0].x)}, ${found[0].y}, ${Math.floor(found[0].z)}) へ上がります`)
      agent.stop('水から上がります。')
      await settle()
      for (const ledge of found) {
        if (!live()) return null
        try { start(ledge, { allowWater: true, allowLowHealth: true, waterExit: true, maxDistance: 4 }) } catch (error) { reasons.push(String(error?.message ?? error).slice(0, 80)); continue }
        await sleep(300)
        for (let i = 0; i < 50 && moving() && !disposed(); i++) await sleep(200)
        if (!wet(getBlock, getPosition())) { log('プレイヤーモード: 水から上がりました'); since = null; anchor = null; return true }
        reasons.push('上がれませんでした')
      }
      log(`プレイヤーモード: 水から上がれません（${[...new Set(reasons)].slice(0, 2).join(' / ') || '不明'}）`)
      return false
    } finally {
      busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '水から上がっています。' : null }) }
}

module.exports = { createPlayerWater, wet, ledges }
