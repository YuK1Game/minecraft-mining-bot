'use strict'

// One ordinary, stationary jump and one ordinary dirt placement. All movement
// uses Runtime's existing input stream; this controller never owns a timer or
// queues player_auth_input itself.
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const POSE_SOURCES = new Set(['move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'])
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|pointed_dripstone|sand$|gravel$/
const FEET = 1.62
const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const key = p => `${p.x},${p.y},${p.z}`
const scopeOf = s => JSON.stringify([s.profile ?? null, String(s.realm?.id ?? ''), s.connectionId ?? null, s.startedAt ?? null, s.dimension ?? null, String(s.runtimeEntityId ?? ''), s.lifecycle?.deathId ?? null])
const dirtTotal = s => (s.inventory?.items ?? []).filter(i => i.name === 'minecraft:dirt' && Number.isInteger(i.count) && i.count > 0).reduce((n, i) => n + i.count, 0)
const isAir = b => b?.known === true && AIR.has(b.name) && !b.extra?.length

// rawServerPosition is copied from received Host state by workingSnapshot.
// A motion hint, a queued tick, or a prediction is deliberately not a pose.
function serverPose (s) {
  if (finite(s?.rawServerPosition) && s.rawServerPositionUpdatedAt != null) return { position: copy(s.rawServerPosition), stamp: s.rawServerPositionUpdatedAt, source: 'raw_server_position' }
  if (finite(s?.position) && POSE_SOURCES.has(s.positionSource) && s.positionUpdatedAt != null && s.positionServerConfirmed !== false) return { position: copy(s.position), stamp: s.positionUpdatedAt, source: s.positionSource }
  return null
}
function atFeet (pose, feet, tolerance = 0.1) {
  return !!pose && Math.hypot(pose.position.x - feet.x, pose.position.z - feet.z) <= 0.18 && Math.abs(pose.position.y - FEET - feet.y) <= tolerance
}
const moment = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
function workingFeet (s) { return finite(s?.position) ? { x: s.position.x, y: s.position.y - FEET, z: s.position.z } : null }
function usableServerPose (s, feet, now = Date.now(), requireFresh = false) {
  const pose = serverPose(s)
  if (!atFeet(pose, feet)) return null
  if (requireFresh) {
    const stamp = moment(pose.stamp), working = workingFeet(s)
    if (!Number.isFinite(stamp) || now - stamp < -50 || now - stamp > 200 || !working || Math.hypot(working.x - pose.position.x, working.y - pose.position.y + FEET, working.z - pose.position.z) > 0.05) return null
  }
  return pose
}
function validPositionVolume (receipt, feet, startedAt, now, expectedScope) {
  const received = moment(receipt?.receivedAt)
  return receipt?.serverConfirmed === true && receipt.kind === 'server_position_volume' && receipt.scope === expectedScope && finite(receipt.feet) && ['x', 'y', 'z'].every(k => Math.abs(receipt.feet[k] - feet[k]) <= 1e-5) && Number.isFinite(receipt.radius) && receipt.radius > 0 && receipt.radius <= 0.12 && typeof receipt.requestId === 'string' && receipt.requestId.length > 0 && Number.isFinite(received) && received >= startedAt && received <= now + 50 && now - received <= 1000
}
function withinPositionVolume (point, receipt) { return finite(point) && Math.hypot(point.x - receipt.feet.x, point.y - receipt.feet.y, point.z - receipt.feet.z) <= receipt.radius + 1e-5 }

