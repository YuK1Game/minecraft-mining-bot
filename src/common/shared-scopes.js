'use strict'

// Lifecycle-scoped buckets attached to `host.shared` so state belonging to a
// connection, a single life, or one Bot mode can be reset together instead of
// leaking across reconnects, deaths, or mode switches. Existing flat `shared.*`
// properties continue to work unchanged and can optionally register for cleanup.

function ensureSharedScopes (shared) {
  if (!shared || typeof shared !== 'object') throw new Error('shared object is required')
  if (!shared.scopes || typeof shared.scopes !== 'object') {
    shared.scopes = {
      persistent: Object.create(null),
      session: Object.create(null),
      life: Object.create(null),
      mode: Object.create(null),
      meta: {
        sessionId: null,
        lifeKey: null,
        mode: null,
        sessionResets: 0,
        lifeResets: 0,
        modeResets: 0
      },
      registered: {
        session: new Set(),
        life: new Set(),
        mode: new Set()
      }
    }
  }
  return shared.scopes
}

function clearBucket (bucket) {
  for (const key of Object.keys(bucket)) delete bucket[key]
}

function clearRegisteredKeys (shared, keys) {
  if (!keys) return
  for (const key of keys) {
    if (key in shared) delete shared[key]
  }
}

function registerScopeKey (shared, scope, key) {
  const scopes = ensureSharedScopes(shared)
  if (!scopes.registered[scope]) throw new Error(`Unknown shared scope: ${scope}`)
  if (typeof key === 'string' && key && key !== 'scopes') scopes.registered[scope].add(key)
  return scopes
}

function resetSessionScope (shared, sessionId = null) {
  const scopes = ensureSharedScopes(shared)
  if (sessionId !== null && scopes.meta.sessionId === sessionId) return false
  clearBucket(scopes.session)
  clearBucket(scopes.life)
  clearRegisteredKeys(shared, scopes.registered.session)
  clearRegisteredKeys(shared, scopes.registered.life)
  scopes.meta.sessionId = sessionId
  scopes.meta.lifeKey = null
  scopes.meta.sessionResets++
  return true
}

function resetLifeScope (shared, lifeKey = null) {
  const scopes = ensureSharedScopes(shared)
  if (lifeKey !== null && scopes.meta.lifeKey === lifeKey) return false
  clearBucket(scopes.life)
  clearRegisteredKeys(shared, scopes.registered.life)
  scopes.meta.lifeKey = lifeKey
  scopes.meta.lifeResets++
  return true
}

function resetModeScope (shared, mode = null) {
  const scopes = ensureSharedScopes(shared)
  if (mode !== null && scopes.meta.mode === mode) return false
  clearBucket(scopes.mode)
  clearRegisteredKeys(shared, scopes.registered.mode)
  scopes.meta.mode = mode
  scopes.meta.modeResets++
  return true
}

function summarizeScopes (shared) {
  const scopes = ensureSharedScopes(shared)
  return {
    meta: { ...scopes.meta },
    counts: {
      persistent: Object.keys(scopes.persistent).length,
      session: Object.keys(scopes.session).length,
      life: Object.keys(scopes.life).length,
      mode: Object.keys(scopes.mode).length
    }
  }
}

module.exports = {
  ensureSharedScopes,
  registerScopeKey,
  resetSessionScope,
  resetLifeScope,
  resetModeScope,
  summarizeScopes
}
