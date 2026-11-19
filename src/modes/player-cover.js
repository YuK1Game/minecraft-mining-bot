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
//   walk starts while a fight is on, whichever enemy the fight is with, nor
//   while the flee holds the input. The run acquires the lease, sees the old
//   input returned (the work, the expedition's step and trip, a motion in
//   flight) before its first walk, and walks only while it still holds it.
// - "Walked to the place" is not "out of the line of fire": after each walk
//   the archers and the Bot are read again where they are now, and only a
//   body no archer sees counts. An archer that moved is planned for again;
//   an unread position or enemy list is not cover.
const { normalizeMode } = require('./bot-mode')
const { unarmed } = require('./player-flee')
const { createControlOwner, holdOf } = require('./control-owner')
const { blocked: blockedResult, interrupted, completed, failed } = require('./return/return-result')

const ARCHER = /^minecraft:(?:skeleton|stray|bogged|pillager|witch)$/
// A witch throws potions from close by, so it counts from sword reach (3 m).
const nearOf = actor => String(actor?.entityType ?? '') === 'minecraft:witch' ? 3 : NEAR_M
const HIT_MS = 4000, NEAR_M = 4, FAR_M = 20, REACH_CELLS = 8, TRIES = 3
// One walk: at most 12.3 s once it has started (player-scaffold-ports.js walk).
const WALK_MS = 14000
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

