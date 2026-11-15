'use strict'

// Moved out of runner.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runner.js.

function createRunnerMovement (rt) {
  async function move (decision, context, { allowThreat = false, allowLowHealth = false, validateRoute = null, validateState = null, movementPolicy = null } = {}) {
    const initial = await rt.read(context.signal)
    rt.guard(initial, { allowThreat, allowLowHealth })
    if (decision.sprint !== undefined && typeof decision.sprint !== 'boolean') throw new rt.RunnerError('sprint must be an explicit boolean', 'INVALID_MOVEMENT_OPTIONS')
    const movementOptions = { allowWater: decision.allowWater === true, ...(allowLowHealth ? { emergency: true } : {}), ...(decision.sprint !== undefined ? { sprint: decision.sprint } : {}), ...(movementPolicy ?? {}) }
    const started = rt.now()
    const near = decision.near ?? (decision.target ? { ...decision.target, y: decision.target.y ?? initial.position.y - 1.62 } : null)
    if (!rt.finite(near)) throw new rt.RunnerError('Movement requires a finite target or resource position')
    const implicitResource = decision.near && /^(?:logs|wood|stone|diamond|diamonds|ore|ores|iron|coal|gold)$/.test(String(decision.resource ?? '')) ? decision.near : null
    const suppliedResourceTarget = decision.resourceTarget ?? implicitResource
    if (suppliedResourceTarget != null && (!rt.finite(suppliedResourceTarget) || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(suppliedResourceTarget[axis])))) throw new rt.RunnerError('Resource approach requires integer resourceTarget coordinates', 'INVALID_RESOURCE_TARGET')
    const resourceTarget = suppliedResourceTarget ? rt.copy(suppliedResourceTarget) : null
    const range = decision.range ?? 3
    if (!Number.isFinite(range) || range < 0.2 || range > 4.5) throw new rt.RunnerError('Invalid approach range')
    if (decision.near && rt.distance(initial.position, near) <= range) return rt.resourceAccessResult(rt.result({ outcome: 'already_in_range', serverConfirmed: initial.positionSource !== 'client_prediction', positionSource: initial.positionSource }), decision, resourceTarget, context, decision.target, initial)
    const observations = context.observations ?? rt.getLastObservation()
    let goal = decision.near ? null : { ...decision.target, y: decision.target.y ?? initial.position.y - 1.62 }
    let attempts = 0
    let finished = false
    let limitStopAttempted = false
    const progressScope = rt.movementProgressScope(initial)
    const progressOrigin = rawPose(initial)
    const safetyMark = state => JSON.stringify([state.agent?.progress?.safetyInterruptions ?? null, state.safety?.escapes ?? null, state.safety?.defenses ?? null, state.safety?.closures ?? null])
    const initialSafetyMark = safetyMark(initial)
    let progressIntact = !allowThreat && !allowLowHealth && !!progressScope && rt.finite(initial.rawServerPosition) && Number.isFinite(progressOrigin.milliseconds) && progressOrigin.milliseconds >= started - 1000 && progressOrigin.milliseconds <= started + 1000
    let seenRaw = progressOrigin
    const rawReceipts = []

    function rawPose (state) {
      const explicitlyRaw = rt.finite(state.rawServerPosition)
      const position = explicitlyRaw ? state.rawServerPosition : state.positionSource !== 'client_prediction' ? state.position : null
      const stamp = explicitlyRaw ? state.rawServerPositionUpdatedAt ?? (state.positionSource !== 'client_prediction' ? state.positionUpdatedAt : null) : state.positionUpdatedAt
      const milliseconds = typeof stamp === 'number' ? stamp : typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) ? Date.parse(stamp) : NaN
      return { position: rt.finite(position) ? rt.copy(position) : null, stamp, milliseconds }
    }

    function assertSafe (state) {
      rt.guard(state, { allowThreat, allowLowHealth })
      validateState?.(state)
      if (state.health < initial.health) throw new rt.RunnerError('Bot took damage while moving', 'TOOK_DAMAGE')
      if (state.startedAt !== initial.startedAt || state.dimension !== initial.dimension || state.connectionId != null && initial.connectionId != null && state.connectionId !== initial.connectionId) throw new rt.RunnerError('Movement changed connection, dimension or session', 'STALE_SESSION')
      if (progressScope && rt.movementProgressScope(state) !== progressScope) throw new rt.RunnerError('Movement changed player identity or known life', 'STALE_SESSION')
      if (!progressIntact) return
      if (state.health !== initial.health || safetyMark(state) !== initialSafetyMark || state.inventory?.known !== true || state.inventory.uncertain || state.world?.initialized !== true || !(state.world.loadedSections > 0) || state.world.mappingIssue) progressIntact = false
      if (['moving', 'settling', 'replan_required'].includes(state.movement?.phase) && /unknown|incomplete|unreceived|not received|lava|hazard|未知|未確認|未受信|溶岩/i.test(state.movement.reason ?? '')) progressIntact = false
      const pose = rawPose(state)
      if (!rt.finite(state.rawServerPosition) || !pose.position || !Number.isFinite(pose.milliseconds) || pose.milliseconds < seenRaw.milliseconds || pose.milliseconds > rt.now() + 1000) { progressIntact = false; return }
      if (pose.stamp === seenRaw.stamp) { if (rt.distance(pose.position, seenRaw.position) > 1e-4) progressIntact = false; return }
      if (goal && rt.horizontal(pose.position, goal) > rt.horizontal(seenRaw.position, goal) + 1e-4) progressIntact = false
      seenRaw = pose
    }

    function recordRawProgress (state, pose) {
      if (!progressIntact || !pose || rt.movementProgressScope(state) !== progressScope) return
      if (rawReceipts.length >= 6) { progressIntact = false; return }
      rawReceipts.push({ position: rt.copy(pose.position), stamp: pose.stamp, milliseconds: pose.milliseconds })
    }

    function freshRaw (current, baseline, since) {
      const pose = rawPose(current)
      const previous = rawPose(baseline)
      if (!pose.position || pose.stamp == null || pose.stamp === previous.stamp || !Number.isFinite(pose.milliseconds)) return null
      if (Number.isFinite(previous.milliseconds) && pose.milliseconds <= previous.milliseconds) return null
      if (pose.milliseconds < since - 1000 || pose.milliseconds > rt.now() + 1000) return null
      return pose
    }

    function reached (current, baseline, since) {
      const pose = goal && freshRaw(current, baseline, since)
      return pose && rt.horizontal(pose.position, goal) <= 0.4 && Math.abs(pose.position.y - (goal.y + 1.62)) <= 0.15 ? pose : null
    }

    function poseChanged (current, baseline) {
      const newer = (stamp, previous) => {
        if (stamp == null || stamp === previous) return false
        const time = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
        const nextTime = time(stamp)
        const oldTime = time(previous)
        return !Number.isFinite(nextTime) || !Number.isFinite(oldTime) || nextTime > oldTime
      }
      const working = rt.finite(current.position) && rt.finite(baseline.position) && newer(current.positionUpdatedAt, baseline.positionUpdatedAt) && rt.distance(current.position, baseline.position) > 1e-4
      const raw = rt.finite(current.rawServerPosition) && rt.finite(baseline.rawServerPosition) && newer(current.rawServerPositionUpdatedAt, baseline.rawServerPositionUpdatedAt) && rt.distance(current.rawServerPosition, baseline.rawServerPosition) > 1e-4
      return working || raw
    }

    function needsSettling (state) {
      const prediction = state.positionSource === 'client_prediction' ? state.predicted?.physicsState ?? state.predicted : null
      if (prediction?.isInWater === true) return false
      if (typeof prediction?.onGround === 'boolean') return prediction.onGround === false
      const position = state.positionSource === 'client_prediction' ? state.position : rawPose(state).position ?? state.position
      const feet = position.y - 1.62
      return Math.abs(feet - Math.round(feet * 2) / 2) > 1e-4
    }

    async function settle (state) {
      const settlingStarted = rt.now()
      rt.report(context, { type: 'move_to', phase: 'settling', target: goal, attempt: attempts })
      await rt.request('POST', '/action', { group: 'movement', method: 'settle', args: [{ maxTicks: 80, maxDrop: 3, maxHorizontal: 1, ...(allowLowHealth ? { emergency: true } : {}) }] }, { signal: context.signal })
      const observed = await rt.waitFor(current => {
        assertSafe(current)
        const movement = current.movement
        if (movement?.phase === 'replan_required') return { interrupted: true, movement }
        if (['failed', 'stopped'].includes(movement?.phase)) throw new rt.RunnerError(movement.reason ?? 'Settling was stopped', 'SETTLE_STOPPED')
        return movement?.phase === 'awaiting_server_confirmation' && movement.settled !== false && movement.onGround !== false ? { interrupted: false, movement } : false
      }, { signal: context.signal, baselineHealth: initial.health, allowThreat, allowLowHealth })
      if (observed.value.interrupted) {
        const progress = freshRaw(observed.state, state, settlingStarted)
        const before = rawPose(state).position
        if (!progress || !before || rt.distance(progress.position, before) < 0.15) throw new rt.RunnerError('Settling correction made no authoritative progress', 'NO_MOVEMENT_PROGRESS')
        recordRawProgress(observed.state, progress)
      }
      return observed
    }

    async function confirmed (pose) {
      // A correction can be the server's successful arrival, not a failed walk.
      // Never call the prediction callback here: it would downgrade this raw
      // server observation into a client-only pose in the stable host.
      rt.checkAbort(context.signal)
      await rt.bestEffort('/move/stop')
      rt.checkAbort(context.signal)
      const completed = await rt.resourceAccessResult(rt.result({ outcome: 'confirmed', serverConfirmed: true, verificationPending: false, confirmedBy: 'fresh_server_position', position: rt.copy(pose.position), positionSource: 'raw_server_position', target: rt.copy(goal), attempts }), decision, resourceTarget, context, goal, initial)
      finished = true
      return completed
    }

    try {
      // The six-cycle budget includes settling-only cycles. Source jitter or
      // partial server progress must never create an unbounded retry loop.
      for (let cycle = 0; cycle < 6; cycle++) {
        rt.checkAbort(context.signal)
        let state = await rt.read(context.signal)
        assertSafe(state)
        const alreadyReached = reached(state, initial, started)
        if (alreadyReached) return await confirmed(alreadyReached)
        if (needsSettling(state)) {
          await settle(state)
          continue
        }
        const candidates = goal ? [goal] : rt.standCandidates(near, state, range, observations)
        let selected
        let settleRequired = false
        for (const target of candidates) {
          rt.checkAbort(context.signal)
          const preview = await rt.request('POST', '/move/preview', { target, options: movementOptions }, { signal: context.signal })
          if (preview?.ready && (!validateRoute || validateRoute(preview, state, target))) { selected = { target, preview, origin: rt.copy(state) }; break }
          settleRequired ||= preview?.settleRequired === true
        }
        if (!selected) {
          if (settleRequired) { await settle(state); continue }
          throw new rt.RunnerError('No known safe standing position has a valid route', 'NO_SAFE_ROUTE')
        }
        goal ??= rt.copy(selected.target)
        state = await rt.read(context.signal)
        assertSafe(state)
        if (validateRoute && !validateRoute(selected.preview, state, goal)) throw new rt.RunnerError('The retreat route approaches an enemy or has unsupported terrain', 'NO_SAFE_ROUTE')
        const attemptStarted = rt.now()
        attempts++
        rt.report(context, { type: 'move_to', phase: 'starting', target: goal, attempt: attempts })
        try {
          await rt.request('POST', '/move/start', { target: goal, options: movementOptions }, { signal: context.signal })
        } catch (error) {
          if (error?.code !== 'HTTP_ERROR') throw error
          const latest = await rt.read(context.signal)
          assertSafe(latest)
          // A fall, jump or correction can invalidate a successful preview
          // before start validates it. Retry only an observed pose change;
          // timestamps, health changes or an arbitrary server error are not
          // movement evidence and never reset the six-cycle budget.
          if (!poseChanged(latest, selected.origin) && !poseChanged(latest, state)) throw error
          await rt.bestEffort('/move/stop')
          rt.report(context, { type: 'move_to', phase: 'replanning', reason: 'pose_changed_before_start', target: goal, attempt: attempts, positionSource: latest.positionSource, position: rt.copy(latest.position), serverConfirmed: false })
          continue
        }
        const observed = await rt.waitFor(current => {
          assertSafe(current)
          const arrival = reached(current, state, attemptStarted)
          if (arrival) return { arrival }
          const movement = current.movement
          if (movement?.phase === 'replan_required') return { interrupted: true, movement }
          if (['failed', 'stopped'].includes(movement?.phase)) throw new rt.RunnerError(movement.reason ?? 'Movement stopped before its predicted destination', 'MOVEMENT_STOPPED')
          return movement?.phase === 'awaiting_server_confirmation' ? { interrupted: false, movement } : false
        }, { signal: context.signal, baselineHealth: initial.health, allowThreat, allowLowHealth })
        if (observed.value.arrival) return await confirmed(observed.value.arrival)
        if (observed.value.interrupted) {
          await rt.bestEffort('/move/stop')
          const authoritative = freshRaw(observed.state, state, attemptStarted)
          const before = rawPose(state).position
          if (!authoritative || !before || rt.distance(authoritative.position, before) < 0.15) throw new rt.RunnerError('The correction did not show authoritative movement progress', 'NO_MOVEMENT_PROGRESS')
          recordRawProgress(observed.state, authoritative)
          rt.report(context, { type: 'move_to', phase: 'replanning', target: goal, attempt: attempts, serverPosition: authoritative.position })
          continue
        }
        const predicted = observed.value.movement.predictedPosition
        if (!rt.finite(predicted)) throw new rt.RunnerError('Movement ended without a finite prediction', 'INVALID_PREDICTION')
        const verification = rt.verifyPosition ? await rt.verifyPosition({ predicted: rt.copy(predicted), origin: rt.copy(state.position), target: rt.copy(goal), state: rt.copy(observed.state), signal: context.signal }) : { accepted: true, serverConfirmed: false }
        if (verification?.accepted === false) throw new rt.RunnerError(verification.reason ?? 'Movement verification rejected the prediction', 'POSITION_REJECTED')
        const serverConfirmed = verification?.serverConfirmed === true
        rt.recordWorkingPosition({ position: rt.copy(predicted), origin: rt.copy(state.position), source: serverConfirmed ? 'server_verified' : 'client_prediction', serverConfirmed, state: verification?.state })
        const completed = await rt.resourceAccessResult(rt.result({ outcome: serverConfirmed ? 'confirmed' : 'predicted', serverConfirmed, verificationPending: !serverConfirmed, predictedPosition: rt.copy(predicted), target: goal, attempts }), decision, resourceTarget, context, goal, initial)
        finished = true
        return completed
      }
      // The action budget ends here regardless of progress. Only received,
      // monotonic approach observations may request another fresh plan; they
      // never establish arrival, resource access or a material gain.
      const last = rawReceipts.at(-1)
      const net = goal && progressOrigin.position && last ? rt.horizontal(progressOrigin.position, last.position) : 0
      const decrease = goal && progressOrigin.position && last ? rt.horizontal(progressOrigin.position, goal) - rt.horizontal(last.position, goal) : 0
      if (progressIntact && attempts > 0 && last && net >= 0.5 && decrease >= 0.15 && rt.horizontal(progressOrigin.position, goal) <= 12 && net <= 12 && rt.now() - started <= rt.timeoutMs && rt.now() - last.milliseconds <= 1000) {
        limitStopAttempted = true
        const stopped = await rt.bestEffort('/move/stop')
        rt.checkAbort(context.signal)
        const latest = await rt.read(context.signal); assertSafe(latest)
        const pose = freshRaw(latest, initial, started)
        if (progressIntact && ['stopped', 'idle'].includes(stopped?.phase) && pose && pose.stamp === last.stamp && rt.distance(pose.position, last.position) <= 1e-4 && rt.now() - pose.milliseconds <= 1000) {
          rt.report(context, { type: 'move_to', phase: 'partial', target: goal, attempts, serverPosition: pose.position, serverConfirmed: false, requiresObservation: true })
          finished = true
          return rt.result({ phase: 'predicted', outcome: 'partial_progress', partial: true, complete: false, arrived: false, collected: false, resourceReady: false, serverConfirmed: false, positionServerConfirmed: true, verificationPending: true, requiresObservation: true, position: rt.copy(pose.position), positionSource: 'raw_server_position', rawPositionUpdatedAt: pose.stamp, target: rt.copy(goal), attempts, progressScope, resumeBefore: started + rt.timeoutMs, progressConfirmedBy: 'fresh_server_approach_progress', progress: { netHorizontal: net, distanceDecrease: decrease, remainingDistance: rt.horizontal(pose.position, goal), rawReceipts: rt.copy(rawReceipts) } })
        }
      }
      throw new rt.RunnerError('Movement exceeded the six-cycle replan and settling limit', 'MOVEMENT_REPLAN_LIMIT')
    } catch (error) {
      if (error?.code === 'NO_SAFE_ROUTE' && attempts > 0) error.movementAttempted = true
      throw error
    } finally { if (!finished && !limitStopAttempted) await rt.bestEffort('/move/stop') }
  }
  return {
    move
  }
}

module.exports = { createRunnerMovement }
