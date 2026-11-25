'use strict'

// A preview is still only a prediction. Reuse its computation for the immediate
// start, while requiring the exact origin, life, policy and observed terrain.
// Callers retain their live actor/input guards and server receipt checks.
function createPreparedRouteCache ({ world, clock = () => performance.now(), maxAgeMs = 500 } = {}) {
  let stored = null
  function key ({ state, initial, settings, target, sprint, automatic, allowWater, emergency, allowLowHealth }) {
    try {
      return JSON.stringify([state.profile, state.realm?.id, state.connectionId, state.startedAt, String(state.runtimeEntityId), state.dimension, state.lifecycle?.deathId, state.health, state.positionUpdatedAt, state.positionSource, initial, target, settings, sprint, automatic, allowWater, emergency, allowLowHealth])
    } catch { return null }
  }
  function observe () {
    const observer = world?.observeTerrain?.(), revision = world?.revision?.(), reader = world?.getBlock
    return {
      run: fn => observer ? observer.run(fn) : fn(),
      current: () => world?.getBlock === reader && (observer ? observer.current() : Number.isSafeInteger(revision) && revision === world?.revision?.()),
      reuse: () => world?.getBlock === reader && (observer?.reuse ? observer.reuse() : observer ? false : Number.isSafeInteger(revision) && revision === world?.revision?.())
    }
  }
  function get (context) {
    const id = key(context), age = stored ? clock() - stored.at : NaN
    if (!id || !stored || stored.key !== id || age < 0 || age > maxAgeMs || !stored.witness.reuse()) return null
    return structuredClone(stored.route)
  }
  function set (context, route, witness) {
    const id = key(context)
    stored = id && route.ready && witness.current() ? { key: id, at: clock(), route: structuredClone(route), witness } : null
  }
  return { key, observe, get, set, clear: () => { stored = null } }
}

module.exports = { createPreparedRouteCache }
