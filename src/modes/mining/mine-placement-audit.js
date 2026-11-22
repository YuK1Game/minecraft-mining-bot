'use strict'

const { observedScope } = require('../../movement/server-position-verifier')

// Bound repeated observations while a failed placement remains pending.
function createMinePlacementAudit (rt) {
  let lastRequestAt = -Infinity
  return async (position, { signal } = {}) => {
    if (Date.now() - lastRequestAt < 30000) return null
    const initial = rt.quarryState(), scope = observedScope(initial), stream = rt.inputStream
    const revision = stream?.stats().actionRevision
    if (!scope || !Number.isSafeInteger(revision)) return null
    const quiet = () => {
      const state = rt.quarryState(), stats = stream.stats()
      return !signal?.aborted && !rt.disposed && !rt.disposing && rt.host.shared.playerWanted === true &&
        observedScope(state) === scope && state.health >= initial.health &&
        rt.inputStream === stream && rt.inputOwner !== 'task' &&
        stats.actionRevision === revision && stats.queuedActions === 0 && stats.queuedTransaction === false
    }
    if (!quiet()) return null
    try {
      rt.requireIdle()
      lastRequestAt = Date.now()
      const request = await rt.requestInventoryResyncWithReceipt('branch_mine_placement')
      const deadline = Date.now() + 2000
      let inventoryReceipt
      while (quiet() && Date.now() < deadline) {
        const received = rt.host.shared.inventoryResync?.lastRequest
        if (received?.requestedAt === request.requestedAt && received.source === request.source &&
          JSON.stringify(received.scope) === JSON.stringify(request.scope) &&
          received.requestSent === true && received.status === 'FRESH_MAIN_OBSERVED' &&
          received.freshMainObserved === true && Date.parse(received.observedAt) >= Date.parse(request.requestedAt)) {
          inventoryReceipt = received
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!inventoryReceipt || !quiet()) return null
      // The air check follows the earlier input on the same ordered connection.
      // It certifies the current cell, not the outcome of the old packet.
      rt.storagePlacementAudit ??= rt.createStoragePlacementAudit({ client: rt.host.client, getState: rt.quarryState })
      const target = await rt.storagePlacementAudit.confirmAir(position, { signal, operationId: 'branch-mine:placement-audit' })
      if (!quiet() || target.serverConfirmed !== true || target.scope !== scope) return null
      rt.requireIdle()
      return { target, inventoryObservedAt: inventoryReceipt.observedAt }
    } catch {
      return null
    }
  }
}

module.exports = { createMinePlacementAudit }
