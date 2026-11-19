'use strict'

// Player mode runs when badly hurt. Live 2026-11-15 18:16 JST: at 5.85 health,
// with a wooden sword and no food, the Bot met one more zombie, was told to
// push through, and died. A player at that health turns and runs: zombies and
// creepers are slower than a sprint.
// - Trigger: health 8 or less (and above 0), a hostile within 12 m, no totem.
//   Not with a weapon in hand once the nearest hostile is within 3.5 m.
//   With no weapon held (live 20:30-20:33 JST: an empty-handed Bot on a trip
//   took two creeper blasts, 20 -> 10 -> 0, without stepping away): a creeper
//   within 8 m at any health, and any hostile within 12 m at health 10 or less.
// - A trip in progress is cancelled first: its walk owns the movement.
// - While it runs, combat is told to stand down (shared.playerFlee, read by the
//   combat work guard) and the autonomy is stopped; each step is the long
//   trip's retreat step (5-12 m straight away, the ordinary movement).
// - It ends when nothing hostile is within 16 m, after 20 s, or when three
//   steps in a row could not start; then combat fights as before. Afterwards
//   the shelter rests the Bot and play resumes by itself.
// - A run that could not take a single step is not tried again for 30 s, then
//   60 s, then 2 min, unless the received health has dropped since or a
//   hostile has come 2 m closer than the one it was stuck on (live
//   2026-11-16 12:20-12:31 JST: at health 2, a drowned in water 6.6 blocks
//   below never came closer; 55 runs in ten minutes each stopped the autonomy
//   and ended with no step, so the Bot never ate or hunted).
// - A run that walked and still has the same hostile as near as before did
//   not get away either (live 2026-11-18 04:31-04:34 JST: a phantom 4.6 blocks
//   overhead stayed at 6.3 m through nine runs of 20 s, 「敵から離れました（71歩）」
//   each time, the Bot on the same spot at health 3.7; neither the fight nor
//   the trip to the base went on). It waits the same way, and during that
//   wait the hostile it could not leave behind does not start a new run,
//   however near it comes: combat has it.
const { normalizeMode } = require('./bot-mode')

const FLEE_AT = 8, UNARMED_FLEE_AT = 10, CREEPER_M = 8, CONTACT_M = 3.5, GAIN_M = 2
const WEAPON = /_sword$|_axe$|^minecraft:(?:bow|crossbow|trident|mace)$/
// Unreceived items are not a weapon in hand.
const unarmed = inventory => !(inventory?.items ?? []).some(item => item?.count > 0 && WEAPON.test(item.name ?? ''))
const text = value => String(value ?? '').replace(/^minecraft:/, '').replace(/[\p{C}§]/gu, ' ').slice(0, 40)
const idOf = actor => actor?.runtimeId ?? actor?.uniqueId ?? null

function fleeWanted ({ health, totem, hostiles, position, weaponless = false, healing = null }) {
  if (!Number.isFinite(health) || health <= 0 || !position) return null
  const hurt = health <= (weaponless ? UNARMED_FLEE_AT : FLEE_AT)
  if (!hurt && !weaponless) return null
  let nearest = null
  for (const actor of hostiles ?? []) {
    if (!actor?.position) continue
    const distance = Math.hypot(actor.position.x - position.x, actor.position.y - (position.y - 1.62), actor.position.z - position.z)
    if (distance <= (hurt ? 12 : /creeper/.test(String(actor.entityType ?? actor.name ?? '')) ? CREEPER_M : -1) && (!nearest || distance < nearest.distance)) nearest = { distance, name: text(actor.entityType ?? actor.name), ...(idOf(actor) != null ? { id: String(idOf(actor)) } : {}) }
  }
  // Armed and already in melee contact: turning away only gives free hits
  // (live 2026-11-16 10:00 JST: with a stone sword at 6.4 health and a drowned
  // at 1.1 m, combat was told to stand down, no step started in three
  // seconds, and three more hits killed the Bot). Combat keeps the fight.
  if (nearest && !weaponless && nearest.distance <= CONTACT_M) return null
  // Armed, and health cannot come back (received hunger under 18, no food
  // held): walking away buys nothing and stops the food work that would heal
  // (live 2026-11-19 12:59-13:09 JST: health 3.66 for ten minutes, hunger
  // 17 → 6, food 0; left zombies at 5-12 m, resumed, left again, and every
  // forage ended 「自律処理は停止されました」). Combat keeps what comes near.
  if (nearest && hurt && !weaponless && healing === false) return null
  // The totem is asked last: reading it costs a full state.
  return nearest && (typeof totem === 'function' ? totem() : totem) !== true ? nearest : null
}

