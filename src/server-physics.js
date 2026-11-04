'use strict'

// Mojang v1.26.60, commit 0879ab5c4c70be1bd520e32a8c49ea4a155616d6:
// json/CorrectPlayerMovePredictionPacketPayload.json describes Pos Delta as
// corrected velocity. It is not an offset to add to Pos. Player corrections do
// not supply player rotation; the rotation fields describe predicted vehicles.
// https://raw.githubusercontent.com/Mojang/bedrock-protocol-docs/0879ab5c4c70be1bd520e32a8c49ea4a155616d6/json/CorrectPlayerMovePredictionPacketPayload.json
// Rewind/current/no-history semantics follow additional_docs/PlayerMovementOverview.md
// in that same revision. This module only normalizes received observations.
const SOURCE = 'correct_player_move_prediction'
const MAX_TICK = (1n << 64n) - 1n
const vector = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis])) ? { x: value.x, y: value.y, z: value.z } : null

function tickValue (value) {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value)) && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  try { const tick = BigInt(value); return tick >= 0n && tick <= MAX_TICK ? tick : null } catch { return null }
}

function normalizePlayerCorrection (packet, { version = '1.26.60', lastCorrectionTick, currentInputTick, historyAvailable } = {}) {
  const reject = (code, reason) => ({ accepted: false, source: SOURCE, code, reason })
  if (version !== '1.26.60') return reject('UNSUPPORTED_VERSION', '補正の正規化は1.26.60の形式に限定しています。')
  if (!packet || typeof packet !== 'object') return reject('INVALID_PACKET', '補正パケットがありません。')
  if (packet.prediction_type === 'vehicle' || packet.prediction_type === 1) return reject('VEHICLE_CORRECTION', '乗り物への補正をプレイヤーの物理状態として扱えません。')
  if (packet.prediction_type !== 'player' && packet.prediction_type !== 0) return reject('UNKNOWN_PREDICTION_TYPE', 'プレイヤーへの補正であることを確認できません。')
  const position = vector(packet.position)
  const velocity = vector(packet.delta)
  if (!position || !velocity || typeof packet.on_ground !== 'boolean') return reject('INCOMPLETE_CORRECTION', '位置・速度・接地状態の有限な実データが必要です。')
  const tick = tickValue(packet.tick)
  if (tick === null) return reject('INVALID_TICK', '補正対象の入力tickを確認できません。')
  const previous = lastCorrectionTick == null ? null : tickValue(lastCorrectionTick)
  const current = currentInputTick == null ? null : tickValue(currentInputTick)
  if (lastCorrectionTick != null && previous === null || currentInputTick != null && current === null || historyAvailable != null && typeof historyAvailable !== 'boolean') return reject('INVALID_CONTEXT', '補正順序または入力履歴の指定が不正です。')
  // Zero tick is an immediate packet under Mojang's receiving rule, rather
  // than an older historical input frame. Never discard it merely for being 0.
  if (tick !== 0n && previous !== null && tick <= previous) return reject('STALE_CORRECTION', '既に処理した補正以前の入力tickです。')
  if (tick !== 0n && current !== null && tick > current) return reject('FUTURE_INPUT_TICK', 'まだ送信していない入力tickへの補正は現在のseedに使えません。')

  let reconciliation = 'packet_tick_only'
  if (tick === 0n) reconciliation = 'immediate'
  else if (current !== null && tick === current) reconciliation = 'current_tick'
  else if (historyAvailable === true) reconciliation = 'rewind_replay'
  else if (historyAvailable === false) reconciliation = 'immediate_without_history'
  return {
    accepted: true,
    source: SOURCE,
    position,
    velocity,
    velocitySource: 'server_correction',
    onGround: packet.on_ground,
    tick: String(tick),
    authoritativeFields: ['position', 'velocity', 'onGround', 'tick'],
    temporalScope: 'packet_tick',
    reconciliation,
    requiresReplay: reconciliation === 'rewind_replay',
    maySeedNow: ['immediate', 'current_tick', 'immediate_without_history'].includes(reconciliation)
  }
}

module.exports = { normalizePlayerCorrection }
