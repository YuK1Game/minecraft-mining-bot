'use strict'

// A bounded proof of the locally queued prediction, never a server receipt.
// Correction T is a post-input-T anchor; replay covers only queued T+1..N.
const MAX_TICK = (1n << 64n) - 1n
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const finite = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
const copy = value => structuredClone(value)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
function tickOf (value) {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value)) && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  try { const tick = BigInt(value); return tick >= 0n && tick <= MAX_TICK ? tick : null } catch { return null }
}
function scopeOf (value) {
  const dimension = ['overworld', 'nether', 'end'][value?.dimension] ?? value?.dimension
  const id = tickOf(value?.runtimeEntityId)
  if (!['overworld', 'nether', 'end'].includes(dimension) || id === null || ['profile', 'realmId', 'connectionId', 'startedAt'].some(key => value?.[key] == null || String(value[key]).length === 0) || !(typeof value?.generation === 'string' && value.generation.length > 0 || Number.isSafeInteger(value?.generation))) return null
  return JSON.stringify([String(value.profile), String(value.realmId), dimension, String(value.connectionId), String(value.startedAt), String(id), String(value.generation)])
}
function controlsOf (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, enabled]) => !CONTROLS.includes(key) || typeof enabled !== 'boolean')) return null
  return Object.fromEntries(CONTROLS.map(key => [key, value[key] ?? false]))
}
function stable (value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
const environmentOf = state => JSON.stringify(stable({ gameMode: state.gameMode, effects: state.effects ?? {}, attributes: state.attributes ?? {}, riding: !!state.riding, flying: !!state.flying, elytraFlying: !!state.elytraFlying, swimmingPose: !!state.swimmingPose }))
const complete = state => finite(state?.position) && finite(state?.velocity) && [state.yaw, state.pitch].every(Number.isFinite) && typeof state.onGround === 'boolean' && ['survival', 0].includes(state.gameMode)
const healthy = value => Number.isFinite(value) && value > 0 && value <= 20

function createInputHistory ({ physics, now = Date.now, maxAgeMs = 4000, maxTicks = 80 } = {}) {
  if (['step', 'toServerPosition', 'blockAt'].some(key => typeof physics?.[key] !== 'function') || typeof now !== 'function') throw new Error('Queued input history requires known-world physics and a clock')
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 4000 || !Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > 80) throw new Error('Invalid queued prediction bounds')
  let frames = []; let anchor = null; let activeScope = null; let revision = 0; let navigationQueued = 0; let lastReset = 'anchor_missing'; let lastWitness = null
  let stationary = null; let lastRaw = null; let hardInvalidatedAt = null; let lastNonNeutral = null
  const result = (ready, reason, details = {}) => ({ ready, reason, revision, navigationQueued, ...details, predictionOnly: true, serverConfirmed: false })
  function snapshot () { const latest = frames.at(-1); return { revision, count: frames.length, latestTick: latest?.tick.toString() ?? null, cursor: latest ? { tick: String(latest.tick), queuedAt: latest.queuedAt } : null, anchorTick: anchor?.tick.toString() ?? null, anchorKind: anchor?.kind ?? null, leaseAt: anchor?.leaseAt ?? null, stationary: stationary ? { neutralFrames: stationary.count, checkpointTick: stationary.checkpoint?.tick.toString() ?? null, frozen: stationary.frozen, disabledReason: stationary.disabledReason } : null, navigationQueued, lastReset, lastWitness: lastWitness ? copy(lastWitness) : null } }
  function invalidate (reason = 'invalidated', options = {}) {
    const retryNeutral = ['input_failed', 'queue_receipt_missing'].includes(reason) && stationary && !stationary.motionSeen && !stationary.frozen && !stationary.disabledReason
    frames = []; anchor = null; activeScope = null; lastReset = String(reason).slice(0, 100); lastWitness = null
    if (retryNeutral) Object.assign(stationary, { count: 0, state: null, lastTick: null, lastQueuedAt: null, checkpoint: null })
    else {
      stationary = null
      const currentTime = now(); const observedAt = stamp(options.observedAt)
      const authoritative = ['authoritative_lifecycle_or_pose_changed', 'authoritative_respawn_cleanup'].includes(reason) && Number.isFinite(observedAt) && Number.isFinite(currentTime) && observedAt <= currentTime
      const boundary = authoritative ? observedAt : currentTime
      hardInvalidatedAt = Math.max(hardInvalidatedAt ?? -Infinity, Number.isFinite(boundary) ? boundary : Infinity)
    }
    revision++; return result(false, lastReset)
  }
  function knownDry (state) {
    if (!complete(state) || state.isInWater || state.isInLava || state.riding || state.flying || state.elytraFlying || state.swimmingPose) throw new Error('unsupported_or_wet_state')
    for (let x = Math.floor(state.position.x - 0.3 + 1e-6); x <= Math.floor(state.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6); z <= Math.floor(state.position.z + 0.3 - 1e-6); z++) {
      for (let y = Math.floor(state.position.y - 0.01); y <= Math.floor(state.position.y + 1.8 - 1e-6); y++) {
        const block = physics.blockAt({ x, y, z })
        if (!block || block.known === false || typeof block.name !== 'string') throw new Error('unknown_world')
        if (/^(?:minecraft:)?(?:flowing_)?(?:water|lava)$/.test(block.name)) throw new Error('unsupported_or_wet_state')
      }
    }
  }
  function supportedStationaryBody (state) {
    knownDry(state)
    if (typeof physics.hasSupport !== 'function' || !physics.hasSupport(state.position) || state.onGround !== true || Math.hypot(state.velocity.x, state.velocity.z) > 1e-6 || state.velocity.y < -0.12 || state.velocity.y > 0.05 || state.isCollidedHorizontally) throw new Error('stationary_support_or_motion_unknown')
    const feet = state.position
    // Only float32 contact tolerance is permitted; partial shape support is
    // sufficient when independent neutral simulation remains stationary.
    const epsilon = 1e-4
    for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) {
      for (let y = Math.floor(feet.y + 1e-6); y <= Math.floor(feet.y + 1.8 - 1e-6); y++) {
        const block = physics.blockAt({ x, y, z })
        if (!Array.isArray(block?.shapes) || block.shapes.some(box => !Array.isArray(box) || box.length !== 6 || !box.every(Number.isFinite))) throw new Error('unknown_stationary_shapes')
        for (const box of block.shapes) if (feet.x + 0.3 > x + box[0] + epsilon && feet.x - 0.3 < x + box[3] - epsilon && feet.z + 0.3 > z + box[2] + epsilon && feet.z - 0.3 < z + box[5] - epsilon && feet.y + 1.8 > y + box[1] + epsilon && feet.y < y + box[4] - epsilon) throw new Error('stationary_body_collision')
      }
    }
  }
  function disableStationary (reason) {
    if (stationary) { stationary.disabledReason = reason; stationary.state = null; stationary.checkpoint = null }
    if (anchor?.kind === 'stationary_raw_checkpoint') anchor = null
    if (!anchor) lastReset = reason
  }
  function observeStationaryRaw (value) {
    const scope = scopeOf(value?.scope); const rawTime = stamp(value?.rawStamp); const receivedAt = stamp(value?.receivedAt)
    if (scope === null || !finite(value?.rawPosition) || ![rawTime, receivedAt].every(Number.isFinite) || !healthy(value?.health) || typeof physics.fromServer !== 'function' || typeof physics.hasSupport !== 'function') return result(false, 'invalid_stationary_raw')
    if (lastRaw && rawTime <= lastRaw.rawTime) return result(false, 'stationary_raw_not_new')
    if (hardInvalidatedAt !== null && (rawTime < hardInvalidatedAt || receivedAt < hardInvalidatedAt)) return result(false, 'stationary_raw_precedes_invalidation')
    if (!lastRaw && lastNonNeutral?.scope === scope && receivedAt <= lastNonNeutral.queuedAt) return result(false, 'stationary_moving_prefix')
    if (anchor?.kind === 'server_correction' && rawTime <= stamp(anchor.rawStamp)) return result(false, 'exact_correction_preferred')
    lastRaw = { scope, rawTime }; hardInvalidatedAt = null
    if (activeScope !== null && activeScope !== scope) { frames = []; activeScope = null }
    anchor = null; lastWitness = null
    stationary = { scope, rawPosition: copy(value.rawPosition), rawStamp: value.rawStamp, receivedAt, health: value.health, environment: null, count: 0, state: null, lastTick: null, lastQueuedAt: null, checkpoint: null, motionSeen: false, frozen: false, disabledReason: null }
    lastReset = 'stationary_neutral_pending'; revision++
    return result(false, 'stationary_neutral_pending')
  }
  function stationaryFrame (frame) {
    const candidate = stationary
    if (!candidate || candidate.disabledReason || candidate.frozen || anchor?.kind === 'server_correction') return
    if (frame.scope !== candidate.scope) { disableStationary('stationary_scope_changed'); return }
    if (frame.health < candidate.health) { disableStationary('stationary_damage'); return }
    if (candidate.environment !== null && frame.environment !== candidate.environment) { disableStationary('stationary_environment_changed'); return }
    if (candidate.lastTick !== null && (frame.tick !== candidate.lastTick + 1n || frame.queuedAt - candidate.lastQueuedAt > 200)) { disableStationary('stationary_history_gap'); return }
    if (Object.values(frame.controls).some(Boolean)) {
      candidate.motionSeen = true
      if (!candidate.checkpoint || candidate.count < 8) { disableStationary('stationary_non_neutral_prefix'); return }
      const checkpoint = candidate.checkpoint
      candidate.frozen = true
      anchor = { kind: 'stationary_raw_checkpoint', derived: true, tick: checkpoint.tick, scope: candidate.scope, state: copy(checkpoint.state), health: checkpoint.health, environment: candidate.environment, rawPosition: copy(candidate.rawPosition), rawStamp: candidate.rawStamp, receivedAt: candidate.receivedAt, leaseAt: frame.queuedAt }
      lastReset = null
      return
    }
    try {
      if (frame.queuedAt < candidate.receivedAt || distance(frame.packetPosition, candidate.rawPosition) > 1e-3 || distance(physics.toServerPosition(frame.state), candidate.rawPosition) > 1e-3) throw new Error('stationary_pose_changed')
      supportedStationaryBody(frame.state)
      let expected = candidate.state
      if (!expected) {
        expected = physics.fromServer({ position: copy(candidate.rawPosition), positionSource: 'received_raw', predicted: null, gameMode: frame.state.gameMode, rotation: { yaw: frame.yaw, pitch: frame.pitch } })
        expected.effects = copy(frame.state.effects ?? {}); expected.attributes = copy(frame.state.attributes ?? {})
        supportedStationaryBody(expected)
      }
      expected = physics.step({ ...expected, yaw: frame.yaw, pitch: frame.pitch }, copy(frame.controls))
      supportedStationaryBody(expected)
      if (distance(physics.toServerPosition(expected), candidate.rawPosition) > 1e-3 || distance(expected.position, frame.state.position) > 1e-3 || distance(expected.velocity, frame.state.velocity) > 1e-3) throw new Error('stationary_replay_contradiction')
      candidate.state = copy(expected); candidate.environment ??= frame.environment; candidate.health = frame.health
      candidate.lastTick = frame.tick; candidate.lastQueuedAt = frame.queuedAt; candidate.count = Math.min(8, candidate.count + 1)
      if (candidate.count === 8) candidate.checkpoint = { tick: frame.tick, state: copy(expected), health: frame.health }
    } catch (error) { disableStationary(/unknown|not received|incomplete block|unloaded/i.test(String(error.message)) ? 'stationary_unknown_world' : String(error.message).slice(0, 100)) }
  }
  function recordQueued (frame) {
    const tick = tickOf(frame?.tick); const scope = scopeOf(frame?.scope); const controls = controlsOf(frame?.controls); const queuedAt = stamp(frame?.queuedAt)
    const bad = frame?.receiptConfirmed !== true ? 'queue_receipt_missing' : frame?.modeled !== true ? 'unmodeled_input' : tick === null || scope === null || !controls || !complete(frame?.predictedState) || !finite(frame?.packetPosition) || ![frame?.yaw, frame?.pitch, queuedAt].every(Number.isFinite) || !healthy(frame?.health) ? 'invalid_queued_frame' : null
    if (controls && Object.values(controls).some(Boolean)) { lastNonNeutral = { scope, queuedAt }; if (stationary) stationary.motionSeen = true }
    if (bad) {
      if (stationary && bad === 'queue_receipt_missing' && (!controls || Object.values(controls).some(Boolean) || frame?.modeled !== true || !finite(frame?.packetPosition) || distance(frame.packetPosition, stationary.rawPosition) > 1e-3)) stationary.motionSeen = true
      invalidate(bad); return { accepted: false, ...snapshot(), reason: bad }
    }
    if (activeScope !== null && activeScope !== scope) { invalidate('scope_changed'); return { accepted: false, ...snapshot(), reason: 'scope_changed' } }
    const previous = frames.at(-1)
    if (previous && (tick <= previous.tick || queuedAt < previous.queuedAt)) { invalidate('non_monotonic_input'); return { accepted: false, ...snapshot(), reason: 'non_monotonic_input' } }
    let state; let environment
    try { state = copy(frame.predictedState); environment = environmentOf(state) } catch { invalidate('invalid_queued_frame'); return { accepted: false, ...snapshot(), reason: 'invalid_queued_frame' } }
    state.yaw = frame.yaw; state.pitch = frame.pitch; state.controls = controls
    activeScope = scope
    frames.push({ tick, scope, controls, yaw: frame.yaw, pitch: frame.pitch, state, packetPosition: copy(frame.packetPosition), health: frame.health, queuedAt, environment })
    stationaryFrame(frames.at(-1))
    while (frames.length > maxTicks + 1) frames.shift()
    if (frame.producer === 'navigation') navigationQueued++
    revision++
    return { accepted: true, tick: String(tick), ...snapshot() }
  }
  function observeAnchor (value) {
    const tick = tickOf(value?.tick); const scope = scopeOf(value?.scope); const receivedAt = stamp(value?.receivedAt); const rawStamp = stamp(value?.rawStamp)
    if (tick === null || tick === 0n || scope === null || !complete(value?.physicsState) || !finite(value?.rawPosition) || ![receivedAt, rawStamp].every(Number.isFinite) || !healthy(value?.health)) return invalidate('invalid_anchor')
    if (anchor?.kind === 'server_correction' && scope === anchor.scope && tick <= anchor.tick) return result(false, 'stale_anchor')
    if (activeScope !== scope) return invalidate('anchor_scope_changed')
    const saved = frames.find(frame => frame.tick === tick)
    if (!saved) return invalidate('anchor_input_missing')
    if (value.health < saved.health) return invalidate('damage')
    let state
    try {
      const receivedPosition = physics.toServerPosition(value.physicsState)
      if (!finite(receivedPosition) || distance(saved.packetPosition, value.rawPosition) > 0.75 || distance(receivedPosition, value.rawPosition) > 1e-3) return invalidate('authoritative_contradiction')
      state = { ...copy(saved.state), position: copy(value.physicsState.position), velocity: copy(value.physicsState.velocity), onGround: value.physicsState.onGround, velocitySource: 'server_correction' }
      knownDry(state)
    } catch (error) { return invalidate(/unknown|not received|incomplete block|unloaded/i.test(String(error.message)) ? 'unknown_world' : 'unsupported_or_wet_state') }
    anchor = { kind: 'server_correction', derived: false, tick, scope, state, health: value.health, environment: saved.environment, rawPosition: copy(value.rawPosition), rawStamp: value.rawStamp, receivedAt, leaseAt: Math.min(receivedAt, rawStamp) }
    stationary = null
    lastReset = null; revision++
    return result(true, null, { anchorTick: String(tick) })
  }
  function evaluateWitness (context = {}) {
    const time = context.now === undefined ? now() : context.now
    if (!anchor) return result(false, stationary && !stationary.disabledReason ? stationary.count >= 8 ? 'stationary_motion_not_started' : 'stationary_neutral_pending' : lastReset ?? 'anchor_missing')
    if (scopeOf(context.scope) !== anchor.scope) return result(false, 'scope_changed')
    if (!Number.isFinite(time) || time < anchor.receivedAt || time < anchor.leaseAt || time - anchor.leaseAt > maxAgeMs) return result(false, 'anchor_stale')
    if (!healthy(context.health) || context.health < anchor.health) return result(false, 'damage')
    if (!finite(context.position)) return result(false, 'position_unknown')
    const latest = frames.at(-1)
    if (!latest || latest.tick <= anchor.tick) return result(false, 'queued_progress_missing')
    if (time < latest.queuedAt || time - latest.queuedAt > 200) return result(false, 'queued_input_stale')
    if (latest.tick - anchor.tick > BigInt(maxTicks)) return result(false, 'tick_limit')
    const replay = frames.filter(frame => frame.tick > anchor.tick)
    let expected = anchor.tick + 1n; let health = anchor.health; let state = copy(anchor.state)
    const physicsTrace = []
    try {
      knownDry(state)
      physicsTrace.push({ tick: String(anchor.tick), position: copy(physics.toServerPosition(state)), physicsState: copy(state) })
      for (const frame of replay) {
        if (frame.tick !== expected++) return result(false, 'history_gap')
        if (frame.scope !== anchor.scope) return result(false, 'scope_changed')
        if (frame.health < health || context.health < frame.health) return result(false, 'damage')
        if (frame.environment !== anchor.environment) return result(false, 'movement_state_changed')
        health = frame.health
        state = physics.step({ ...state, yaw: frame.yaw, pitch: frame.pitch }, copy(frame.controls))
        knownDry(state)
        if (distance(physics.toServerPosition(state), frame.packetPosition) > 0.75) return result(false, 'prediction_contradiction')
        physicsTrace.push({ tick: String(frame.tick), position: copy(physics.toServerPosition(state)), physicsState: copy(state) })
      }
      const position = physics.toServerPosition(state)
      if (!finite(position) || distance(position, context.position) > 0.75) return result(false, 'prediction_contradiction')
      return result(true, null, { expectedPosition: copy(position), expectedFeet: copy(state.position), physicsState: copy(state), physicsTrace, tick: String(latest.tick), anchorTick: String(anchor.tick), firstTick: String(anchor.tick + 1n), lastTick: String(latest.tick), queuedTicks: replay.length, anchor: { kind: anchor.kind, derived: anchor.derived, checkpointTick: String(anchor.tick), leaseAt: anchor.leaseAt, tick: String(anchor.tick), rawPosition: copy(anchor.rawPosition), rawStamp: anchor.rawStamp, receivedAt: anchor.receivedAt, scope: anchor.scope, physicsState: copy(anchor.state) } })
    } catch (error) { return result(false, /unknown|not received|incomplete block|unloaded/i.test(String(error.message)) ? 'unknown_world' : 'replay_failed') }
  }
  function witness (context = {}) {
    const observedAt = context.now === undefined ? now() : context.now
    const value = evaluateWitness({ ...context, now: observedAt })
    const age = origin => Number.isFinite(observedAt) && Number.isFinite(origin) ? observedAt - origin : null
    lastWitness = { ready: value.ready, reason: value.reason, revision: value.revision, anchorTick: anchor?.tick.toString() ?? null, lastTick: frames.at(-1)?.tick.toString() ?? null, queuedTicks: anchor ? frames.filter(frame => frame.tick > anchor.tick).length : 0, observedAt: Number.isFinite(observedAt) ? observedAt : null, anchorAgeMs: anchor ? age(anchor.leaseAt) : null, latestQueuedAgeMs: age(frames.at(-1)?.queuedAt) }
    return value
  }
  return { observeAnchor, observeStationaryRaw, recordQueued, invalidate, witness, snapshot }
}

module.exports = { createInputHistory }
