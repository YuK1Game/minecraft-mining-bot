'use strict'

const { randomUUID: cryptoRandomUUID } = require('node:crypto')

// A sandbox-only, read-only position witness. The selector is inverted
// (rm = minimum distance, 2026-11-13): the executing player matches only when
// OUTSIDE the requested volume, so 'at the position' is the failure reply
// commands.generic.noTargetMatch, which the Realm still sends with the
// gamerule sendcommandfeedback false (a success reply is suppressed there and
// showed 'HouchiChan was found' in chat). A success reply proves the player is
// elsewhere. Anything else, or no reply, is unconfirmed. No prediction or
// queued input is a reply.
// Schema: minecraft-data bedrock/1.26.60 packet_command_output (origin/output).
// https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/testfor
// https://learn.microsoft.com/en-us/minecraft/creator/documents/targetselectors
const RADIUS = 0.12
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BOUNDARY = new Set(['start_game', 'change_dimension', 'respawn', 'disconnect', 'close'])
const copy = value => structuredClone(value)
const uuidOf = value => typeof value === 'string' && UUID.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value) ? value.toLowerCase() : null
const messageKey = value => typeof value === 'string' ? value.replace(/^%/, '') : ''
// ProtoDef decodes li64 into its SignedBigInt two-word array on this client.
const int64 = value => typeof value === 'bigint' ? value >= -(1n << 63n) && value < 1n << 63n : Number.isSafeInteger(value) || Array.isArray(value) && value.length === 2 && value.every(word => Number.isInteger(word) && word >= -2147483648 && word <= 2147483647)

function feetValid (p) {
  return p && ['x', 'y', 'z'].every(a => Number.isFinite(p[a]) && Math.abs(p[a]) <= 30000000) && Number.isSafeInteger(p.y) && Number.isSafeInteger(p.x - 0.5) && Number.isSafeInteger(p.z - 0.5)
}

function observedScope (s) {
  if (!s || s.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || s.spawnPending || !Number.isFinite(s.health) || !(s.health > 0) || typeof s.profile !== 'string' || !s.profile || s.realm?.id == null || !String(s.realm.id) || typeof s.connectionId !== 'string' || !s.connectionId || typeof s.startedAt !== 'string' || !s.startedAt || !['overworld', 'nether', 'end'].includes(s.dimension) || !/^\d+$/.test(String(s.runtimeEntityId ?? '')) || String(s.runtimeEntityId) === '0' || !Number.isSafeInteger(s.lifecycle?.deathId) || s.lifecycle.deathId < 0) return null
  return JSON.stringify([s.profile, String(s.realm.id), s.connectionId, s.startedAt, s.dimension, String(s.runtimeEntityId), s.lifecycle.deathId])
}

