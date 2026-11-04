'use strict'

const { resourceMinHealth } = require('./learning-health')

const { performance } = require('node:perf_hooks')
const { buildStationaryInput } = require('./input')

// A deliberately limited prediction probe: one block on known, full, level
// ground. This is not a general Bedrock physics or pathfinding implementation.
// Mojang PlayerMovementOverview requires client prediction; absence of a
// correction is not an acknowledgement. Verify the saved position on reconnect.
const EYE_HEIGHT = 1.62
const STEP = 0.05
const INTENT = 0.25
const GROUND_DRAG = 0.546
const SUPPORT = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite'])
const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'fern', 'deadbush'])
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const copy = value => ({ x: value.x, y: value.y, z: value.z })

function finitePosition (value) {
  return value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
}

function createWalker ({ client, getState, world, startGame, version, startGameReceivedAt = performance.now(), now = () => performance.now(), onError = () => {} }) {
  if (version !== '1.26.60') throw new Error('平地歩行の検証は1.26.60専用です。')
  let baseTick
  try { baseTick = BigInt(startGame.current_tick) } catch { throw new Error('歩行の開始tickが不明です。') }
  if (baseTick < 0n || !Number.isFinite(startGameReceivedAt)) throw new Error('歩行のtickアンカーが不正です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof world?.getBlock !== 'function') throw new Error('歩行には接続と既知の地形が必要です。')
  let timer = null
  let predicted = null
  let plan = null
  let remaining = 0
  let velocity = 0
  let braking = 0
  let lastTick = null
  let lastTime = null
  let sent = 0
  let yaw = 0
  let direction = null
  let serverSignature = null
  let status = { phase: 'idle', predictedPosition: null, serverPosition: null, target: null, sent: 0, reason: null, serverConfirmed: false }

  function stateForWalking () {
    const state = getState()
    if (state.phase !== 'spawned' || !finitePosition(state.position)) throw new Error('ワールド参加と位置取得が必要です。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('平地歩行はサバイバル専用です。')
    if (!Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new Error('体力が少ないか不明のため歩行できません。')
    return state
  }

  function clearAt (position) {
    const feetY = position.y - EYE_HEIGHT
    const baseY = Math.round(feetY)
    if (Math.abs(feetY - baseY) > 0.05) throw new Error('整数の高さの平地に立っている必要があります。')
    // Full player footprint (0.6 wide), not just the centre column.
    for (let x = Math.floor(position.x - 0.3 + 1e-6); x <= Math.floor(position.x + 0.3 - 1e-6); x++) {
      for (let z = Math.floor(position.z - 0.3 + 1e-6); z <= Math.floor(position.z + 0.3 - 1e-6); z++) {
        const support = world.getBlock(x, baseY - 1, z)
        if (!support.known || !SUPPORT.has(nameOf(support)) || support.boundingBox !== 'block' || support.extra?.length) throw new Error('通路の地面が未取得・段差・危険な地面です。')
        for (let y = baseY; y <= Math.floor(baseY + 1.8 - 1e-6); y++) {
          const block = world.getBlock(x, y, z)
          if (!block.known || !PASSABLE.has(nameOf(block)) || block.boundingBox !== 'empty' || block.extra?.length) throw new Error('通路に障害物・液体・未取得のブロックがあります。')
        }
      }
    }
  }

  function preview (target) {
    const errors = []
    let result = null
    try {
      const state = stateForWalking()
      const origin = copy(state.position)
      if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.z)) throw new Error('歩行先のx/zを指定してください。')
      if (target.y != null && Math.abs(target.y - origin.y) > 0.05) throw new Error('高さの違う歩行先には対応していません。')
      const destination = { x: target.x, y: origin.y, z: target.z }
      const distance = Math.hypot(destination.x - origin.x, destination.z - origin.z)
      if (distance < 0.1 || distance > 3.001) throw new Error('平地歩行は0.1〜3ブロック以内です。')
      const dx = (destination.x - origin.x) / distance
      const dz = (destination.z - origin.z) / distance
      // Include a small braking margin, checking every 0.05 block.
      for (let travelled = 0; travelled <= distance + 0.15 + 1e-6; travelled += STEP) {
        clearAt({ x: origin.x + dx * travelled, y: origin.y, z: origin.z + dz * travelled })
      }
      result = { origin, target: destination, distance, direction: { x: dx, z: dz } }
    } catch (error) { errors.push(error.message) }
    return { ready: errors.length === 0, ...result, errors, serverConfirmed: false, limit: 'flat-ground-three-blocks' }
  }

  function signature (state) {
    return `${state.positionUpdatedAt ?? ''}:${state.position.x},${state.position.y},${state.position.z}`
  }

  function send (moving, distance = 0) {
    const state = stateForWalking()
    if (state.dimension !== plan.dimension) throw new Error('次元が変わったため停止します。')
    if (signature(state) !== serverSignature) throw new Error('サーバーから位置更新を受信したため、再確認が必要です。')
    const time = now()
    if (lastTime !== null && time - lastTime > 150) throw new Error('入力周期が遅れたため歩行を停止しました。')
    const candidate = { x: predicted.x + direction.x * distance, y: predicted.y, z: predicted.z + direction.z * distance }
    clearAt(candidate)
    const wallTick = baseTick + BigInt(Math.max(0, Math.floor((time - startGameReceivedAt) / 50)))
    const tick = lastTick === null || wallTick > lastTick ? wallTick : lastTick + 1n
    const packet = buildStationaryInput({ position: candidate, pitch: 0, yaw, tick })
    packet.input_data = moving ? ['up', 'vertical_collision'] : ['vertical_collision']
    packet.input_mode = 'game_pad'
    packet.move_vector = { x: 0, z: moving ? INTENT : 0 }
    packet.analogue_move_vector = { ...packet.move_vector }
    packet.raw_move_vector = { ...packet.move_vector }
    packet.delta = { x: direction.x * distance, y: -0.0784, z: direction.z * distance }
    client.queue('player_auth_input', packet)
    predicted = candidate
    lastTick = tick
    lastTime = time
    sent++
    status.predictedPosition = copy(predicted)
    status.sent = sent
  }

  function stop (reason = '歩行を停止しました。') {
    if (timer) clearInterval(timer)
    const wasWalking = status.phase === 'walking'
    timer = null
    if (wasWalking && predicted) {
      try { send(false) } catch { /* Connection/correction may make a final input unsafe. */ }
    }
    status.phase = 'stopped'
    status.reason = reason
    return snapshot()
  }

  function fail (error) {
    stop(error.message)
    status.phase = 'failed'
    onError(error)
  }

  function advance () {
    if (status.phase !== 'walking') return
    try {
      if (remaining > 1e-6) {
        const distance = Math.min(STEP, remaining)
        send(true, distance)
        remaining -= distance
        velocity = distance
      } else if (braking < 4) {
        velocity *= GROUND_DRAG
        send(false, velocity)
        braking++
      } else {
        send(false)
        clearInterval(timer)
        timer = null
        status.phase = 'awaiting_server_confirmation'
        status.reason = '予測位置への入力送信が終了しました。再接続後のサーバー保存位置で確認してください。'
      }
    } catch (error) { fail(error) }
  }

  function start (target) {
    if (timer) throw new Error('すでに歩行中です。')
    const candidate = preview(target)
    if (!candidate.ready) throw new Error(candidate.errors.join('\n'))
    const state = stateForWalking()
    plan = { ...candidate, dimension: state.dimension }
    predicted = copy(candidate.origin)
    direction = candidate.direction
    remaining = candidate.distance
    yaw = Math.atan2(-direction.x, direction.z) * 180 / Math.PI
    braking = 0
    velocity = 0
    lastTime = null
    serverSignature = signature(state)
    status = { phase: 'walking', predictedPosition: copy(predicted), serverPosition: copy(state.position), target: copy(candidate.target), sent, reason: null, serverConfirmed: false }
    advance()
    if (status.phase === 'walking') timer = setInterval(advance, 50)
    return snapshot()
  }

  function applyPacket (name, packet) {
    if (!timer) return
    const state = getState()
    if (name === 'move_player' && String(packet.runtime_id) !== state.runtimeEntityId) return
    if (!['move_player', 'correct_player_move_prediction', 'server_post_move', 'change_dimension', 'respawn'].includes(name)) return
    if (name === 'respawn' && String(packet.runtime_entity_id) !== state.runtimeEntityId) return
    if (finitePosition(packet.position)) status.serverPosition = copy(packet.position)
    // An authoritative position update must not be answered with our old prediction.
    status.phase = 'server_update'
    stop('サーバーの位置更新を受信したため歩行を停止しました。位置を再確認してください。')
  }

  function snapshot () { return structuredClone(status) }
  return { preview, start, stop, applyPacket, snapshot, stats: snapshot }
}

module.exports = { createWalker }
