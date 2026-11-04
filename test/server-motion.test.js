'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { normalizeServerMotion } = require('../src/server-motion')

const motion = (overrides = {}) => ({ runtime_entity_id: 494n, velocity: { x: 0.2, y: 0.35, z: -0.15 }, tick: 123n, ...overrides })
const hints = (overrides = {}) => ({ entity_runtime_id: 494n, velocity: { x: -0.1, y: -0.0784, z: 0.05 }, on_ground: false, ...overrides })
let codec
function roundtrip (name, params) {
  codec ??= { serializer: createSerializer('1.26.60'), parser: createDeserializer('1.26.60') }
  return codec.parser.parsePacketBuffer(codec.serializer.createPacketBuffer({ name, params })).data.params
}

test('real 1.26.60 set_entity_motion wire uses runtime_entity_id, velocity and correlated tick', () => {
  const packet = roundtrip('set_entity_motion', motion())
  assert.deepEqual(Object.keys(packet).sort(), ['runtime_entity_id', 'tick', 'velocity'])
  const normalized = normalizeServerMotion('set_entity_motion', packet, { ownRuntimeId: '494', currentInputTick: 123n })
  assert.equal(normalized.accepted, true)
  assert.equal(normalized.targetRuntimeId, '494')
  assert.equal(normalized.tick, '123')
  assert.equal(normalized.nextMotionTick, '123')
  assert.deepEqual(normalized.velocity, packet.velocity)
  assert.equal(normalized.velocityOperation, 'replace')
  assert.equal(normalized.reconciliation, 'current_tick')
  assert.equal(normalized.maySeedNow, true)
  assert.equal(Object.hasOwn(normalized, 'onGround'), false)
  assert.equal(Object.hasOwn(normalized, 'position'), false)
  assert.deepEqual(normalized.authoritativeFields, ['velocity', 'tick'])
})

test('real hints wire instead uses entity_runtime_id and a real ground boolean without a tick', () => {
  const packet = roundtrip('motion_prediction_hints', hints())
  assert.deepEqual(Object.keys(packet).sort(), ['entity_runtime_id', 'on_ground', 'velocity'])
  const normalized = normalizeServerMotion('motion_prediction_hints', packet, { ownRuntimeId: 494n, arrivalSequence: 9, lastHintSequence: 8 })
  assert.equal(normalized.accepted, true)
  assert.equal(normalized.onGround, false)
  assert.equal(normalized.tickKnown, false)
  assert.deepEqual(normalized.velocity, packet.velocity)
  assert.equal(normalized.velocityOperation, 'replace')
  assert.equal(normalized.nextHintSequence, '9')
  assert.deepEqual(normalized.ordering, { kind: 'receive_order', sequenceKnown: true, sequence: '9' })
  assert.deepEqual(normalized.authoritativeFields, ['velocity', 'onGround'])
  assert.equal(Object.hasOwn(normalized, 'tick'), false, 'absence of a packet tick is not tick zero')
  assert.equal(normalized.maySeedNow, true)
})

test('only the own entity is eligible and packet-specific ID spellings cannot be substituted', () => {
  for (const [name, packet] of [['set_entity_motion', motion()], ['motion_prediction_hints', hints()]]) {
    assert.equal(normalizeServerMotion(name, packet, { ownRuntimeId: '495' }).code, 'OTHER_ENTITY')
    assert.equal(normalizeServerMotion(name, packet).code, 'OWN_ENTITY_UNKNOWN')
    assert.equal(normalizeServerMotion(name, packet, { ownRuntimeId: {} }).code, 'OWN_ENTITY_UNKNOWN')
  }
  assert.equal(normalizeServerMotion('set_entity_motion', { entity_runtime_id: 494n, velocity: motion().velocity, tick: 1n }, { ownRuntimeId: 494n }).code, 'INVALID_ENTITY_ID')
  assert.equal(normalizeServerMotion('motion_prediction_hints', { runtime_entity_id: 494n, velocity: hints().velocity, on_ground: true }, { ownRuntimeId: 494n }).code, 'INVALID_ENTITY_ID')
})

