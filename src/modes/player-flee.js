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
const { normalizeMode } = require('./bot-mode')

const FLEE_AT = 8, UNARMED_FLEE_AT = 10, CREEPER_M = 8, CONTACT_M = 3.5
const WEAPON = /_sword$|_axe$|^minecraft:(?:bow|crossbow|trident|mace)$/
// Unreceived items are not a weapon in hand.
const unarmed = inventory => !(inventory?.items ?? []).some(item => item?.count > 0 && WEAPON.test(item.name ?? ''))
const text = value => String(value ?? '').replace(/^minecraft:/, '').replace(/[\p{C}§]/gu, ' ').slice(0, 40)

function fleeWanted ({ health, totem, hostiles, position, weaponless = false }) {
  if (!Number.isFinite(health) || health <= 0 || !position) return null
  const hurt = health <= (weaponless ? UNARMED_FLEE_AT : FLEE_AT)
  if (!hurt && !weaponless) return null
  let nearest = null
  for (const actor of hostiles ?? []) {
    if (!actor?.position) continue
    const distance = Math.hypot(actor.position.x - position.x, actor.position.y - (position.y - 1.62), actor.position.z - position.z)
    if (distance <= (hurt ? 12 : /creeper/.test(String(actor.entityType ?? actor.name ?? '')) ? CREEPER_M : -1) && (!nearest || distance < nearest.distance)) nearest = { distance, name: text(actor.entityType ?? actor.name) }
  }
  // Armed and already in melee contact: turning away only gives free hits
  // (live 2026-11-16 10:00 JST: with a stone sword at 6.4 health and a drowned
  // at 1.1 m, combat was told to stand down, no step started in three
  // seconds, and three more hits killed the Bot). Combat keeps the fight.
  if (nearest && !weaponless && nearest.distance <= CONTACT_M) return null
  // The totem is asked last: reading it costs a full state.
  return nearest && (typeof totem === 'function' ? totem() : totem) !== true ? nearest : null
}

function createPlayerFlee ({ getMode, shared, agent, travel = null, getState, hostiles, retreat, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, restUntil = 0, stuck = 0, stuckHealth = null, stuckDistance = null
  const inPlay = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true

  async function tick () {
    if (busy || !inPlay() || shared.travelNight?.cover) return false
    const state = getState()
    const resting = now() < restUntil
    // Hurt again since the run that went nowhere: the wait is over.
    if (resting && stuckHealth === null) return false
    const threat = fleeWanted({ health: state.health, totem: state.totem, hostiles: hostiles(), position: state.position, weaponless: unarmed(state.inventory) })
    if (!threat) return false
    // So is it when a hostile has come 2 m closer than the one it was stuck on
    // (live 2026-11-16 13:08 JST: during the wait a creeper walked up to 3.8 m
    // and its blast killed the Bot at health 2).
    if (resting && !(state.health < stuckHealth - 0.5) && !(threat.distance <= stuckDistance - 2)) return false
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
      log(failed >= 3 ? `プレイヤーモード: 離れる経路がないため、その場で戦います（${steps}歩）` : `プレイヤーモード: 敵から離れました（${steps}歩）`)
      // After a failed run, combat gets five seconds before the next try; a
      // run with no step at all waits longer each time.
      if (failed >= 3 && steps === 0) {
        stuck++
        stuckHealth = getState().health
        stuckDistance = threat.distance
        restUntil = now() + Math.min(120000, 30000 * 2 ** (stuck - 1))
        log(`プレイヤーモード: 1歩も離れられなかったため、体力が減らない限り${Math.round((restUntil - now()) / 1000)}秒は離れ直しません。`)
      } else {
        stuck = 0; stuckHealth = null; stuckDistance = null
        if (failed >= 3) restUntil = now() + 5000
      }
      return true
    } finally { shared.playerFlee = null; busy = false }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '敵から離れています。' : null }) }
}

// In play with a weapon in the received inventory: combat fights as usual, the
// "nothing to lose" rule of the long-trip preparation does not apply.
const armedInPlay = (shared, inventory) => shared?.playerWanted === true && !shared.inventoryUncertain && !unarmed(inventory)

module.exports = { createPlayerFlee, fleeWanted, unarmed, armedInPlay, FLEE_AT }
