'use strict'

// Player mode: out of an archer's line of fire when it cannot be fought.
// Without a bow the only answer to a skeleton is to walk up to it, and where
// no walk leads there the Bot stood in its sight and was shot (real Realm
// 2026-11-16 13:47 and 14:31 JST, and witches at 2026-11-17 03:38 and
// 06:14 JST, whose potions killed the Bot the same way: a skeleton 8-11 m away, the approach ended
// with 「No known bounded melee stance」, the flee found no step straight away
// from it, and three arrows killed the Bot each time).
// - Trigger: in play, no bow with arrows held, hit within the last four
//   seconds, and an archer between 4 m and 20 m with a clear line to the body
//   that is not known to be reachable on foot (those are fought).
// - It walks to the nearest place it can reach on foot (within eight blocks)
//   that no such archer sees: both the eye and the body centre there are
//   behind received blocks. Unreceived blocks are not cover.
// - While it walks, combat is told to stand down (shared.playerFlee, as for
//   the flee) and the autonomy is stopped. Behind cover combat fights as
//   before: an archer that comes round the corner is in sword reach.
// - No such place: said once in the log; tried again after ten seconds.
// - An archer it can walk to is fought only with a weapon in the received
//   inventory. Without one it is "cannot be fought" as well (live 2026-11-18
//   11:49:05-11:49:53 JST: just respawned, no sword yet, a witch 8-10 m away
//   on foot; this cover said "reachable", combat had nothing to swing, the
//   flee waits for health 10 without a weapon, and the Bot went from 19 to 1
//   in 22 s without a step, then died).
// - Who holds the input is decided in control-owner.js: with a weapon, no
//   walk starts while a fight is on, whichever enemy the fight is with.
const { normalizeMode } = require('./bot-mode')
const { unarmed } = require('./player-flee')
const { createControlOwner } = require('./control-owner')

const ARCHER = /^minecraft:(?:skeleton|stray|bogged|pillager|witch)$/
// A witch throws potions from close by, so it counts from sword reach (3 m).
const nearOf = actor => String(actor?.entityType ?? '') === 'minecraft:witch' ? 3 : NEAR_M
const HIT_MS = 4000, NEAR_M = 4, FAR_M = 20, REACH_CELLS = 8, TRIES = 3
const hasBow = inventory => { const items = inventory?.items ?? []; return items.some(item => item?.name === 'minecraft:bow' && item.count > 0) && items.some(item => item?.name === 'minecraft:arrow' && item.count > 0) }
const eyeOf = actor => ({ x: actor.position.x, y: actor.position.y + 1.6, z: actor.position.z })

// Archers that see the body standing with its feet at `feet` (eye or centre).
function exposedTo (feet, archers, sight) {
  const eye = { x: feet.x, y: feet.y + 1.62, z: feet.z }, centre = { x: feet.x, y: feet.y + 0.9, z: feet.z }
  return archers.filter(actor => sight(eyeOf(actor), eye) !== false || sight(eyeOf(actor), centre) !== false)
}

// The nearest walkable cells (in walking order) that none of the archers sees.
function coverCells ({ feet, cells, archers, sight, limit = TRIES }) {
  const found = []
  const home = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.001), z: Math.floor(feet.z) }
  for (const cell of cells) {
    if (cell.x === home.x && cell.y === home.y && cell.z === home.z) continue
    if (Math.max(Math.abs(cell.x - home.x), Math.abs(cell.z - home.z)) > REACH_CELLS) continue
    if (exposedTo({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, archers, sight).length) continue
    found.push(cell)
    if (found.length >= limit) break
  }
  return found
}

function createPlayerCover ({ getMode, shared, agent, getState, hostiles, sight, cells, walk, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, owner = createControlOwner({ shared, now }) }) {
  let busy = false, restUntil = 0
  // Why the last tick did not run, for the hit note (damage-note.js).
  let skip = null
  const inPlay = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true

  async function tick () {
    const reason = busy ? 'busy' : !inPlay() ? 'not_playing' : now() < restUntil ? 'rest' : shared.travelNight?.cover ? 'night_pit' : owner.walking() ? 'fleeing' : blocked() ? 'blocked' : null
    if (reason) { skip = reason; return false }
    const hitAt = Number(shared.recentDamageNoPrimary?.at ?? NaN)
    if (!(now() - hitAt >= 0 && now() - hitAt <= HIT_MS)) { skip = 'no_recent_hit'; return false }
    const state = getState()
    if (!(state.health > 0) || !state.position || state.inventory == null) { skip = 'state_unknown'; return false }
    if (hasBow(state.inventory)) { skip = 'bow'; return false }
    const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
    const range = actor => Math.hypot(actor.position.x - feet.x, actor.position.y - feet.y, actor.position.z - feet.z)
    const near = (hostiles() ?? []).filter(actor => actor?.position && (ARCHER.test(String(actor.entityType ?? '')) || actor.tridentThrower === true) && range(actor) > nearOf(actor) && range(actor) <= FAR_M)
    const exposed = near.length ? exposedTo(feet, near, sight) : []
    const armed = !unarmed(state.inventory)
    const archers = exposed
    if (!archers.length) { skip = !near.length ? 'no_archer_4_20m' : `unseen_by_${near.length}`; return false }
    // An armed fight that is on keeps the input (control-owner.js).
    if (owner.fighting(armed)) { skip = 'fighting'; return false }
    skip = null
    busy = true
    try {
      const places = coverCells({ feet, cells: cells(state.position), archers: near, sight })
      const name = String(archers[0].entityType).replace(/^minecraft:/, '')
      if (!places.length) {
        restUntil = now() + 10000
        log(`プレイヤーモード: ${name} の射線から外れられる場所が近くにありません（${range(archers[0]).toFixed(1)}m）`)
        return false
      }
      log(`プレイヤーモード: ${armed ? '近づけない' : '武器がなく戦えない'} ${name}（${range(archers[0]).toFixed(1)}m）に撃たれているため、射線から外れます`)
      for (const cell of places) {
        if (!inPlay()) break
        owner.claim('cover', 14000)
        if (agent.running()) agent.stop('弓の敵の射線から外れます。')
        let arrived = false
        try { arrived = await walk({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }) === true } catch { arrived = false }
        if (arrived) { log('プレイヤーモード: 射線から外れました'); restUntil = now() + 2000; return true }
      }
      restUntil = now() + 5000
      log('プレイヤーモード: 射線から外れる場所へ歩けませんでした')
      return false
    } finally { owner.release('cover'); busy = false }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '弓の敵の射線から外れています。' : null, skip }) }
}

module.exports = { createPlayerCover, coverCells, exposedTo }
