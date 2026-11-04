'use strict'

const { resourceMinHealth } = require('./learning-health')

const { performance } = require('node:perf_hooks')
const { createNavigator } = require('./navigation')
const { buildStationaryInput } = require('./input')
const { createInputReplay } = require('./input-replay')
const { normalizePlayerCorrection } = require('./server-physics')
const { previewCriticalHop, createCriticalHopStepper } = require('./critical-hop')

const INTERVAL = 50
const finite = position => position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))
const copy = position => ({ x: position.x, y: position.y, z: position.z })

function movementInput (controls, previous, predicted) {
  let x = Number(!!controls.left) - Number(!!controls.right)
  let z = Number(!!controls.forward) - Number(!!controls.back)
  const length = Math.hypot(x, z)
  if (length > 1) { x /= length; z /= length }
  const flags = []
  for (const [control, flag] of [['forward', 'up'], ['back', 'down'], ['left', 'left'], ['right', 'right']]) if (controls[control]) flags.push(flag)
  if (controls.jump) flags.push('jumping', 'want_up')
  if (controls.jump && !previous.jump) flags.push('start_jumping')
  for (const [control, stateFlag, heldFlag, startFlag, stopFlag] of [
    ['sprint', 'sprinting', 'sprint_down', 'start_sprinting', 'stop_sprinting'],
    ['sneak', 'sneaking', 'sneak_down', 'start_sneaking', 'stop_sneaking']
  ]) {
    if (controls[control]) flags.push(stateFlag, heldFlag)
    if (controls[control] && !previous[control]) flags.push(startFlag)
    if (!controls[control] && previous[control]) flags.push(stopFlag)
  }
  if (predicted.onGround || predicted.isCollidedVertically) flags.push('vertical_collision')
  if (predicted.isCollidedHorizontally) flags.push('horizontal_collision')
  return { vector: { x, z }, flags }
}

