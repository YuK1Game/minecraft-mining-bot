'use strict'

// Player mode: no food held, hunger falling, and the Bot deep in a tunnel.
// The plan keeps choosing the forage, but every animal it knows stands on the
// surface and no land route reaches it from below, so it tunnels on instead
// (real Realm 2026-11-17 08:16-08:20 JST: food 0, hunger 16 → 14, 31 forage
// decisions with 0 hits, 50 blocks further down a tunnel). Then:
// - the autonomy stops, the Bot comes up to open sky (its own tunnel back on
//   foot, else straight up: the same climb as the recovery), and play goes on
//   there, where the forage can walk to the animals.
// - Only while playing, hunger received at 14 or less, no food held and
//   received solid ground overhead. Not while a hostile is within 12 m or
//   another job runs. Five minutes between tries.
const { normalizeMode } = require('./bot-mode')
const { underCover } = require('./player-surface')

const HUNGRY = 14, AGAIN_MS = 300000
const FOOD = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon)$|^minecraft:(?:bread|apple|golden_apple|carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup)$/
const hasFood = inventory => (inventory?.items ?? []).some(item => item?.count > 0 && FOOD.test(item.name ?? ''))

function createPlayerFood ({ getMode, shared, agent, climb, getState, getHunger, getBlock, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  async function tick () {
    if (!live() || busy || blocked() || now() < waitUntil) return null
    const hunger = getHunger(), state = getState()
    if (!Number.isFinite(hunger) || hunger > HUNGRY || state?.inventory?.known !== true || hasFood(state.inventory) || !underCover(getBlock, state.position)) return null
    busy = true
    waitUntil = now() + AGAIN_MS
    try {
      log(`プレイヤーモード: 食料がなく満腹度が ${hunger} のため、地上へ出て食料を探します`)
      agent.stop('食料を探しに地上へ出ます。')
      let out = null
      try { out = await climb(() => !live()) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 100) } }
      log(`プレイヤーモード: ${out?.ok ? '地上へ出ました。食料を探します' : `地上へ出られません（${out?.reason ?? '不明'}）`}`)
      return out?.ok === true
    } finally {
      busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '食料を探しに地上へ出ています。' : null }) }
}

module.exports = { createPlayerFood, hasFood }
