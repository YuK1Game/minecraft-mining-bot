'use strict'

// 1.26.60 wire names are verified by the real codec tests. In particular the
// entity-ID field names differ, and motion_prediction_hints carries no tick.
// Mojang v1.26.60 (0879ab5c4c70be1bd520e32a8c49ea4a155616d6):
// json/SetActorMotionPacketPayload.json and json/MotionPredictionHintsPacket.json.
// These packets supply replacement velocity, not a positional or velocity delta.
const MAX_UNSIGNED = (1n << 64n) - 1n
const vector = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis])) ? { x: value.x, y: value.y, z: value.z } : null
function unsigned (value) {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value)) && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  try { const parsed = BigInt(value); return parsed >= 0n && parsed <= MAX_UNSIGNED ? parsed : null } catch { return null }
}

function normalizeServerMotion (name, packet, options = {}) {
  const { ownRuntimeId, version = '1.26.60' } = options
  const reject = (code, reason) => ({ accepted: false, source: name, code, reason })
  if (version !== '1.26.60') return reject('UNSUPPORTED_VERSION', 'サーバー速度の正規化は1.26.60の形式に限定しています。')
  if (!['set_entity_motion', 'motion_prediction_hints'].includes(name)) return reject('UNSUPPORTED_PACKET', 'この種類のパケットを速度指定として使えません。')
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return reject('INVALID_PACKET', '受信した速度パケットがありません。')
  const own = unsigned(ownRuntimeId)
  if (own === null) return reject('OWN_ENTITY_UNKNOWN', '自分の接続内エンティティIDを確認できません。')
  const target = unsigned(name === 'set_entity_motion' ? packet.runtime_entity_id : packet.entity_runtime_id)
  if (target === null) return reject('INVALID_ENTITY_ID', 'このパケット形式の対象IDを確認できません。')
  if (target !== own) return reject('OTHER_ENTITY', '自分以外のエンティティの速度です。')
  // The local schema calls Motion "velocity" for both packets. Do not accept
  // delta/motion aliases: delta belongs to a different packet's wire contract.
  const velocity = vector(packet.velocity)
  if (!velocity) return reject('INVALID_VELOCITY', '有限な実速度のx/y/zが必要です。')
  const base = { accepted: true, source: name, targetRuntimeId: String(target), velocity, velocitySource: name, velocityOperation: 'replace' }

  if (name === 'motion_prediction_hints') {
    if (typeof packet.on_ground !== 'boolean') return reject('GROUND_STATE_UNKNOWN', '速度ヒントの実際の接地状態が必要です。')
    const sequence = options.arrivalSequence == null ? null : unsigned(options.arrivalSequence)
    const previous = options.lastHintSequence == null ? null : unsigned(options.lastHintSequence)
    if (options.arrivalSequence != null && sequence === null || options.lastHintSequence != null && previous === null || previous !== null && sequence === null) return reject('INVALID_HINT_ORDER', '速度ヒントの実受信順序を確認できません。')
    if (previous !== null && sequence <= previous) return reject('STALE_HINT', '既に処理した速度ヒント以前の受信順序です。')
    return {
      ...base,
      onGround: packet.on_ground,
      authoritativeFields: ['velocity', 'onGround'],
      tickKnown: false,
      ordering: { kind: 'receive_order', sequenceKnown: sequence !== null, ...(sequence === null ? {} : { sequence: String(sequence) }) },
      ...(sequence === null ? {} : { nextHintSequence: String(sequence) }),
      temporalScope: 'packet_arrival',
      reconciliation: 'unticked_motion_hint',
      requiresReplay: false,
      maySeedNow: true
    }
  }

  const tick = unsigned(packet.tick)
  if (tick === null) return reject('INVALID_TICK', '速度指定の実入力tickを確認できません。')
  const previous = options.lastMotionTick == null ? null : unsigned(options.lastMotionTick)
  const current = options.currentInputTick == null ? null : unsigned(options.currentInputTick)
  if (options.lastMotionTick != null && previous === null || options.currentInputTick != null && current === null || options.historyAvailable != null && typeof options.historyAvailable !== 'boolean') return reject('INVALID_CONTEXT', '速度指定の入力tickまたは履歴の指定が不正です。')
  if (tick !== 0n && previous !== null && tick <= previous) return reject('STALE_MOTION', '既に処理した速度指定以前の入力tickです。')
  if (tick !== 0n && current !== null && tick > current) return reject('FUTURE_INPUT_TICK', 'まだ送信していない入力tickの速度です。')
  let reconciliation = 'packet_tick_only'
  if (tick === 0n) reconciliation = 'immediate'
  else if (current !== null && current === tick) reconciliation = 'current_tick'
  else if (options.historyAvailable === true) reconciliation = 'rewind_replay'
  else if (options.historyAvailable === false) reconciliation = 'immediate_without_history'
  const nextTick = tick === 0n ? previous : tick
  return {
    ...base,
    tick: String(tick),
    tickKnown: true,
    authoritativeFields: ['velocity', 'tick'],
    ordering: { kind: 'input_tick', tick: String(tick) },
    ...(nextTick === null ? {} : { nextMotionTick: String(nextTick) }),
    temporalScope: 'packet_tick',
    reconciliation,
    requiresReplay: reconciliation === 'rewind_replay',
    maySeedNow: ['immediate', 'current_tick', 'immediate_without_history'].includes(reconciliation)
  }
}

module.exports = { normalizeServerMotion }
