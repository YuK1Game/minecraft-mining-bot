'use strict'

const { isDeepStrictEqual } = require('node:util')

// Correlate a legacy checkpoint with an actual, uniquely observed rejection.
// This proves no successful transfer: the portable controller must still read
// both inventories and prove the entire container unchanged before retrying.
function historicalSourceRejection ({ checkpoint, recordedFailure, events, state } = {}) {
  const cp = checkpoint, record = recordedFailure
  const no = reason => ({ ok: false, reason })
  if (!cp || cp.kind !== 'shulker' || cp.stage !== 'depositing' || cp.intent?.type !== 'deposit' || cp.placed?.length !== 1 || cp.positions?.length !== 1) return no('REJECTION_CHECKPOINT_UNSUPPORTED')
  if (record?.type !== 'carried_storage' || record.operationId !== cp.operationId || record.status !== 'blocked' || record.result?.status !== 'blocked' || record.result.reason !== 'サーバーがチェストへの移動を拒否しました。' || !isDeepStrictEqual(record.result.checkpoint, cp)) return no('REJECTION_RECORD_MISMATCH')
  const life = state?.lifecycle?.deathId ?? state?.deathId
  const scope = { profile: state?.profile, realmId: state?.realm?.id == null ? null : String(state.realm.id), dimension: state?.dimension, connectionId: state?.connectionId, startedAt: state?.startedAt, runtimeEntityId: state?.runtimeEntityId == null ? null : String(state.runtimeEntityId), life }
  if (state?.phase !== 'spawned' || state.dead || state.isDead || !(state.health > 0) || !Number.isSafeInteger(life) || !isDeepStrictEqual(scope, cp.scope)) return no('REJECTION_SCOPE_CHANGED')
  const began = Date.parse(record.at), connected = Date.parse(scope.startedAt)
  if (!Number.isFinite(began) || !Number.isFinite(connected) || began < connected || !Array.isArray(events) || !events.length || !events.some(event => Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) <= began)) return no('REJECTION_HISTORY_INCOMPLETE')
  const found = []
  for (const event of events) {
    const at = Date.parse(event.at)
    if (event.name !== 'item_stack_response' || !Number.isFinite(at) || at < began || at > began + 30000) continue
    if (!Array.isArray(event.requests)) return no('REJECTION_HISTORY_INCOMPLETE')
    for (const response of event.requests) {
      // Count every refusal, including malformed/unknown responses. Selecting
      // only status49 could attribute a different request's rejection to this
      // checkpoint when its own generic failure actually came from status50.
      if (response?.status === 'ok' || response?.status === 0) continue
      found.push({ response, event, at })
    }
  }
  if (found.length !== 1) return no('REJECTION_RESPONSE_AMBIGUOUS')
  const { response, event, at } = found[0], p = event.position, stand = cp.stand
  if (response?.status !== 49 || !Number.isInteger(response.id) || response.id >= 0 || response.id < -2147483647 || Math.abs(response.id % 2) !== 1) return no('REJECTION_RESPONSE_AMBIGUOUS')
  if (!p || !stand || !['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Number.isSafeInteger(stand[k])) || Math.hypot(p.x - stand.x - 0.5, p.y - stand.y - 1.62, p.z - stand.z - 0.5) > 0.7) return no('REJECTION_POSITION_UNCONFIRMED')
  const intent = cp.intent, epoch = cp.initialContentsVerified?.windowEpoch
  if (!Number.isSafeInteger(epoch) || typeof intent.source !== 'string' || typeof intent.destination !== 'string' || !Number.isInteger(cp.windowId)) return no('REJECTION_WINDOW_UNCONFIRMED')
  return { ok: true, proof: {
    kind: 'chest_source_slot_rejection', version: 1, requestId: response.id, status: 49, protocolStatusCode: 49,
    operation: 'deposit_item', item: intent.name, windowId: cp.windowId, windowEpoch: epoch,
    position: structuredClone(cp.positions[0]), scope: structuredClone(cp.scope), count: intent.count,
    sourceSlot: intent.sourceSlot, playerSlot: intent.sourceSlot, chestSlot: intent.chestSlot,
    rawEncoding: 'v8-base64', sourceBefore: intent.source, destinationBefore: intent.destination,
    observedAt: at, wireSent: true, serverRejected: true,
    evidenceOrigin: 'historical_server_response_and_recorded_checkpoint', recordedFailureAt: record.at, matchedResponseCount: 1
  } }
}

module.exports = { historicalSourceRejection }
