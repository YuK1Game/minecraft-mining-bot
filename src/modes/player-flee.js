'use strict'

// Player mode runs when badly hurt. Live 2026-11-15 18:16 JST: at 5.85 health,
// with a wooden sword and no food, the Bot met one more zombie, was told to
// push through, and died. A player at that health turns and runs: zombies and
// creepers are slower than a sprint.
// - Trigger: health 8 or less (and above 0), a hostile within 12 m, no totem.
// - While it runs, combat is told to stand down (shared.playerFlee, read by the
//   combat work guard) and the autonomy is stopped; each step is the long
//   trip's retreat step (5-12 m straight away, the ordinary movement).
// - It ends when nothing hostile is within 16 m, after 20 s, or when three
//   steps in a row could not start; then combat fights as before. Afterwards
//   the shelter rests the Bot and play resumes by itself.
const { normalizeMode } = require('./bot-mode')

const FLEE_AT = 8
const text = value => String(value ?? '').replace(/^minecraft:/, '').replace(/[\p{C}§]/gu, ' ').slice(0, 40)

function fleeWanted ({ health, totem, hostiles, position }) {
  if (!Number.isFinite(health) || health <= 0 || health > FLEE_AT || totem === true || !position) return null
  let nearest = null
  for (const actor of hostiles ?? []) {
    if (!actor?.position) continue
    const distance = Math.hypot(actor.position.x - position.x, actor.position.y - (position.y - 1.62), actor.position.z - position.z)
    if (distance <= 12 && (!nearest || distance < nearest.distance)) nearest = { distance, name: text(actor.entityType ?? actor.name) }
  }
  return nearest
}

function createPlayerFlee ({ getMode, shared, agent, getState, hostiles, retreat, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, restUntil = 0
  const inPlay = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true

  async function tick () {
    if (busy || !inPlay() || now() < restUntil || shared.travelNight?.cover) return false
    const state = getState()
    const threat = fleeWanted({ health: state.health, totem: state.totem, hostiles: hostiles(), position: state.position })
    if (!threat) return false
    busy = true
    let steps = 0, failed = 0
    try {
      log(`プレイヤーモード: 体力が少ないため敵から離れます（体力 ${Math.round(state.health * 10) / 10}、${threat.name} ${threat.distance.toFixed(1)}m）`)
      const until = now() + 20000
      while (inPlay() && now() < until && failed < 3) {
        const current = getState()
        if (!(current.health > 0)) break
        const near = (hostiles() ?? []).filter(actor => actor?.position && current.position && Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) <= 16)
        if (!near.length) break
        // Combat stands down only while a step is being tried or walked.
        shared.playerFlee = { until: now() + 9000 }
        if (agent.running()) agent.stop('体力が少ないため敵から離れます。')
        let moved = false
        try { moved = await retreat() === true } catch { moved = false }
        if (moved) { steps++; failed = 0 } else { failed++; await sleep(250) }
      }
      log(failed >= 3 ? `プレイヤーモード: 離れる経路がないため、その場で戦います（${steps}歩）` : `プレイヤーモード: 敵から離れました（${steps}歩）`)
      // After a failed run, combat gets five seconds before the next try.
      if (failed >= 3) restUntil = now() + 5000
      return true
    } finally { shared.playerFlee = null; busy = false }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '体力が少ないため敵から離れています。' : null }) }
}

module.exports = { createPlayerFlee, fleeWanted, FLEE_AT }
