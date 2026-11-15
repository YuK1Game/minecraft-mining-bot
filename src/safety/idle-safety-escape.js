'use strict'

// Moved out of idle-safety.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of idle-safety.js.

const { prepareEscape } = require('./escape/escape-prepare')
const { waitAtSurface } = require('./escape/escape-surface-wait')
const { chooseEscapeAction } = require('./escape/escape-choice')
const { runEscapeAction } = require('./escape/escape-action')
const { checkDryProgress } = require('./escape/escape-dry-progress')
const { correctInWater } = require('./escape/escape-water-correction')
const { replanInWater } = require('./escape/escape-water-replan')
const { tryPartialOrClear } = require('./escape/escape-partial')
const { handleEscapeFailure } = require('./escape/escape-failure')
const { recheckWaterEpisode } = require('./escape/escape-water-episode')
const { unarmedFallback } = require('./escape/escape-unarmed')

function createIdleSafetyEscape (rt) {
  async function escapeOrStop (run, op, value, reason) {
    // The stages called in this block live in modules of their own (scripts/extract-stage.js).
    // `vars` reads and writes this function's locals at the moment of use.
    let surfaceWaitSafe, waitForLanding, knownActors, lastWaterEpisodeLeg, clearedEscapeTarget, dryProgressActors, initialHealth, originalThreats, dryProgressStartedAt, episodeKnown, episodeOrigin, episodeThreat, safeReplanActors, timestamp, dangerReplans, landingDistancesSafe, receivedWaterEpisodeReady, receivedWaterReady, clearAttempted, safeKnownActors, actorReplans, changedActorBodyReady, horizontal
    const vars = {
      get actorReplans () { return actorReplans }, set actorReplans ($value) { actorReplans = $value },
      get changedActorBodyReady () { return changedActorBodyReady }, set changedActorBodyReady ($value) { changedActorBodyReady = $value },
      get clearAttempted () { return clearAttempted }, set clearAttempted ($value) { clearAttempted = $value },
      get clearedEscapeTarget () { return clearedEscapeTarget }, set clearedEscapeTarget ($value) { clearedEscapeTarget = $value },
      get dangerReplans () { return dangerReplans }, set dangerReplans ($value) { dangerReplans = $value },
      get dryProgressActors () { return dryProgressActors }, set dryProgressActors ($value) { dryProgressActors = $value },
      get dryProgressStartedAt () { return dryProgressStartedAt }, set dryProgressStartedAt ($value) { dryProgressStartedAt = $value },
      get episodeKnown () { return episodeKnown }, set episodeKnown ($value) { episodeKnown = $value },
      get episodeOrigin () { return episodeOrigin }, set episodeOrigin ($value) { episodeOrigin = $value },
      get episodeThreat () { return episodeThreat }, set episodeThreat ($value) { episodeThreat = $value },
      get horizontal () { return horizontal }, set horizontal ($value) { horizontal = $value },
      get initialHealth () { return initialHealth }, set initialHealth ($value) { initialHealth = $value },
      get knownActors () { return knownActors }, set knownActors ($value) { knownActors = $value },
      get landingDistancesSafe () { return landingDistancesSafe }, set landingDistancesSafe ($value) { landingDistancesSafe = $value },
      get lastWaterEpisodeLeg () { return lastWaterEpisodeLeg }, set lastWaterEpisodeLeg ($value) { lastWaterEpisodeLeg = $value },
      get op () { return op }, set op ($value) { op = $value },
      get originalThreats () { return originalThreats }, set originalThreats ($value) { originalThreats = $value },
      get reason () { return reason }, set reason ($value) { reason = $value },
      get receivedWaterEpisodeReady () { return receivedWaterEpisodeReady }, set receivedWaterEpisodeReady ($value) { receivedWaterEpisodeReady = $value },
      get receivedWaterReady () { return receivedWaterReady }, set receivedWaterReady ($value) { receivedWaterReady = $value },
      get run () { return run }, set run ($value) { run = $value },
      get safeKnownActors () { return safeKnownActors }, set safeKnownActors ($value) { safeKnownActors = $value },
      get safeReplanActors () { return safeReplanActors }, set safeReplanActors ($value) { safeReplanActors = $value },
      get surfaceWaitSafe () { return surfaceWaitSafe }, set surfaceWaitSafe ($value) { surfaceWaitSafe = $value },
      get timestamp () { return timestamp }, set timestamp ($value) { timestamp = $value },
      get value () { return value }, set value ($value) { value = $value },
      get waitForLanding () { return waitForLanding }, set waitForLanding ($value) { waitForLanding = $value }
    }
    const prepareEscapeResult = await prepareEscape(rt, vars)
    if (prepareEscapeResult && 'value' in prepareEscapeResult) return prepareEscapeResult.value
    const waitAtSurfaceResult = await waitAtSurface(rt, vars)
    if (waitAtSurfaceResult && 'value' in waitAtSurfaceResult) return waitAtSurfaceResult.value
    value = await waitForLanding(value)
    for (let attempt = 0; attempt < 8 && (rt.escape || rt.partialEscape) && value.state.health > 0 && !value.unknown && value.state.inventory?.known === true && !value.state.inventory.uncertain; attempt++) {
      // The stages called in this block live in modules of their own (scripts/extract-stage.js).
      // `vars2` reads and writes this function's locals at the moment of use.
      let escapeAction, supported, mayUseShallowWater, mayUsePartial
      const vars2 = {
        get escapeAction () { return escapeAction }, set escapeAction ($value) { escapeAction = $value },
        get knownActors () { return knownActors },
        get lastWaterEpisodeLeg () { return lastWaterEpisodeLeg }, set lastWaterEpisodeLeg ($value) { lastWaterEpisodeLeg = $value },
        get mayUsePartial () { return mayUsePartial }, set mayUsePartial ($value) { mayUsePartial = $value },
        get mayUseShallowWater () { return mayUseShallowWater }, set mayUseShallowWater ($value) { mayUseShallowWater = $value },
        get op () { return op }, set op ($value) { op = $value },
        get run () { return run }, set run ($value) { run = $value },
        get supported () { return supported }, set supported ($value) { supported = $value },
        get value () { return value }, set value ($value) { value = $value }
      }
      const chooseEscapeActionResult = await chooseEscapeAction(rt, vars2)
      if (chooseEscapeActionResult?.flow === 'break') break
      try {
        // The stages called in this block live in modules of their own (scripts/extract-stage.js).
        // `vars3` reads and writes this function's locals at the moment of use.
        let after, before, cause, dryProgressCandidate, rejection, result, recordContinuation, waterFreshCorrection, freshCorrection, oldStamp, recoverableLowHealth, horizontal
        const vars3 = {
          get after () { return after }, set after ($value) { after = $value },
          get attempt () { return attempt }, set attempt ($value) { attempt = $value },
          get before () { return before }, set before ($value) { before = $value },
          get cause () { return cause }, set cause ($value) { cause = $value },
          get clearAttempted () { return clearAttempted }, set clearAttempted ($value) { clearAttempted = $value },
          get clearedEscapeTarget () { return clearedEscapeTarget }, set clearedEscapeTarget ($value) { clearedEscapeTarget = $value },
          get dangerReplans () { return dangerReplans }, set dangerReplans ($value) { dangerReplans = $value },
          get dryProgressActors () { return dryProgressActors },
          get dryProgressCandidate () { return dryProgressCandidate }, set dryProgressCandidate ($value) { dryProgressCandidate = $value },
          get dryProgressStartedAt () { return dryProgressStartedAt },
          get episodeKnown () { return episodeKnown },
          get episodeOrigin () { return episodeOrigin },
          get episodeThreat () { return episodeThreat },
          get escapeAction () { return escapeAction },
          get freshCorrection () { return freshCorrection }, set freshCorrection ($value) { freshCorrection = $value },
          get horizontal () { return horizontal }, set horizontal ($value) { horizontal = $value },
          get initialHealth () { return initialHealth },
          get knownActors () { return knownActors },
          get landingDistancesSafe () { return landingDistancesSafe },
          get lastWaterEpisodeLeg () { return lastWaterEpisodeLeg }, set lastWaterEpisodeLeg ($value) { lastWaterEpisodeLeg = $value },
          get mayUsePartial () { return mayUsePartial },
          get mayUseShallowWater () { return mayUseShallowWater },
          get oldStamp () { return oldStamp }, set oldStamp ($value) { oldStamp = $value },
          get op () { return op }, set op ($value) { op = $value },
          get originalThreats () { return originalThreats },
          get reason () { return reason }, set reason ($value) { reason = $value },
          get receivedWaterEpisodeReady () { return receivedWaterEpisodeReady },
          get receivedWaterReady () { return receivedWaterReady },
          get recordContinuation () { return recordContinuation }, set recordContinuation ($value) { recordContinuation = $value },
          get recoverableLowHealth () { return recoverableLowHealth }, set recoverableLowHealth ($value) { recoverableLowHealth = $value },
          get rejection () { return rejection }, set rejection ($value) { rejection = $value },
          get result () { return result }, set result ($value) { result = $value },
          get run () { return run }, set run ($value) { run = $value },
          get safeKnownActors () { return safeKnownActors },
          get safeReplanActors () { return safeReplanActors },
          get supported () { return supported },
          get surfaceWaitSafe () { return surfaceWaitSafe },
          get timestamp () { return timestamp },
          get value () { return value }, set value ($value) { value = $value },
          get waitForLanding () { return waitForLanding },
          get waterFreshCorrection () { return waterFreshCorrection }, set waterFreshCorrection ($value) { waterFreshCorrection = $value }
        }
        const runEscapeActionResult = await runEscapeAction(rt, vars3)
        if (runEscapeActionResult && 'value' in runEscapeActionResult) return runEscapeActionResult.value
        const checkDryProgressResult = await checkDryProgress(rt, vars3)
        if (checkDryProgressResult && 'value' in checkDryProgressResult) return checkDryProgressResult.value
        if (checkDryProgressResult?.flow === 'break') break
        if (checkDryProgressResult?.flow === 'continue') continue
        // After a scheduling stall, the last predicted move may be ahead of
        // the last received position. Give the server a short chance to send
        // a correction while the ordinary idle stream resumes, but never
        // authorize another route from prediction alone.
        const correctInWaterResult = await correctInWater(rt, vars3)
        if (correctInWaterResult && 'value' in correctInWaterResult) return correctInWaterResult.value
        if (correctInWaterResult?.flow === 'break') break
        if (correctInWaterResult?.flow === 'continue') continue
        // A server correction during a surface swim is not an arrival. When
        // it proves meaningful outward movement, replan from the new position
        // rather than disconnecting while two known creepers are still near.
        const replanInWaterResult = await replanInWater(rt, vars3)
        if (replanInWaterResult?.flow === 'continue') continue
        if (replanInWaterResult?.flow === 'break') break
        const tryPartialOrClearResult = await tryPartialOrClear(rt, vars3)
        if (tryPartialOrClearResult && 'value' in tryPartialOrClearResult) return tryPartialOrClearResult.value
        if (tryPartialOrClearResult?.flow === 'continue') continue
        if (tryPartialOrClearResult?.flow === 'break') break
      } catch (error) {
        // The stages called in this block live in modules of their own (scripts/extract-stage.js).
        // `vars4` reads and writes this function's locals at the moment of use.
        const vars4 = {
          get actorReplans () { return actorReplans }, set actorReplans ($value) { actorReplans = $value },
          get changedActorBodyReady () { return changedActorBodyReady },
          get dangerReplans () { return dangerReplans }, set dangerReplans ($value) { dangerReplans = $value },
          get error () { return error }, set error ($value) { error = $value },
          get initialHealth () { return initialHealth },
          get knownActors () { return knownActors },
          get lastWaterEpisodeLeg () { return lastWaterEpisodeLeg }, set lastWaterEpisodeLeg ($value) { lastWaterEpisodeLeg = $value },
          get mayUseShallowWater () { return mayUseShallowWater },
          get op () { return op }, set op ($value) { op = $value },
          get originalThreats () { return originalThreats },
          get run () { return run }, set run ($value) { run = $value },
          get safeKnownActors () { return safeKnownActors },
          get safeReplanActors () { return safeReplanActors },
          get value () { return value }, set value ($value) { value = $value },
          get waitForLanding () { return waitForLanding }
        }
        const handleEscapeFailureResult = await handleEscapeFailure(rt, vars4)
        if (handleEscapeFailureResult && 'value' in handleEscapeFailureResult) return handleEscapeFailureResult.value
        if (handleEscapeFailureResult?.flow === 'break') break
        if (handleEscapeFailureResult?.flow === 'continue') continue
      }
      break
    }
    // End a bounded batch without disconnecting only when received positions
    // prove useful net movement. The next ordinary tick owns a new episode
    // and must earn its own progress; this never declares the danger cleared.
    const recheckWaterEpisodeResult = await recheckWaterEpisode(rt, vars)
    if (recheckWaterEpisodeResult && 'value' in recheckWaterEpisodeResult) return recheckWaterEpisodeResult.value
    // Exhausting the optional pause margin is not a new actual emergency.
    // Hold the next productive action after draining this bounded episode;
    // only a fresh actual danger can authorize another retreat batch.
    const unarmedFallbackResult = await unarmedFallback(rt, vars)
    if (unarmedFallbackResult && 'value' in unarmedFallbackResult) return unarmedFallbackResult.value
  }
  return {
    escapeOrStop
  }
}

module.exports = { createIdleSafetyEscape }
