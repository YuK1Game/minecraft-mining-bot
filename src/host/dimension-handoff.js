'use strict'

const names = ['overworld', 'nether', 'end']
const dimensionName = value => names[value] ?? value

// Bedrock 1.26.60 (protocol 2225): the server supplies the optional loading
// screen ID and initiates the action-14 handshake. Echo that action before
// waiting for the destination chunks, then close the server's loading screen.
function createDimensionHandoff ({ state, shared, queue, terrainKnown, getLife, stopActions, ready, onError = () => {} }) {
  let pending = null, sequence = 0
  function reset () {
    pending = null
    shared.dragonDimensionTransition = null
    shared.loadingScreenEnded = state.loadingScreenEnded = false
  }
  function drain (transfer) {
    transfer.retryAt = Infinity
    function failed (error) {
      if (transfer !== pending) return
      transfer.retryAt = Date.now() + 2000
      onError(error)
    }
    try { void Promise.resolve(stopActions()).then(() => { transfer.drained = true }, failed) } catch (error) { failed(error) }
  }
  function begin (from, packet) {
    const to = dimensionName(packet.dimension)
    if (!names.includes(to) || !names.includes(dimensionName(from))) return
    const id = packet.loading_screen_id ?? null
    const life = getLife()
    const position = packet.position && [packet.position.x, packet.position.y, packet.position.z].every(Number.isFinite) ? { ...packet.position } : null
    shared.dragonDimensionTransition = { sequence: ++sequence, at: Date.now(), from: dimensionName(from), to, position, connectionId: state.connectionId, deathId: life?.deathId ?? null, respawn: packet.respawn === true || life?.dead === true }
    const transfer = pending = { to, id, ack: false, ackSent: false, drained: false }
    shared.loadingScreenEnded = state.loadingScreenEnded = false
    drain(transfer)
    if (id != null) queue('serverbound_loading_screen', { type: 1, loading_screen_id: id })
  }
  function credits (packet) {
    if (packet?.status !== 0 || state.runtimeEntityId == null || String(packet.runtime_entity_id) !== String(state.runtimeEntityId)) return false
    queue('show_credits', { runtime_entity_id: BigInt(state.runtimeEntityId), status: 1 })
    return true
  }
  function observe (name, packet) {
    if (!pending) return false
    if (name === 'timer' && pending.retryAt <= Date.now()) drain(pending)
    if (name === 'player_action' && String(packet.runtime_entity_id) === String(state.runtimeEntityId) && [14, 'dimension_change_ack'].includes(packet.action)) pending.ack = true
    if (!pending.ack || dimensionName(state.dimension) !== pending.to) return true
    if (!pending.ackSent) {
      const block = { x: 0, y: 0, z: 0 }
      queue('player_action', { runtime_entity_id: BigInt(state.runtimeEntityId), action: 'dimension_change_ack', position: block, result_position: block, face: 0 })
      pending.ackSent = true
    }
    if (!pending.drained || !state.position || !terrainKnown(state.position)) return true
    if (pending.id != null) queue('serverbound_loading_screen', { type: 2, loading_screen_id: pending.id })
    pending = null
    shared.loadingScreenEnded = state.loadingScreenEnded = true
    ready()
    return false
  }
  return { begin, observe, credits, reset, pending: () => !!pending }
}

module.exports = { createDimensionHandoff }