function createPlayerFlee ({ getMode, shared, agent, travel = null, getState, hostiles, retreat, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, restUntil = 0, stuck = 0, stuckHealth = null, stuckDistance = null
  // The hostiles the last runs walked from without leaving them behind.
  const kept = new Set()
  const others = () => kept.size ? (hostiles() ?? []).filter(actor => idOf(actor) == null || !kept.has(String(idOf(actor)))) : hostiles()
  // Why the last tick did not run, for the hit note (damage-note.js).
  let skip = null
  const inPlay = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true

  async function tick () {
    if (busy) { skip = 'busy'; return false }
    if (!inPlay()) { skip = 'not_playing'; return false }
    if (shared.travelNight?.cover) { skip = 'night_pit'; return false }
    const state = getState()
    const resting = now() < restUntil
    // Hurt again since the run that went nowhere: the wait is over.
    if (resting && stuckHealth === null) { skip = 'rest'; return false }
    const threat = fleeWanted({ health: state.health, totem: state.totem, hostiles: resting ? others() : hostiles(), position: state.position, weaponless: unarmed(state.inventory), healing: state.healing })
    if (!threat) { skip = resting && kept.size ? 'kept_up_rest' : 'no_threat'; return false }
    // So is it when a hostile has come 2 m closer than the one it was stuck on
    // (live 2026-11-16 13:08 JST: during the wait a creeper walked up to 3.8 m
    // and its blast killed the Bot at health 2).
    if (resting && !(state.health < stuckHealth - 0.5) && !(threat.distance <= stuckDistance - 2)) { skip = 'stuck_rest'; return false }
    skip = null
    busy = true
    let steps = 0, failed = 0
    try {
      log(`プレイヤーモード: ${state.health <= FLEE_AT ? '体力が少ないため' : '武器がないため'}敵から離れます（体力 ${Math.round(state.health * 10) / 10}、${threat.name} ${threat.distance.toFixed(1)}m）`)
      const until = now() + 20000
      while (inPlay() && now() < until && failed < 3) {
        const current = getState()
        if (!(current.health > 0)) break
        const near = (hostiles() ?? []).filter(actor => actor?.position && current.position && Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) <= 16)
        if (!near.length) break
        // Caught up with while armed: combat takes the fight back.
        if (steps + failed > 0 && !unarmed(current.inventory) && near.some(actor => Math.hypot(actor.position.x - current.position.x, actor.position.y - (current.position.y - 1.62), actor.position.z - current.position.z) <= CONTACT_M)) break
        // Combat stands down only while a step is being tried or walked.
        shared.playerFlee = { until: now() + 9000 }
        if (agent.running()) agent.stop('敵から離れます。')
        if (travel?.status()?.busy) { try { await travel.cancel() } catch { /* The step below fails and is retried. */ } }
        let moved = false
        try { moved = await retreat() === true } catch { moved = false }
        if (moved) { steps++; failed = 0 } else { failed++; await sleep(250) }
      }
      // Walked, and the hostile is as near as it was: it flies, or it keeps up.
      const end = getState()
      const left = steps > 0 ? fleeWanted({ health: end.health, totem: end.totem, hostiles: hostiles(), position: end.position, weaponless: unarmed(end.inventory), healing: end.healing }) : null
      const keptUp = !!left && left.distance < threat.distance + GAIN_M
      log(failed >= 3 ? `プレイヤーモード: 離れる経路がないため、その場で戦います（${steps}歩）` : keptUp ? `プレイヤーモード: 離れても敵との距離が開きません（${steps}歩、${left.name} ${left.distance.toFixed(1)}m）` : `プレイヤーモード: 敵から離れました（${steps}歩）`)
      // After a failed run, combat gets five seconds before the next try; a
      // run with no step at all, or one that did not get away, waits longer each time.
      if ((failed >= 3 && steps === 0) || keptUp) {
        stuck++
        stuckHealth = end.health
        stuckDistance = keptUp ? left.distance : threat.distance
        if (keptUp && left.id != null) kept.add(left.id)
        restUntil = now() + Math.min(120000, 30000 * 2 ** (stuck - 1))
        log(keptUp ? `プレイヤーモード: 離れられない敵のため、ほかの敵が近づくか体力が減らない限り${Math.round((restUntil - now()) / 1000)}秒は離れ直しません（その敵は戦闘に任せます）。` : `プレイヤーモード: 1歩も離れられなかったため、体力が減らない限り${Math.round((restUntil - now()) / 1000)}秒は離れ直しません。`)
      } else {
        stuck = 0; stuckHealth = null; stuckDistance = null; kept.clear()
        if (failed >= 3) restUntil = now() + 5000
      }
      return true
    } finally { shared.playerFlee = null; busy = false }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '敵から離れています。' : null, skip }) }
}

// In play with a weapon in the received inventory: combat fights as usual, the
// "nothing to lose" rule of the long-trip preparation does not apply.
const armedInPlay = (shared, inventory) => shared?.playerWanted === true && !shared.inventoryUncertain && !unarmed(inventory)

// A hostile within melee contact (the caller asks for a weapon) is combat's, even while a
// step away from another one is being walked: the stand-down covered the
// whole step, so a zombie that closed in during it hit freely (live
// 2026-11-19 12:17 JST: combat ended on PLAYER_FLEE with a zombie within 2 m,
// health 20 to 2 in five seconds).
function caughtUp (target, state) {
  const at = target?.position, me = state?.position
  if (!at || !me) return false
  return Math.hypot(at.x - me.x, at.y - (me.y - 1.62), at.z - me.z) <= CONTACT_M
}

module.exports = { caughtUp, createPlayerFlee, fleeWanted, unarmed, armedInPlay, FLEE_AT }
