'use strict'

// Player mode shelters like a player with nothing built yet: before dusk, and
// when badly hurt with nothing close, it stops playing, digs the covered pit
// the long trip uses (three down, a block on top; every step confirmed by
// received terrain), waits, then opens the pit and plays on.
// - Night is judged only from the received world clock. An unknown clock digs
//   nothing.
// - Rest: health under 10, hunger 18 or more (natural healing works) and no
//   hostile within 10 m. It ends at 18 health or when hunger falls under 18.
// The pit record is the long trip's (shared.travelNight), so a pit dug during
// a trip to find trees is kept and opened by the same rules.
// A rest pit the expedition dug for its own wait (owner 'dragon', dragon-rest-pit.js) is the expedition's while
// it owns the work: it is not this shelter's until a tick here takes it over (the ordinary play works again).
// Counted as active it made the expedition wait for this shelter, whose tick it had stopped.
const { normalizeMode } = require('./bot-mode')
const { dayPhase } = require('../travel/night-stop')

const REST_BELOW = 10
const REST_UNTIL = 18
const RETRY_MS = 60000
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 160)

// What to do now. Pure: `pit` is the shared record, `vitals` the received values.
function shelterDecision ({ pit, clock, vitals, hostileDistance, now, wanted }) {
  const phase = dayPhase(clock), health = vitals?.health, hunger = vitals?.hunger
  if (pit?.cover) {
    if (pit.reason === 'rest' && phase.known && phase.shelter) return { action: 'stay', reason: 'night' }
    if (pit.reason === 'rest') return Number.isFinite(health) && health >= REST_UNTIL || Number.isFinite(hunger) && hunger < 18 ? { action: 'leave' } : { action: 'stay', reason: 'rest' }
    return phase.known && phase.resume ? { action: 'leave' } : { action: 'stay', reason: 'night' }
  }
  if (!wanted || now - (pit?.playerTriedAt ?? 0) < RETRY_MS) return { action: 'none' }
  if (phase.known && phase.shelter) return { action: 'dig', reason: 'night' }
  const calm = hostileDistance == null || hostileDistance > 10
  if (Number.isFinite(health) && health > 0 && health < REST_BELOW && Number.isFinite(hunger) && hunger >= 18 && calm) return { action: 'dig', reason: 'rest' }
  return { action: 'none' }
}

const MESSAGES = { night: '夜のため、ふたをした穴の中で朝まで待ちます。', rest: '体力回復のため、ふたをした穴の中で待ちます。' }

function createPlayerShelter ({ getMode, shared, agent, recovery = null, getClock, getVitals, hostileDistance = () => null, travelBusy = () => false, dig, uncover, disposed = () => false, log = () => {}, now = Date.now }) {
  let busy = false, reason = null
  const record = () => (shared.travelNight ??= { cover: null, pitTried: 0 })
  const active = () => busy || !!shared.travelNight?.cover && shared.travelNight.owner !== 'dragon' && shared.playerWanted === true

  async function restart () {
    for (let attempt = 0; attempt < 5 && !disposed() && shared.playerWanted === true; attempt++) {
      try { await agent.start({ ...agent.objective }); return true } catch { await new Promise(resolve => setTimeout(resolve, 2000)) }
    }
    return false
  }

  async function tick () {
    if (busy || disposed() || normalizeMode(getMode()) !== 'player' || shared.playerWanted !== true || travelBusy()) return null
    busy = true
    try {
      const pit = record()
      if (pit.owner) pit.owner = null
      const decision = shelterDecision({ pit, clock: getClock(), vitals: getVitals(), hostileDistance: hostileDistance(), now: now(), wanted: true })
      if (decision.action === 'none') return decision
      if (decision.action === 'stay') {
        pit.reason = decision.reason; reason = MESSAGES[decision.reason]
        // Whoever dug the pit, nothing else plays while the Bot is inside it.
        if (agent.running()) agent.stop(reason)
        return decision
      }
      if (decision.action === 'dig') {
        pit.playerTriedAt = now(); reason = MESSAGES[decision.reason]
        recovery?.cancel()
        agent.stop(reason)
        // The stopped run's current action drains before the pit's mining may start.
        for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await new Promise(resolve => setTimeout(resolve, 200))
        const result = await dig()
        if (result?.ok) { pit.cover = result.cover; pit.reason = decision.reason; log(`プレイヤーモード: ${reason}`); return decision }
        log(`プレイヤーモード: ここに避難の穴を作れません（${text(result?.reason)}）。プレイを続けます`)
        reason = null
        await restart()
        return { ...decision, failed: true }
      }
      // leave
      const opened = await uncover(pit.cover)
      if (!opened) { reason = '穴のふたを開けられません。やり直します。'; return { action: 'stay', reason: pit.reason } }
      log(pit.reason === 'rest' ? 'プレイヤーモード: 回復したので穴を出て続けます' : 'プレイヤーモード: 朝になったので穴を出て続けます')
      pit.cover = null; pit.reason = null; pit.pitTried = 0; reason = null
      await restart()
      return decision
    } catch (error) {
      log(`プレイヤーモード: 避難の処理に失敗 ${text(error?.message)}`)
      return null
    } finally { busy = false }
  }

  return { tick, status: () => ({ active: active(), reason: active() ? reason ?? MESSAGES[shared.travelNight?.reason] ?? MESSAGES.night : null }) }
}

module.exports = { createPlayerShelter, shelterDecision, REST_BELOW, REST_UNTIL }
