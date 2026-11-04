'use strict'

const { performance } = require('node:perf_hooks')

// Vanilla reference sequence: ClientReady(2) requests respawn; the server's
// ReadyToSpawn(1) supplies the destination; PlayerAction.Respawn completes it.
// References: Mojang RespawnPacket/PlayerRespawnState and the Bedrock adapter's
// health.js. Unlike that adapter, no invented {0,0,0} position is ever sent.
function createLifecycle ({ client, getState, version = '1.26.60', timeoutMs = 12000, actionFallbackMs = 5000, now = () => performance.now(), onRespawn = () => {}, onDeath = () => {}, onSpawnPending = () => {} }) {
  if (version !== '1.26.60') throw new Error('リスポーン処理は1.26.60専用です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function') throw new Error('リスポーンには接続と状態取得関数が必要です。')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(actionFallbackMs) || actionFallbackMs <= 0) throw new Error('リスポーンの待ち時間が不正です。')

  let runtimeId = null
  let hardcore = false
  let hardcoreKnown = false
  let health = null
  let healthSequence = 0
  let sequence = 0
  let deathId = 0
  let deathSequence = 0
  let aliveSignalSequence = 0
  let dead = false
  let lastPosition = null
  let ready = null
  let pending = null
  let lastResult = null
  let deathInfo = null
  let attempts = 0
  let phase = 'observing'
  let invalidInitialPosition = false
  let spawnPending = false

  const copyPosition = value => ({ x: value.x, y: value.y, z: value.z })
  const state = () => getState() ?? {}
  const currentId = () => runtimeId ?? state().runtimeEntityId
  const own = id => id != null && currentId() != null && String(id) === String(currentId())
  function validPosition (value) {
    if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(value[axis])) || Math.abs(value.x) > 30000000 || Math.abs(value.z) > 30000000) return false
    const dimension = state().dimension
    const bounds = dimension === 'nether' || dimension === 1 ? [-4, 132] : dimension === 'end' || dimension === 2 ? [-4, 260] : [-68, 324]
    return value.y >= bounds[0] && value.y <= bounds[1]
  }
  function rememberPosition (value, source) {
    if (!validPosition(value)) return null
    lastPosition = { position: copyPosition(value), source, sequence, time: now() }
    if (pending && sequence > pending.startedSequence) pending.confirmedPosition = lastPosition
    return lastPosition
  }
  function markDead () {
    if (dead) return
    dead = true
    deathId++
    deathSequence = sequence
    aliveSignalSequence = 0
    if (ready && now() - ready.time <= 2000) ready.deathId = deathId
    else ready = null
    phase = pending ? 'respawning' : 'dead'
    try { onDeath({ deathId, deathInfo: deathInfo ? structuredClone(deathInfo) : null }) } catch { /* Observation callbacks cannot alter protocol state. */ }
  }
  function observeHealth (value) {
    if (!Number.isFinite(value)) return
    health = value
    healthSequence = sequence
    if (value <= 0) markDead()
    else if (dead) {
      // BDS may restore health while it is only preparing ReadyToSpawn. Keep
      // the confirmed death latched until the handshake or an explicit spawn
      // event plus a fresh server position confirms the player is alive.
      phase = pending ? 'respawning' : 'awaiting_respawn_confirmation'
    } else if (!pending && !spawnPending) {
      phase = 'alive'
      ready = null
    }
  }
  function errorMessage (error) { return String(error?.message ?? error).slice(0, 300) }
  function fail (message, nextPhase = 'failed') {
    if (!pending) { phase = nextPhase; return }
    const attempt = pending
    pending = null
    clearTimeout(attempt.timeout)
    clearTimeout(attempt.fallback)
    phase = nextPhase
    lastResult = { phase: nextPhase, reason: message, deathId, clientReadySent: attempt.clientReadySent, actionSent: attempt.actionSent, serverReadyReceived: attempt.serverReady != null }
    attempt.reject(new Error(message))
  }
  function sendAction () {
    if (!pending || pending.actionSent) return
    const point = pending.serverReady?.position ?? lastPosition?.position
    if (!validPosition(point)) return
    const block = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }
    client.queue('player_action', { runtime_entity_id: BigInt(String(currentId())), action: 'respawn', position: block, result_position: { ...block }, face: -1 })
    pending.actionSent = true
    pending.actionSequence = sequence
    phase = 'awaiting_server_respawn'
  }
  function sendClientReady () {
    if (!pending || pending.clientReadySent) return
    const point = pending.serverReady?.position ?? lastPosition?.position
    if (!validPosition(point)) { phase = 'awaiting_server_position'; return }
    client.queue('respawn', { position: copyPosition(point), state: 2, runtime_entity_id: BigInt(String(currentId())) })
    pending.clientReadySent = true
    phase = 'awaiting_server_ready'
    if (pending.serverReady) sendAction()
  }
  function settle () {
    if (!pending || !pending.clientReadySent || health == null || health <= 0) return
    const confirmed = pending.confirmedPosition
    if (!confirmed || !validPosition(confirmed.position)) { phase = 'awaiting_server_position'; return }
    const freshHealth = healthSequence > pending.startedSequence
    const postAction = pending.actionSent && (healthSequence > pending.actionSequence || aliveSignalSequence > pending.actionSequence || (confirmed.sequence > pending.actionSequence && confirmed.source !== 'respawn'))
    const directServerMove = freshHealth && confirmed.sequence > pending.startedSequence && confirmed.source !== 'respawn'
    if (!(postAction && healthSequence > deathSequence) && !directServerMove) return
    const attempt = pending
    pending = null
    clearTimeout(attempt.timeout)
    clearTimeout(attempt.fallback)
    dead = false
    spawnPending = false
    phase = 'alive'
    ready = null
    lastResult = { phase: 'alive', health, position: copyPosition(confirmed.position), positionSource: confirmed.source, deathId, serverConfirmed: true }
    const result = structuredClone(lastResult)
    try { onRespawn(structuredClone(result)) } catch (error) { lastResult.callbackError = errorMessage(error) }
    attempt.resolve(result)
  }

  function respawn (options = {}) {
    if (pending) return pending.promise
    const current = state()
    if (!['spawned', 'dead', 'respawning'].includes(current.phase)) return Promise.reject(new Error('接続済みのワールドでのみリスポーンできます。'))
    if (hardcore) return Promise.reject(new Error('ハードコアのワールドでは自動リスポーンを要求しません。'))
    if (currentId() == null || !/^\d+$/.test(String(currentId())) || BigInt(String(currentId())) <= 0n) return Promise.reject(new Error('自分のプレイヤーIDがまだ不明です。'))
    if (health == null && Number.isFinite(current.health)) health = current.health
    if (Number.isFinite(current.health) && current.health <= 0) { health = current.health; markDead() }
    else if (current.dead === true) markDead()
    if (!dead && !spawnPending && !(health != null && health <= 0)) return Promise.reject(new Error('死亡を確認していないためリスポーンを要求しません。'))
    const waitMs = options.timeoutMs ?? timeoutMs
    if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 60000) return Promise.reject(new Error('リスポーン待ちは1〜60000msの範囲で指定してください。'))
    if (!lastPosition) {
      const serverPoint = current.serverPosition ?? (current.positionSource === 'client_prediction' ? null : current.position)
      rememberPosition(serverPoint, 'snapshot_server_position')
    }
    let resolve
    let reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const cachedReady = ready?.deathId === deathId ? ready : null
    pending = { promise, resolve, reject, startedSequence: sequence, clientReadySent: false, actionSent: false, actionSequence: null, serverReady: cachedReady, confirmedPosition: cachedReady, timeout: null, fallback: null }
    attempts++
    phase = 'respawning'
    pending.timeout = setTimeout(() => fail('制限時間内にサーバー座標と体力の回復を確認できませんでした。'), waitMs)
    // The BDS adapter also uses this bounded fallback if ReadyToSpawn is absent.
    pending.fallback = setTimeout(() => {
      try { sendAction() } catch (error) { fail(errorMessage(error)) }
    }, Math.min(actionFallbackMs, waitMs / 2))
    try { sendClientReady() } catch (error) { fail(errorMessage(error)) }
    return promise
  }

  function applyPacket (name, packet = {}) {
    sequence++
    if (name === 'close' || name === 'disconnect' || name === 'kick') {
      fail('接続が終了したためリスポーンを中止しました。', 'disconnected')
      return
    }
    if (name === 'start_game') {
      if (pending) fail('接続が切り替わったためリスポーンを中止しました。', 'disconnected')
      runtimeId = packet.runtime_entity_id == null ? null : String(packet.runtime_entity_id)
      hardcore = packet.hardcore === true
      hardcoreKnown = typeof packet.hardcore === 'boolean'
      health = null; healthSequence = 0; deathSequence = 0; aliveSignalSequence = 0; dead = false; ready = null; lastPosition = null; deathInfo = null; phase = 'observing'
      invalidInitialPosition = !validPosition(packet.player_position)
      spawnPending = false
      rememberPosition(packet.player_position, name)
      return
    }
    if (name === 'death_info') {
      deathInfo = { cause: String(packet.cause ?? '').slice(0, 200), messages: (Array.isArray(packet.messages) ? packet.messages : []).slice(0, 8).map(message => String(message).slice(0, 200)) }
      return
    }
    if (name === 'update_attributes' && own(packet.runtime_entity_id)) {
      const attribute = packet.attributes?.find(value => value.name === 'minecraft:health')
      if (attribute) observeHealth(attribute.current)
    } else if (name === 'set_health') {
      observeHealth(packet.health)
    } else if (name === 'entity_event' && own(packet.runtime_entity_id)) {
      if (packet.event_id === 'death_animation' || packet.event_id === 3) { health = 0; healthSequence = sequence; markDead() }
      else if (packet.event_id === 'respawn' || packet.event_id === 18) aliveSignalSequence = sequence
    } else if (name === 'respawn') {
      const searching = packet.state === 0 || packet.state === 'searching_for_spawn' || packet.state === 'SearchingForSpawn'
      const localOrZero = own(packet.runtime_entity_id) || packet.runtime_entity_id == null || String(packet.runtime_entity_id) === '0'
      // BDS can reconnect a dead player with a positive health attribute and
      // an out-of-world start_game placeholder, followed by local searching
      // and ready packets with runtime ID zero. Neither health nor that initial
      // placeholder proves the player has already respawned.
      if (!dead && !spawnPending && !pending && invalidInitialPosition && lastPosition === null && localOrZero && searching) {
        spawnPending = true
        phase = 'awaiting_spawn_confirmation'
        try { onSpawnPending() } catch { /* Observation callbacks cannot alter protocol state. */ }
      }
      // Respawn is local-player context. Some servers leave its runtime ID at 0;
      // permit that only during a death/respawn, never for other nonzero actors.
      const currentHealth = state().health
      const localContext = own(packet.runtime_entity_id) || ((packet.runtime_entity_id == null || String(packet.runtime_entity_id) === '0') && (dead || spawnPending || pending || (Number.isFinite(currentHealth) && currentHealth <= 0)))
      if (!localContext) return
      const isReady = packet.state === 1 || packet.state === 'ready_to_spawn' || packet.state === 'ReadyToSpawn'
      // SearchingForSpawn(0) may carry a placeholder, not a destination.
      // It must never become the successful respawn's physical position.
      const record = isReady ? rememberPosition(packet.position, name) : null
      if (isReady && record) {
        ready = { ...record, deathId }
        if (pending) {
          pending.serverReady = ready
          pending.confirmedPosition = ready
          try { sendClientReady(); sendAction() } catch (error) { fail(errorMessage(error)) }
        }
      }
    } else if (name === 'move_player' && own(packet.runtime_id)) {
      rememberPosition(packet.position, name)
    } else if (name === 'correct_player_move_prediction' || name === 'server_post_move' || name === 'change_dimension') {
      rememberPosition(packet.position, name)
    }
    if (pending && !pending.clientReadySent) {
      try { sendClientReady() } catch (error) { fail(errorMessage(error)) }
    }
    settle()
    if (!pending && dead && health > 0 && healthSequence > deathSequence && aliveSignalSequence > deathSequence && lastPosition?.sequence > deathSequence) {
      // Immediate-respawn worlds can complete without a client request. Ready
      // plus health alone is insufficient; an explicit server respawn event is
      // required before adopting this as an automatic successful recovery.
      dead = false
      phase = 'alive'
      ready = null
      lastResult = { phase: 'alive', health, position: copyPosition(lastPosition.position), positionSource: lastPosition.source, deathId, serverConfirmed: true, automatic: true }
      try { onRespawn(structuredClone(lastResult)) } catch (error) { lastResult.callbackError = errorMessage(error) }
    }
  }

  function stop (reason = 'リスポーンを中止しました。') { fail(reason, 'stopped') }
  function stats () {
    return {
      phase, dead, health, hardcore, hardcoreKnown, spawnPending, runtimeEntityId: currentId() == null ? null : String(currentId()), attempts,
      pending: pending !== null, clientReadySent: pending?.clientReadySent ?? false, actionSent: pending?.actionSent ?? false,
      serverReadyReceived: pending?.serverReady != null, deathId,
      readyPosition: ready ? copyPosition(ready.position) : null,
      deathInfo: deathInfo ? structuredClone(deathInfo) : null,
      lastServerPosition: lastPosition ? copyPosition(lastPosition.position) : null,
      lastResult: lastResult ? structuredClone(lastResult) : null
    }
  }
  return { applyPacket, respawn, stop, stats }
}

module.exports = { createLifecycle }
