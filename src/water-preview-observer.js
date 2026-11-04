'use strict'

// Observation only: wrap an existing synchronous preview and capture the state
// its existing getState call actually read. No new state read or preview occurs.
function createWaterPreviewObserver ({ preview, publish, getLife = () => null, getGeneration = () => null, now = Date.now }) {
  if (typeof preview !== 'function' || typeof publish !== 'function') throw Error('Existing preview and observation sink required')
  let active = null
  const point = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])) ? { x: p.x, y: p.y, z: p.z } : null
  const label = (s, length = 120) => typeof s === 'string' ? s.slice(0, length) : null
  const stamp = s => typeof s === 'number' && Number.isFinite(s) ? s : label(s)
  function record (entry, result, error) {
    const s = entry.state, prediction = s?.positionSource === 'client_prediction' ? s.predicted ?? s.workingPrediction : null, seed = prediction?.physicsState ?? prediction, feet = seed?.feetPosition ?? seed?.position
    const flags = {}
    for (const name of ['allowWater', 'directSurface', 'exactGoal', 'directFlat', 'partialDrop', 'partialRecenter', 'controlledDrop', 'shoreRecenter', 'stablePartialOrigin', 'emergency', 'sprint', 'maxDistance', 'maxExpanded', 'maxTicks']) flags[name] = typeof entry.options?.[name] === 'boolean' || typeof entry.options?.[name] === 'number' && Number.isFinite(entry.options[name]) ? entry.options[name] : null
    const value = {
      version: 'water_preview_observation_v1', at: new Date(now()).toISOString(), elapsedMs: performance.now() - entry.started,
      generation: getGeneration(),
      scope: { profile: label(s?.profile), realmId: s?.realm?.id == null ? null : label(String(s.realm.id)), connectionId: label(s?.connectionId), startedAt: label(s?.startedAt), runtimeEntityId: s?.runtimeEntityId == null ? null : label(String(s.runtimeEntityId)), dimension: label(s?.dimension), life: getLife() },
      stateRead: { present: s != null, phase: label(s?.phase), health: Number.isFinite(s?.health) ? s.health : null, position: point(s?.position), positionUpdatedAt: stamp(s?.positionUpdatedAt), positionSource: label(s?.positionSource), rawServerPosition: point(s?.rawServerPosition), rawServerPositionUpdatedAt: stamp(s?.rawServerPositionUpdatedAt), predictionPosition: point(prediction?.position), seedFeet: point(feet), seedVelocity: point(seed?.velocity), onGround: typeof seed?.onGround === 'boolean' ? seed.onGround : null, isInWater: typeof seed?.isInWater === 'boolean' ? seed.isInWater : null, isInLava: typeof seed?.isInLava === 'boolean' ? seed.isInLava : null, seedMatchesPosition: point(prediction?.position) && point(s?.position) ? ['x', 'y', 'z'].every(k => Math.abs(prediction.position[k] - s.position[k]) < 1e-4) : null, feetMatchPosition: point(feet) && point(s?.position) ? ['x', 'y', 'z'].every(k => Math.abs(feet[k] - s.position[k] + (k === 'y' ? 1.62 : 0)) < 1e-3) : null },
      request: { target: point(entry.target), flags, avoidanceCount: Array.isArray(entry.options?.avoidance) ? entry.options.avoidance.length : 0, avoidance: (Array.isArray(entry.options?.avoidance) ? entry.options.avoidance : []).slice(0, 16).map(a => ({ id: label(a?.id), position: point(a?.position), minDistance: Number.isFinite(a?.minDistance) ? a.minDistance : null, padding: Number.isFinite(a?.padding) ? a.padding : null })) },
      result: { ready: result?.ready === true, directSurface: result?.directSurface === true, directFlat: result?.directFlat === true, partialRecenter: result?.partialRecenter === true, partialDrop: result?.partialDrop === true, controlledDrop: result?.controlledDrop === true, reason: label(result?.reason, 240), error: label(error?.message, 240), origin: point(result?.origin), target: point(result?.target), waypointCount: Array.isArray(result?.waypoints) ? result.waypoints.length : 0, waypoints: (Array.isArray(result?.waypoints) ? result.waypoints : []).slice(0, 8).map(w => ({ position: point(w?.position), action: label(w?.action), medium: label(w?.medium), waterSurfaceY: Number.isFinite(w?.waterSurfaceY) ? w.waterSurfaceY : null })), predictedTraceCount: Array.isArray(result?.predictedTrace) ? result.predictedTrace.length : 0, predictedTraceFirst: point(result?.predictedTrace?.[0]), predictedTraceLast: point(result?.predictedTrace?.at(-1)) },
      truncated: Array.isArray(entry.options?.avoidance) && entry.options.avoidance.length > 16 || Array.isArray(result?.waypoints) && result.waypoints.length > 8
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 24576) { value.request.avoidance = []; value.result.waypoints = []; value.truncated = true }
    return value
  }
  function captureState (state) { if (active) active.state = state }
  function observePreview (target, options) {
    if (options?.allowWater !== true) return preview(target, options)
    const previous = active, entry = { target, options, state: null, started: performance.now() }; active = entry
    let result, failure
    try { result = preview(target, options); return result } catch (error) { failure = error; throw error } finally { active = previous; try { publish(record(entry, result, failure)) } catch { /* An observation cannot change a real preview result. */ } }
  }
  return { preview: observePreview, captureState }
}

module.exports = { createWaterPreviewObserver }