function createPlayerCover ({ getMode, shared, agent = null, hold = null, getState, hostiles, sight, cells, walk, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), owner = createControlOwner({ shared, now, sleep }) }) {
  let busy = false, restUntil = 0, last = null, saidAt = -Infinity
  // Why the last tick did not run, for the hit note (damage-note.js).
  let skip = null
  const inPlay = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  // What can still send when a run takes the input, and how each is asked to stop (control-owner.js handoff; cover-ports.js).
  const input = hold ?? holdOf({ work: { on: () => agent.running(), stop: reason => agent.stop(reason) }, fight: { on: () => owner.held() } })
  const isArcher = actor => ARCHER.test(String(actor.entityType ?? '')) || actor.tridentThrower === true
  // Where the Bot and the archers are now, from received data; null while either is not read.
  function view () {
    const state = getState(), seen = hostiles()
    if (!(state?.health > 0) || !state.position || state.inventory == null || !Array.isArray(seen)) return null
    const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
    const range = actor => Math.hypot(actor.position.x - feet.x, actor.position.y - feet.y, actor.position.z - feet.z)
    const within = seen.filter(actor => actor?.position && isArcher(actor) && range(actor) <= FAR_M)
    return { state, feet, range, within, far: within.filter(actor => range(actor) > nearOf(actor)), seenBy: exposedTo(feet, within, sight) }
  }

  async function tick () {
    const reason = busy ? 'busy' : !inPlay() ? 'not_playing' : now() < restUntil ? 'rest' : shared.travelNight?.cover ? 'night_pit' : blocked() ? 'blocked' : null
    if (reason) { skip = reason; return false }
    const hitAt = Number(shared.recentDamageNoPrimary?.at ?? NaN)
    if (!(now() - hitAt >= 0 && now() - hitAt <= HIT_MS)) { skip = 'no_recent_hit'; return false }
    const first = view()
    if (!first) { skip = 'state_unknown'; return false }
    const { state, feet, range } = first
    if (hasBow(state.inventory)) { skip = 'bow'; return false }
    const near = first.far
    const archers = near.length ? exposedTo(feet, near, sight) : []
    const armed = !unarmed(state.inventory)
    if (!archers.length) { skip = !near.length ? 'no_archer_4_20m' : `unseen_by_${near.length}`; return false }
    // An armed fight that is on, or another walk, keeps the input (control-owner.js). Check and record are one step.
    const got = owner.acquire('cover', { ms: WALK_MS, armed })
    if (!got.acquired) { skip = got.code === 'FIGHT_ON' ? 'fighting' : got.code === 'INPUT_HELD' ? (got.holder.who === 'flee' ? 'fleeing' : `${got.holder.who}_walking`) : got.code.toLowerCase(); return false }
    const lease = got.lease
    skip = null
    busy = true
    try {
      const name = String(archers[0].entityType).replace(/^minecraft:/, '')
      if (!coverCells({ feet, cells: cells(state.position), archers: near, sight, limit: 1 }).length) {
        restUntil = now() + 10000
        last = failed('NO_COVER', { evidence: { lease: lease.id } })
        log(`プレイヤーモード: ${name} の射線から外れられる場所が近くにありません（${range(archers[0]).toFixed(1)}m）`)
        return false
      }
      // The work, the expedition's step and trip and a motion in flight are stopped, and seen stopped, first.
      const taken = await owner.handoff(lease, input, { reason: '弓の敵の射線から外れます。' })
      if (!taken.ok) {
        last = taken.code === 'HANDOFF_INCOMPLETE' ? blockedResult(taken.code, { kind: 'owner_released' }, { evidence: { lease: lease.id, holding: taken.holding } }) : interrupted(taken.code, { evidence: { lease: lease.id } })
        restUntil = now() + 1000
        if (now() - saidAt >= 10000) { saidAt = now(); log(taken.code === 'HANDOFF_INCOMPLETE' ? `プレイヤーモード: 前の操作（${taken.holding.join('・')}）がまだ入力を持っているため、射線から外れる歩きを始めません（HANDOFF_INCOMPLETE、操作権 ${lease.id}）` : `プレイヤーモード: 射線から外れる歩きをやめました（${taken.code}、操作権 ${lease.id}）`) }
        return false
      }
      log(`プレイヤーモード: ${armed ? '近づけない' : '武器がなく戦えない'} ${name}（${range(archers[0]).toFixed(1)}m）に撃たれているため、射線から外れます`)
      const tried = new Set()
      let stillSeen = null
      for (let attempt = 0; attempt < TRIES && inPlay(); attempt++) {
        // The archers move: each walk is planned from where they and the Bot are now.
        const here = view()
        if (!here) { last = failed('COVER_UNKNOWN', { evidence: { lease: lease.id } }); break }
        const cell = coverCells({ feet: here.feet, cells: cells(here.state.position), archers: here.within, sight, limit: TRIES + tried.size }).find(found => !tried.has(`${found.x},${found.y},${found.z}`))
        if (!cell) break
        tried.add(`${cell.x},${cell.y},${cell.z}`)
        if (!lease.renew(WALK_MS)) { last = interrupted(lease.lost() ?? 'LEASE_RELEASED', { evidence: { lease: lease.id } }); return false }
        let arrived = false
        try { arrived = await walk({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, lease) === true } catch { arrived = false }
        // Judged by where the Bot and the archers are now, not by the arrival: a walk cut short
        // may have left the line of fire, and one that arrived may stand in a new one.
        const after = view(), code = lease.lost()
        // A run that lost the input ends here; what it walked stays walked, and the next run reads the state anew.
        if (code) {
          last = interrupted(code, { progress: { walks: attempt + 1 }, evidence: { lease: lease.id, covered: after ? after.seenBy.length === 0 : null } })
          if (now() - saidAt >= 10000) { saidAt = now(); log(`プレイヤーモード: 射線から外れる歩きをやめました（${code}、操作権 ${lease.id}）`) }
          return false
        }
        if (after && !after.seenBy.length) {
          restUntil = now() + 2000
          last = completed(after.within.length ? 'COVERED' : 'ARCHER_GONE', { progress: { walks: attempt + 1 }, evidence: { lease: lease.id, arrived, archers: after.within.length } })
          log(after.within.length ? 'プレイヤーモード: 射線から外れました' : 'プレイヤーモード: 撃っていた弓の敵が近くにいなくなりました')
          return true
        }
        if (!after) { last = failed('COVER_UNKNOWN', { evidence: { lease: lease.id } }); break }
        stillSeen = arrived ? String(after.seenBy[0].entityType ?? '').replace(/^minecraft:/, '') : null
      }
      restUntil = now() + 5000
      if (last?.code !== 'COVER_UNKNOWN') last = failed(stillSeen ? 'STILL_EXPOSED' : 'COVER_NOT_REACHED', { progress: { walks: tried.size }, evidence: { lease: lease.id } })
      log(last.code === 'COVER_UNKNOWN' ? 'プレイヤーモード: 位置か敵の受信がなく、射線から外れたか確かめられません' : stillSeen ? `プレイヤーモード: 歩いた先でも ${stillSeen} の射線が通っています` : 'プレイヤーモード: 射線から外れる場所へ歩けませんでした')
      return false
    } finally { lease.release(); busy = false }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '弓の敵の射線から外れています。' : null, skip, last }) }
}

module.exports = { createPlayerCover, coverCells, exposedTo }
