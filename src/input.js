'use strict'

const VERSION = '1.26.60'
const ACTIONS = new Set(['start_break', 'continue_break', 'abort_break', 'stop_break'])
const INTERVAL_MS = 50
const PAYLOAD_FLAGS = new Set(['block_action', 'item_interact', 'item_stack_request', 'client_predicted_vehicle'])

function finiteVector (value, label) {
  if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))) {
    throw new Error(`${label}には有限のx/y/z座標が必要です。`)
  }
  return { x: value.x, y: value.y, z: value.z }
}

function blockPosition (value) {
  const position = finiteVector(value, 'ブロック')
  if (!Object.values(position).every(number => Number.isInteger(number) && number >= -2147483648 && number <= 2147483647)) {
    throw new Error('ブロック座標は32ビットの整数で指定してください。')
  }
  return position
}

function validatePhysicsState (value) {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('physicsStateはデータオブジェクトで指定してください。')
  const seen = new Set()
  function visit (current, depth) {
    if (typeof current === 'number' && !Number.isFinite(current)) throw new Error('physicsStateに有限でない数値があります。')
    if (typeof current === 'function' || typeof current === 'symbol') throw new Error('physicsStateにはデータだけを指定してください。')
    if (current == null || typeof current !== 'object') return
    if (depth > 16 || seen.has(current)) throw new Error('physicsStateの循環または深すぎるデータは使えません。')
    seen.add(current)
    for (const child of Object.values(current)) visit(child, depth + 1)
    seen.delete(current)
  }
  visit(value, 0)
}

function buildStationaryInput ({ position, pitch, yaw, tick, actions = [] }) {
  position = finiteVector(position, 'プレイヤー位置')
  if (!Number.isFinite(pitch) || !Number.isFinite(yaw) || pitch < -90 || pitch > 90) {
    throw new Error('視線のpitch/yawが不正です。')
  }
  if (typeof tick !== 'bigint' || tick < 0n) throw new Error('入力tickは0以上のBigIntで指定してください。')
  const yawRadians = yaw * Math.PI / 180
  const pitchRadians = pitch * Math.PI / 180
  return {
    pitch,
    yaw,
    position,
    move_vector: { x: 0, z: 0 },
    head_yaw: yaw,
    input_data: actions.length ? ['block_action'] : [],
    input_mode: 'mouse',
    play_mode: 'normal',
    interaction_model: 'crosshair',
    interact_rotation: { x: pitch, z: yaw },
    tick,
    delta: { x: 0, y: 0, z: 0 },
    transaction: null,
    item_stack_request: null,
    block_action: actions.length ? actions : null,
    vehicle_rotation: null,
    predicted_vehicle: null,
    analogue_move_vector: { x: 0, z: 0 },
    camera_orientation: {
      x: -Math.sin(yawRadians) * Math.cos(pitchRadians),
      y: -Math.sin(pitchRadians),
      z: Math.cos(yawRadians) * Math.cos(pitchRadians)
    },
    raw_move_vector: { x: 0, z: 0 }
  }
}

