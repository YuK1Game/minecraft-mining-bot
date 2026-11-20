'use strict'

// Revoking an input owner is expected control flow, not evidence that its
// route failed or that the player changed world. Keep those causes distinct
// across asynchronous work so retry accounting does not depend on timing.
const INTERRUPTIONS = new Set(['CANCELLED', 'ABORT_ERR', 'ACTION_BUSY', 'YIELD', 'COMBAT_PRIORITY', 'SAFETY_COMBAT_PREEMPTED', 'SAFETY_OWNER_CHANGED', 'SAFETY_SCOPE_CHANGED', 'SAFETY_GENERATION_CHANGED'])
const safetyScope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.runtimeEntityId == null ? null : String(state.runtimeEntityId)])
const interrupted = (code, message, cause) => Object.assign(new Error(message, cause == null ? undefined : { cause }), { code, cancelled: true })
const isSafetyInterruption = error => error?.cancelled === true || error?.name === 'AbortError' || INTERRUPTIONS.has(error?.code) || error?.message === 'COMBAT_PRIORITY'

function createSafetyOwnership ({ currentGeneration, getState, combatOwnsInput, userBehaviorOwns }) {
  const origin = safetyScope(getState())
  function reason () {
    if (!currentGeneration()) return ['SAFETY_GENERATION_CHANGED', '待機保護の世代が変わったため中断しました。']
    if (safetyScope(getState()) !== origin) return ['SAFETY_SCOPE_CHANGED', '待機保護のワールド・プレイヤーが変わったため中断しました。']
    if (combatOwnsInput()) return ['SAFETY_COMBAT_PREEMPTED', '待機保護の操作を戦闘に引き継ぎました。']
    if (userBehaviorOwns()) return ['SAFETY_OWNER_CHANGED', '待機保護の操作を利用者指定の動作に引き継ぎました。']
    return null
  }
  function requireCurrent () {
    const changed = reason()
    if (changed) throw interrupted(...changed)
  }
  function errorFor (error) {
    const changed = reason()
    return changed ? interrupted(...changed, error) : error
  }
  return { originScope: origin, current: () => reason() === null, requireCurrent, errorFor }
}

module.exports = { createSafetyOwnership, isSafetyInterruption }