function createMovement ({ client, getState, world, startGame, startGameReceivedAt, version, allowWater = false, physics = null, waterPhysics = null, clock = () => performance.now(), onPrediction = () => {}, onQueuedFrame = null, getQueuedCursor = null, onError = () => {}, replanMixedAfterReplay = false }) {
  let criticalHopSequence = 0
  let criticalQueuedFrame = null
  if (version !== '1.26.60') throw new Error('Movement prediction supports Bedrock 1.26.60 only')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function') throw new Error('Movement requires a connected client and state reader')
  if (onQueuedFrame !== null && typeof onQueuedFrame !== 'function') throw new Error('onQueuedFrame must be a synchronous callback')
  if (getQueuedCursor !== null && typeof getQueuedCursor !== 'function') throw new Error('getQueuedCursor must be a synchronous callback')
  if (typeof replanMixedAfterReplay !== 'boolean') throw new Error('Trusted mixed replay planning must be boolean')
  if (typeof allowWater !== 'boolean') throw new Error('allowWater must be an explicit boolean')
  if (waterPhysics && (waterPhysics.capabilities?.version !== version || waterPhysics.capabilities?.water === 'disabled' || typeof waterPhysics.step !== 'function')) throw new Error('Prebuilt water physics must match the movement version and allow water')
  if (physics && (physics.capabilities?.version !== version || physics.capabilities?.water !== 'disabled' || typeof physics.step !== 'function')) throw new Error('Prebuilt dry physics must match the movement version and disable water')
  let anchorTick
  try { anchorTick = BigInt(startGame.current_tick) } catch { throw new Error('Missing movement tick anchor') }
  const anchorTime = startGameReceivedAt ?? clock()
  if (anchorTick < 0n || !Number.isFinite(anchorTime)) throw new Error('Invalid movement tick anchor')
  const navigators = new Map()
  let navigator = null
  let stepper = null
  let timer = null
  let previousControls = {}
  let lastTick = null
  let lastTime = null
  let previousHealth = null
  let rawSignature = null
  let dimension = null
  let lastFrame = null
  let collisionFrames = 0
  let collisionWaypoint = null
  let inputReplay = null; let replayPhysics = null
  let beforeInput = null; let checkingFrame = false
  let startDiagnostics = null
  let lastPreviewFailure = null
  let lastPreviewTiming = null; let lastStartTiming = null; let measuringStart = null
  let jumpScope = null
  let correctionRun = null
  let sent = 0
  let status = { phase: 'idle', target: null, route: null, predictedPosition: null, predictedFeet: null, lastAuthoritativePosition: null, sent: 0, tick: null, reason: null, serverConfirmed: false, requiresServerConfirmation: true, allowWater: false, emergency: false, sprintRequested: false, sprintAllowed: false }
  const active = () => status.phase === 'moving' || status.phase === 'settling'

  function signature (state) {
    return `${state.positionUpdatedAt ?? ''}:${state.position.x},${state.position.y},${state.position.z}`
  }

  function fullCorrectionScope(state) {
    const life=state?.lifecycle?.deathId
    if(typeof state?.profile!=='string'||!state.profile||state.realm?.id==null||typeof state.connectionId!=='string'||!state.connectionId||!Number.isFinite(Date.parse(state.startedAt))||!/^\d+$/.test(String(state.runtimeEntityId))||String(state.runtimeEntityId)==='0'||!['overworld','nether','end'].includes(state.dimension)||!Number.isSafeInteger(life)||life<0)return null
    return JSON.stringify([state.profile,String(state.realm.id),state.connectionId,state.startedAt,String(state.runtimeEntityId),state.dimension,life])
  }
  function replanAcceptedMixedReplay(replay,state) {
    const no=reason=>({accepted:false,reason})
    const run=correctionRun,seed=replay.physicsState
    if(!run||!status.continueAfterReplay||typeof beforeInput!=='function'||status.phase!=='moving'||timer===null)return no('Trusted mixed replay replan is not enabled')
    if(fullCorrectionScope(state)!==run.scope||state.health<run.health)return no('Mixed replay scope or health changed')
    if(run.replans>=3||run.usedTicks>=run.maxTicks||clock()>=run.deadline)return no('Original mixed replay budget exhausted')
    if(!finite(seed?.position)||!finite(seed?.velocity)||typeof seed.onGround!=='boolean'||!Number.isFinite(seed.yaw)||!Number.isFinite(seed.pitch)||seed.isInLava||seed.riding||seed.flying||seed.elytraFlying||seed.swimmingPose)return no('Accepted replay lacks a supported corrected physical seed')
    let checked
    checkingFrame=true
    try { checked=beforeInput({phase:'moving',predictedState:structuredClone(seed),packetPosition:copy(replay.position),controls:{...previousControls},correctionReplan:true}) } finally { checkingFrame=false }
    if(checked&&typeof checked.then==='function'){Promise.resolve(checked).catch(()=>{});return no('Mixed replay guard must be synchronous')}
    if(checked===false||!active())return no('Mixed replay guard rejected the corrected origin')
    run.replans++
    const route=navigator.plan(structuredClone(seed),copy(run.target),structuredClone(run.options))
    if(!route.ready||!finite(route.target)||['x','y','z'].some(k=>route.target[k]!==run.target[k])||route.planningOnly)return no(route.reason??'The same known mixed target has no current ordinary route')
    if(!active()||fullCorrectionScope(getState())!==run.scope||getState().health<run.health||clock()>=run.deadline)return no('Mixed replay context changed during planning')
    const next=navigator.createStepper(route,structuredClone(seed),{maxTicks:run.maxTicks-run.usedTicks,sprint:status.sprintAllowed})
    stepper=next;status.route=structuredClone(route)
    return {accepted:true,frame:next.snapshot(),replanned:true}
  }

  function currentState (duringMovement = false, emergency = status.emergency === true, onStateRead = null) {
    const state = getState()
    onStateRead?.(state)
    if (state?.phase !== 'spawned' || !finite(state.position)) throw new Error('Movement requires a spawned player with a server position')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('Movement prediction is survival-only')
    if (state.dead || state.isDead || state.lifecycle?.dead || !Number.isFinite(state.health) || state.health <= (emergency ? 0 : resourceMinHealth(state))) throw new Error('Movement stopped because health is low, dead or unknown')
    if (duringMovement) {
      if(correctionRun&&(fullCorrectionScope(state)!==correctionRun.scope||clock()>=correctionRun.deadline))throw new Error('Original mixed movement scope or deadline ended')
      if (status.route?.boundedJump && jumpScope !== JSON.stringify([state.profile ?? null, state.realm?.id ?? null, state.dimension ?? null, state.connectionId ?? null, state.startedAt ?? null, state.runtimeEntityId ?? null])) throw new Error('Bounded jump session or player changed')
      if (state.dimension !== dimension) throw new Error('Movement stopped because the dimension changed')
      // Combat's own approach expects to be hit (poison, arrows); it re-checks
      // every poll, so damage alone does not stop that move. Low health still does.
      if (state.health < previousHealth && state.combatMotion !== true) throw new Error('Movement stopped because the bot took damage')
      if (signature(state) !== rawSignature) throw new Error('An authoritative position update requires replanning')
      previousHealth = state.health
    }
    return state
  }

  function navigatorFor (enabled) {
    if (!navigators.has(enabled)) navigators.set(enabled, createNavigator({ world, version, allowWater: enabled, ...(enabled && waterPhysics ? { physics: waterPhysics } : !enabled && physics ? { physics } : {}) }))
    return navigators.get(enabled)
  }

  function sprintPolicy (state, requested) {
    const entry = state.vitals?.hunger
    const hunger = typeof entry === 'number' ? entry : entry?.value ?? state.food?.hunger ?? state.hunger
    const known = Number.isFinite(hunger) && hunger >= 0 && hunger <= 20 && entry?.source !== 'client_prediction'
    return { sprintRequested: requested, sprintAllowed: requested && known && hunger > 6, hunger: known ? hunger : null, sprintReason: !requested ? 'not_requested' : !known ? 'hunger_unknown' : hunger <= 6 ? 'hunger_too_low' : 'known_hunger_above_six' }
  }

  function receivedSprintHunger (state) {
    const entry = state.vitals?.hunger
    if (entry?.source !== 'server_attribute' || !Number.isFinite(entry.value) || entry.value <= 6 || entry.value > 20) return false
    if (!['connectionId', 'startedAt', 'runtimeEntityId'].every(key => entry[key] == null || String(entry[key]) === String(state[key]))) return false
    if (entry.observedAt != null) {
      const stamp = typeof entry.observedAt === 'number' ? entry.observedAt : Date.parse(entry.observedAt), start = Date.parse(state.startedAt)
      if (!Number.isFinite(stamp) || stamp > Date.now() || Number.isFinite(start) && stamp < start) return false
    }
    return true
  }

  function knownDrySegment (from, to, seen = new Set()) {
    if (!finite(from) || !finite(to)) return false
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25))
    if (steps > 256) return false
    for (let index = 0; index <= steps; index++) {
      const point = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, from[axis] + (to[axis] - from[axis]) * index / steps]))
      for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) for (let y = Math.floor(point.y - 0.05); y <= Math.floor(point.y + 1.8 - 1e-6); y++) {
        const key = `${x},${y},${z}`
        if (seen.has(key)) continue
        if (seen.size >= 2048) return false
        seen.add(key)
        const block = world.getBlock(x, y, z)
        if (block?.known !== true || typeof block.name !== 'string' || /(?:water|lava)/.test(block.name) || block.extra?.some(layer => layer?.known === false || typeof layer?.name !== 'string' || /(?:water|lava)/.test(layer.name))) return false
      }
    }
    return true
  }

  function knownDryRoute (initial, route) {
    if (!route.ready || initial.isInWater || initial.isInLava || initial.swimmingPose || !Array.isArray(route.waypoints) || route.waypoints.length > 64 || route.waypoints.some(point => point.action === 'swim' || point.medium === 'water' || point.medium === 'liquid')) return false
    const seen = new Set(); let previous = initial.position, samples = 0
    for (const waypoint of route.waypoints) {
      const point = waypoint.position
      if (!finite(point) || (samples += Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) / 0.25))) > 256 || !knownDrySegment(previous, point, seen)) return false
      previous = point
    }
    return knownDrySegment(initial.position, initial.position, seen)
  }

  function routeSprintPolicy (state, requested, dry, automatic = false) {
    const policy = sprintPolicy(state, requested)
    if (requested && dry === false) return { ...policy, sprintAllowed: false, sprintReason: 'route_not_known_dry' }
    if (automatic && policy.sprintAllowed && (state.threatPolicy !== 'online_learning' || !receivedSprintHunger(state))) return { ...policy, sprintAllowed: false, sprintReason: 'current_learning_server_hunger_required' }
    return policy
  }

  function requireJumpHunger (state, policy, enabled, emergency) {
    const entry = state.vitals?.hunger
    const time = value => typeof value === 'number' ? value : Date.parse(value)
    const stamp = time(entry?.observedAt)
    const sessionStarted = time(state.startedAt)
    const matchingScope = ['connectionId', 'startedAt', 'runtimeEntityId'].every(key => entry?.[key] == null || String(entry[key]) === String(state[key]))
    // An unchanged server attribute remains authoritative for this connection;
    // it is state, not a heartbeat. Fence prior sessions and future timestamps
    // without inventing an expiry that would disable a late emergency sprint.
    // connectedAt is the world-spawn timestamp; initial attributes can legally
    // precede it. startedAt fences this connection's actual host session.
    if (enabled || !emergency || !policy.sprintAllowed || entry?.source !== 'server_attribute' || !state.connectionId || !Number.isFinite(sessionStarted) || !matchingScope || !Number.isFinite(stamp) || stamp > Date.now() || stamp < sessionStarted) throw new Error('Bounded jump requires current-session server hunger above six and explicit dry emergency sprint')
  }

  function prepare (target, options = {}, onStateRead = null) {
    const enabled = options.allowWater ?? allowWater
    if (typeof enabled !== 'boolean') throw new Error('allowWater must be an explicit boolean')
    const emergency = options.emergency ?? false
    if (typeof emergency !== 'boolean') throw new Error('emergency must be an explicit boolean')
    if (options.sprint !== undefined && typeof options.sprint !== 'boolean') throw new Error('sprint must be an explicit boolean')
    const continueAfterReplay = options.continueAfterReplay ?? false
    if (typeof continueAfterReplay !== 'boolean' || options.beforeInput != null && typeof options.beforeInput !== 'function') throw new Error('Replay continuation requires a boolean option and a synchronous frame guard')
    const state = currentState(false, emergency, onStateRead)
    const automatic = options.sprint === undefined && options.boundedJump == null && state.threatPolicy === 'online_learning' && receivedSprintHunger(state)
    const sprint = options.sprint ?? automatic
    if (options.boundedJump != null) requireJumpHunger(state, sprintPolicy(state, sprint), enabled, emergency)
    const candidate = navigatorFor(enabled)
    const initial = candidate.physics.fromServer(state)
    const route = candidate.plan(initial, target, { maxDistance: options.maxDistance ?? 12, maxExpanded: options.maxExpanded ?? 1500, avoidance: options.avoidance, directFlat: options.directFlat ?? false, directSurface: options.directSurface ?? false, exactGoal: options.exactGoal ?? false, partialDrop: options.partialDrop ?? false, partialRecenter: options.partialRecenter ?? false, controlledDrop: options.controlledDrop ?? false, shoreRecenter: options.shoreRecenter ?? false, stablePartialOrigin: options.stablePartialOrigin ?? (options.boundedJump != null), boundedJump: options.boundedJump ?? null })
    let sprintRouteDry = null
    if (automatic) { try { sprintRouteDry = knownDryRoute(initial, route) } catch { sprintRouteDry = false } }
    const policy = routeSprintPolicy(state, sprint, sprintRouteDry, automatic)
    if (!route.ready && !initial.onGround && !initial.isInWater) route.settleRequired = true
    Object.assign(route, policy, { sprintRouteDry, sprintAutomatic: automatic })
    return { state, candidate, initial, route, allowWater: enabled, emergency, requestedDirectSurface: options.directSurface === true, continueAfterReplay, beforeInput: options.beforeInput ?? null, sprintRouteDry, sprintAutomatic: automatic, ...policy }
  }

  function preview (target, options = {}) {
    const previewStarted = performance.now()
    let previewState; let stateRead = false; let result
    try { result = prepare(target, options, state => { previewState = state; stateRead = true }).route } catch (error) { result = { ready: false, reason: error.message, waypoints: [], serverConfirmed: false, predictionOnly: true } }
    if (!result.ready) {
      // Keep failure evidence out of the per-frame snapshot. Prefer the exact
      // state read by prepare; a diagnostic read must never mask its failure.
      try {
        let stateReadError = null
        if (!stateRead) {
          try { previewState = getState() } catch (error) { stateReadError = typeof error?.message === 'string' ? error.message.slice(0, 200) : 'State unavailable' }
        }
        const state = previewState
        const prediction = state?.positionSource === 'client_prediction' ? state.predicted ?? state.workingPrediction : null
        const seed = prediction?.physicsState ?? prediction
        const seedFeet = seed?.feetPosition ?? seed?.position
        const matchesPosition = finite(state?.position) && finite(prediction?.position) ? ['x', 'y', 'z'].every(axis => Math.abs(prediction.position[axis] - state.position[axis]) < 1e-4) : null
        const feetMatchPosition = finite(state?.position) && finite(seedFeet) ? ['x', 'y', 'z'].every(axis => Math.abs(seedFeet[axis] - state.position[axis] + (axis === 'y' ? 1.62 : 0)) < 1e-3) : null
        const flag = (name, fallback = false) => {
          const value = options?.[name] ?? fallback
          return typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? value.slice(0, 40) : null
        }
        const label = value => typeof value === 'string' ? value.slice(0, 80) : typeof value === 'number' && Number.isFinite(value) ? value : null
        lastPreviewFailure = {
          reason: typeof result.reason === 'string' ? result.reason.slice(0, 200) : null,
          target: finite(target) ? copy(target) : null,
          requested: Object.fromEntries(['emergency', 'directFlat', 'directSurface', 'exactGoal', 'partialDrop', 'partialRecenter', 'controlledDrop', 'shoreRecenter', 'stablePartialOrigin', 'sprint', 'continueAfterReplay'].map(name => [name, flag(name)]).concat([['allowWater', flag('allowWater', allowWater)]])),
          state: {
            phase: label(state?.phase), gameMode: label(state?.gameMode), health: Number.isFinite(state?.health) ? state.health : null,
            dead: state?.dead === true || state?.isDead === true || state?.lifecycle?.dead === true,
            position: finite(state?.position) ? copy(state.position) : null, positionSource: label(state?.positionSource),
            prediction: {
              present: prediction != null, physicsStatePresent: prediction?.physicsState != null,
              position: finite(prediction?.position) ? copy(prediction.position) : null,
              feetPosition: finite(seedFeet) ? copy(seedFeet) : null,
              matchesPosition, feetMatchPosition, velocityFinite: finite(seed?.velocity),
              seedEligible: matchesPosition === true && finite(seed?.velocity), onGround: typeof seed?.onGround === 'boolean' ? seed.onGround : null
            }
          },
          stateReadError
        }
      } catch { /* Diagnostics cannot replace the original preview result. */ }
    }
    lastPreviewTiming = { at: Date.now(), elapsedMs: performance.now() - previewStarted, ready: result?.ready === true }
    return result
  }

  function packetFor (frame, controls, tick) {
    const predicted = frame.predictedState
    const input = movementInput(controls, previousControls, predicted)
    const packet = buildStationaryInput({ position: frame.packetPosition, pitch: predicted.pitch, yaw: predicted.yaw, tick })
    packet.move_vector = input.vector
    packet.analogue_move_vector = { ...input.vector }
    packet.raw_move_vector = { ...input.vector }
    packet.input_data = input.flags
    packet.delta = copy(predicted.velocity)
    return packet
  }

  function publish (frame, controls, tick, receiptConfirmed = false) {
    const queuedAt = Date.now()
    status.criticalHopQueuedPair = null
    if (status.route?.operation === 'critical_hop' && status.phase === 'moving' && receiptConfirmed && finite(frame.packetPosition)) {
      const current = { criticalHopId: status.criticalHopId, tick: String(tick), queuedAt, position: copy(frame.packetPosition), packetY: Math.fround(frame.packetPosition.y), receiptConfirmed: true, onGround: frame.predictedState.onGround }
      const previous = criticalQueuedFrame
      if (previous && previous.criticalHopId === current.criticalHopId && previous.receiptConfirmed && BigInt(current.tick) === BigInt(previous.tick) + 1n && queuedAt >= previous.queuedAt && queuedAt - previous.queuedAt <= 200) status.criticalHopQueuedPair = { criticalHopId: current.criticalHopId, previous: structuredClone(previous), current: structuredClone(current), deltaY: current.packetY - previous.packetY }
      criticalQueuedFrame = current
    } else criticalQueuedFrame = null
    status.predictedPosition = copy(frame.packetPosition)
    status.predictedFeet = copy(frame.predictedState.position)
    status.sent = sent
    status.tick = String(tick)
    status.queuedTick = String(tick)
    status.queuedAt = queuedAt
    status.queuedReceiptConfirmed = receiptConfirmed === true
    status.waypointIndex = frame.waypointIndex
    status.waypoint = frame.waypoint
    status.controls = { ...controls }
    status.physicsState = structuredClone(frame.predictedState)
    status.velocity = copy(frame.predictedState.velocity)
    status.onGround = frame.predictedState.onGround
    status.settled = frame.settled === true
    if (status.route?.boundedJump) status.boundedJumpLanded = frame.boundedJumpLanded === true
    onPrediction({ position: copy(frame.packetPosition), feetPosition: copy(frame.predictedState.position), velocity: copy(frame.predictedState.velocity), onGround: frame.predictedState.onGround, physicsState: structuredClone(frame.predictedState), controls: { ...controls }, settled: frame.settled === true, tick: String(tick), phase: status.phase, source: 'client_prediction', serverConfirmed: false })
  }

  function clearTimer () {
    if (timer) clearInterval(timer)
    timer = null
  }

  function queuedFrame (receipt, frame, controls, health, modeled) {
    if (!onQueuedFrame) return
    try {
      onQueuedFrame({ tick: receipt?.tick ?? null, receiptConfirmed: receipt?.tick != null, controls: { ...controls }, yaw: frame.predictedState.yaw, pitch: frame.predictedState.pitch, predictedState: structuredClone(frame.predictedState), packetPosition: copy(frame.packetPosition), health, queuedAt: Date.now(), modeled, producer: 'navigation' })
    } catch { /* Prediction evidence cannot change the already queued input. */ }
  }

  function finish (phase, reason, { release = false } = {}) {
    clearTimer()
    if (release && !checkingFrame && active() && lastFrame) {
      try {
        const state = currentState(true)
        const wallTick = anchorTick + BigInt(Math.max(0, Math.floor((clock() - anchorTime) / INTERVAL)))
        const tick = lastTick === null || wallTick > lastTick ? wallTick : lastTick + 1n
        const receipt = client.queue('player_auth_input', packetFor(lastFrame, {}, tick))
        queuedFrame(receipt, lastFrame, {}, state.health, false)
        lastTick = receipt?.tick == null ? tick : BigInt(receipt.tick)
        inputReplay?.clear('unsimulated_release')
        sent++
        status.sent = sent
        status.tick = String(lastTick)
      } catch { /* Do not send a prediction after a correction, damage or disconnect. */ }
    }
    previousControls = {}
    criticalQueuedFrame = null
    status.criticalHopQueuedPair = null
    status.phase = phase
    status.reason = reason
    status.controls = {}
    if (phase === 'stopped' || phase === 'failed') status.queuedReceiptConfirmed = false
    return snapshot()
  }

  function stop (reason = 'Movement stopped') {
    stepper?.stop(reason)
    return finish('stopped', reason, { release: true })
  }

  function resetLifecycle (reason = 'Authoritative lifecycle reset') {
    inputReplay?.clear('authoritative_lifecycle_reset')
    stepper?.stop(reason)
    finish('stopped', reason)
    startDiagnostics = null
    lastPreviewFailure = null
    Object.assign(status, { inputReplay: null, lastAuthoritativePosition: null, target: null, route: null, predictedPosition: null, predictedFeet: null, physicsState: null, velocity: null, onGround: null })
    lastFrame = null
    previousHealth = null
    rawSignature = null
  }

  function fail (error) {
    stepper?.stop(error.message)
    finish('failed', error.message)
    try { onError(error) } catch { /* The owning controller handles its callback failures. */ }
  }

  function emitFrame (tick) {
    const frameStartedAt = performance.now()
    const state = currentState(true)
    const afterState = performance.now()
    const policy = routeSprintPolicy(state, status.sprintRequested === true, status.sprintRouteDry, status.sprintAutomatic)
    if (status.route?.boundedJump) requireJumpHunger(state, policy, status.allowWater, status.emergency)
    Object.assign(status, policy)
    stepper.setSprint?.(policy.sprintAllowed)
    if(correctionRun){if(correctionRun.usedTicks>=correctionRun.maxTicks)throw new Error('Original mixed movement tick limit reached');correctionRun.usedTicks++}
    const frame = stepper.next()
    const afterPhysics = performance.now()
    if (frame.phase === 'failed') throw new Error(frame.reason ?? 'Navigation prediction failed')
    if (!['moving', 'settling', 'awaiting_server_confirmation', 'replan_required'].includes(frame.phase)) throw new Error(`Unexpected navigation phase: ${frame.phase}`)
    if (frame.predictedState.isInLava) throw new Error('Movement stopped before entering lava')
    if (frame.predictedState.isInWater && (!status.allowWater || status.route?.shoreRecenter === true)) throw new Error('Water movement is not enabled for this route')
    if (status.sprintRouteDry === true && status.sprintRequested === true && (frame.predictedState.isInWater || frame.predictedState.swimmingPose || !knownDrySegment(lastFrame?.predictedState.position ?? status.physicsState.position, frame.predictedState.position))) throw new Error('Dry sprint route became wet or unknown before input dispatch; replan required')
    if (collisionWaypoint !== frame.waypointIndex) { collisionFrames = 0; collisionWaypoint = frame.waypointIndex }
    if (frame.predictedState.isCollidedHorizontally) collisionFrames++
    else collisionFrames = 0
    // Swimming toward a known bank can legitimately press against its side
    // while buoyancy and the model's liquid-exit impulse lift the player.
    const collisionLimit = frame.waypoint?.action === 'swim' && status.allowWater ? 40 : frame.waypoint?.action === 'jump' ? 12 : 4
    if (collisionFrames >= collisionLimit) throw new Error('Movement stopped at an unexpected persistent collision')
    const controls = frame.controls ?? {}
    const beforeGuard = performance.now()
    if (beforeInput) {
      checkingFrame = true
      try {
        const checked = beforeInput(structuredClone(frame))
        if (checked && typeof checked.then === 'function') {
          Promise.resolve(checked).catch(() => {})
          throw new Error('Movement frame guard must complete synchronously')
        }
        if (checked === false || !active()) throw new Error('Movement frame guard rejected the proposed input')
      } finally { checkingFrame = false }
    }
    const afterGuard = performance.now()
    const receipt = client.queue('player_auth_input', packetFor(frame, controls, tick))
    queuedFrame(receipt, frame, controls, state.health, true)
    const sentTick = receipt?.tick == null ? tick : BigInt(receipt.tick)
    if (sentTick < tick || sentTick < 0n || getQueuedCursor && (receipt?.tick == null || sentTick !== tick)) throw new Error('The sent input tick receipt is invalid')
    const afterQueue = performance.now()
    lastTick = sentTick
    sent++
    previousControls = { ...controls }
    lastFrame = frame
    if (frame.phase === 'awaiting_server_confirmation' || frame.phase === 'replan_required') {
      status.phase = frame.phase
      status.reason = frame.reason
      clearTimer()
    }
    publish(frame, controls, sentTick, receipt?.tick != null && sentTick === tick)
    inputReplay?.record({ tick: sentTick, controls, yaw: frame.predictedState.yaw, pitch: frame.predictedState.pitch, physicsState: frame.predictedState, scope: { connectionId: state.connectionId, dimension: state.dimension, runtimeEntityId: state.runtimeEntityId }, health: state.health })
    const completed = performance.now()
    const samples = { stateMs: afterState - frameStartedAt, physicsMs: afterPhysics - afterState, beforeInputMs: afterGuard - beforeGuard, queueMs: afterQueue - afterGuard, publishMs: completed - afterQueue, totalMs: completed - frameStartedAt }
    status.maxFrameTimings ??= { stateMs: 0, physicsMs: 0, beforeInputMs: 0, queueMs: 0, publishMs: 0, totalMs: 0 }
    for (const [key, value] of Object.entries(samples)) status.maxFrameTimings[key] = Math.max(status.maxFrameTimings[key] ?? 0, value)
  }

  function flush () {
    if (!active()) return
    try {
      currentState(true)
      const time = clock()
      if (Number.isFinite(time) && lastTime !== null) status.lastTimerGapMs = Math.max(0, time - lastTime)
      // A callback late in its 50ms bucket can cross four tick boundaries in
      // less than 200ms. Bound both wall time and the number of due inputs.
      if (!Number.isFinite(time) || (lastTime !== null && (time < lastTime || time - lastTime > 200))) throw new Error('Movement input timer stalled')
      const targetTick = anchorTick + BigInt(Math.max(0, Math.floor((time - anchorTime) / INTERVAL)))
      if (lastTick === null) emitFrame(targetTick)
      else {
        const elapsed = targetTick - lastTick
        if (elapsed > 4n) throw new Error('Too many movement ticks were missed')
        for (let count = 0; count < Number(elapsed) && active(); count++) emitFrame(lastTick + 1n)
      }
      lastTime = time
    } catch (error) { fail(error) }
  }

  function begin (prepared, nextStepper, phase) {
    if (active()) throw new Error('Movement is already running')
    criticalQueuedFrame = null
    status.criticalHopQueuedPair = null
    let cursor = null; let cursorAge = null
    if (getQueuedCursor) {
      const value = getQueuedCursor()
      if (value != null) {
        try { cursor = BigInt(value.tick) } catch { throw new Error('Queued movement cursor is invalid') }
        cursorAge = Date.now() - value.queuedAt
        if (measuringStart) measuringStart.beginCursor = { tick: String(value.tick), queuedAt: value.queuedAt, ageMs: cursorAge }
        const targetTick = anchorTick + BigInt(Math.max(0, Math.floor((clock() - anchorTime) / INTERVAL)))
        if (cursor < 0n || !Number.isFinite(value.queuedAt) || !Number.isFinite(cursorAge) || cursorAge < 0 || cursorAge > 200) throw new Error('Queued movement handoff timer stalled')
        if (targetTick - cursor > 4n) throw new Error('Too many queued movement handoff ticks were missed')
      }
    }
    correctionRun=null
    if(replanMixedAfterReplay&&prepared.continueAfterReplay&&typeof prepared.beforeInput==='function'&&prepared.allowWater&&(prepared.initial.isInWater===true||prepared.route.waypoints.some(w=>w.medium==='water'))&&prepared.route.waypoints.some(w=>w.medium==='land')){
      const scope=fullCorrectionScope(prepared.state)
      if(!scope)throw new Error('Trusted mixed replay requires full actual life scope')
      correctionRun={scope,health:prepared.state.health,target:copy(prepared.route.target),options:structuredClone(prepared.replanOptions),maxTicks:prepared.tickLimit,usedTicks:0,replans:0,deadline:clock()+prepared.tickLimit*INTERVAL}
    }
    navigator = prepared.candidate
    if (!inputReplay || replayPhysics !== navigator.physics) {
      replayPhysics = navigator.physics
      inputReplay = createInputReplay({ physics: replayPhysics })
    }
    stepper = nextStepper
    startDiagnostics = { phase, sentBeforeStart: sent, routeOperation: prepared.route.operation ?? 'navigate', requestedSprint: prepared.sprintRequested === true, sprintAllowed: prepared.sprintAllowed === true, requestedDirectSurface: prepared.requestedDirectSurface === true, initialPhysicsState: structuredClone(prepared.initial) }
    beforeInput = prepared.beforeInput ?? null
    previousControls = prepared.route.operation === 'critical_hop' ? { ...prepared.initial.controls } : {}
    previousHealth = prepared.state.health
    rawSignature = signature(prepared.state)
    dimension = prepared.state.dimension
    jumpScope = prepared.route.boundedJump ? JSON.stringify([prepared.state.profile ?? null, prepared.state.realm?.id ?? null, prepared.state.dimension ?? null, prepared.state.connectionId ?? null, prepared.state.startedAt ?? null, prepared.state.runtimeEntityId ?? null]) : null
    lastTime = cursor === null ? null : clock() - cursorAge
    // Skip idle time without simulating it, while preserving monotonic ticks if
    // an operation is stopped and immediately restarted in the same frame.
    const currentTick = anchorTick + BigInt(Math.max(0, Math.floor((clock() - anchorTime) / INTERVAL)))
    if (cursor !== null) lastTick = cursor
    else if (lastTick === null || lastTick < currentTick) lastTick = currentTick - 1n
    lastFrame = null
    collisionFrames = 0
    collisionWaypoint = null
    status = {
      phase, target: copy(prepared.route.target), route: structuredClone(prepared.route),
      predictedPosition: copy(prepared.state.position), predictedFeet: copy(prepared.initial.position),
      lastAuthoritativePosition: copy(prepared.state.position), sent, tick: null, reason: null,
      serverConfirmed: false, requiresServerConfirmation: true, allowWater: prepared.allowWater,
      criticalHopId: prepared.criticalHopId ?? null,
      queuedTick: null, queuedAt: null, queuedReceiptConfirmed: false, criticalHopQueuedPair: null,
      physicsState: structuredClone(prepared.initial), velocity: copy(prepared.initial.velocity), onGround: prepared.initial.onGround, settled: false, emergency: prepared.emergency === true, continueAfterReplay: prepared.continueAfterReplay === true && typeof beforeInput === 'function', sprintRouteDry: prepared.sprintRouteDry ?? null, sprintAutomatic: prepared.sprintAutomatic === true, ...routeSprintPolicy(prepared.state, prepared.sprintRequested === true, prepared.sprintRouteDry, prepared.sprintAutomatic)
    }
    flush()
    if (active()) timer = setInterval(flush, INTERVAL)
    return snapshot()
  }

  function start (target, options = {}) {
    const started = performance.now(), timing = { at: Date.now(), target: finite(target) ? copy(target) : null, outcome: 'preparing', entryCursor: null }
    lastStartTiming = timing
    try { const value = getQueuedCursor?.(); if (value) timing.entryCursor = { tick: String(value.tick), queuedAt: value.queuedAt, ageMs: Date.now() - value.queuedAt } } catch (error) { timing.entryCursorError = String(error.message ?? error).slice(0, 120) }
    measuringStart = timing
    let mark = performance.now()
    try {
      if (active()) throw new Error('Movement is already running')
      const prepared = prepare(target, options)
      timing.prepareMs = performance.now() - mark
      if (!prepared.route.ready) throw new Error(prepared.route.reason ?? 'No safe navigation route')
      const maxTicks = options.maxTicks ?? 400
      if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 1200) throw new Error('maxTicks must be between 1 and 1200')
      mark = performance.now()
      prepared.tickLimit=maxTicks
      prepared.replanOptions={maxDistance:options.maxDistance??12,maxExpanded:options.maxExpanded??1500,avoidance:prepared.route.avoidance??[],directFlat:options.directFlat??false,directSurface:options.directSurface??false,exactGoal:options.exactGoal??false,partialDrop:options.partialDrop??false,partialRecenter:options.partialRecenter??false,controlledDrop:options.controlledDrop??false,shoreRecenter:options.shoreRecenter??false,stablePartialOrigin:options.stablePartialOrigin??false}
      const nextStepper = prepared.candidate.createStepper(prepared.route, prepared.initial, { maxTicks, sprint: prepared.sprintAllowed })
      timing.stepperMs = performance.now() - mark; mark = performance.now()
      const result = begin(prepared, nextStepper, 'moving')
      timing.beginMs = performance.now() - mark; timing.outcome = 'started'
      return result
    } catch (error) { timing.outcome = 'failed'; timing.error = String(error.message ?? error).slice(0, 200); throw error } finally { timing.elapsedMs = performance.now() - started; measuringStart = null }
  }

  function prepareHop (options = {}) {
    const state = currentState(false, true)
    const candidate = createNavigator({ world, version, allowWater: false, ...(physics ? { physics } : {}) })
    const initial = candidate.physics.fromServer(state)
    const verifyStanding = value => candidate.verifyOrigin(value)
    const proof = previewCriticalHop({ physics: candidate.physics, initial, verifyStanding, aimPoint: options.aimPoint })
    const route = { ...proof, operation: 'critical_hop', origin: copy(initial.position), target: copy(initial.position), waypoints: [{ position: copy(initial.position), action: 'critical_hop' }] }
    return { state, initial, candidate, route, allowWater: false, emergency: true, sprintRequested: false, sprintAllowed: false, verifyStanding }
  }

  function previewHop (options = {}) {
    try { return structuredClone(prepareHop(options).route) } catch (error) { return { ready: false, reason: error.message } }
  }

  function startHop (options = {}) {
    if (active()) throw new Error('Movement is already running')
    const prepared = prepareHop(options)
    if (!prepared.route.ready) throw new Error(prepared.route.reason)
    prepared.criticalHopId = ++criticalHopSequence
    return begin(prepared, createCriticalHopStepper({ physics: prepared.candidate.physics, initial: prepared.initial, verifyStanding: prepared.verifyStanding, getAim: options.getAim, aimPoint: options.aimPoint }), 'moving')
  }

  function settle (options = {}) {
    if (active()) throw new Error('Movement is already running')
    const emergency = options.emergency ?? false
    if (typeof emergency !== 'boolean') throw new Error('emergency must be an explicit boolean')
    const state = currentState(false, emergency)
    const candidate = navigatorFor(false)
    const initial = candidate.physics.fromServer(state, { velocity: options.velocity, onGround: options.onGround })
    const nextStepper = candidate.createSettler(initial, options)
    const route = { ready: true, origin: copy(initial.position), target: nextStepper.snapshot().target, waypoints: [], operation: 'settle', serverConfirmed: false, predictionOnly: true }
    return begin({ state, candidate, initial, route, allowWater: false, emergency }, nextStepper, 'settling')
  }

  function applyPacket (name, packet = {}) {
    // Lifecycle resets also arrive while waiting to replan. Their old input
    // history must not survive merely because no movement timer is active.
    let resetHistory = name === 'close' || name === 'change_dimension'
    if ((name === 'move_player' && (packet.mode === 'teleport' || packet.mode === 2)) || (name === 'respawn' && packet.state === 1)) {
      const ownRuntimeId = getState()?.runtimeEntityId
      const packetRuntimeId = name === 'move_player' ? packet.runtime_id : packet.runtime_entity_id
      resetHistory = ownRuntimeId != null && packetRuntimeId != null && String(packetRuntimeId) === String(ownRuntimeId)
    }
    if (resetHistory) inputReplay?.clear('authoritative_lifecycle_reset')
    if (!active()) return
    const state = getState()
    if (name === 'close') { finish('stopped', 'Connection closed'); return }
    if (name === 'update_attributes') {
      if (String(packet.runtime_entity_id) !== state.runtimeEntityId) return
      const health = packet.attributes?.find(attribute => attribute.name === 'minecraft:health')?.current
      if (Number.isFinite(health) && (health <= (status.emergency ? 0 : resourceMinHealth({ ...state, health })) || health < previousHealth && state.combatMotion !== true)) fail(new Error('Movement stopped because the bot took damage'))
      return
    }
    if (name === 'move_player' && String(packet.runtime_id) !== state.runtimeEntityId) return
    if (name === 'respawn' && String(packet.runtime_entity_id) !== state.runtimeEntityId) return
    if (!['move_player', 'correct_player_move_prediction', 'server_post_move', 'change_dimension', 'respawn'].includes(name)) return
    try {
      if (finite(packet.position)) {
        status.lastAuthoritativePosition = copy(packet.position)
        if (name === 'correct_player_move_prediction' && inputReplay && lastTick != null) {
          const correction = normalizePlayerCorrection(packet, { version, currentInputTick: lastTick, historyAvailable: true })
          const replay = inputReplay.reconcile(correction, { scope: { connectionId: state.connectionId, dimension: state.dimension, runtimeEntityId: state.runtimeEntityId }, health: state.health, currentInputTick: lastTick })
          status.inputReplay = { accepted: replay.accepted, code: replay.code ?? null, correctionTick: replay.correctionTick ?? null, currentTick: replay.replayedToTick ?? null, replayedTicks: replay.replayedTicks ?? 0 }
          if (replay.accepted) {
            let resumed = status.continueAfterReplay && status.phase === 'moving' && status.allowWater && timer !== null ? stepper.resumeReplay?.(replay.physicsState) : null
            if(resumed?.accepted!==true&&correctionRun)resumed=replanAcceptedMixedReplay(replay,state)
            status.inputReplay.replanned=resumed?.replanned===true
            status.inputReplay.continued = resumed?.accepted === true
            if (resumed?.reason) status.inputReplay.continuationRejected = resumed.reason
            if (!status.inputReplay.continued) stepper.reconcile(replay.physicsState)
            status.predictedPosition = copy(replay.position); status.predictedFeet = copy(replay.physicsState.position)
            status.physicsState = structuredClone(replay.physicsState); status.velocity = copy(replay.physicsState.velocity); status.onGround = replay.physicsState.onGround
            onPrediction({ position: copy(replay.position), feetPosition: copy(replay.physicsState.position), velocity: copy(replay.physicsState.velocity), onGround: replay.physicsState.onGround, physicsState: structuredClone(replay.physicsState), tick: replay.replayedToTick, correctionTick: replay.correctionTick, replayedTicks: replay.replayedTicks, source: 'corrected_input_replay', serverConfirmed: false })
            if (status.inputReplay.continued) {
              lastFrame = { ...lastFrame, ...resumed.frame }
              rawSignature = signature(state)
            } else finish('replan_required', 'Server correction replayed through sent input; replan from the corrected present prediction')
            return { replayed: true, continued: status.inputReplay.continued, correctionTick: replay.correctionTick, currentTick: replay.replayedToTick }
          }
        }
        const authoritative = navigator.physics.fromServer({ ...state, position: packet.position }, { velocity: packet.delta ?? packet.velocity ?? { x: 0, y: 0, z: 0 }, onGround: packet.on_ground ?? false })
        stepper.reconcile(authoritative)
      } else stepper.stop('Authoritative lifecycle update')
      // Never answer a correction with the old prediction.
      finish('replan_required', 'Authoritative server update received; replan from the server position')
    } catch (error) { fail(error) }
  }

  function snapshot () { return structuredClone({ ...status, correctionReplan:correctionRun?{replans:correctionRun.replans,usedTicks:correctionRun.usedTicks,maxTicks:correctionRun.maxTicks,deadline:correctionRun.deadline}:null, timingDiagnostics: { preview: lastPreviewTiming, start: lastStartTiming }, running: timer !== null && active() }) }
  return { preview, start, previewHop, startHop, settle, stop, resetLifecycle, applyPacket, snapshot, stats: snapshot, diagnostics: () => startDiagnostics || lastPreviewFailure ? structuredClone({ ...startDiagnostics, lastPreviewFailure }) : null }
}

module.exports = { createMovement, movementInput }