function createServerPositionVerifier ({ client, getState, now = Date.now, timeoutMs = 1500, randomUUID = cryptoRandomUUID } = {}) {
  if (typeof client?.queue !== 'function' || [getState, now, randomUUID].some(fn => typeof fn !== 'function') || !Number.isFinite(timeoutMs) || timeoutMs < 20 || timeoutMs > 10000) throw new Error('Position verifier needs received state, command packets and a bounded timeout')
  let pending = null; let lastResult = null
  const used = new Set()
  const read = () => { try { return getState() } catch { return null } }
  const stamp = () => { const value = now(); return Number.isFinite(value) && value >= 0 ? value : null }
  function finish (request, result) {
    if (pending !== request) return
    pending = null
    clearTimeout(request.timer)
    request.signal?.removeEventListener('abort', request.abort)
    lastResult = copy(result)
    request.resolve(copy(result))
  }
  const fail = (request, reason, detail) => finish(request, { serverConfirmed: false, reason, feet: copy(request.feet), radius: request.radius ?? RADIUS, requestId: request.id, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) })

  // radius (optional, 0.12..1.5): a wider check around a rounded point, used to
  // confirm roughly where the bot is (e.g. after knockback) without centring it.
  function confirm (feet, { signal, operationId, radius = null } = {}) {
    if (signal?.aborted) return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_CANCELLED' })
    const wide = radius !== null
    if (wide && !(Number.isFinite(radius) && radius >= RADIUS && radius <= 1.5)) return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_INVALID_REQUEST' })
    if (wide) feet = feet && ['x', 'y', 'z'].every(a => Number.isFinite(feet[a]) && Math.abs(feet[a]) <= 30000000) ? { x: Math.round(feet.x * 100) / 100, y: Math.round(feet.y * 100) / 100, z: Math.round(feet.z * 100) / 100 } : null
    if (!(wide ? feet : feetValid(feet)) || signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') || operationId != null && (typeof operationId !== 'string' || operationId.length > 200 || /[\r\n\u0000]/.test(operationId))) return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_INVALID_REQUEST' })
    if (pending) return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_VERIFIER_BUSY' })
    const state = read(), scope = observedScope(state), startedAt = stamp()
    if (!scope || startedAt == null) return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_STATE_UNAVAILABLE' })
    let id
    try { id = uuidOf(randomUUID()) } catch { return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_REQUEST_ID_UNAVAILABLE' }) }
    if (!id || used.has(id)) return Promise.resolve({ serverConfirmed: false, reason: 'POSITION_REQUEST_ID_REUSED' })
    used.add(id)
    const target = { x: feet.x, y: feet.y, z: feet.z }
    return new Promise(resolve => {
      const request = pending = { id, operationId: operationId ?? null, feet: target, ...(wide ? { radius } : {}), scope, runtimeEntityId: String(state.runtimeEntityId), playerName: typeof state.playerName === 'string' && state.playerName ? state.playerName : null, startedAt, deadline: startedAt + timeoutMs, signal, resolve, timer: null, abort: null }
      request.abort = () => fail(request, 'POSITION_CANCELLED', signal?.reason?.message)
      request.timer = setTimeout(() => fail(request, 'POSITION_TIMEOUT'), timeoutMs)
      signal?.addEventListener('abort', request.abort, { once: true })
      if (signal?.aborted) { request.abort(); return }
      try {
        client.queue('command_request', {
          command: `/testfor @s[x=${target.x},y=${target.y},z=${target.z},rm=${request.radius ?? RADIUS}]`,
          origin: { type: 'player', uuid: id, request_id: '', player_entity_id: 0n },
          internal: false, version: 'latest'
        })
      } catch (error) { fail(request, 'POSITION_SEND_FAILED', error?.message ?? error) }
    })
  }

  function applyPacket (name, packet = {}) {
    const request = pending
    if (!request) return false
    if (BOUNDARY.has(name)) { fail(request, 'POSITION_SCOPE_CHANGED'); return true }
    if (!packet || typeof packet !== 'object') return false
    if (name === 'entity_event' && String(packet.runtime_entity_id) === request.runtimeEntityId && ['death_animation', 3, 'respawn', 18].includes(packet.event_id) || name === 'set_health' && Number.isFinite(packet.health) && packet.health <= 0 || name === 'update_attributes' && String(packet.runtime_entity_id) === request.runtimeEntityId && packet.attributes?.some(a => a.name === 'minecraft:health' && Number.isFinite(a.current) && a.current <= 0)) { fail(request, 'POSITION_SCOPE_CHANGED'); return true }
    if (name !== 'command_output' || uuidOf(packet.origin?.uuid) !== request.id) return false
    if (observedScope(read()) !== request.scope) { fail(request, 'POSITION_SCOPE_CHANGED'); return true }
    const receivedAt = stamp()
    if (receivedAt == null || receivedAt < request.startedAt || receivedAt > request.deadline) { fail(request, 'POSITION_TIMEOUT'); return true }
    const origin = packet.origin
    const schema = origin.type === 'player' && typeof origin.request_id === 'string' && int64(origin.player_entity_id) && typeof packet.output_type === 'string' && typeof packet.has_data === 'boolean' && (!packet.has_data || typeof packet.data === 'string') && Number.isInteger(packet.success_count) && packet.success_count >= 0 && packet.success_count <= 0xffffffff && Array.isArray(packet.output) && packet.output.length === 1
    const output = schema ? packet.output[0] : null
    const parameters = output && Array.isArray(output.parameters) && output.parameters.length === 1 && output.parameters.every(p => typeof p === 'string' && p.length > 0)
    // Inside the volume: exactly one failure message saying no target matched.
    const inside = schema && packet.success_count === 0 && packet.output.length === 1 && output?.success === false && ['commands.generic.noTargetMatch', 'commands.testfor.failure'].includes(messageKey(output.message_id)) && Array.isArray(output.parameters) && output.parameters.every(p => typeof p === 'string')
    // Outside the volume: our own player matched the inverted selector.
    const outside = schema && packet.success_count === 1 && output?.success === true && messageKey(output.message_id) === 'commands.testfor.success' && parameters && (!request.playerName || output.parameters[0] === request.playerName)
    if (inside) finish(request, { serverConfirmed: true, kind: 'server_position_volume', feet: copy(request.feet), radius: request.radius ?? RADIUS, requestId: request.id, receivedAt, scope: request.scope, witness: 'inverted_no_target' })
    else fail(request, outside ? 'POSITION_NOT_FOUND' : packet.success_count === 0 ? 'POSITION_COMMAND_REJECTED' : 'POSITION_OUTPUT_UNCONFIRMED', output?.message_id)
    return true
  }

  function snapshot () { return { pending: !!pending, requestId: pending?.id ?? null, operationId: pending?.operationId ?? null, feet: pending ? copy(pending.feet) : null, radius: RADIUS, startedAt: pending?.startedAt ?? null, deadline: pending?.deadline ?? null, lastResult: copy(lastResult) } }
  function cancel (reason = 'Position verification cancelled') { if (pending) fail(pending, 'POSITION_CANCELLED', reason); return snapshot() }
  return { confirm, applyPacket, cancel, snapshot }
}

module.exports = { createServerPositionVerifier, observedScope, uuidOf, int64 }
