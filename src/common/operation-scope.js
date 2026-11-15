'use strict'

// Owns the lifetime of nested work, not the native controllers themselves.
// Capture/run/cancel ports keep the controller ownership checks in the existing
// action-owner tracker. Completing a child must not discard its parent's owner.
function createOperationScope ({ signal, guard = () => {}, captureOwner = () => null, runOwned = null, cancelOwned = () => {}, abortError = () => new Error('OPERATION_ABORTED') } = {}) {
  const pending = new Set()
  let interrupted = false, disposed = false
  const check = () => {
    if (interrupted || disposed || signal?.aborted) throw abortError()
    guard()
  }
  const cleanup = action => {
    if (action.cancelled) return
    action.cancelled = true
    try { Promise.resolve(cancelOwned(action.kind, action.owner)).catch(() => {}) } catch {}
  }
  const cancel = () => {
    interrupted = true
    // Children release their own controllers before their parents. Each token
    // is still checked by cancelOwned, so a later foreign run is left alone.
    for (const action of [...pending].reverse()) {
      cleanup(action)
      action.reject(abortError())
    }
  }
  signal?.addEventListener('abort', cancel, { once: true })

  async function perform (kind, work) {
    check()
    const action = { kind, owner: captureOwner(kind), cancelled: false, reject: null }
    const stopped = new Promise((resolve, reject) => { action.reject = reject })
    pending.add(action)
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(); return runOwned ? runOwned(action.owner, () => work(action.owner)) : work(action.owner) }),
        stopped
      ])
    } catch (error) {
      cleanup(action)
      throw error
    } finally {
      pending.delete(action)
    }
  }
  function dispose () {
    if (disposed) return
    if (pending.size) cancel()
    disposed = true
    signal?.removeEventListener('abort', cancel)
  }
  return { perform, cancel, dispose }
}

module.exports = { createOperationScope }
