'use strict'

const { isDeepStrictEqual } = require('node:util')

// A legacy timeout is not an acknowledgement. Preserve a received empty main
// slot as evidence; the controller must still refresh inventory, retain every
// other individual box, and freshly open all 27 exact slots before adopting it.
function historicalEmptyPlacement ({ checkpoint: cp, recordedFailure: record, events, state } = {}) {
  const no = reason => ({ ok: false, reason })
  if (!cp || cp.version !== 1 || cp.kind !== 'shulker' || cp.stage !== 'placing' || cp.intent?.type !== 'place' || cp.intent.notSent === true || cp.placed?.length !== 0 || cp.deposited?.length !== 0 || cp.positions?.length !== 1 || !isDeepStrictEqual(cp.positions[0], cp.intent.position) || !Number.isInteger(cp.intent.slot) || cp.intent.slot < 0 || cp.intent.slot > 8 || typeof cp.intent.source !== 'string' || !cp.initialContents || !Array.isArray(cp.plan) || cp.plan.some(p => p.transferred !== 0)) return no('PLACEMENT_HISTORY_CHECKPOINT_UNSUPPORTED')
  if (record?.type !== 'carried_storage' || record.operationId !== cp.operationId || record.status !== 'blocked' || record.result?.status !== 'blocked' || record.result.reason !== 'サーバーから設置・使用の完了を確認できませんでした。' || !isDeepStrictEqual(record.result.checkpoint, cp)) return no('PLACEMENT_HISTORY_RECORD_MISMATCH')
  const life = state?.lifecycle?.deathId ?? state?.deathId
  const scope = { profile: state?.profile, realmId: state?.realm?.id == null ? null : String(state.realm.id), dimension: state?.dimension, connectionId: state?.connectionId, startedAt: state?.startedAt, runtimeEntityId: state?.runtimeEntityId == null ? null : String(state.runtimeEntityId), life }
  if (state?.phase !== 'spawned' || state.dead || state.isDead || !(state.health > 0) || !Number.isSafeInteger(life) || !isDeepStrictEqual(scope, cp.scope)) return no('PLACEMENT_HISTORY_SCOPE_CHANGED')
  const began = Date.parse(record.at), connected = Date.parse(scope.startedAt)
  if (!Number.isFinite(began) || !Number.isFinite(connected) || began < connected || !Array.isArray(events) || !events.some(e => Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) <= began)) return no('PLACEMENT_HISTORY_INCOMPLETE')
  const during = events.filter(e => { const at = Date.parse(e.at); return Number.isFinite(at) && at >= began && at <= began + 8000 })
  // Legacy request IDs are unavailable in this old checkpoint. Any refusal in
  // its time window makes attribution uncertain, rather than a successful place.
  if (during.some(e => e.name === 'item_stack_response' && (!Array.isArray(e.requests) || e.requests.some(r => r?.status !== 'ok' && r?.status !== 0)))) return no('PLACEMENT_HISTORY_RESPONSE_AMBIGUOUS')
  const candidates = during.filter(e => e.name === 'inventory_content' && [0, 'inventory'].includes(e.windowId) && Array.isArray(e.items) && e.items.length === 35 && new Set(e.items.map(i => i?.slot)).size === 35 && e.items.every(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < 36 && i.slot !== cp.intent.slot && Number.isInteger(i.id) && i.id !== 0 && Number.isInteger(i.count) && i.count > 0 && i.count <= 127))
  if (!candidates.length) return no('PLACEMENT_EMPTY_SLOT_UNOBSERVED')
  const e = candidates[0], p = e.position, stand = cp.stand
  if (!p || !stand || !['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Number.isSafeInteger(stand[k])) || Math.hypot(p.x - stand.x - 0.5, p.y - stand.y - 1.62, p.z - stand.z - 0.5) > 0.7) return no('PLACEMENT_HISTORY_POSITION_UNCONFIRMED')
  return { ok: true, proof: { kind: 'historical_empty_source_slot', version: 1, scope: structuredClone(cp.scope), jobId: cp.jobId, operationId: cp.operationId, position: structuredClone(cp.intent.position), slot: cp.intent.slot, sourceBefore: cp.intent.source, operationStartedAt: record.at, observedAt: Date.parse(e.at), receivedMain: structuredClone(e.items), observedPosition: structuredClone(e.position), requestOutcome: 'unacknowledged' } }
}

module.exports = { historicalEmptyPlacement }
