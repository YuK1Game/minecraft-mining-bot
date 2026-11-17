'use strict'

// A hit with no visible cause leaves a log line of what was around it: the
// body's cells and every received entity within 48 m, arrows included (live
// 2026-11-17 22:21-22:22 JST: 14 hits of 0.7-0.96 over 90 s, no hostile, effect
// or arrow line in the log, the Bot stood still until it died).
const GAP_MS = 5000
const RANGE_M = 48
const SKIP = /^minecraft:(item|xp_orb|player)$/

function noteDamage ({ shared, health, position, actors, getBlock, log, now = Date.now() }) {
  const at = shared?.travelLastDamageAt
  if (!Number.isFinite(at) || at === shared.damageNoteSeen) return null
  shared.damageNoteSeen = at
  if (now - (shared.damageNoteAt ?? -Infinity) < GAP_MS) return null
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
  shared.damageNoteAt = now
  const feet = { x: Math.floor(position.x), y: Math.floor(position.y - 1.62 + 1e-3), z: Math.floor(position.z) }
  const cell = dy => { const block = getBlock(feet.x, feet.y + dy, feet.z); return block?.known === false ? '?' : String(block?.name ?? '?').replace(/^minecraft:/, '') }
  const list = (actors ?? []).filter(actor => actor?.entityType && !SKIP.test(actor.entityType) && actor.alive !== false)
  const unknown = list.filter(actor => !actor.position || ![actor.position.x, actor.position.y, actor.position.z].every(Number.isFinite)).length
  const near = list.filter(actor => actor.position && [actor.position.x, actor.position.y, actor.position.z].every(Number.isFinite))
    .map(actor => ({ type: actor.entityType.replace(/^minecraft:/, ''), distance: Math.hypot(actor.position.x - position.x, actor.position.y - (position.y - 1.62), actor.position.z - position.z), dy: actor.position.y - (position.y - 1.62) }))
    .filter(actor => actor.distance <= RANGE_M).sort((a, b) => a.distance - b.distance).slice(0, 8)
  const text = `被弾のまわり: 体力 ${Number.isFinite(health) ? Math.round(health * 100) / 100 : '?'}、足 (${feet.x}, ${feet.y}, ${feet.z})、足のマス ${cell(0)}・頭 ${cell(1)}・下 ${cell(-1)}、${RANGE_M}m 以内 ${near.length ? near.map(actor => `${actor.type} ${actor.distance.toFixed(1)}m(${actor.dy >= 0 ? '+' : ''}${actor.dy.toFixed(1)})`).join(' / ') : 'なし'}${unknown ? `、位置不明 ${unknown}` : ''}`
  log(text)
  return text
}

module.exports = { noteDamage }
