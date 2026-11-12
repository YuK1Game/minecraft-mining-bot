'use strict'

const { observedScope } = require('./server-position-verifier')
const { normalizeChunkArea, areaContainsFeet } = require('./chunk-area')
const sources = new Set(['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'])
const finite = p => p && ['x', 'y', 'z'].every(key => Number.isFinite(p[key]))
const feetOf = s => finite(s?.position) ? { x: s.position.x, y: s.position.y - 1.62, z: s.position.z } : null
const distance = (a, b) => finite(a) && finite(b) ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity
const stamp = value => typeof value === 'number' ? value : Date.parse(value)

function createControlLocation ({ getState, getObservedState, generation, confirmPosition, isMoving = () => false, store = {}, now = Date.now }) {
  if ([getState, getObservedState, generation, confirmPosition, isMoving, now].some(fn => typeof fn !== 'function')) throw TypeError('Control position requires observed state and scoped position witnesses')
  function context () {
    const state = getState(), scope = Number.isFinite(Date.parse(state?.startedAt)) ? observedScope(state) : null
    if (store.scope !== scope) Object.assign(store, { scope, proof: null, motionAt: 0, packetBarrier: null, lastPrediction: null })
    return { state, scope, generation: generation(), feet: feetOf(state) }
  }
  function invalidate () {
    context(); store.proof = null; store.motionAt = now()
    const at = stamp(getObservedState()?.positionUpdatedAt)
    store.packetBarrier = Number.isFinite(at) ? at : null
  }
  function notePrediction (prediction, source) {
    const c = context()
    if (!finite(prediction?.position)) { invalidate(); return }
    const previous = store.lastPrediction ?? c.state.position
    if (source !== 'idle_physics' || distance(previous, prediction.position) > 0.003 || store.proof && distance(feetOf({ position: prediction.position }), store.proof.pose) > 0.03) invalidate()
    store.lastPrediction = { ...prediction.position }
  }
  const unknown = () => ({ confirmed: false, feet: null, radius: null, scope: null, generation: generation(), observedAt: null, source: null })
  function snapshot () {
    const c = context()
    if (!c.scope || !c.feet || isMoving()) return unknown()
    const proof = store.proof
    if (proof && proof.scope === c.scope && proof.generation === c.generation && distance(c.feet, proof.pose) <= 0.03) {
      const { pose, ...result } = proof
      return structuredClone(result)
    }
    store.proof = null
    const observed = getObservedState(), feet = feetOf(observed), at = stamp(observed?.positionUpdatedAt)
    if (observedScope(observed) !== c.scope || !sources.has(observed?.positionSource) || observed.positionServerConfirmed === false ||
      !Number.isFinite(at) || at < Date.parse(c.state.startedAt) || at < (store.motionAt ?? 0) || Number.isFinite(store.packetBarrier) && at <= store.packetBarrier || at > now() || distance(feet, c.feet) > 0.03) return unknown()
    return { confirmed: true, feet, radius: 0, scope: c.scope, generation: c.generation, observedAt: at, source: 'server_position_packet' }
  }
  async function confirm (feet = null, { area = null, signal, operationId, radius = 0.2 } = {}) {
    const c = context(), requested = feet ?? c.feet, began = now()
    const selected = area == null ? null : normalizeChunkArea(area)
    if (!c.scope || !finite(requested) || distance(requested, c.feet) > 0.03 || !Number.isFinite(radius) || radius < 0.12 || radius > 0.35 || selected && !areaContainsFeet(selected, requested, radius)) return { serverConfirmed: false, reason: 'CONTROL_POSITION_UNCONFIRMED' }
    signal?.throwIfAborted()
    invalidate()
    const receipt = await confirmPosition(requested, { signal, operationId, radius })
    const after = context()
    if (signal?.aborted || after.scope !== c.scope || after.generation !== c.generation || distance(after.feet, c.feet) > 0.03 ||
      receipt?.serverConfirmed !== true || receipt.kind !== 'server_position_volume' || receipt.scope !== c.scope ||
      !finite(receipt.feet) || receipt.radius !== radius || !Number.isFinite(receipt.receivedAt) || receipt.receivedAt < began || receipt.receivedAt > now() ||
      distance(receipt.feet, requested) > 0.015 || selected && !areaContainsFeet(selected, receipt.feet, radius)) return { serverConfirmed: false, reason: 'CONTROL_POSITION_UNCONFIRMED' }
    store.proof = { confirmed: true, feet: { ...receipt.feet }, radius, scope: c.scope, generation: c.generation, observedAt: receipt.receivedAt, source: 'server_position_volume', pose: after.feet }
    return receipt
  }
  return { snapshot, confirm, invalidate, notePrediction }
}
module.exports = { createControlLocation }
