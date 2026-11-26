'use strict'

// Lifecycle-scoped buckets attached to `host.shared` so state belonging to a
// connection, a single life, or one Bot mode can be reset together instead of
// leaking across reconnects, deaths, or mode switches. Also dispatches scope
// reset listeners so `lifecycle-signal.js` can abort active waits immediately.

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
      },
      listeners: {
        session: new Set(),
        life: new Set(),
        mode: new Set()
      }
    }
  }
  if (!shared.scopes.listeners) {
    shared.scopes.listeners = {
      session: new Set(),
      life: new Set(),
      mode: new Set()
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

function notifyScopeReset (scopes, scope, detail) {
  const set = scopes.listeners?.[scope]
  if (!set || !set.size) return
  for (const fn of [...set]) {
    try { fn(detail) } catch { /* Listener errors must never block scope reset. */ }
  }
}

function onScopeReset (shared, scope, fn) {
  const scopes = ensureSharedScopes(shared)
  if (!scopes.listeners[scope]) throw new Error(`Unknown shared scope: ${scope}`)
  if (typeof fn !== 'function') throw new Error('Scope reset listener must be a function')
  scopes.listeners[scope].add(fn)
  return () => { scopes.listeners[scope].delete(fn) }
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
  const previousSession = scopes.meta.sessionId
  const previousLife = scopes.meta.lifeKey
  clearBucket(scopes.session)
  clearBucket(scopes.life)
  clearRegisteredKeys(shared, scopes.registered.session)
  clearRegisteredKeys(shared, scopes.registered.life)
  scopes.meta.sessionId = sessionId
  scopes.meta.lifeKey = null
  scopes.meta.sessionResets++
  notifyScopeReset(scopes, 'life', { scope: 'life', previous: previousLife, next: null, via: 'session' })
  notifyScopeReset(scopes, 'session', { scope: 'session', previous: previousSession, next: sessionId })
  return true
}

function resetLifeScope (shared, lifeKey = null) {
  const scopes = ensureSharedScopes(shared)
  if (lifeKey !== null && scopes.meta.lifeKey === lifeKey) return false
  const previous = scopes.meta.lifeKey
  clearBucket(scopes.life)
  clearRegisteredKeys(shared, scopes.registered.life)
  scopes.meta.lifeKey = lifeKey
  scopes.meta.lifeResets++
  notifyScopeReset(scopes, 'life', { scope: 'life', previous, next: lifeKey })
  return true
}

function resetModeScope (shared, mode = null) {
  const scopes = ensureSharedScopes(shared)
  if (mode !== null && scopes.meta.mode === mode) return false
  const previous = scopes.meta.mode
  clearBucket(scopes.mode)
  clearRegisteredKeys(shared, scopes.registered.mode)
  scopes.meta.mode = mode
  scopes.meta.modeResets++
  notifyScopeReset(scopes, 'mode', { scope: 'mode', previous, next: mode })
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
  onScopeReset,
  registerScopeKey,
  resetSessionScope,
  resetLifeScope,
  resetModeScope,
  summarizeScopes
}
