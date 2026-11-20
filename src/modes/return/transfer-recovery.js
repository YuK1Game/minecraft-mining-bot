'use strict'

const { isDeepStrictEqual } = require('node:util')
const { refreshInventoryWithRetry } = require('../../inventory/inventory-refresh')

// Keep a typed refusal separate from the chest's capacity and accessibility.
// A rejection is never a transfer receipt, even after a successful refresh.
function transferEvidence (error) {
  const details = error?.details == null ? null : structuredClone(error.details)
  return { code: typeof error?.code === 'string' ? error.code : null, details, rejectionProof: details?.rejectionProof ?? null }
}

function sourceRejected (proof) {
  return proof?.kind === 'chest_source_slot_rejection' && proof.version === 1 && proof.origin === 'matching_live_server_response' && proof.protocolStatusCode === 49 && proof.status === 49 && proof.wireSent === true && proof.serverRejected === true
}

const refreshScope = proof => {
  const { life, ...scope } = proof.scope
  return { ...scope, deathId: life }
}

// The inventory's existing rate-limit helper bounds the send and its one
// cooldown retry. Afterwards only this request's fresh full-inventory receipt
// permits a new chest operation; a previously known inventory cannot do so.
async function refreshRejectedTransfer ({ operations, proof, stop, sleep, now }) {
  const inventory = operations.inventory
  const result = { status: 'RESYNC_UNAVAILABLE', freshMainObserved: false }
  if (typeof inventory?.resync !== 'function' || typeof inventory?.resyncStatus !== 'function') return result
  const verify = () => { if (stop()) throw Object.assign(new Error('チェスト操作を中断しました。'), { code: 'CONTAINER_INTERRUPTED' }) }
  try {
    const started = now()
    const request = await refreshInventoryWithRetry({ refreshInventory: () => inventory.resync(), verify, sleep, now })
    result.request = request
    const requested = Date.parse(request?.requestedAt)
    if (request?.requestSent !== true || !Number.isFinite(requested) || requested < started || requested > now() || !Number.isSafeInteger(request.fullCountAtSend) || request.fullCountAtSend < 0 || !isDeepStrictEqual(request.scope, refreshScope(proof))) return { ...result, status: 'RESYNC_REQUEST_UNCONFIRMED' }
    // Count slices as well as elapsed time, so even an injected stuck clock
    // cannot turn a missing receipt into an unbounded wait.
    const deadline = now() + 5000
    for (let waited = 0; waited <= 5000; waited += 200) {
      verify()
      const received = inventory.resyncStatus()
      const own = received?.requestSent === true && received.requestedAt === request.requestedAt && received.fullCountAtSend === request.fullCountAtSend && isDeepStrictEqual(received.scope, request.scope)
      if (own && received.status === 'FRESH_MAIN_OBSERVED' && received.freshMainObserved === true && Date.parse(received.observedAt) >= requested && Date.parse(received.observedAt) <= now()) return { ...result, status: received.status, freshMainObserved: true, observedAt: received.observedAt }
      if (now() >= deadline || waited === 5000) break
      await sleep(200)
    }
    return { ...result, status: 'RESYNC_RECEIPT_UNCONFIRMED' }
  } catch (error) { return { ...result, status: error?.code ?? 'RESYNC_FAILED', detail: String(error?.message ?? error).slice(0, 160) } }
}

module.exports = { transferEvidence, sourceRejected, refreshRejectedTransfer }
