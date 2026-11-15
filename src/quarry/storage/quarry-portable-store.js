'use strict'

// Moved out of quarry-portable-storage.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-portable-storage.js.

const { storeHelpers } = require('./store/store-helpers')
const { openCheckpoint } = require('./store/store-checkpoint')
const { resumeCheckpoint } = require('./store/store-resume')
const { placeContainer } = require('./store/store-place')
const { openContainer } = require('./store/store-open')
const { transferItems } = require('./store/store-transfer')
const { packContainer } = require('./store/store-pack')
const { breakContainer } = require('./store/store-break')
const { recoverContainer } = require('./store/store-recover')

function createQuarryPortableStore (rt) {
  async function storeCarried (request, { signal, onCheckpoint, canPlace = () => true, capacityWork = null } = {}) {
    if (rt.active) return { status: 'blocked', reason: 'STORAGE_BUSY', serverConfirmed: false, deposited: [], checkpoint: rt.copy(request?.checkpoint ?? null) }
    let cp = null, windowEvidence = null
    const run = rt.active = { checkpoint: null }
    // The stages called in this block live in modules of their own (scripts/extract-stage.js).
    // `vars` reads and writes this function's locals at the moment of use.
    let guard, save, perform, readWindowEvidence, result, close, moveToCell, appendRecoverySpace, requirePickupRoom, pickupEntityIds, wait, pickupArea, actions
    const vars = {
      get actions () { return actions }, set actions ($value) { actions = $value },
      get appendRecoverySpace () { return appendRecoverySpace }, set appendRecoverySpace ($value) { appendRecoverySpace = $value },
      get close () { return close }, set close ($value) { close = $value },
      get cp () { return cp }, set cp ($value) { cp = $value },
      get guard () { return guard }, set guard ($value) { guard = $value },
      get moveToCell () { return moveToCell }, set moveToCell ($value) { moveToCell = $value },
      get onCheckpoint () { return onCheckpoint }, set onCheckpoint ($value) { onCheckpoint = $value },
      get perform () { return perform }, set perform ($value) { perform = $value },
      get pickupArea () { return pickupArea }, set pickupArea ($value) { pickupArea = $value },
      get pickupEntityIds () { return pickupEntityIds }, set pickupEntityIds ($value) { pickupEntityIds = $value },
      get readWindowEvidence () { return readWindowEvidence }, set readWindowEvidence ($value) { readWindowEvidence = $value },
      get request () { return request }, set request ($value) { request = $value },
      get requirePickupRoom () { return requirePickupRoom }, set requirePickupRoom ($value) { requirePickupRoom = $value },
      get result () { return result }, set result ($value) { result = $value },
      get save () { return save }, set save ($value) { save = $value },
      get signal () { return signal }, set signal ($value) { signal = $value },
      get wait () { return wait }, set wait ($value) { wait = $value },
      get windowEvidence () { return windowEvidence }, set windowEvidence ($value) { windowEvidence = $value }
    }
    storeHelpers(rt, vars)
    try {
      // The stages called in this block live in modules of their own (scripts/extract-stage.js).
      // `vars2` reads and writes this function's locals at the moment of use.
      let capacityBatch, supplyWork, recovering, pinnedSource, reconcileDeposit, expected, owned
      const vars2 = {
        get canPlace () { return canPlace }, set canPlace ($value) { canPlace = $value },
        get capacityBatch () { return capacityBatch }, set capacityBatch ($value) { capacityBatch = $value },
        get capacityWork () { return capacityWork }, set capacityWork ($value) { capacityWork = $value },
        get close () { return close },
        get cp () { return cp }, set cp ($value) { cp = $value },
        get expected () { return expected }, set expected ($value) { expected = $value },
        get guard () { return guard },
        get moveToCell () { return moveToCell },
        get owned () { return owned }, set owned ($value) { owned = $value },
        get perform () { return perform },
        get pickupArea () { return pickupArea },
        get pickupEntityIds () { return pickupEntityIds },
        get pinnedSource () { return pinnedSource }, set pinnedSource ($value) { pinnedSource = $value },
        get readWindowEvidence () { return readWindowEvidence },
        get reconcileDeposit () { return reconcileDeposit }, set reconcileDeposit ($value) { reconcileDeposit = $value },
        get recovering () { return recovering }, set recovering ($value) { recovering = $value },
        get request () { return request }, set request ($value) { request = $value },
        get requirePickupRoom () { return requirePickupRoom },
        get result () { return result },
        get run () { return run },
        get save () { return save },
        get signal () { return signal }, set signal ($value) { signal = $value },
        get supplyWork () { return supplyWork }, set supplyWork ($value) { supplyWork = $value },
        get wait () { return wait },
        get windowEvidence () { return windowEvidence }, set windowEvidence ($value) { windowEvidence = $value }
      }
      await openCheckpoint(rt, vars2)
      const resumeCheckpointResult = await resumeCheckpoint(rt, vars2)
      if (resumeCheckpointResult && 'value' in resumeCheckpointResult) return resumeCheckpointResult.value

      if (!recovering) {
        // The stages called in this block live in modules of their own (scripts/extract-stage.js).
        // `vars3` reads and writes this function's locals at the moment of use.
        let current, slots
        const vars3 = {
          get appendRecoverySpace () { return appendRecoverySpace },
          get canPlace () { return canPlace }, set canPlace ($value) { canPlace = $value },
          get capacityBatch () { return capacityBatch },
          get capacityWork () { return capacityWork }, set capacityWork ($value) { capacityWork = $value },
          get close () { return close },
          get cp () { return cp }, set cp ($value) { cp = $value },
          get current () { return current }, set current ($value) { current = $value },
          get guard () { return guard },
          get moveToCell () { return moveToCell },
          get perform () { return perform },
          get pinnedSource () { return pinnedSource },
          get readWindowEvidence () { return readWindowEvidence },
          get reconcileDeposit () { return reconcileDeposit },
          get request () { return request }, set request ($value) { request = $value },
          get requirePickupRoom () { return requirePickupRoom },
          get result () { return result },
          get save () { return save },
          get signal () { return signal }, set signal ($value) { signal = $value },
          get slots () { return slots }, set slots ($value) { slots = $value },
          get supplyWork () { return supplyWork },
          get windowEvidence () { return windowEvidence }, set windowEvidence ($value) { windowEvidence = $value }
        }
        const placeContainerResult = await placeContainer(rt, vars3)
        if (placeContainerResult && 'value' in placeContainerResult) return placeContainerResult.value
        await openContainer(rt, vars3)
        await transferItems(rt, vars3)
        const packContainerResult = await packContainer(rt, vars3)
        if (packContainerResult && 'value' in packContainerResult) return packContainerResult.value
      }
      await breakContainer(rt, vars2)
      const recoverContainerResult = await recoverContainer(rt, vars2)
      if (recoverContainerResult && 'value' in recoverContainerResult) return recoverContainerResult.value
    } catch (error) {
      actions.cancel()
      let details = error.details
      if (cp?.kind === 'shulker' && cp.expectedContents && Array.isArray(cp.recoveryBaseline) && cp.placed?.length === 1 && ['STORAGE_RECOVERY_UNCONFIRMED', 'STORAGE_PICKUP_STAND_UNKNOWN'].includes(error.code)) {
        try {
          const recovery = rt.recoveryDiagnostic(cp)
          details = { ...(details ?? {}), recovery }
          // Final failure only; the full bounded diagnostic also survives in
          // the job's result details when the concise event log is truncated.
          try { rt.onRecoveryDiagnostic?.(rt.copy(recovery)) } catch { /* A logger cannot change the operation result. */ }
        } catch { /* Preserve the original failure and checkpoint if diagnostic observation fails. */ }
      }
      return { ...result('blocked', error.code ?? String(error.message ?? error)), ...(details ? { details: rt.copy(details) } : {}) }
    } finally {
      actions.dispose()
      if (rt.active === run) rt.active = null
    }
  }
  return {
    storeCarried
  }
}

module.exports = { createQuarryPortableStore }
