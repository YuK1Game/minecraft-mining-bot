'use strict'

// Bedrock correction T describes the state AFTER input T. Replaying starts at
// T+1 and emits no packets. Raw observations remain separate from predictions.
// https://github.com/Mojang/bedrock-protocol-docs/blob/main/additional_docs/PlayerMovementOverview.md
const MAX_TICK = (1n << 64n) - 1n
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const { finitePoint: finite } = require('./vec3')
const copy = value => structuredClone(value)
function tickOf (value) {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value)) && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  try { const n = BigInt(value); return n >= 0n && n <= MAX_TICK ? n : null } catch { return null }
}
function scopeOf (value) {
  const dimension = ['overworld', 'nether', 'end'][value?.dimension] ?? value?.dimension
  const id = tickOf(value?.runtimeEntityId)
  const epoch = value?.movementEpoch ?? 0
  if (typeof value?.connectionId !== 'string' || !value.connectionId || !['overworld', 'nether', 'end'].includes(dimension) || id === null || !(typeof epoch === 'string' || typeof epoch === 'number' && Number.isSafeInteger(epoch))) return null
  return JSON.stringify([value.connectionId, dimension, String(id), epoch])
}
function controlsOf (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([name, enabled]) => !CONTROLS.includes(name) || typeof enabled !== 'boolean')) return null
  return Object.fromEntries(CONTROLS.map(name => [name, value[name] ?? false]))
}
function stable (value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
const environmentOf = state => JSON.stringify(stable({ gameMode: state.gameMode, effects: state.effects ?? {}, attributes: state.attributes ?? {}, riding: state.riding ?? false, flying: state.flying ?? false, elytraFlying: state.elytraFlying ?? false, swimmingPose: state.swimmingPose ?? false }))

function createInputReplay ({ physics, maxEntries = 32, maxReplayTicks = 8 } = {}) {
  if (['fromServer', 'step', 'toServerPosition', 'blockAt'].some(name => typeof physics?.[name] !== 'function')) throw new Error('Input replay requires known-world physics')
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 2 || maxEntries > 64 || !Number.isSafeInteger(maxReplayTicks) || maxReplayTicks < 1 || maxReplayTicks > 16 || maxReplayTicks >= maxEntries) throw new Error('Invalid bounded input replay limits')
  let frames = []; let activeScope = null; let lastCorrectionTick = null; let lastReset = null
  const reject = (code, reason) => ({ accepted: false, code, reason, predictionOnly: true, serverConfirmed: false })
  const snapshot = () => ({ count: frames.length, oldestTick: frames[0]?.tick.toString() ?? null, latestTick: frames.at(-1)?.tick.toString() ?? null, lastCorrectionTick: lastCorrectionTick?.toString() ?? null, maxEntries, maxReplayTicks, lastReset })
  function clear (reason = 'cleared') { frames = []; activeScope = null; lastCorrectionTick = null; lastReset = String(reason).slice(0, 100); return snapshot() }
  function record (frame) {
    const tick = tickOf(frame?.tick); const scope = scopeOf(frame?.scope); const controls = controlsOf(frame?.controls); const state = frame?.physicsState
    if (tick === null || scope === null || !controls || !finite(state?.position) || !finite(state?.velocity) || !Number.isFinite(frame?.yaw) || !Number.isFinite(frame?.pitch) || typeof state?.onGround !== 'boolean' || !Number.isFinite(frame?.health) || frame.health <= 0 || frame.health > 20 || !['survival', 0].includes(state?.gameMode)) return reject('INVALID_FRAME', 'A sent frame requires complete controls, look, scope, health and post-tick physics')
    let saved; let environment
    try { saved = copy(state); environment = environmentOf(saved) } catch { return reject('INVALID_FRAME', 'The movement state cannot be copied') }
    if (activeScope !== null && scope !== activeScope) clear('scope_changed')
    if (frames.length && tick <= frames.at(-1).tick) return reject('NON_MONOTONIC_INPUT', 'Sent input ticks must increase exactly')
    saved.yaw = frame.yaw; saved.pitch = frame.pitch; saved.controls = controls
    activeScope = scope
    frames.push({ tick, scope, controls, yaw: frame.yaw, pitch: frame.pitch, health: frame.health, state: saved, environment })
    while (frames.length > maxEntries) frames.shift()
    return { accepted: true, tick: String(tick), count: frames.length }
  }
  function knownBody (state) {
    if (!finite(state?.position) || !finite(state?.velocity) || ![state.yaw, state.pitch].every(Number.isFinite) || state.isInLava) throw new Error(state.isInLava ? 'Lava prediction is unsupported' : 'Incomplete replay state')
    if (state.riding || state.flying || state.elytraFlying || state.swimmingPose) throw new Error('Unsupported movement pose during replay')
    for (let x = Math.floor(state.position.x - 0.3 + 1e-6); x <= Math.floor(state.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6); z <= Math.floor(state.position.z + 0.3 - 1e-6); z++) {
      for (let y = Math.floor(state.position.y - 0.01); y <= Math.floor(state.position.y + 1.8 - 1e-6); y++) {
        const block = physics.blockAt({ x, y, z })
        if (!block || block.known === false || typeof block.name !== 'string') throw new Error('Unknown replay terrain')
        if (['lava', 'flowing_lava', 'minecraft:lava', 'minecraft:flowing_lava'].includes(block.name)) throw new Error('Lava prediction is unsupported')
      }
    }
  }
  function reconcile (correction, context = {}) {
    const tick = tickOf(correction?.tick); const scope = scopeOf(context.scope); const current = tickOf(context.currentInputTick)
    if (correction?.accepted !== true || correction?.source !== 'correct_player_move_prediction' || tick === null || !finite(correction.position) || !finite(correction.velocity) || typeof correction.onGround !== 'boolean') return reject('INVALID_CORRECTION', 'A normalized player correction is required')
    if (tick === 0n) return reject('ZERO_TICK_IMMEDIATE', 'Zero-tick corrections use the caller\'s immediate path, not historical replay')
    if (scope === null || current === null || !Number.isFinite(context.health) || context.health <= 0 || context.health > 20) return reject('INVALID_CONTEXT', 'Current sent tick, health and scope must be known')
    if (activeScope !== scope) return reject('SCOPE_CHANGED', 'Replay cannot cross a connection, dimension, player or movement epoch')
    if (lastCorrectionTick !== null && tick <= lastCorrectionTick) return reject('STALE_CORRECTION', 'This correction is not newer than the last replayed correction')
    if (tick > current) return reject('FUTURE_INPUT_TICK', 'The correction refers to input that has not been sent')
    if (!frames.length || frames.at(-1).tick !== current) return reject('LATEST_INPUT_MISSING', 'History must end at the most recently sent input')
    const anchorIndex = frames.findIndex(frame => frame.tick === tick)
    if (anchorIndex < 0) return reject('HISTORY_MISSING', 'The corrected post-tick movement state is no longer retained')
    if (current - tick > BigInt(maxReplayTicks)) return reject('REPLAY_LIMIT', 'The correction exceeds the bounded replay window')
    const history = frames.slice(anchorIndex); const anchor = history[0]
    let expected = tick; let health = anchor.health
    for (const frame of history) {
      if (frame.tick !== expected++) return reject('HISTORY_GAP', 'Every sent input between correction and current tick must be retained')
      if (frame.scope !== scope) return reject('SCOPE_CHANGED', 'Recorded scope differs during replay')
      if (frame.health < health || context.health < frame.health) return reject('DAMAGE', 'Observed damage invalidates movement replay')
      if (frame.environment !== anchor.environment) return reject('MOVEMENT_STATE_CHANGED', 'Movement effects, attributes or pose changed during the replay window')
      health = frame.health
    }
    let state; const replayed = []; const correctedStates = []
    try {
      const received = physics.fromServer({ position: copy(correction.position), positionSource: 'server_correction', predicted: null, gameMode: anchor.state.gameMode, rotation: { yaw: anchor.yaw, pitch: anchor.pitch } }, { velocity: copy(correction.velocity), onGround: correction.onGround })
      state = { ...copy(anchor.state), position: copy(received.position), velocity: copy(correction.velocity), onGround: correction.onGround, yaw: anchor.yaw, pitch: anchor.pitch, controls: copy(anchor.controls), velocitySource: 'server_correction' }
      knownBody(state)
      correctedStates.push(copy(state))
      for (const frame of history.slice(1)) {
        state = physics.step({ ...state, yaw: frame.yaw, pitch: frame.pitch }, copy(frame.controls))
        knownBody(state)
        replayed.push({ tick: String(frame.tick), physicsState: copy(state) })
        correctedStates.push(copy(state))
      }
      const position = physics.toServerPosition(state)
      if (!finite(position)) throw new Error('Incomplete replay position')
      for (let index = 0; index < history.length; index++) frames[anchorIndex + index].state = correctedStates[index]
      lastCorrectionTick = tick
      return { accepted: true, correctionTick: String(tick), replayedToTick: String(current), replayedTicks: replayed.length, authoritativePosition: copy(correction.position), authoritativeVelocity: copy(correction.velocity), authoritativeOnGround: correction.onGround, physicsState: copy(state), position: copy(position), replayedFrames: replayed, predictionOnly: true, serverConfirmed: false }
    } catch (error) {
      const reason = String(error.message ?? error).slice(0, 200)
      return reject(/lava/i.test(reason) ? 'UNSAFE_LAVA' : /unknown|not received|incomplete block|unloaded/i.test(reason) ? 'UNKNOWN_WORLD' : 'REPLAY_PHYSICS_FAILED', reason)
    }
  }
  return { record, reconcile, clear, snapshot }
}

module.exports = { createInputReplay }
