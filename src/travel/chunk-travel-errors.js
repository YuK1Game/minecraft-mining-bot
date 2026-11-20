'use strict'

const aliases = new Map([
  ...['ACTION_BUSY', 'RESET_BUSY', 'STORAGE_BUSY', 'CHUNK_MOVE_BUSY', 'CHUNK_MOVE_NOT_IDLE', 'MOVE_LIFE_UNKNOWN', 'THREAT_OBSERVATION_UNKNOWN', 'NEARBY_THREAT'].map(code => [code, 'CHUNK_TRAVEL_BUSY']),
  ...['NAVIGATION_CONTEXT_CHANGED', 'NAVIGATION_TERRAIN_CHANGED', 'CHUNK_MOVE_CONTEXT_CHANGED', 'CHUNK_MOVE_THREAT_CHANGED'].map(code => [code, 'CHUNK_TRAVEL_CONTEXT_CHANGED'])
])
function chunkErrorCode (error) { return /^CHUNK_TRAVEL_[A-Z_]+$/.test(error?.code ?? '') ? error.code : aliases.get(error?.code) ?? 'CHUNK_TRAVEL_FAILED' }
function planningFailure (proposal, target, rejection) {
  const reason = rejection?.reason ?? proposal?.reason
  return {
    target: structuredClone(target), ready: proposal?.ready === true,
    code: rejection?.code ?? proposal?.code ?? 'NAVIGATION_NO_ROUTE',
    reason: typeof reason === 'string' ? reason.slice(0, 240) : null,
    expanded: Number.isSafeInteger(proposal?.expanded) ? proposal.expanded : null,
    unknownFrontier: Array.isArray(proposal?.unknownFrontier) ? structuredClone(proposal.unknownFrontier.slice(0, 16)) : [],
    ...(rejection?.point ? { point: structuredClone(rejection.point) } : {})
  }
}
const guardFailures = {
  threat: { code: 'CHUNK_MOVE_THREAT_CHANGED', reason: '敵の位置または攻撃範囲が変わったため、移動を再確認します。' },
  unknown: { code: 'THREAT_OBSERVATION_UNKNOWN', reason: '敵の位置の受信を待っています。' },
  hurt: { code: 'CHUNK_TRAVEL_DAMAGED', reason: '被弾したため停止しました。' },
  scope: { code: 'CHUNK_MOVE_CONTEXT_CHANGED', reason: '移動の操作権または接続状態が変わりました。' }
}
function chunkMovementGuard ({ owner, isCurrent, controllerGuard, ordinaryGuard, diagnostics }) {
  return frame => {
    if (!owner || !isCurrent() || owner.signal?.aborted) return false
    try { if (controllerGuard && controllerGuard(frame) === false) return false } catch (error) {
      if (error?.code === 'CHUNK_TRAVEL_TERRAIN_CHANGED') owner.guardFailure = { code: 'NAVIGATION_TERRAIN_CHANGED', reason: '歩行直前に参照した地形が変わりました。' }
      throw error
    }
    diagnostics.waterGuardWhy = null
    const allowed = ordinaryGuard ? ordinaryGuard(frame) !== false : true
    if (!allowed) owner.guardFailure = { ...(guardFailures[diagnostics.waterGuardWhy] ?? { code: 'CHUNK_TRAVEL_MOVE_FAILED', reason: `Movement frame guard rejected: ${diagnostics.waterGuardWhy ?? 'unknown reason'}` }) }
    return allowed
  }
}
function movementStatus (snapshot, failure) {
  const state = snapshot ?? { phase: 'unavailable', running: false }
  return failure && ['failed', 'stopped', 'replan_required'].includes(state.phase) ? { ...state, guardFailure: structuredClone(failure) } : state
}
module.exports = { chunkErrorCode, planningFailure, chunkMovementGuard, movementStatus }
