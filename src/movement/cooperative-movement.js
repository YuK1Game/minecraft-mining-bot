'use strict'

// Keep the existing synchronous activation boundary (input ownership,
// container close and heartbeat handoff). Planning can yield before it.
function cooperativeMovement (ports, { movement, prepare, check }) {
  if (typeof movement?.previewAsync !== 'function') return ports
  const guarded = options => ({ ...options, check: () => {
    check()
    options?.signal?.throwIfAborted()
    return options?.check?.() ?? true
  } })
  async function previewAsync (target, options = {}) {
    check(); options.signal?.throwIfAborted(); prepare()
    return movement.previewAsync(target, guarded(options))
  }
  function startPrepared (target, options = {}) {
    check(); options.signal?.throwIfAborted()
    return ports.start(target, { ...options, requirePrepared: true })
  }
  async function startAsync (target, options = {}) {
    await previewAsync(target, options)
    return startPrepared(target, options)
  }
  return { ...ports, previewAsync, startPrepared, startAsync }
}

module.exports = { cooperativeMovement }
