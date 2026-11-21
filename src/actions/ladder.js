'use strict'

// A received ladder is a special vertical route. Ordinary walking/mining
// keeps its solid-footing rules. This controller supplies frames to Runtime's
// existing Input; it never starts another packet timer or invents a pose.
const { movementInput } = require('../movement/movement')
const { observedScope } = require('../movement/server-position-verifier')
const { serverPose, usableServerPose, validPositionVolume, withinPositionVolume, workingFeet } = require('../quarry/exit/quarry-pillar')
const { FACE, ladderAt, ladderPlan, landingAt, safeBody, fail } = require('../movement/ladder-geometry')
const { rebaseLadderCorrection, recordLadderFrame } = require('../movement/ladder-correction')
const copy = value => structuredClone(value)
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function createLadderMovement ({ getState, getBlock, getPhysics, getInput, acquireInput, ownsInput, releaseInput, getCorrection = () => null, onPrediction = () => {}, confirmPosition = null, guard = () => true, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = null, pollMs = 25 } = {}) {
  if ([getState, getBlock, getPhysics, getInput, acquireInput, ownsInput, releaseInput, getCorrection, onPrediction, guard, now, sleep].some(fn => typeof fn !== 'function') || confirmPosition != null && typeof confirmPosition !== 'function') throw new Error('Ladder requires live received state, owned Input, physics and position confirmation ports')
  if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000) || !Number.isFinite(pollMs) || pollMs < 1) throw new Error('Invalid ladder bounds')
  let active = null, last = null
  const usedWitnesses = new Set()

  function check (run) {
    if (active !== run || run.cancelled || run.signal?.aborted) fail(run.reason ?? 'LADDER_CANCELLED')
    const state = getState()
    if (!run.scope || observedScope(state) !== run.scope) fail('LADDER_SCOPE_CHANGED')
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || state.spawnPending) fail('LADDER_NOT_ALIVE')
    if (state.health < run.health) fail('LADDER_DAMAGED')
    if (guard(state) !== true) fail('LADDER_PREEMPTED')
    if (run.input && (getInput() !== run.input || !ownsInput(run.token, run.input))) fail('LADDER_INPUT_CHANGED')
    if (run.failure) fail(run.failure)
    if (run.plan) {
      for (let y = run.plan.minY; y <= run.plan.maxY; y++) if (ladderAt(getBlock, { ...run.plan.column, y })?.face !== run.plan.facing) fail('LADDER_CONTINUITY_CHANGED')
      if (!landingAt(getBlock, run.physics, run.plan.to)) fail('LADDER_LANDING_CHANGED')
    }
    const pose = serverPose(state)
    if (run.input && pose && pose.stamp !== run.lastPoseStamp) {
      run.lastPoseStamp = pose.stamp
      const changed = distance({ ...pose.position, y: pose.position.y - 1.62 }, run.physical.position) > 0.18
      if (changed) {
        const correction = getCorrection()
        if (!rebaseLadderCorrection({ run, correction, pose, state, getBlock, now: now() })) {
          run.correctionDiagnostic = { refusal: run.correctionRefusal, phase: run.phase,
            feet: [pose.position.x, pose.position.y - 1.62, pose.position.z].map(value => Number(value.toFixed(4))),
            tick: correction?.tick ?? null,
            oldestQueuedTick: run.sentFrames[0]?.tick ?? null, newestQueuedTick: run.sentFrames.at(-1)?.tick ?? null }
          fail('LADDER_SERVER_CORRECTION')
        }
      }
    }
    return state
  }

  async function confirm (run, feet, origin = false) {
    let state = check(run)
    const raw = usableServerPose(state, feet, now(), true)
    if (raw && (origin || raw.stamp !== run.originStamp)) return { kind: 'server_position', position: copy(raw.position), stamp: raw.stamp, serverConfirmed: true }
    if (!confirmPosition) return null
    const started = now(), receipt = await confirmPosition(copy(feet), { signal: run.signal, operationId: run.operationId, radius: 0.12 })
    state = check(run)
    // The existing radius API serializes a centimetre-rounded centre. Allow
    // only that exact documented rounding, and require the actual requested
    // feet to lie in the returned volume as well. Never move the origin to
    // the centre of its block to satisfy a position witness.
    const wireFeet = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.round(feet[axis] * 100) / 100]))
    const valid = validPositionVolume(receipt, feet, started, now(), run.scope) || validPositionVolume(receipt, wireFeet, started, now(), run.scope)
    if (!valid || usedWitnesses.has(receipt.requestId) || !withinPositionVolume(feet, receipt) || !withinPositionVolume(workingFeet(state), receipt)) fail(origin ? 'LADDER_ORIGIN_UNCONFIRMED' : 'LADDER_POSITION_UNCONFIRMED')
    usedWitnesses.add(receipt.requestId)
    if (usedWitnesses.size > 256) usedWitnesses.delete(usedWitnesses.values().next().value)
    return copy(receipt)
  }

  function steer (run, target, sneak = false, forwardOnly = false) {
    const candidates = forwardOnly ? [{ forward: true }, { forward: true, left: true }, { forward: true, right: true }] : [{}, { forward: true }, { back: true }, { left: true }, { right: true }]
    let best = null
    for (const base of candidates) {
      const holdingSneak = sneak && (!run.physical.onGround || Object.keys(base).length > 0)
      const controls = { ...base, ...(holdingSneak ? { sneak: true } : {}) }
      try {
        const predicted = run.physics.step(run.physical, controls)
        safeBody(getBlock, run.physics, predicted.position, run.replayedCorrections > 0 ? run.plan : null)
        // A short braking lookahead avoids circling the centre with residual
        // airborne velocity when getting on/off a ladder.
        let coast = predicted
        for (let i = 0; i < 3; i++) coast = run.physics.step(coast, holdingSneak ? { sneak: true } : {})
        // Once the received landing is reached, centring by another full
        // walking input can keep alternating a few centimetres across it.
        // Prefer braking when its projected stop stays inside the same
        // arrival radius; the ordinary two settled frames and server witness
        // still decide whether the move completed.
        if (run.phase === 'dismount' && !holdingSneak && !Object.keys(base).length && predicted.onGround && coast.onGround && horizontal(coast.position, target) < 0.075 && Math.abs(coast.position.y - target.y) <= 0.04) return { controls, predicted }
        const score = horizontal(coast.position, target) ** 2 + horizontal(predicted.position, target) ** 2 * 0.1
        if (!best || score < best.score) best = { controls, predicted, score }
      } catch {}
    }
    if (!best) fail('LADDER_NO_SAFE_FRAME')
    return best
  }

  function frame ({ rotation = {}, tick } = {}) {
    const run = active
    if (!run?.input || run.cancelled) return null
    try {
      check(run)
      if (++run.ticks > run.maxTicks) fail('LADDER_INPUT_TIMEOUT')
      run.physical.yaw = rotation.yaw ?? run.physical.yaw
      run.physical.pitch = rotation.pitch ?? run.physical.pitch
      const { plan } = run, p = run.physical.position
      if (run.phase === 'mount' && horizontal(p, plan.centre) <= 0.16) run.phase = 'climb'
      if (run.phase === 'climb') {
        // The wall push leaves upward velocity for two more ticks. Start
        // braking before the floor height so a two-block-high landing does
        // not catch the player's head under its ceiling.
        const atLevel = plan.direction > 0 ? p.y >= plan.climbToY - 0.12 : plan.direction < 0 ? p.y <= plan.climbToY + 0.22 : true
        if (atLevel) run.phase = 'dismount'
      }
      let next
      if (run.phase === 'mount') next = steer(run, plan.centre)
      else if (run.phase === 'climb' && plan.direction > 0) {
        const normal = FACE[plan.facing]
        next = steer(run, { x: plan.centre.x - normal.x * 0.25, z: plan.centre.z - normal.z * 0.25 }, false, true)
      } else if (run.phase === 'climb') next = { controls: {}, predicted: run.physics.step(run.physical, {}) }
      else {
        const near = horizontal(p, plan.to) < 0.3
        // Sneak arrests ladder descent while crossing onto a landing. Once
        // the body clears the ladder, gravity lands it on the received floor.
        const ontoLanding = horizontal(plan.to, plan.centre) > 0.1
        const fineLanding = run.physical.onGround && near && horizontal(p, plan.centre) > 0.85
        next = steer(run, plan.to, ontoLanding && (fineLanding || !run.physical.onGround && (horizontal(p, plan.centre) < 0.7 || near)))
      }
      safeBody(getBlock, run.physics, next.predicted.position, run.replayedCorrections > 0 ? run.plan : null)
      const np = next.predicted.position
      if (np.y < Math.min(plan.from.y, plan.to.y) - 0.35 || np.y > Math.max(plan.from.y, plan.to.y) + 1.25 || horizontal(np, plan.centre) > 1.25) fail('LADDER_LEFT_ROUTE')
      if (horizontal(np, plan.centre) < 0.3 && !next.predicted.onGround && !ladderAt(getBlock, { x: plan.column.x, y: Math.floor(np.y), z: plan.column.z })) fail('LADDER_LOST_CONTACT')
      const settled = run.phase === 'dismount' && !next.controls.sneak && next.predicted.onGround === true && horizontal(np, plan.to) <= 0.08 && Math.abs(np.y - plan.to.y) <= 0.04 && Math.hypot(next.predicted.velocity.x, next.predicted.velocity.z) < 0.008
      run.settledFrames = settled ? run.settledFrames + 1 : 0
      if (distance(run.physical.position, np) < 1e-5 && !settled) run.stalled++
      else run.stalled = 0
      if (run.stalled > 40) fail('LADDER_NO_PROGRESS')
      run.physical = next.predicted
      const wire = movementInput(next.controls, run.previous, next.predicted), predicted = copy(next.predicted), position = run.physics.toServerPosition(predicted)
      run.previous = next.controls; run.expectedTick = String(tick)
      return { position, delta: copy(predicted.velocity), physicsState: predicted, predictedState: predicted, controls: next.controls, moveVector: wire.vector, inputFlags: wire.flags,
        commitPrediction: () => { if (active === run && !run.cancelled && !run.failure && ownsInput(run.token, run.input)) onPrediction({ position, feetPosition: copy(predicted.position), velocity: copy(predicted.velocity), onGround: predicted.onGround, physicsState: predicted, source: 'client_prediction', serverConfirmed: false }) } }
    } catch (error) {
      run.failure = error.code ?? error.message
      // Throwing stops Input before it can fall back to an unguarded neutral
      // frame in the same tick. The operation releases only its own lease.
      throw error
    }
  }

  function onQueuedFrame (queued) {
    const run = active
    if (!run?.input || run.cancelled || queued?.producer !== 'input') return
    if (queued.modeled !== true || queued.receiptConfirmed !== true || String(queued.tick) !== run.expectedTick) { run.failure = 'LADDER_INPUT_RECEIPT_UNCONFIRMED'; return }
    run.queued++
    run.lastQueuedTick = String(queued.tick)
    recordLadderFrame(run.sentFrames, queued)
  }

  function cancel (reason = 'LADDER_CANCELLED') {
    const run = active
    if (!run) return
    run.cancelled = true; run.reason = String(reason)
    if (run.input) releaseInput(run.token, run.input)
  }

  async function move (request, { signal } = {}) {
    if (active) return { status: 'blocked', reason: 'LADDER_BUSY', serverConfirmed: false }
    const state = getState(), run = { token: {}, signal, scope: observedScope(state), health: state.health, operationId: request?.operationId, input: null, phase: 'preparing', ticks: 0, queued: 0, previous: {}, settledFrames: 0, stalled: 0, lastPoseStamp: serverPose(state)?.stamp ?? null, originStamp: serverPose(state)?.stamp ?? null }
    run.sentFrames = []
    run.replayedCorrections = 0
    active = run
    try {
      check(run)
      run.physics = getPhysics(); run.plan = ladderPlan(request, getBlock, run.physics)
      const evidence = await confirm(run, run.plan.from, true)
      if (!evidence) fail('LADDER_ORIGIN_UNCONFIRMED')
      const current = check(run)
      if (horizontal(workingFeet(current), run.plan.from) > 0.12 || Math.abs(workingFeet(current).y - run.plan.from.y) > 0.12) fail('LADDER_ORIGIN_CHANGED')
      if (!landingAt(getBlock, run.physics, workingFeet(current))) fail('LADDER_ORIGIN_UNSUPPORTED')
      run.physical = run.physics.fromServer(current)
      if (run.physical.isInWater || run.physical.isInLava || run.physical.isInWeb || !run.physical.onGround && !ladderAt(getBlock, { x: run.plan.column.x, y: Math.floor(run.physical.position.y), z: run.plan.column.z })) fail('LADDER_ORIGIN_UNSAFE')
      run.phase = horizontal(run.physical.position, run.plan.centre) > 0.16 ? 'mount' : 'climb'
      const bound = timeoutMs ?? Math.min(180000, 6000 + Math.abs(run.plan.to.y - run.plan.from.y) * 650)
      run.maxTicks = Math.ceil(bound / 50) + 4
      const deadline = now() + bound
      await acquireInput({ token: run.token, operationId: run.operationId })
      run.input = getInput(); check(run)
      const normal = FACE[run.plan.facing], eye = getState().position
      run.input.lookAt({ x: eye.x - normal.x * 2, y: eye.y, z: eye.z - normal.z * 2 })
      run.input.start()
      while (now() < deadline) {
        check(run)
        if (run.settledFrames >= 2 && run.queued >= 2) {
          const positionEvidence = await confirm(run, run.plan.to)
          check(run)
          if (positionEvidence) {
            if (!landingAt(getBlock, run.physics, run.plan.to) || !run.physical.onGround || horizontal(run.physical.position, run.plan.to) > 0.1) fail('LADDER_LANDING_CHANGED')
            last = { status: 'completed', serverConfirmed: true, confirmedBy: positionEvidence.kind, positionEvidence, from: copy(run.plan.from), to: copy(run.plan.to), queuedFrames: run.queued, replayedCorrections: run.replayedCorrections }
            return copy(last)
          }
        }
        await sleep(pollMs)
      }
      fail(run.settledFrames >= 2 ? 'LADDER_POSITION_UNCONFIRMED' : 'LADDER_TIMEOUT')
    } catch (error) {
      const reason = error.code ?? error.message
      last = { status: run.cancelled || signal?.aborted || /PREEMPTED|INPUT_CHANGED|SCOPE_CHANGED|DAMAGED|CORRECTION/.test(reason) ? 'interrupted' : 'blocked', reason, serverConfirmed: false, phase: run.phase, queuedFrames: run.queued, replayedCorrections: run.replayedCorrections,
        ...(run.correctionDiagnostic ? { correctionDiagnostic: run.correctionDiagnostic } : {}) }
      return copy(last)
    } finally {
      if (active === run) {
        if (run.input) releaseInput(run.token, run.input)
        active = null
      }
    }
  }

  return { move, frame, onQueuedFrame, cancel, snapshot: () => ({ busy: !!active, phase: active?.phase ?? 'idle', target: copy(active?.plan?.to ?? null), serverConfirmed: false, lastResult: copy(last) }) }
}

module.exports = { createLadderMovement }
