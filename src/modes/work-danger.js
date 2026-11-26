'use strict'

// Player mode: "an enemy is near", the one answer of the jobs that take the work from the autonomous run (storage,
// discard, torch, base, house, wool, sand, food, water: mode-runtime.js `danger`), and who it is (`why`, `text`), so that a
// job it cuts short can say so.
//
// Counted:
// - health lost within HURT_MS (real Realm 2026-11-17 09:52-09:53 JST: a skeleton 12.4 m away shot the Bot from 12.9 to
//   0 while the storage and the food climb started anyway);
// - a hostile within NEAR_M. A walker with fresh evidence of no route to the Bot is not (2026-11-17 11:15 JST: zombies
//   10-12 m away in the cave above held the base trip); a creeper always is;
// - an archer or a witch within ARCHER_M whose position was received within FRESH_MS (one that aims turns, and every
//   turn is a position update: 2026-11-17 10:46-10:59 JST, a cave skeleton 15 below with no update for 4 minutes held the
//   sand search), unless every line between the two bodies ends in a received block with a body: the evidence the flee
//   uses (player-flee-threats.js, combat-exposure.js with solidCover). A line through unreceived blocks is not cover, and
//   neither is water or a plant.
//
// The last condition is of 2026-11-20. The archer rule measured the distance through the ground: 22:15-22:44 JST (house at
// (9877, 64, 10138)), six runs of the house repair ended 「敵が近いため中断しました」 with nothing placed and no fight,
// hit or flee line within 5 s of any of them; at 23:40 sixteen hostiles stood in the caves 9-32 blocks under the house,
// a skeleton 13 below among them, every position received within seconds. Which of them cut the six runs short was not
// in the log: the line now says.
const { createCombatExposure } = require('../combat/combat-exposure')

const NEAR_M = 12, ARCHER_M = 24, HURT_MS = 10000, FRESH_MS = 60000
const ARCHER = /skeleton|stray|bogged|pillager|witch/

// world(): the received blocks ({ getBlock }); the lines between the bodies are read from it on every look.
function createWorkDanger ({ health, where, hostiles, world, nearest = () => Infinity, unreachable = () => false, now = Date.now }) {
  let healthSeen = null, hurtAt = -Infinity
  // True: a line is clear. False: every line ends in a received block with a body. Null: not told (unreceived blocks).
  const sight = (actor, at) => createCombatExposure({ world: world(), entities: {}, scopeOf: () => null, solidCover: true }).evaluate(actor, { position: at }).evidence.sight
  // { code: HURT | NEAR | ARCHER, type, distance, rise } of the first that counts; null when none does.
  function why () {
    const value = health()
    if (Number.isFinite(value)) { if (Number.isFinite(healthSeen) && value < healthSeen) hurtAt = now(); healthSeen = value }
    if (now() - hurtAt < HURT_MS) return { code: 'HURT' }
    const at = where()
    if (!at) { const distance = nearest(); return distance < NEAR_M ? { code: 'NEAR', type: null, distance, rise: null } : null }
    for (const actor of hostiles() ?? []) {
      const p = actor?.position, type = String(actor?.entityType ?? '')
      if (!p) continue
      const distance = Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z), rise = p.y - (at.y - 1.62)
      // Any enemy but a creeper whose every line to the Bot ends in received solid blocks is not near for work (the owner's
      // rule, 2026-11-26 22:27 JST: 「射線切れてるし…無視していい」), and a walker with no route is not either (unreachable).
      // Live 2026-11-26 18:19-22:14 JST: a zombie 3-6 below and then a skeleton 8 m off in the caves under the house cut
      // every house repair run short, 「敵が近いため中断しました」 every two minutes for hours.
      let covered = false
      if (distance < NEAR_M && !/creeper/.test(type)) { try { covered = sight(actor, at) === false } catch { covered = false } }
      if (distance < NEAR_M && !covered && (/creeper/.test(type) || !unreachable(actor))) return { code: 'NEAR', type, distance, rise }
      if (!ARCHER.test(type) || !(distance < ARCHER_M) || now() - Date.parse(actor.positionUpdatedAt ?? '') > FRESH_MS) continue
      let seen = null
      try { seen = sight(actor, at) } catch { /* Not told: counted. */ }
      if (seen !== false) return { code: 'ARCHER', type, distance, rise }
    }
    return null
  }
  // For a log line: 「skeleton 18m・13段下」, 「10秒以内に被弾」; null when nothing counts.
  function text () {
    const found = why()
    if (!found) return null
    if (found.code === 'HURT') return `${HURT_MS / 1000}秒以内に被弾`
    const name = found.type ? found.type.replace(/^minecraft:/, '') : '敵'
    const level = Number.isFinite(found.rise) && Math.abs(found.rise) >= 1.5 ? `・${Math.round(Math.abs(found.rise))}段${found.rise > 0 ? '上' : '下'}` : ''
    return `${name} ${Math.round(found.distance)}m${level}`
  }
  return { near: () => why() !== null, why, text }
}

module.exports = { createWorkDanger, NEAR_M, ARCHER_M, HURT_MS, FRESH_MS }
