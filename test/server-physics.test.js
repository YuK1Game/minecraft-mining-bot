'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { normalizePlayerCorrection } = require('../src/server-physics')

function correction (overrides = {}) {
  return { prediction_type: 'player', position: { x: -10.25, y: 70.62, z: 4.5 }, delta: { x: -0.12, y: 0.32, z: 0.07 }, rotation: { x: 0, z: 0 }, angular_velocity: undefined, on_ground: false, tick: 123n, ...overrides }
}

test('1.26.60 wire correction preserves its position, supplied velocity and false on-ground without position snapping', () => {
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const params = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'correct_player_move_prediction', params: correction() })).data.params
  const normalized = normalizePlayerCorrection(params, { currentInputTick: 123n })
  assert.equal(normalized.accepted, true)
  assert.deepEqual(normalized.position, params.position)
  assert.deepEqual(normalized.velocity, params.delta)
  assert.equal(normalized.position.y, params.position.y, 'the helper does not alter the protocol position or apply eye/feet offsets')
  assert.notEqual(normalized.position.x, params.position.x + params.delta.x)
  assert.equal(normalized.onGround, false)
  assert.equal(normalized.velocitySource, 'server_correction')
  assert.equal(normalized.reconciliation, 'current_tick')
  assert.equal(normalized.maySeedNow, true)
})

test('a grounded correction retains its actual nonzero vertical velocity and does not invent omitted physics state', () => {
  const normalized = normalizePlayerCorrection(correction({ on_ground: true, delta: { x: 0, y: -0.0784, z: 0 }, rotation: { x: 89, z: 270 } }))
  assert.equal(normalized.onGround, true)
  assert.equal(normalized.velocity.y, -0.0784)
  for (const field of ['rotation', 'yaw', 'pitch', 'isInWater', 'isInLava', 'isCollidedHorizontally', 'isCollidedVertically', 'controls', 'effects', 'attributes', 'physicsState']) assert.equal(Object.hasOwn(normalized, field), false, field)
  assert.deepEqual(normalized.authoritativeFields, ['position', 'velocity', 'onGround', 'tick'])
  assert.equal(normalized.temporalScope, 'packet_tick')
  assert.equal(normalized.maySeedNow, false, 'unknown input/history context cannot claim this is a complete current-frame state')
})

test('historical corrections distinguish rewind-and-replay from an explicit no-history immediate application', () => {
  const packet = correction()
  const rewind = normalizePlayerCorrection(packet, { currentInputTick: 130n, historyAvailable: true })
  assert.equal(rewind.reconciliation, 'rewind_replay')
  assert.equal(rewind.requiresReplay, true)
  assert.equal(rewind.maySeedNow, false)
  const noHistory = normalizePlayerCorrection(packet, { currentInputTick: 130n, historyAvailable: false })
  assert.equal(noHistory.reconciliation, 'immediate_without_history')
  assert.equal(noHistory.maySeedNow, true)
  assert.equal(noHistory.position.x, packet.position.x)
  assert.deepEqual(noHistory.velocity, packet.delta)
  const unknown = normalizePlayerCorrection(packet, { currentInputTick: 130n })
  assert.equal(unknown.reconciliation, 'packet_tick_only')
  assert.equal(unknown.maySeedNow, false)
})

test('vehicle, missing-type and incomplete packets cannot become player velocity seeds', () => {
  for (const prediction_type of ['vehicle', 1, undefined, 'unknown', 2]) assert.equal(normalizePlayerCorrection(correction({ prediction_type })).accepted, false)
  assert.equal(normalizePlayerCorrection(correction({ prediction_type: 0 })).accepted, true)
  for (const incomplete of [
    { delta: undefined }, { delta: { x: 0, y: NaN, z: 0 } },
    { position: { x: Infinity, y: 64, z: 0 } }, { on_ground: undefined }, { on_ground: 0 }
  ]) assert.equal(normalizePlayerCorrection(correction(incomplete)).accepted, false)
})

test('tick order is exact above Number precision and zero tick remains an immediate packet', () => {
  const huge = 9007199254741000n
  const normalized = normalizePlayerCorrection(correction({ tick: huge }), { currentInputTick: huge, lastCorrectionTick: huge - 1n })
  assert.equal(normalized.tick, String(huge))
  assert.equal(normalized.accepted, true)
  assert.equal(normalizePlayerCorrection(correction(), { lastCorrectionTick: 123n }).code, 'STALE_CORRECTION')
  assert.equal(normalizePlayerCorrection(correction(), { lastCorrectionTick: 124n }).code, 'STALE_CORRECTION')
  assert.equal(normalizePlayerCorrection(correction(), { currentInputTick: 122n }).code, 'FUTURE_INPUT_TICK')
  const immediate = normalizePlayerCorrection(correction({ tick: 0n }), { lastCorrectionTick: huge, currentInputTick: huge, historyAvailable: true })
  assert.equal(immediate.accepted, true)
  assert.equal(immediate.reconciliation, 'immediate')
  assert.equal(immediate.maySeedNow, true)
})

test('malformed ticks, unknown context and another version are rejected rather than guessed', () => {
  for (const tick of [-1n, 1n << 64n, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1.5', 'bad', undefined]) assert.equal(normalizePlayerCorrection(correction({ tick })).code, 'INVALID_TICK')
  assert.equal(normalizePlayerCorrection(correction(), { currentInputTick: 'bad' }).code, 'INVALID_CONTEXT')
  assert.equal(normalizePlayerCorrection(correction(), { historyAvailable: 'false' }).code, 'INVALID_CONTEXT')
  assert.equal(normalizePlayerCorrection(correction(), { version: '1.21.130' }).code, 'UNSUPPORTED_VERSION')
})

test('normalization is passive, deterministic and detached from both packet and caller context', () => {
  const packet = correction()
  const options = { currentInputTick: 130n, historyAvailable: false }
  const before = structuredClone({ packet, options })
  const normalized = normalizePlayerCorrection(packet, options)
  assert.deepEqual(normalized, normalizePlayerCorrection(packet, options))
  normalized.position.x = 999
  normalized.velocity.y = 999
  assert.deepEqual({ packet, options }, before)
})