test('velocity must be the real finite schema field, including an explicit zero-velocity replacement', () => {
  for (const velocity of [undefined, null, { x: 1, y: NaN, z: 0 }, { x: Infinity, y: 0, z: 0 }, { x: '0', y: 0, z: 0 }]) {
    assert.equal(normalizeServerMotion('set_entity_motion', motion({ velocity, delta: { x: 0, y: 0, z: 0 }, motion: { x: 0, y: 0, z: 0 } }), { ownRuntimeId: 494n }).code, 'INVALID_VELOCITY')
  }
  const stop = normalizeServerMotion('set_entity_motion', motion({ velocity: { x: 0, y: 0, z: 0 }, tick: 0n }), { ownRuntimeId: 494n })
  assert.equal(stop.accepted, true)
  assert.deepEqual(stop.velocity, { x: 0, y: 0, z: 0 })
  assert.equal(stop.velocityOperation, 'replace')
})

test('motion ticks and unticked hint receive order are separate and cannot cancel each other', () => {
  const acceptedMotion = normalizeServerMotion('set_entity_motion', motion({ tick: 10n }), { ownRuntimeId: 494n, lastMotionTick: 9n, lastHintSequence: 100000, historyAvailable: false })
  assert.equal(acceptedMotion.accepted, true)
  assert.equal(normalizeServerMotion('set_entity_motion', motion({ tick: 10n }), { ownRuntimeId: 494n, lastMotionTick: 10n, arrivalSequence: 100001 }).code, 'STALE_MOTION')
  const acceptedHint = normalizeServerMotion('motion_prediction_hints', hints({ tick: 1n }), { ownRuntimeId: 494n, lastMotionTick: 100000n, currentInputTick: 0n, arrivalSequence: 2, lastHintSequence: 1 })
  assert.equal(acceptedHint.accepted, true)
  assert.equal(Object.hasOwn(acceptedHint, 'tick'), false)
  assert.equal(normalizeServerMotion('motion_prediction_hints', hints({ tick: 999999n }), { ownRuntimeId: 494n, arrivalSequence: 2, lastHintSequence: 2 }).code, 'STALE_HINT')
  assert.equal(normalizeServerMotion('motion_prediction_hints', hints(), { ownRuntimeId: 494n, lastHintSequence: 2 }).code, 'INVALID_HINT_ORDER')
})

test('zero motion tick applies immediately without lowering the previous nonzero high-water mark', () => {
  const normalized = normalizeServerMotion('set_entity_motion', motion({ tick: 0n }), { ownRuntimeId: 494n, lastMotionTick: 999n, currentInputTick: 1000n, historyAvailable: true })
  assert.equal(normalized.accepted, true)
  assert.equal(normalized.tick, '0')
  assert.equal(normalized.nextMotionTick, '999')
  assert.equal(normalized.reconciliation, 'immediate')
  assert.equal(normalized.maySeedNow, true)
})

test('historical motion remains tied to its frame unless the caller explicitly selects no-history fallback', () => {
  const packet = motion()
  const unknown = normalizeServerMotion('set_entity_motion', packet, { ownRuntimeId: 494n, currentInputTick: 130n })
  assert.equal(unknown.maySeedNow, false)
  assert.equal(unknown.temporalScope, 'packet_tick')
  assert.equal(unknown.reconciliation, 'packet_tick_only')
  const replay = normalizeServerMotion('set_entity_motion', packet, { ownRuntimeId: 494n, currentInputTick: 130n, historyAvailable: true })
  assert.equal(replay.requiresReplay, true)
  assert.equal(replay.maySeedNow, false)
  const fallback = normalizeServerMotion('set_entity_motion', packet, { ownRuntimeId: 494n, currentInputTick: 130n, historyAvailable: false })
  assert.equal(fallback.reconciliation, 'immediate_without_history')
  assert.equal(fallback.maySeedNow, true)
  assert.equal(normalizeServerMotion('set_entity_motion', packet, { ownRuntimeId: 494n, currentInputTick: 122n }).code, 'FUTURE_INPUT_TICK')
})

