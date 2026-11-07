'use strict'

const { randomUUID: createUUID } = require('node:crypto')
const { observedScope, uuidOf, int64 } = require('./server-position-verifier')

// 1.26.60 vanilla en_US.lang: commands.locate.biome.success takes the biome,
// three integer block coordinates and the distance from the command origin.
function resultCoordinates (packet) {
  if (packet.origin.type !== 'player' || typeof packet.origin.request_id !== 'string' ||
      !int64(packet.origin.player_entity_id) || typeof packet.output_type !== 'string' ||
      typeof packet.has_data !== 'boolean' || (packet.has_data && typeof packet.data !== 'string') ||
      packet.success_count !== 1 || !Array.isArray(packet.output) || packet.output.length !== 1) return null
  const entry = packet.output[0]
  if (entry?.success !== true || !/^%?commands\.locate\.biome\.success$/.test(entry.message_id) ||
      !Array.isArray(entry.parameters) || entry.parameters.length !== 5) return null
  const [biome, ...values] = entry.parameters
  if (!['minecraft:plains', 'plains'].includes(biome) ||
      !values.every(n => typeof n === 'string' && /^-?\d{1,8}$/.test(n))) return null
  const [x, y, z, distance] = values.map(Number)
  if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 319 || distance < 0) return null
  return { position: { x, y, z }, distance }
}

function createPlainsLocator ({ client, getState, now = Date.now, randomUUID = createUUID, timeoutMs = 20000 }) {
  let pending = null, lastResult = null
  const used = new Set()
  const fail = reason => ({ serverConfirmed: false, reason })
  function finish (result) {
    const request = pending
    clearTimeout(request.timer)
    pending = null
    lastResult = { requestId: request.id, scope: request.scope, ...result }
    request.resolve(structuredClone(lastResult))
  }
  function locate () {
    if (pending) return Promise.resolve(fail('LOCATE_BUSY'))
    const state = getState(), scope = observedScope(state)
    if (!scope || state.dimension !== 'overworld') return Promise.resolve(fail('LOCATE_STATE_UNAVAILABLE'))
    const id = uuidOf(randomUUID())
    if (!id || used.has(id)) return Promise.resolve(fail('LOCATE_INVALID_REQUEST_ID'))
    used.add(id)
    return new Promise(resolve => {
      const startedAt = now()
      pending = { id, scope, startedAt, runtimeEntityId: String(state.runtimeEntityId), resolve, timer: setTimeout(() => finish(fail('LOCATE_TIMEOUT')), timeoutMs) }
      try {
        client.queue('command_request', { command: '/locate biome minecraft:plains', origin: { type: 'player', uuid: id, request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' })
      } catch { finish(fail('LOCATE_SEND_FAILED')) }
    })
  }
  function cancel () { if (pending) finish(fail('LOCATE_INTERRUPTED')) }
  function applyPacket (name, packet, { replaying = false } = {}) {
    if (!pending || replaying) return
    if (['start_game', 'change_dimension', 'respawn', 'disconnect', 'close', 'death_info'].includes(name) ||
        (name === 'set_health' && packet?.health <= 0) ||
        (name === 'entity_event' && String(packet?.runtime_entity_id) === pending.runtimeEntityId && ['death_animation', 3, 'respawn', 18].includes(packet.event_id)) ||
        (name === 'update_attributes' && String(packet?.runtime_entity_id) === pending.runtimeEntityId && packet.attributes?.some(a => a.name === 'minecraft:health' && a.current <= 0))) {
      cancel()
      return
    }
    if (name !== 'command_output' || uuidOf(packet?.origin?.uuid) !== pending.id) return
    if (observedScope(getState()) !== pending.scope) { finish(fail('LOCATE_SCOPE_CHANGED')); return }
    const receivedAt = now()
    if (receivedAt < pending.startedAt || receivedAt > pending.startedAt + timeoutMs) { finish(fail('LOCATE_TIMEOUT')); return }
    const coordinates = resultCoordinates(packet)
    // Keep the correlated server reply even when the server refuses or sends
    // a newly formatted message. Return only JSON-safe fields to diagnostics.
    const serverOutput = {
      origin: { type: packet.origin.type, uuid: packet.origin.uuid, request_id: packet.origin.request_id, player_entity_id: String(packet.origin.player_entity_id) },
      success_count: packet.success_count, output_type: packet.output_type, has_data: packet.has_data,
      output: Array.isArray(packet.output) ? structuredClone(packet.output) : null
    }
    finish({ ...(coordinates ? { serverConfirmed: true, biome: 'plains', ...coordinates } : fail('LOCATE_OUTPUT_UNCONFIRMED')), receivedAt, serverOutput })
  }
  function snapshot () { return { pending: !!pending, requestId: pending?.id ?? null, lastResult: structuredClone(lastResult) } }
  return { locate, applyPacket, cancel, snapshot }
}

module.exports = { createPlainsLocator }
