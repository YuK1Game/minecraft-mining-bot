'use strict'

// Player mode: no food held, hunger falling, and the Bot deep in a tunnel.
// Structured with `supply-task-runner` result codes and bounded failure memory
// while preserving legacy `tick()` return values.
const { normalizeMode } = require('./bot-mode')
const { underCover } = require('./player-surface')
const { createSupplyOutcomeTracker } = require('./supply-task-runner')

const HUNGRY = 17, REGEN = 18, HURT = 10, AGAIN_MS = 300000, NEAR_M = 6, TRIP_MS = 180000
const FOOD = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon)$|^minecraft:(?:bread|apple|golden_apple|carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup)$/
const hasFood = inventory => (inventory?.items ?? []).some(item => item?.count > 0 && FOOD.test(item.name ?? ''))

function createPlayerFood ({ getMode, shared, agent, climb, travel = null, prey = () => null, scope = () => null, inBranchMine = () => false, getState, getHunger, getBlock, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0
  const tracker = createSupplyOutcomeTracker({ taskId: 'food', shared, scope, now })
  const R = tracker.result
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  async function runStep () {
    if (!live() || busy || blocked() || now() < waitUntil) return null
    if (inBranchMine()) {
      const outcome = R.blocked('INSIDE_BRANCH_MINE', { kind: 'position_changed' }, { detail: '採掘場内のため、はしご退出後に食料を探します' })
      tracker.record(outcome, { stage: 'surface' })
      return null
    }
    const hunger = getHunger(), state = getState()
    const stuck = Number.isFinite(state?.health) && state.health < HURT && hunger < REGEN
    if (!Number.isFinite(hunger) || (hunger > HUNGRY && !stuck) || state?.inventory?.known !== true || hasFood(state.inventory) || !state.position) return null
    if (!underCover(getBlock, state.position)) return walkToFood(state.position, hunger)

    const cellKey = `${Math.floor(state.position.x / 8)},${Math.floor(state.position.y / 8)},${Math.floor(state.position.z / 8)}`
    if (tracker.isExhausted({ stage: 'climb', target: cellKey, code: 'FOOD_CLIMB_FAILED' })) {
      return null
    }
    busy = true
    waitUntil = now() + AGAIN_MS
    try {
      log(`プレイヤーモード: 食料がなく満腹度が ${hunger} のため、地上へ出て食料を探します`)
      agent.stop('食料を探しに地上へ出ます。')
      let out = null
      try { out = await climb(() => !live()) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 100) } }
      log(`プレイヤーモード: ${out?.ok ? '地上へ出ました。食料を探します' : `地上へ出られません（${out?.reason ?? '不明'}）`}`)
      const outcome = out?.ok === true
        ? R.completed('FOOD_SURFACED', { detail: '地上へ出ました' })
        : R.failed('FOOD_CLIMB_FAILED', { detail: out?.reason ?? '不明', retry: { kind: 'position_changed' } })
      tracker.record(outcome, { stage: 'climb', target: cellKey })
      return outcome
    } finally {
      busy = false
      await restart()
    }
  }

  async function walkToFood (position, hunger) {
    let target = null
    try { target = prey() } catch {}
    if (!travel || !target || ![target.x, target.z].every(Number.isFinite) || Math.hypot(target.x - position.x, target.z - position.z) <= NEAR_M || travel.status()?.busy) return null
    const destination = { x: Math.floor(target.x), z: Math.floor(target.z) }
    const targetKey = `${Math.floor(destination.x / 16)},${Math.floor(destination.z / 16)}`
    if (tracker.isExhausted({ stage: 'travel', target: targetKey, code: 'FOOD_TRAVEL_FAILED' })) return null
    busy = true
    waitUntil = now() + AGAIN_MS
    try {
      log(`プレイヤーモード: 食料がなく満腹度が ${hunger} のため、食料源 (${destination.x}, ${destination.z}) へ長距離移動で近づきます`)
      agent.stop('食料源へ近づきます。')
      try {
        await travel.to({ destination })
      } catch (error) {
        const msg = String(error?.message ?? error).slice(0, 100)
        log(`プレイヤーモード: 食料源へ移動を始められません ${msg}`)
        const outcome = R.failed('FOOD_TRAVEL_FAILED', { detail: msg, evidence: { destination } })
        tracker.record(outcome, { stage: 'travel', target: targetKey })
        return outcome
      }
      const until = now() + TRIP_MS
      while (live() && now() < until && travel.status()?.busy) await sleep(1000)
      if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
      const outcome = R.completed('FOOD_APPROACHED', { evidence: { destination } })
      tracker.record(outcome, { stage: 'travel', target: targetKey })
      return outcome
    } finally {
      busy = false
      await restart()
    }
  }

  async function tick () {
    const outcome = await runStep()
    return tracker.toTickBoolean(outcome)
  }

  return {
    tick,
    runStep,
    status: () => ({ active: busy, reason: busy ? '食料を探しています。' : null, lastOutcome: tracker.last() })
  }
}

module.exports = { createPlayerFood, hasFood }