function createInput ({ client, getState, version, startGame, startGameReceivedAt, clock = () => performance.now(), frameProvider, onQueuedFrame = null, getQueuedCursor = null, onError = () => {} }) {
  if (version !== VERSION) throw new Error(`入力操作は ${VERSION} 専用です。現在のバージョンでは送信しません。`)
  if (startGame?.server_authoritative_block_breaking !== true) {
    throw new Error('サーバー権威のブロック破壊が確認できないため入力を送信しません。')
  }
  const effectiveMode = startGame.player_gamemode === 'fallback' || startGame.player_gamemode === 5
    ? startGame.world_gamemode
    : startGame.player_gamemode
  if (effectiveMode !== 'survival' && effectiveMode !== 0) {
    throw new Error('現在の入力操作はサバイバルモード専用です。')
  }
  if (typeof client?.queue !== 'function' || typeof getState !== 'function') {
    throw new Error('入力操作には接続済みクライアントと状態取得関数が必要です。')
  }
  if (frameProvider != null && typeof frameProvider !== 'function') throw new Error('frameProviderは同期関数で指定してください。')
  if (onQueuedFrame !== null && typeof onQueuedFrame !== 'function') throw new Error('onQueuedFrame must be a synchronous callback')
  if (getQueuedCursor !== null && typeof getQueuedCursor !== 'function') throw new Error('getQueuedCursor must be a synchronous callback')
  const frameFlags = frameProvider ? new Set(Object.values(require('minecraft-data')(`bedrock_${version}`).protocol.types.InputData[1].mappings)) : null
  let tick
  try { tick = BigInt(startGame.current_tick) } catch { throw new Error('開始tickを取得できませんでした。') }
  if (tick < 0n) throw new Error('開始tickは0以上である必要があります。')
  const initialTick = tick
  const receivedAt = startGameReceivedAt ?? clock()
  if (!Number.isFinite(receivedAt)) throw new Error('開始tickの受信時刻が不正です。')
  let timer = null
  let timerGeneration = 0
  let desiredRotation = null
  let actions = []
  let transaction = null
  let transactionSent = null
  let activeTarget = null
  let lastError = null
  let sent = 0
  const receiptMismatches = []
  const diagnosticMoment = () => ({ wallMs: Date.now(), monotonicMs: performance.now() })
  const diagnosticText = (value, limit) => ['string', 'number', 'bigint'].includes(typeof value) ? String(value).replace(/[\u0000-\u001f]/g, '?').slice(0, limit) : null
  const diagnosticTick = value => value == null ? null : diagnosticText(value, 24)
  function rememberReceiptMismatch (state, timing, cursor, localTick, wallTick, requestedTick, actualTick) {
    const life = state.lifecycle?.deathId ?? state.deathId
    const elapsed = (a, b) => a && b ? Math.max(0, b.monotonicMs - a.monotonicMs) : null
    const identity = { profile: diagnosticText(state.profile, 16), realmId: diagnosticText(state.realm?.id, 24), connectionId: diagnosticText(state.connectionId, 36), startedAt: diagnosticText(state.startedAt, 24), runtimeEntityId: diagnosticText(state.runtimeEntityId, 20), dimension: diagnosticText(state.dimension, 12), deathId: Number.isSafeInteger(life) && life >= 0 ? life : null, source: diagnosticText(state.positionSource, 24), rawStamp: diagnosticText(state.rawServerPositionUpdatedAt ?? (state.positionSource !== 'client_prediction' ? state.positionUpdatedAt : null), 32), modelStamp: diagnosticText(state.positionUpdatedAt, 32) }
    receiptMismatches.push({ at: diagnosticMoment(), timerGeneration, localTickBefore: diagnosticTick(localTick), wallTick: diagnosticTick(wallTick), requestedTick: diagnosticTick(requestedTick), actualReceiptTick: diagnosticTick(actualTick), cursorBeforeBatch: cursor ? { tick: diagnosticTick(cursor.tick), queuedAt: cursor.queuedAt, readAt: cursor.readAt, ageMs: cursor.ageMs } : null, identity, timing, durationsMs: { frameProvider: elapsed(timing.providerBefore, timing.providerAfter), queue: elapsed(timing.queueBefore, timing.queueAfter), onQueuedFrame: elapsed(timing.callbackBefore, timing.callbackAfter), total: elapsed(timing.emitBefore, timing.callbackAfter ?? timing.queueAfter) } })
    while (receiptMismatches.length > 4 || Buffer.byteLength(JSON.stringify(receiptMismatches), 'utf8') > 7680) receiptMismatches.shift()
  }

  function currentState () {
    const state = getState()
    if (state?.phase !== 'spawned') throw new Error('ワールド参加完了後に入力を開始してください。')
    if (state.spawnPending) throw new Error('参加位置をサーバーで確認するまで通常入力を停止します。')
    if (state.gameMode != null && state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('サバイバルモード以外では入力を停止します。')
    finiteVector(state.position, 'プレイヤー位置')
    if (state.health != null && state.health <= 0) throw new Error('プレイヤーが倒れたため入力を停止します。')
    return state
  }

  const cursorFailure = message => Object.assign(new Error(message), { frameProviderFailure: true })
  function queuedCursor () {
    if (!getQueuedCursor) return null
    const cursor = getQueuedCursor()
    if (cursor == null) return null
    let sentTick
    try { sentTick = BigInt(cursor.tick) } catch { throw cursorFailure('Queued input cursor is invalid') }
    if (sentTick < 0n || !Number.isFinite(cursor.queuedAt)) throw cursorFailure('Queued input cursor is invalid')
    const readAt = Date.now()
    const age = readAt - cursor.queuedAt
    if (!Number.isFinite(age) || age < 0 || age > 200) throw cursorFailure('Queued input handoff timer stalled')
    return { tick: sentTick, queuedAt: cursor.queuedAt, readAt, ageMs: age }
  }

  function emit (pending, packedTransaction = null, onTransactionSent = null, requestedTick = null, cursorBeforeBatch = null) {
    const timing = { emitBefore: diagnosticMoment(), providerBefore: null, providerAfter: null, queueBefore: null, queueAfter: null, callbackBefore: null, callbackAfter: null }
    const localTickBefore = tick
    const state = currentState()
    const rotation = desiredRotation ?? state.rotation
    if (!rotation) throw new Error('プレイヤーの視線を取得できませんでした。')
    const elapsedMs = clock() - receivedAt
    if (!Number.isFinite(elapsedMs)) throw new Error('入力時刻を取得できませんでした。')
    const currentTick = initialTick + BigInt(Math.floor(Math.max(0, elapsedMs) / INTERVAL_MS))
    const nextTick = requestedTick ?? (tick + 1n > currentTick ? tick + 1n : currentTick)
    let position = state.position
    let delta = { x: 0, y: 0, z: 0 }
    let providedFrame = null
    const flags = new Set()
    if (frameProvider) {
      try {
        timing.providerBefore = diagnosticMoment()
        const frame = frameProvider({ state: structuredClone(state), rotation: { pitch: rotation.pitch, yaw: rotation.yaw }, tick: nextTick })
        timing.providerAfter = diagnosticMoment()
        if (frame && typeof frame.then === 'function') {
          Promise.resolve(frame).catch(() => {})
          throw new Error('frameProviderは同期した入力データを返す必要があります。')
        }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('frameProviderは同期した入力データを返す必要があります。')
        providedFrame = frame
        position = finiteVector(frame.position, '予測位置')
        delta = finiteVector(frame.delta, '予測速度')
        validatePhysicsState(frame.physicsState)
        validatePhysicsState(frame.predictedState)
        if (frame.commitPrediction != null && typeof frame.commitPrediction !== 'function') throw new Error('commitPrediction must be a synchronous callback')
        if (frame.inputFlags != null && !Array.isArray(frame.inputFlags)) throw new Error('inputFlagsは文字列の配列で指定してください。')
        for (const flag of frame.inputFlags ?? []) {
          if (typeof flag !== 'string' || !frameFlags.has(flag)) throw new Error('inputFlagsに未対応のフラグがあります。')
          if (!PAYLOAD_FLAGS.has(flag)) flags.add(flag)
        }
        const physical = frame.physicsState ?? frame.predictedState
        if (physical?.onGround === true || physical?.isCollidedVertically === true) flags.add('vertical_collision')
        if (physical?.isCollidedHorizontally === true) flags.add('horizontal_collision')
      } catch (error) {
        const failure = new Error(error?.message ?? String(error))
        failure.frameProviderFailure = true
        throw failure
      }
    }
    const packet = buildStationaryInput({ position, pitch: rotation.pitch, yaw: rotation.yaw, tick: nextTick, actions: pending })
    packet.delta = delta
    for (const flag of flags) if (!packet.input_data.includes(flag)) packet.input_data.push(flag)
    if (packedTransaction) {
      packet.transaction = packedTransaction
      packet.input_data.push('item_interact')
    }
    timing.queueBefore = diagnosticMoment()
    const receipt = client.queue('player_auth_input', packet)
    timing.queueAfter = diagnosticMoment()
    if (onQueuedFrame) {
      timing.callbackBefore = diagnosticMoment()
      try {
        onQueuedFrame({ tick: receipt?.tick ?? null, receiptConfirmed: receipt?.tick != null, controls: structuredClone(providedFrame?.controls ?? providedFrame?.predictedState?.controls ?? providedFrame?.physicsState?.controls ?? {}), yaw: rotation.yaw, pitch: rotation.pitch, predictedState: structuredClone(providedFrame?.predictedState ?? providedFrame?.physicsState ?? null), packetPosition: { ...packet.position }, health: state.health, queuedAt: Date.now(), modeled: providedFrame?.predictedState != null || providedFrame?.physicsState != null, producer: 'input' })
      } catch { /* Prediction evidence cannot change the already queued input. */ }
      timing.callbackAfter = diagnosticMoment()
    }
    if (getQueuedCursor) {
      let actualTick
      try { actualTick = receipt?.tick == null ? null : BigInt(receipt.tick) } catch { actualTick = null }
      if (actualTick !== nextTick) {
        try { rememberReceiptMismatch(state, timing, cursorBeforeBatch, localTickBefore, currentTick, nextTick, actualTick) } catch { /* Diagnostics cannot change the existing rejection. */ }
        throw cursorFailure('Queued input receipt does not cover the simulated tick')
      }
    }
    providedFrame?.commitPrediction?.()
    if (packedTransaction && onTransactionSent) {
      try { onTransactionSent() } catch (error) { lastError = error.message }
    }
    tick = nextTick
    sent++
    for (const action of pending) {
      if (action.action === 'start_break' || action.action === 'continue_break') activeTarget = action
      else activeTarget = null
    }
  }

  function stop (sendAbort = true) {
    if (timer !== null) clearInterval(timer)
    timerGeneration++
    const wasRunning = timer !== null
    timer = null
    actions = []
    transaction = null
    transactionSent = null
    if (sendAbort && wasRunning && activeTarget) {
      try {
        const pending = [{ ...activeTarget, action: 'abort_break' }]
        const cursor = queuedCursor()
        if (cursor) emitCursorFrames(cursor, () => ({ pending }), true)
        else emit(pending)
      } catch (error) { lastError = error.message }
    }
    activeTarget = null
  }

  function fail (error) {
    lastError = error.message
    // A failed physics provider must not be called a second time just to emit
    // abort_break using another potentially unsafe prediction.
    stop(error.frameProviderFailure !== true)
    onError(error)
  }

  function release () {
    actions = []
    transaction = null
    transactionSent = null
    if (timer !== null && activeTarget) actions.push({ ...activeTarget, action: 'abort_break', position: { ...activeTarget.position } })
  }

  function emitCursorFrames (cursor, takePending, force = false) {
    const elapsedMs = clock() - receivedAt
    if (!Number.isFinite(elapsedMs)) throw cursorFailure('Queued input time is invalid')
    const targetTick = initialTick + BigInt(Math.floor(Math.max(0, elapsedMs) / INTERVAL_MS))
    const elapsed = targetTick - cursor.tick
    const due = force && elapsed <= 0n ? 1n : elapsed
    if (due > 4n) throw cursorFailure('Too many queued input handoff ticks were missed')
    if (due <= 0n) return
    for (let count = 1n; count < due; count++) emit([], null, null, cursor.tick + count, cursor)
    const { pending, packedTransaction = null, onTransactionSent = null } = takePending()
    emit(pending, packedTransaction, onTransactionSent, cursor.tick + due, cursor)
  }

  function flush () {
    const cursor = queuedCursor()
    if (cursor) {
      emitCursorFrames(cursor, () => {
        const pending = actions; const packedTransaction = transaction; const onTransactionSent = transactionSent
        actions = []; transaction = null; transactionSent = null
        return { pending, packedTransaction, onTransactionSent }
      })
      return
    }
    const pending = actions
    actions = []
    const packedTransaction = transaction
    const onTransactionSent = transactionSent
    transaction = null
    transactionSent = null
    emit(pending, packedTransaction, onTransactionSent)
  }

  function start () {
    if (timer !== null) return
    currentState()
    lastError = null
    try { flush() } catch (error) { fail(error); throw error }
    const generation = ++timerGeneration
    timer = setInterval(() => {
      if (timer === null || generation !== timerGeneration) return
      try { flush() } catch (error) { fail(error) }
    }, INTERVAL_MS)
  }

  function sendAction (action, position, face = 1, { hitPoint } = {}) {
    if (timer === null) throw new Error('ブロック操作の前に入力送信を開始してください。')
    if (!ACTIONS.has(action)) throw new Error('対応していないブロック操作です。')
    if (!Number.isInteger(face) || face < 0 || face > 5) throw new Error('ブロック面は0〜5で指定してください。')
    position = blockPosition(position)
    const state = currentState()
    // A validated visible face may be closer than the cube centre. The mining
    // controller additionally verifies the complete ray against live terrain.
    let reach = { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 }
    if (hitPoint != null) {
      reach = finiteVector(hitPoint, '採掘面の交点')
      const axis = face <= 1 ? 'y' : face <= 3 ? 'z' : 'x'
      const plane = position[axis] + Number(face % 2 === 1)
      if (Math.abs(reach[axis] - plane) > 1e-5 || ['x', 'y', 'z'].some(key => reach[key] < position[key] - 1e-5 || reach[key] > position[key] + 1 + 1e-5)) throw new Error('交点が指定されたブロック面にありません。')
    }
    const distance = Math.hypot(reach.x - state.position.x, reach.y - state.position.y, reach.z - state.position.z)
    if (distance > 4.5) throw new Error('対象ブロックが採掘範囲外です。')
    const followsRelease = action === 'start_break' && actions.length === 1 && actions[0].action === 'abort_break'
    if (actions.length && !followsRelease) throw new Error('前のブロック操作が送信されるまで待ってください。')
    actions.push({ action, position, face })
  }

  function lookAt (target) {
    target = finiteVector(target, '注視点')
    const position = currentState().position
    const dx = target.x - position.x
    const dy = target.y - position.y
    const dz = target.z - position.z
    const horizontal = Math.hypot(dx, dz)
    if (horizontal === 0 && dy === 0) throw new Error('注視点がプレイヤー位置と一致しています。')
    desiredRotation = {
      pitch: -Math.atan2(dy, horizontal) * 180 / Math.PI,
      yaw: Math.atan2(-dx, dz) * 180 / Math.PI
    }
    return { ...desiredRotation }
  }

  function sendTransaction (value, { onSent } = {}) {
    if (timer === null) throw new Error('アイテム操作の前に入力送信を開始してください。')
    currentState()
    if (!value || typeof value !== 'object' || !value.data || !value.legacy || !Array.isArray(value.actions)) throw new Error('正規のアイテム操作データが必要です。')
    if (transaction) throw new Error('前のアイテム操作の送信を待ってください。')
    transaction = structuredClone(value)
    if (onSent != null && typeof onSent !== 'function') { transaction = null; throw new Error('送信通知は関数で指定してください。') }
    transactionSent = onSent ?? null
  }

  return {
    start,
    stop,
    release,
    sendAction,
    lookAt,
    sendTransaction,
    stats: () => ({ running: timer !== null, tick: String(tick), sent, queuedActions: actions.length, target: activeTarget ? structuredClone(activeTarget.position) : null, rotation: desiredRotation ? { ...desiredRotation } : null, lastError, receiptMismatches: structuredClone(receiptMismatches) })
  }
}

module.exports = { buildStationaryInput, createInput }