function createQuarryPillar ({ getState, getBlock, getPhysics, getInput, equipDirt, placeBlock, cancelPlace, acquireInput, ownsInput, releaseInput, onPrediction = () => {}, confirmPosition = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 6000, pollMs = 20 } = {}) {
  if ([getState, getBlock, getPhysics, getInput, equipDirt, placeBlock, cancelPlace, acquireInput, ownsInput, releaseInput, onPrediction, now, sleep].some(fn => typeof fn !== 'function')) throw new Error('Pillar requires live physics, owned input and confirmed ordinary placement ports')
  if (confirmPosition !== null && typeof confirmPosition !== 'function') throw new Error('Position confirmation must be an explicit oracle callback')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || !Number.isFinite(pollMs) || pollMs < 1) throw new Error('Invalid pillar bounds')
  let active = null
  let preparing = false
  let preparingReason = null
  let last = null
  const positionRequests = new Set()

  async function positionVolume (feet, options, verify) {
    const started = now(), receipt = await confirmPosition(copy(feet), options)
    const verified = verify()
    if (!validPositionVolume(receipt, feet, started, now(), scopeOf(verified ?? getState())) || positionRequests.has(receipt.requestId)) throw new Error('ASCENT_POSITION_UNCONFIRMED')
    positionRequests.add(receipt.requestId)
    return copy(receipt)
  }

  function check (run) {
    if (active !== run || run.cancelled || run.signal?.aborted) throw Object.assign(new Error(run.reason ?? 'ASCENT_INTERRUPTED'), { code: run.reason ?? 'ASCENT_INTERRUPTED' })
    const s = getState()
    if (scopeOf(s) !== run.scope) throw Object.assign(new Error('ASCENT_SCOPE_CHANGED'), { code: 'ASCENT_SCOPE_CHANGED' })
    if (s.dead || s.isDead || s.lifecycle?.dead || s.phase !== 'spawned' || !(s.health > 0)) throw Object.assign(new Error('ASCENT_NOT_ALIVE'), { code: 'ASCENT_NOT_ALIVE' })
    if (s.inventory?.known !== true || s.inventory.uncertain) throw Object.assign(new Error('ASCENT_INVENTORY_UNKNOWN'), { code: 'ASCENT_INVENTORY_UNKNOWN' })
    if (s.health < run.health) throw Object.assign(new Error('ASCENT_DAMAGED'), { code: 'ASCENT_DAMAGED' })
    if (run.input && (getInput() !== run.input || !ownsInput(run.token, run.input))) throw Object.assign(new Error('ASCENT_INPUT_CHANGED'), { code: 'ASCENT_INPUT_CHANGED' })
    const pose = serverPose(s)
    if (run.input && pose && pose.stamp !== run.lastPoseStamp) {
      run.lastPoseStamp = pose.stamp
      const observedFeet = { ...pose.position, y: pose.position.y - FEET }
      if (Math.hypot(observedFeet.x - run.physical.position.x, observedFeet.y - run.physical.position.y, observedFeet.z - run.physical.position.z) > 0.3) throw Object.assign(new Error('ASCENT_SERVER_CORRECTION'), { code: 'ASCENT_SERVER_CORRECTION' })
    }
    return s
  }
  function dryVolume (state) {
    if (state.isInWater || state.isInLava || state.isInWeb || state.flying || state.elytraFlying || state.riding || state.swimmingPose) throw new Error('ASCENT_UNSAFE_BODY')
    for (let x = Math.floor(state.position.x - 0.299); x <= Math.floor(state.position.x + 0.299); x++) for (let z = Math.floor(state.position.z - 0.299); z <= Math.floor(state.position.z + 0.299); z++) for (let y = Math.floor(state.position.y + 0.0001); y <= Math.floor(state.position.y + 1.7999); y++) {
      if (!isAir(getBlock(x, y, z))) throw new Error('ASCENT_HEADSPACE_CHANGED')
    }
  }
  function frame ({ state: inputState, rotation = {}, tick } = {}) {
    const run = active
    if (!run?.input || run.cancelled || run.failure) return null
    try {
      check(run)
      if (++run.ticks > 40 && !run.landed) throw new Error('ASCENT_JUMP_TIMEOUT')
      const controls = { jump: run.ticks === 1 }
      run.physical = run.physics.step({ ...run.physical, yaw: rotation.yaw ?? run.physical.yaw, pitch: rotation.pitch ?? run.physical.pitch }, controls)
      if (Math.hypot(run.physical.position.x - run.centre.x, run.physical.position.z - run.centre.z) > 0.15) throw new Error('ASCENT_LEFT_COLUMN')
      dryVolume(run.physical)
      run.airborne ||= run.physical.onGround === false
      const wasLanded = run.landed
      run.landed = run.airborne && run.physical.onGround === true
      if (run.landed && !wasLanded) run.landingStamp = serverPose(getState())?.stamp ?? null
      if (run.landed && Math.abs(run.physical.position.y - (run.target.y + 1)) > 0.1) throw new Error('ASCENT_RETURNED_TO_ORIGIN')
      const predicted = copy(run.physical), position = run.physics.toServerPosition(predicted)
      run.expectedTick = tick == null ? null : String(tick)
      run.inputWorkingFeetY = Number.isFinite(inputState?.position?.y) ? inputState.position.y - FEET : null
      return { position, delta: copy(predicted.velocity), physicsState: predicted, predictedState: predicted, controls,
        inputFlags: controls.jump ? ['jumping', 'want_up', 'start_jumping'] : [],
        commitPrediction: () => {
          if (active === run && !run.cancelled && ownsInput(run.token, run.input)) {
            onPrediction({ position, feetPosition: copy(predicted.position), velocity: copy(predicted.velocity), onGround: predicted.onGround, physicsState: predicted, source: 'client_prediction', serverConfirmed: false })
            const recorded = run.checkpoint.diagnostics.frames.find(f => f.tick === String(tick))
            if (recorded) recorded.predictionCommittedAt = now()
          }
        } }
    } catch (error) {
      run.failure = error.code ?? error.message
      run.checkpoint.diagnostics.frameFailure = { tick: tick == null ? null : String(tick), at: now(), reason: String(run.failure).slice(0, 300), modelFeetY: run.physical?.position?.y ?? null }
      return null
    }
  }
  function onQueuedFrame (queued) {
    const run = active
    if (!run?.input || run.cancelled || run.failure || queued?.producer !== 'input') return
    if (queued.modeled !== true || queued.receiptConfirmed !== true || queued.tick == null || String(queued.tick) !== run.expectedTick) { run.failure = 'ASCENT_INPUT_RECEIPT_UNCONFIRMED'; return }
    run.lastQueued = { tick: String(queued.tick), position: copy(queued.packetPosition) }
    const physical = queued.predictedState
    if (!run.placeAttempted && physical?.onGround === false && physical.position?.y > run.target.y + 1.0001 && physical.position.y <= run.target.y + 1.29) {
      run.placeAttempted = true
      run.checkpoint.phase = 'placement_pending'
      run.checkpoint.queuedTick = String(queued.tick)
      run.checkpoint.diagnostics.placementTriggeredAt = now()
      run.checkpoint.diagnostics.placementTriggeredTick = String(queued.tick)
      // Input commits its prediction after onQueuedFrame. The ordinary place
      // oracle must see that committed, non-overlapping airborne body.
      run.placement = Promise.resolve().then(() => {
        const state = check(run)
        run.checkpoint.diagnostics.placementStartedAt = now()
        run.checkpoint.diagnostics.placementStartedWorkingFeetY = Number.isFinite(state.position?.y) ? state.position.y - FEET : null
        return placeBlock({ position: copy(run.target), slot: run.slot, face: 1 })
      }).then(result => {
        run.placeResult = result
        Object.assign(run.checkpoint.diagnostics, { placementRespondedAt: now(), placementResponse: { phase: result?.phase ?? null, confirmedBy: result?.confirmedBy ?? null } })
      }, error => {
        run.placeError = error.code ?? error.message
        Object.assign(run.checkpoint.diagnostics, { placementRespondedAt: now(), placementResponse: { phase: 'failed', reason: String(run.placeError).slice(0, 300) } })
      })
    }
    // Bounded diagnostics only: these are sent-model frames, not extra world or
    // position evidence. Read one received cell, never another full snapshot.
    let block = null
    try { block = getBlock(run.target.x, run.target.y, run.target.z) } catch {}
    const frames = run.checkpoint.diagnostics.frames
    frames.push({ tick: String(queued.tick), feetY: physical?.position?.y ?? null, velocityY: physical?.velocity?.y ?? null, queuedAt: Number.isFinite(queued.queuedAt) ? queued.queuedAt : now(), workingFeetYBeforeFrame: run.inputWorkingFeetY, jump: queued.controls?.jump === true, jumpStart: run.ticks === 1 && queued.controls?.jump === true, placementAttempted: run.placeAttempted, placedBlock: block?.known === true && block.name === 'minecraft:dirt', blockKnown: block?.known === true, blockName: block?.known === true ? block.name : null, landed: run.landed === true })
    if (frames.length > 16) frames.splice(0, frames.length - 16)
  }
  function cancel (reason = 'ASCENT_INTERRUPTED') {
    const run = active
    if (!run) { if (preparing) preparingReason = String(reason); return }
    run.cancelled = true; run.reason = String(reason)
    if (run.input && getInput() === run.input && ownsInput(run.token, run.input)) {
      if (run.placeAttempted) cancelPlace(run.reason)
      releaseInput(run.token, run.input)
    }
  }
  async function step (request, { signal, onCheckpoint = async () => {} } = {}) {
    if (active || preparing) return { status: 'blocked', reason: 'ASCENT_BUSY', serverConfirmed: false, checkpoint: copy(request?.checkpoint ?? null) }
    const column = request?.column, feetY = request?.feetY
    if (!column || !Number.isSafeInteger(column.x) || !Number.isSafeInteger(column.z) || !Number.isSafeInteger(feetY)) throw new Error('Pillar needs an integer column and feetY')
    const target = { x: column.x, y: feetY, z: column.z }, centre = { x: column.x + 0.5, y: feetY, z: column.z + 0.5 }
    const prior = request.checkpoint
    if (prior && key(prior.target ?? {}) !== key(target)) return { status: 'blocked', reason: 'ASCENT_CHECKPOINT_MISMATCH', serverConfirmed: false, checkpoint: copy(prior) }
    if (prior?.phase === 'completed' && prior.serverConfirmed === true) {
      try {
        const s = getState(), expected = { ...centre, y: feetY + 1 }, block = getBlock(target.x, target.y, target.z)
        if (scopeOf(s) !== prior.scope || block?.known !== true || block.name !== 'minecraft:dirt') throw new Error('ASCENT_CHECKPOINT_CHANGED')
        if (!usableServerPose(s, expected, now(), !!confirmPosition)) {
          if (!confirmPosition) throw new Error('ASCENT_CHECKPOINT_CHANGED')
          const receipt = await positionVolume(expected, { signal, operationId: request.operationId }, () => { if (signal?.aborted || scopeOf(getState()) !== prior.scope) throw new Error('ASCENT_SCOPE_CHANGED') })
          return { status: 'completed', serverConfirmed: true, checkpoint: { ...copy(prior), positionVolume: receipt }, reused: true }
        }
        return { status: 'completed', serverConfirmed: true, checkpoint: copy(prior), reused: true }
      } catch (error) { return { status: 'blocked', reason: error.code ?? error.message, serverConfirmed: false, checkpoint: copy(prior) } }
    }
    // An unfinished persisted intent might have reached the server. Replaying it
    // automatically risks a second placement or inventing a consumption receipt.
    if (prior) return { status: 'blocked', reason: 'ASCENT_UNCERTAIN_STEP', serverConfirmed: false, checkpoint: copy(prior) }
    let run
    preparing = true; preparingReason = null
    try {
      let s = getState()
      if (signal?.aborted) throw new Error('ASCENT_INTERRUPTED')
      if (s.phase !== 'spawned' || s.dead || s.isDead || !(s.health > 0)) throw new Error('ASCENT_ORIGIN_UNCONFIRMED')
      const initialScope = scopeOf(s), initialHealth = s.health
      const verifyOriginState = () => {
        const current = getState()
        if (signal?.aborted || preparingReason) throw new Error(preparingReason ?? 'ASCENT_INTERRUPTED')
        if (scopeOf(current) !== initialScope || current.phase !== 'spawned' || current.dead || current.isDead || current.lifecycle?.dead || !(current.health > 0) || current.health < initialHealth) throw new Error('ASCENT_ORIGIN_CHANGED')
        return current
      }
      const resolveOrigin = async (current, refusedReason = 'ASCENT_ORIGIN_UNCONFIRMED') => {
        const pose = usableServerPose(current, centre, now(), !!confirmPosition)
        if (pose) return { state: current, pose, modelPosition: copy(pose.position), evidence: { kind: 'server_position', position: copy(pose.position), stamp: pose.stamp } }
        if (!confirmPosition) throw new Error(refusedReason)
        const receipt = await positionVolume(centre, { signal, operationId: request.operationId }, verifyOriginState)
        const latest = verifyOriginState()
        if (!withinPositionVolume(workingFeet(latest), receipt)) throw new Error('ASCENT_MODEL_OUTSIDE_CONFIRMED_VOLUME')
        return { state: latest, pose: serverPose(latest), modelPosition: copy(latest.position), evidence: receipt }
      }
      const beforeEquip = await resolveOrigin(s)
      s = beforeEquip.state
      if (s.inventory?.known !== true || s.inventory.uncertain) throw new Error('ASCENT_INVENTORY_UNKNOWN')
      const floor = getBlock(target.x, target.y - 1, target.z)
      if (floor?.known !== true || floor.boundingBox !== 'block' || floor.extra?.length || HAZARD.test(floor.name)) throw new Error('ASCENT_SUPPORT_UNCONFIRMED')
      for (let y = feetY; y <= feetY + 3; y++) if (!isAir(getBlock(target.x, y, target.z))) throw new Error('ASCENT_HEADSPACE_BLOCKED')
      const dirt = s.inventory.items.filter(i => i.name === 'minecraft:dirt' && i.count > 0).sort((a, b) => a.slot - b.slot)[0]
      if (!dirt) throw new Error('EXIT_DIRT_REQUIRED')
      verifyOriginState()
      const equipped = await equipDirt(dirt.slot, { signal })
      const origin = await resolveOrigin(verifyOriginState(), 'ASCENT_ORIGIN_CHANGED'), latest = origin.state, latestPose = origin.pose
      const slot = equipped?.slot ?? (dirt.slot <= 8 ? dirt.slot : null)
      const held = latest.inventory?.items?.find(i => i.slot === slot)
      if (!Number.isInteger(slot) || slot < 0 || slot > 8 || held?.name !== 'minecraft:dirt' || !(held.count > 0) || latest.inventory?.known !== true || latest.inventory.uncertain || scopeOf(latest) !== scopeOf(s)) throw new Error('ASCENT_DIRT_EQUIP_UNCONFIRMED')
      // This remains a physics model seed inside a server-confirmed volume;
      // the volume centre is never written as an exact received player pose.
      const physics = getPhysics(), physical = physics.fromServer({ ...latest, position: origin.modelPosition, predicted: null, physicsState: null })
      if (physical.onGround !== true || Math.hypot(physical.velocity.x, physical.velocity.z) > 0.01) throw new Error('ASCENT_ORIGIN_UNSETTLED')
      const checkpoint = { version: 1, jobId: request.jobId, operationId: request.operationId, target, phase: 'intent', beforeDirt: dirtTotal(latest), slot, stackId: held.stackId ?? null, beforeCount: held.count, originStamp: latestPose?.stamp ?? null, originPositionEvidence: copy(origin.evidence), modelSeedSource: origin.evidence.kind === 'server_position_volume' ? 'working_prediction_with_server_position_volume' : 'received_server_position', modelSeedPosition: copy(origin.modelPosition), scope: scopeOf(latest), serverConfirmed: false,
        diagnostics: { startedAt: now(), framesPredictionOnly: true, frames: [], placementTriggeredAt: null, placementStartedAt: null, placementRespondedAt: null } }
      await onCheckpoint(copy(checkpoint))
      if (signal?.aborted || preparingReason) throw new Error(preparingReason ?? 'ASCENT_INTERRUPTED')
      run = { token: {}, target, centre, scope: scopeOf(latest), health: latest.health, signal, physics, physical, slot, checkpoint, lastPoseStamp: latestPose?.stamp ?? null, ticks: 0, airborne: false, landed: false, placeAttempted: false, input: null }
      active = run
      check(run)
      await acquireInput({ token: run.token, operationId: request.operationId })
      run.input = getInput(); check(run)
      const deadline = now() + timeoutMs
      run.input.start()
      for (;;) {
        const current = check(run)
        if (run.failure) throw new Error(run.failure)
        if (run.placeError) throw new Error('ASCENT_PLACEMENT_UNCONFIRMED')
        const block = getBlock(target.x, target.y, target.z), currentPose = usableServerPose(current, { ...centre, y: feetY + 1 }, now(), !!confirmPosition)
        const placed = run.placeResult?.phase === 'completed' && run.placeResult.confirmedBy === 'server_block_and_inventory' && block?.known === true && block.name === 'minecraft:dirt' && dirtTotal(current) === checkpoint.beforeDirt - 1
        const rawConfirmed = currentPose && currentPose.stamp !== checkpoint.originStamp && currentPose.stamp !== run.landingStamp
        if (placed && run.landed && !rawConfirmed && confirmPosition && !run.positionVolume) {
          run.positionVolume = await positionVolume({ ...centre, y: feetY + 1 }, { signal, operationId: request.operationId }, () => check(run))
          if (run.failure || now() >= deadline) throw new Error('ASCENT_POSITION_UNCONFIRMED')
          continue
        }
        if (placed && run.landed && (rawConfirmed || run.positionVolume)) {
          Object.assign(checkpoint, { phase: 'completed', serverConfirmed: true, confirmedBy: rawConfirmed ? 'server_block_inventory_and_position' : 'server_block_inventory_and_position_volume', afterDirt: dirtTotal(current) })
          if (rawConfirmed) Object.assign(checkpoint, { position: copy(currentPose.position), positionStamp: currentPose.stamp })
          else Object.assign(checkpoint, { positionVolume: copy(run.positionVolume), modelLandingFeet: copy(run.physical.position) })
          await onCheckpoint(copy(checkpoint))
          last = { status: 'completed', serverConfirmed: true, checkpoint: copy(checkpoint) }
          return copy(last)
        }
        if (now() >= deadline) throw new Error(placed ? 'ASCENT_POSITION_UNCONFIRMED' : 'ASCENT_PLACEMENT_UNCONFIRMED')
        await sleep(pollMs)
      }
    } catch (error) {
      if (run && !run.placeAttempted) run.checkpoint.phase = 'not_sent'
      if (run) {
        Object.assign(run.checkpoint.diagnostics, { failedAt: now(), failureReason: String(error.code ?? error.message).slice(0, 300) })
        try {
          const state = getState(), pose = serverPose(state)
          run.checkpoint.diagnostics.failureObservation = { workingFeetY: Number.isFinite(state.position?.y) ? state.position.y - FEET : null, rawFeetY: pose ? pose.position.y - FEET : null, rawStamp: pose?.stamp ?? null, inventoryKnown: state.inventory?.known === true, inventoryUncertain: state.inventory?.uncertain === true, dirt: dirtTotal(state) }
        } catch {}
      }
      last = { status: 'blocked', reason: error.code ?? error.message, serverConfirmed: false, checkpoint: copy(run?.checkpoint ?? prior ?? null) }
      return copy(last)
    } finally {
      if (run && active === run) {
        if (run.input && getInput() === run.input && ownsInput(run.token, run.input)) {
          if (run.placeAttempted && run.checkpoint.phase !== 'completed') cancelPlace('ASCENT_STEP_ENDED')
          releaseInput(run.token, run.input)
        }
        active = null
      }
      preparing = false; preparingReason = null
    }
  }
  return { step, frame, onQueuedFrame, cancel, snapshot: () => ({ busy: active !== null || preparing, phase: active?.checkpoint.phase ?? 'idle', target: active ? copy(active.target) : null, diagnostics: copy(active?.checkpoint.diagnostics ?? last?.checkpoint?.diagnostics ?? null), lastResult: copy(last) }) }
}

module.exports = { createQuarryPillar, serverPose, atFeet, usableServerPose, validPositionVolume, withinPositionVolume, workingFeet }
