'use strict'

// Player mode runs when badly hurt. Live 2026-11-15 18:16 JST: at 5.85 health,
// with a wooden sword and no food, the Bot met one more zombie, was told to
// push through, and died. A player at that health turns and runs: zombies and
// creepers are slower than a sprint.
// - Trigger: health 8 or less (and above 0), a hostile within 12 m, no totem.
//   Not with a weapon in hand once the nearest hostile is within 3.5 m.
//   With no weapon held (live 20:30-20:33 JST: an empty-handed Bot on a trip
//   took two creeper blasts, 20 -> 10 -> 0, without stepping away): a creeper
//   within 8 m at any health, an archer or a witch within 12 m at any health,
//   and any hostile within 12 m at health 10 or less.
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
// - Who holds the input is decided in control-owner.js: no run starts while
//   an armed fight is on or another walk (the cover) holds the input, and the
//   stand-down of combat is the owner's lease. The run acquires the lease,
//   sees the old input returned (the work, a trip, a motion in flight) before
//   its first step, and sends each step only while it still holds the lease.
//   A run that could not take the input, or lost it, says nothing about the
//   way: it is not counted as "no step could start".
const { normalizeMode } = require('./bot-mode')
const { createControlOwner, holdOf, inContact, CONTACT_M } = require('./control-owner')
const { blocked: blockedResult, interrupted, completed, partial, failed: failedResult } = require('./return/return-result')

const FLEE_AT = 8, UNARMED_FLEE_AT = 10, CREEPER_M = 8, GAIN_M = 2
// With no weapon an archer or a witch is run from at any health within
// RANGED_M (live 2026-11-19 17:47:10-17:47:19 JST: respawned empty-handed, the
// Bot came down the house's step 1.1 m from a witch at health 19; the flee
// waited for health 10, the potions took it from 19 to 4 in six seconds, and
// the run that started then was too late).
const RANGED = /skeleton|stray|bogged|pillager|witch|blaze|ghast/, RANGED_M = 12, STRUCK_MS = 4000
// Hurt and just hit: a shooter with a line to the Bot (the caller passes only
// those, player-flee-threats.js) is run from out to its shooting range, not
// the 12 m of a walker (live 2026-11-24 04:06:53-04:07:06 JST: health 7, no
// armour, a skeleton 14.5-16.2 m away on open grass; this said "no threat",
// there was no cover and no fight, and three arrows in 12 s took 11 health
// while the Bot stood still).
const SHOT_M = 20
// One step: 1.5 s of planning and at most 8 s of walking (long-travel-runtime.js retreatStep).
const STEP_MS = 12000
const WEAPON = /_sword$|_axe$|^minecraft:(?:bow|crossbow|trident|mace)$/
// Unreceived items are not a weapon in hand.
const unarmed = inventory => !(inventory?.items ?? []).some(item => item?.count > 0 && WEAPON.test(item.name ?? ''))
const text = value => String(value ?? '').replace(/^minecraft:/, '').replace(/[\p{C}§]/gu, ' ').slice(0, 40)
const idOf = actor => actor?.runtimeId ?? actor?.uniqueId ?? null