test('hints require their ground field but neither packet can invent position, rotation, water or effects', () => {
  for (const on_ground of [undefined, null, 0, 'false']) assert.equal(normalizeServerMotion('motion_prediction_hints', hints({ on_ground }), { ownRuntimeId: 494n }).code, 'GROUND_STATE_UNKNOWN')
  const normalized = normalizeServerMotion('set_entity_motion', motion({ on_ground: true, position: { x: 999, y: 999, z: 999 }, rotation: { x: 90, z: 90 }, effects: { jump: 9 } }), { ownRuntimeId: 494n, historyAvailable: false })
  for (const field of ['position', 'feetPosition', 'onGround', 'rotation', 'yaw', 'pitch', 'physicsState', 'isInWater', 'isInLava', 'controls', 'effects', 'attributes']) assert.equal(Object.hasOwn(normalized, field), false, field)
  const unticked = normalizeServerMotion('motion_prediction_hints', hints({ on_ground: true }), { ownRuntimeId: 494n })
  assert.equal(unticked.onGround, true)
  assert.deepEqual(unticked.ordering, { kind: 'receive_order', sequenceKnown: false })
})

test('IDs and ticks retain uint64 precision while malformed context is never guessed', () => {
  const huge = 9007199254741000n
  const normalized = normalizeServerMotion('set_entity_motion', motion({ runtime_entity_id: huge, tick: huge }), { ownRuntimeId: String(huge), currentInputTick: huge, lastMotionTick: huge - 1n })
  assert.equal(normalized.accepted, true)
  assert.equal(normalized.targetRuntimeId, String(huge))
  assert.equal(normalized.tick, String(huge))
  for (const tick of [-1n, 1n << 64n, 1.5, '1.5', Number.MAX_SAFE_INTEGER + 1, undefined]) assert.equal(normalizeServerMotion('set_entity_motion', motion({ tick }), { ownRuntimeId: 494n }).code, 'INVALID_TICK')
  assert.equal(normalizeServerMotion('set_entity_motion', motion(), { ownRuntimeId: 494n, lastMotionTick: 'bad' }).code, 'INVALID_CONTEXT')
  assert.equal(normalizeServerMotion('set_entity_motion', motion(), { ownRuntimeId: 494n, historyAvailable: 'false' }).code, 'INVALID_CONTEXT')
  assert.equal(normalizeServerMotion('set_entity_motion', motion(), { ownRuntimeId: 494n, version: '1.21.130' }).code, 'UNSUPPORTED_VERSION')
  assert.equal(normalizeServerMotion('move_player', motion(), { ownRuntimeId: 494n }).code, 'UNSUPPORTED_PACKET')
})

test('normalization is passive, deterministic and detached without integrating or adding the velocity', () => {
  const packet = motion()
  const options = { ownRuntimeId: '494', currentInputTick: 130n, historyAvailable: false, currentVelocity: { x: 10, y: 20, z: 30 }, position: { x: 1, y: 64, z: 2 } }
  const original = structuredClone({ packet, options })
  const normalized = normalizeServerMotion('set_entity_motion', packet, options)
  assert.deepEqual(normalized.velocity, packet.velocity)
  assert.notEqual(normalized.velocity.x, packet.velocity.x + options.currentVelocity.x)
  assert.deepEqual(normalized, normalizeServerMotion('set_entity_motion', packet, options))
  assert.doesNotThrow(() => JSON.stringify(normalized))
  normalized.velocity.x = 999
  assert.deepEqual({ packet, options }, original)
})
