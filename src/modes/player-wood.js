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

const isLogWork = decision => !!decision && (decision.type === 'gather_logs' || decision.resource === 'logs')

// The survival and diamond plans answer "no wood, wait" (wood_harvest_disabled).
// In player mode that wait becomes the base plan's log work, when it has any.
function withPlayerWood ({ mode, decision, planLogs }) {
  if (normalizeMode(mode) !== 'player' || decision?.code !== 'wood_harvest_disabled') return decision
  let logs = null
  try { logs = planLogs() } catch { /* Keep the wait when the base plan cannot answer. */ }
  return isLogWork(logs) ? logs : decision
}

module.exports = { logsAllowed, withPlayerWood, isLogWork }