function fleeWanted ({ health, totem, hostiles, position, weaponless = false, healing = null, struck = false }) {
  if (!Number.isFinite(health) || health <= 0 || !position) return null
  const hurt = health <= (weaponless ? UNARMED_FLEE_AT : FLEE_AT)
  if (!hurt && !weaponless) return null
  let nearest = null
  for (const actor of hostiles ?? []) {
    if (!actor?.position) continue
    const distance = Math.hypot(actor.position.x - position.x, actor.position.y - (position.y - 1.62), actor.position.z - position.z)
    const type = String(actor.entityType ?? actor.name ?? '')
    const shooter = RANGED.test(type) || actor.tridentThrower === true
    if (distance <= (hurt ? (struck && shooter ? SHOT_M : 12) : /creeper/.test(type) ? CREEPER_M : shooter ? RANGED_M : -1) && (!nearest || distance < nearest.distance)) nearest = { distance, name: text(actor.entityType ?? actor.name), ...(idOf(actor) != null ? { id: String(idOf(actor)) } : {}) }
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

function createPlayerFlee ({ getMode, shared, agent, travel = null, motion = null, getState, hostiles, retreat, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), owner = createControlOwner({ shared, now, sleep }) }) {
  let busy = false, restUntil = 0, stuck = 0, stuckHealth = null, stuckDistance = null, last = null, saidAt = -Infinity
  // What can still send when a run takes the input, and how each is asked to stop (control-owner.js handoff).
  const input = holdOf({
    work: { on: () => agent.running(), stop: reason => agent.stop(reason) },
    trip: { on: () => travel?.status()?.busy === true, stop: () => travel.cancel() },
    motion: { on: () => motion?.moving() === true, stop: reason => motion.stop(reason) },
    fight: { on: () => owner.held() }
  })
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
    // An armed fight that is on keeps the input (control-owner.js).
    if (owner.fighting(!unarmed(state.inventory))) { skip = 'fighting'; return false }
    const resting = now() < restUntil
    // Hurt again since the run that went nowhere: the wait is over.
    if (resting && stuckHealth === null) { skip = 'rest'; return false }
    // "Health cannot come back, so stay" is for hostiles that stand off. While
    // being hit with no fight on, it does not hold (live 2026-11-19
    // 18:02:23-18:02:32 JST: health 5, hunger 16, no food, the fight ended on
    // HP_DISENGAGE, no cover within reach; this said "no threat" and a
    // skeleton 7 m away took the last 5 health in nine seconds).
    const struck = now() - Number(shared.recentDamageNoPrimary?.at ?? NaN) <= STRUCK_MS
    const healing = struck ? null : state.healing
    const threat = fleeWanted({ health: state.health, totem: state.totem, hostiles: resting ? others() : hostiles(), position: state.position, weaponless: unarmed(state.inventory), healing, struck })
    if (!threat) { skip = resting && kept.size ? 'kept_up_rest' : 'no_threat'; return false }
    // So is it when a hostile has come 2 m closer than the one it was stuck on
    // (live 2026-11-16 13:08 JST: during the wait a creeper walked up to 3.8 m
    // and its blast killed the Bot at health 2).
    if (resting && !(state.health < stuckHealth - 0.5) && !(threat.distance <= stuckDistance - 2)) { skip = 'stuck_rest'; return false }
    // Check and record in one step: the run that is refused sends nothing.
    const got = owner.acquire('flee', { ms: STEP_MS, armed: !unarmed(state.inventory) })
    if (!got.acquired) { skip = got.code === 'FIGHT_ON' ? 'fighting' : got.code === 'INPUT_HELD' ? `${got.holder.who}_walking` : got.code.toLowerCase(); return false }
    const lease = got.lease
    skip = null
    busy = true
    let steps = 0, failed = 0, stopped = null
    try {
      // The work, a trip in progress and a motion in flight are stopped, and seen stopped, first.
      const taken = await owner.handoff(lease, input, { reason: '敵から離れます。' })
      if (!taken.ok) { stopped = taken; restUntil = Math.max(restUntil, now() + 1000) } else log(`プレイヤーモード: ${state.health <= FLEE_AT ? '体力が少ないため' : '武器がないため'}敵から離れます（体力 ${Math.round(state.health * 10) / 10}、${threat.name} ${threat.distance.toFixed(1)}m）`)
      const until = now() + 20000
      while (!stopped && inPlay() && now() < until && failed < 3) {
        const current = getState()
        if (!(current.health > 0)) break
        const near = (hostiles() ?? []).filter(actor => actor?.position && current.position && Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) <= 16)
        if (!near.length) break
        // Caught up with while armed: combat takes the fight back.
        if (steps + failed > 0 && !unarmed(current.inventory) && near.some(actor => Math.hypot(actor.position.x - current.position.x, actor.position.y - (current.position.y - 1.62), actor.position.z - current.position.z) <= CONTACT_M)) break
        // Combat stands down only while a step is being tried or walked.
        if (!lease.renew(STEP_MS)) { stopped = { code: lease.lost() ?? 'LEASE_RELEASED' }; break }
        let moved = false
        try { moved = await retreat(lease) === true } catch { moved = false }
        // The input was lost during the step: what it walked stays walked, nothing more is sent.
        const code = lease.lost()
        if (code) { if (moved) steps++; stopped = { code }; break }
        if (moved) { steps++; failed = 0 } else { failed++; await sleep(250) }
      }
      if (stopped) {
        last = stopped.code === 'HANDOFF_INCOMPLETE' ? blockedResult(stopped.code, { kind: 'owner_released' }, { progress: { steps }, evidence: { lease: lease.id, holding: stopped.holding } }) : interrupted(stopped.code, { progress: { steps }, evidence: { lease: lease.id } })
        if (now() - saidAt >= 10000) {
          saidAt = now()
          log(stopped.code === 'HANDOFF_INCOMPLETE' ? `プレイヤーモード: 前の操作（${stopped.holding.join('・')}）がまだ入力を持っているため、離れる歩きを始めません（HANDOFF_INCOMPLETE、操作権 ${lease.id}）` : `プレイヤーモード: 離れる歩きをやめました（${steps}歩、${stopped.code}、操作権 ${lease.id}）`)
        }
        return steps > 0
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
      const progress = { steps }, evidence = { lease: lease.id }
      last = keptUp ? partial('KEPT_UP', { progress, evidence }) : failed >= 3 ? failedResult('NO_STEP', { progress, evidence }) : completed('LEFT', { progress, evidence })
      return true
    } finally { lease.release(); busy = false }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '敵から離れています。' : null, skip, last }) }
}

// In play with a weapon in the received inventory: combat fights as usual, the
// "nothing to lose" rule of the long-trip preparation does not apply.
const armedInPlay = (shared, inventory) => shared?.playerWanted === true && !shared.inventoryUncertain && !unarmed(inventory)

// A hostile within melee contact (the caller asks for a weapon) is combat's, even while a
// step away from another one is being walked: the stand-down covered the
// whole step, so a zombie that closed in during it hit freely (live
// 2026-11-19 12:17 JST: combat ended on PLAYER_FLEE with a zombie within 2 m,
// health 20 to 2 in five seconds).
const caughtUp = inContact

module.exports = { caughtUp, createPlayerFlee, fleeWanted, unarmed, armedInPlay, FLEE_AT }
