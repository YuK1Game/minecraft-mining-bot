'use strict'

const { randomUUID: cryptoRandomUUID } = require('node:crypto')
const { observedScope, uuidOf, int64 } = require('./server-position-verifier')

// Read-only current-state evidence, never proof that a prior placement was unsent.
// https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/testforblock
// Mojang's resource_pack/texts/en_US.lang: commands.testforblock.success has
// three integer parameters, in x/y/z order.
// https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/texts/en_US.lang
const KIND = 'server_storage_target_air'
const BOUNDARY = new Set(['start_game', 'change_dimension', 'disconnect', 'close', 'death_info'])
const copy = value => structuredClone(value)
const messageKey = value => typeof value === 'string' ? value.replace(/^%/, '') : ''
const validPosition = position => position && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis])) &&
  Math.abs(position.x) <= 30000000 && Math.abs(position.z) <= 30000000 && position.y >= -64 && position.y <= 319

function createStoragePlacementAudit ({ client, getState, now = Date.now, timeoutMs = 1500, randomUUID = cryptoRandomUUID } = {}) {
  if (typeof client?.queue !== 'function' || [getState, now, randomUUID].some(fn => typeof fn !== 'function') ||
    !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 1500) throw new Error('Storage target audit requires scoped observations and a bounded read-only command')
  let pending = null, lastResult = null, disposed = false
  const used = new Set()
  const read = () => { try { return getState() } catch { return null } }
  const stamp = () => { const value = now(); return Number.isSafeInteger(value) && value >= 0 ? value : null }
  const refused = reason => Promise.resolve({ serverConfirmed: false, kind: KIND, reason })
  function finish (request, result) {
    if (pending !== request) return
    pending = null
    clearTimeout(request.timer)
    request.signal?.removeEventListener('abort', request.abort)
    lastResult = copy(result)
    request.resolve(copy(result))
  }
  function fail (request, reason, detail = null) {
    finish(request, {
      serverConfirmed: false, kind: KIND, reason, scope: request.scope, position: copy(request.position),
      requestId: request.id, operationId: request.operationId, startedAt: request.startedAt,
      ...(detail == null ? {} : { detail: String(detail).slice(0, 160) })
    })
  }
  function confirmAir (position, { signal, operationId } = {}) {
    if (disposed) return refused('STORAGE_AIR_AUDIT_DISPOSED')
    if (signal?.aborted) return refused('STORAGE_AIR_CANCELLED')
    if (!validPosition(position) || typeof operationId !== 'string' || !operationId.length || operationId.length > 200 || /[\r\n\u0000]/.test(operationId) ||
      signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return refused('STORAGE_AIR_INVALID_REQUEST')
    if (pending) return refused('STORAGE_AIR_AUDIT_BUSY')
    const state = read(), scope = observedScope(state), startedAt = stamp()
    if (!scope || !Number.isFinite(Date.parse(state.startedAt)) || startedAt == null) return refused('STORAGE_AIR_STATE_UNAVAILABLE')
    // Keep UUID anti-replay state bounded without evicting an old request ID.
    if (used.size >= 256) return refused('STORAGE_AIR_AUDIT_LIMIT_REACHED')
    let id
    try { id = uuidOf(randomUUID()) } catch { return refused('STORAGE_AIR_REQUEST_ID_UNAVAILABLE') }
    if (!id || used.has(id)) return refused('STORAGE_AIR_REQUEST_ID_REUSED')
    used.add(id)
    const target = { x: position.x, y: position.y, z: position.z }
    return new Promise(resolve => {
      const request = pending = {
        id, operationId, position: target, scope, runtimeEntityId: String(state.runtimeEntityId),
        startedAt, deadline: startedAt + timeoutMs, signal, resolve, timer: null, abort: null
      }
      request.abort = () => fail(request, 'STORAGE_AIR_CANCELLED', signal?.reason?.message)
      request.timer = setTimeout(() => fail(request, 'STORAGE_AIR_TIMEOUT'), timeoutMs)
      signal?.addEventListener('abort', request.abort, { once: true })
      if (signal?.aborted) { request.abort(); return }
      try {
        client.queue('command_request', {
          // Inverted (2026-11-13): only failure replies, which the Realm sends with
          // the gamerule sendcommandfeedback false. Air: the inner testfor finds no
          // target (rm = 1000000). Not air: the execute condition is false.
          command: `/execute if block ${target.x} ${target.y} ${target.z} air run testfor @s[rm=1000000]`,
          origin: { type: 'player', uuid: id, request_id: '', player_entity_id: 0n },
          internal: false, version: 'latest'
        })
      } catch (error) { fail(request, 'STORAGE_AIR_SEND_FAILED', error?.message ?? error) }
    })
  }
  function applyPacket (name, packet = {}) {
    const request = pending
    if (!request) return false
    if (BOUNDARY.has(name)) { fail(request, 'STORAGE_AIR_SCOPE_CHANGED'); return true }
    if (!packet || typeof packet !== 'object') return false
    const ownActor = packet.runtime_entity_id == null || String(packet.runtime_entity_id) === request.runtimeEntityId
    if (name === 'respawn' && ownActor || name === 'entity_event' && ownActor && ['death_animation', 3, 'respawn', 18].includes(packet.event_id) ||
      name === 'set_health' && Number.isFinite(packet.health) && packet.health <= 0 ||
      name === 'update_attributes' && ownActor && packet.attributes?.some(attribute => attribute.name === 'minecraft:health' && Number.isFinite(attribute.current) && attribute.current <= 0)) {
      fail(request, 'STORAGE_AIR_SCOPE_CHANGED'); return true
    }
    if (name !== 'command_output' || uuidOf(packet.origin?.uuid) !== request.id) return false
    if (observedScope(read()) !== request.scope) { fail(request, 'STORAGE_AIR_SCOPE_CHANGED'); return true }
    const receivedAt = stamp()
    if (receivedAt == null || receivedAt < request.startedAt || receivedAt > request.deadline) { fail(request, 'STORAGE_AIR_TIMEOUT'); return true }
    const origin = packet.origin
    const schema = origin.type === 'player' && typeof origin.request_id === 'string' && int64(origin.player_entity_id) &&
      typeof packet.output_type === 'string' && typeof packet.has_data === 'boolean' && (!packet.has_data || typeof packet.data === 'string') &&
      Number.isInteger(packet.success_count) && packet.success_count >= 0 && packet.success_count <= 0xffffffff && Array.isArray(packet.output) && packet.output.length >= 1 && packet.output.length <= 2
    const output = schema ? packet.output[0] : null
    const strings = o => o && Array.isArray(o.parameters) && o.parameters.every(p => typeof p === 'string')
    // Recorded on the live Realm (2026-11-13, sendcommandfeedback false):
    // air -> [commands.generic.noTargetMatch [], commands.execute.failed [testfor, <player>]]
    // not air -> [commands.execute.falseCondition [if, block]]. Anything else (a success
    // reply included: the inversion no longer holds) is unconfirmed.
    const air = schema && packet.success_count === 0 && packet.output.length === 2 && output?.success === false && messageKey(output.message_id) === 'commands.generic.noTargetMatch' && strings(output) && output.parameters.length === 0 &&
      packet.output[1]?.success === false && messageKey(packet.output[1].message_id) === 'commands.execute.failed' && strings(packet.output[1]) && packet.output[1].parameters.length === 2 && packet.output[1].parameters[0] === 'testfor'
    if (air) {
      finish(request, {
        serverConfirmed: true, kind: KIND, scope: request.scope, position: copy(request.position),
        requestId: request.id, operationId: request.operationId, startedAt: request.startedAt, receivedAt
      })
    } else {
      const notAir = schema && packet.success_count === 0 && packet.output.length === 1 && output?.success === false && messageKey(output.message_id) === 'commands.execute.falseCondition' && strings(output) && output.parameters.length === 2 && output.parameters[0] === 'if' && output.parameters[1] === 'block'
      fail(request, notAir ? 'STORAGE_TARGET_NOT_AIR' : packet.success_count === 0 ? 'STORAGE_AIR_COMMAND_REJECTED' : 'STORAGE_AIR_OUTPUT_UNCONFIRMED', output?.message_id)
    }
    return true
  }
  function snapshot () {
    return {
      disposed, pending: !!pending, requestId: pending?.id ?? null, operationId: pending?.operationId ?? null,
      position: pending ? copy(pending.position) : null, scope: pending?.scope ?? null,
      startedAt: pending?.startedAt ?? null, deadline: pending?.deadline ?? null, lastResult: copy(lastResult)
    }
  }
  function cancel (reason = 'Storage target audit cancelled') {
    if (pending) fail(pending, 'STORAGE_AIR_CANCELLED', reason)
    return snapshot()
  }
  function dispose () {
    disposed = true
    if (pending) fail(pending, 'STORAGE_AIR_AUDIT_DISPOSED')
    return snapshot()
  }
  return { confirmAir, applyPacket, snapshot, cancel, dispose }
}

module.exports = { createStoragePlacementAudit }
