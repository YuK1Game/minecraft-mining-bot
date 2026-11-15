'use strict'

// Wood in player mode. The quarry rule "never cut trees" stays as it is; player
// mode plays like a survival player, so it may cut natural trees for logs.
// Leaves stay off in both modes.
const { normalizeMode } = require('./bot-mode')

// Whether logs may be cut now: player mode, or the long-trip preparation
// allowance (about 10 logs, 30 minutes) granted in quarry mode.
function logsAllowed (shared, now = Date.now()) {
  if (normalizeMode(shared?.botMode) === 'player') return true
  const allowance = shared?.woodHarvestAllowance
  return !!allowance && allowance.purpose === 'long_travel_prep' && now < allowance.expiresAt
}

const isLogWork = decision => !!decision && (decision.type === 'gather_logs' || decision.resource === 'logs' || decision.stage === 'logs')

// The base plan asked for wood: as if no pickaxe were held (with one it mines
// stone instead) and with a stone goal it cannot reach (it never "completes").
function woodPlanInput (state, options = {}) {
  const inventory = state?.inventory
  const items = Array.isArray(inventory?.items) ? inventory.items.filter(item => !/_pickaxe$/.test(String(item?.name ?? ''))) : inventory?.items
  return { state: { ...state, inventory: inventory ? { ...inventory, items } : inventory }, options: { ...options, allowLogs: true, logCount: 10, stoneCount: 2304 } }
}

// The survival and diamond plans answer "no wood, wait" (wood_harvest_disabled).
// In player mode that wait becomes what the base wood plan says next: pick up
// a dropped log, walk to a tree, cut it, look around, or its own wait with the
// real reason. (Live 2026-11-15 17:40 JST: the plan said "collect the dropped
// log", which was not recognised as wood work, and the Bot waited beside it.)
// A base plan that ends the run (stop, complete) or fails keeps the wait.
function withPlayerWood ({ mode, decision, planLogs, log = () => {} }) {
  if (normalizeMode(mode) !== 'player' || decision?.code !== 'wood_harvest_disabled') return decision
  let logs = null
  try { logs = planLogs() } catch (error) { log(`プレイヤーモード: 木の計画に失敗 ${String(error?.message ?? error).slice(0, 120)}`) }
  if (!logs || ['stop', 'complete'].includes(logs.type) || logs.code === 'wood_harvest_disabled') return decision
  return logs
}

module.exports = { logsAllowed, withPlayerWood, isLogWork, woodPlanInput }
