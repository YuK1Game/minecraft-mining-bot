'use strict'

// Planning origin reconciliation (2026-11-13). Live 22:35: the last received
// server position (22:21, feet y71.84 in the air) and the working prediction
// (feet y70) disagreed, and a chunk move failed before its first leg. Before a
// route is planned, when the received position is old or 0.3 m+ away from the
// working one and either has no known support, the server is asked about both
// once (the same witness the supply approach uses). Only a confirmed position
// is used: a confirmed received one discards the disproved prediction; nothing
// is rewritten from an unconfirmed guess.

const EYE = 1.62
const feetOf = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])) ? { x: p.x, y: p.y - EYE, z: p.z } : null
const rounded = f => ({ x: Math.round(f.x * 100) / 100, y: Math.round(f.y * 1000) / 1000, z: Math.round(f.z * 100) / 100 })

function originDisagreement (state, { now = Date.now(), staleMs = 10000, hasSupport = () => true } = {}) {
  const working = feetOf(state?.position), received = feetOf(state?.rawServerPosition)
  if (!working || !received) return null
  const at = Date.parse(state.rawServerPositionUpdatedAt ?? '')
  const stale = !Number.isFinite(at) || now - at > staleMs
  const apart = Math.hypot(working.x - received.x, working.y - received.y, working.z - received.z)
  if (!stale && apart < 0.3) return null
  const supported = { working: safe(() => hasSupport(working)), received: safe(() => hasSupport(received)) }
  if (supported.working && supported.received) return null
  return { working, received, apart, stale, supported }
}
function safe (fn) { try { return fn() === true } catch { return false } }

async function reconcileMoveOrigin ({ state, confirm, discardPrediction, hasSupport, now = Date.now(), log = () => {} }) {
  const issue = originDisagreement(state, { now, hasSupport })
  if (!issue || typeof confirm !== 'function') return { checked: false }
  const ask = async feet => { try { return (await confirm(rounded(feet), { radius: 0.3 }))?.serverConfirmed === true } catch { return false } }
  const workingOk = await ask(issue.working), receivedOk = issue.apart >= 0.3 ? await ask(issue.received) : workingOk
  let action = 'none'
  if (receivedOk && !workingOk && typeof discardPrediction === 'function') { discardPrediction('planning origin: the received position was confirmed'); action = 'discarded_prediction' }
  log(`移動の起点を照合: working=${workingOk} received=${receivedOk} apart=${issue.apart.toFixed(2)} stale=${issue.stale} action=${action}`)
  return { checked: true, workingOk, receivedOk, action, ...issue }
}

// The planner's origin from the working state. A prediction whose metadata no
// longer matches its working position (stale after a correction, live 22:35)
// cannot seed the planner: it is discarded once and the origin taken again.
function planningOrigin ({ fromServer, getState, discardPrediction }) {
  try { return fromServer(getState()) } catch (error) {
    if (!/Prediction metadata does not match/.test(String(error.message)) || typeof discardPrediction !== 'function') throw error
    discardPrediction('planning origin: prediction metadata did not match')
    return fromServer(getState())
  }
}

module.exports = { originDisagreement, reconcileMoveOrigin, planningOrigin }
