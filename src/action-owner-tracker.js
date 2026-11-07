'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')

// The context follows asynchronous equipment and segmented walks. A controller
// start outside that context always replaces its previous cancellation owner.
function createActionOwnerTracker ({ isCurrent = () => true } = {}) {
  const context = new AsyncLocalStorage(), owners = new WeakSet(), records = new WeakMap()
  let sequence = 0
  const current = owner => owners.has(owner) && isCurrent(owner) === true
  const createOwner = details => { const owner = Object.freeze({ context: details }); owners.add(owner); return owner }
  const run = (owner, fn) => {
    if (!current(owner)) throw Object.assign(new Error('STORAGE_ACTION_OWNER_CHANGED'), { code: 'STORAGE_ACTION_OWNER_CHANGED' })
    return context.run(owner, fn)
  }
  function track (controller, methods, { invalidate = [], isActive = () => false } = {}) {
    if (!controller || records.has(controller)) return controller
    const record = { owner: null, serial: 0 }; records.set(controller, record)
    for (const name of methods) {
      if (typeof controller[name] !== 'function') continue
      const original = controller[name]
      controller[name] = function (...args) {
        const owner = context.getStore() ?? null
        if (owner && !current(owner)) throw Object.assign(new Error('STORAGE_ACTION_OWNER_CHANGED'), { code: 'STORAGE_ACTION_OWNER_CHANGED' })
        const busy = isActive(controller) === true
        // A synchronous refusal must not steal the existing run's token.
        const result = original.apply(this, args)
        if (!busy) { record.owner = owner; record.serial = ++sequence }
        return result
      }
    }
    for (const name of invalidate) {
      if (typeof controller[name] !== 'function') continue
      const original = controller[name]
      controller[name] = function (...args) { record.owner = null; record.serial = ++sequence; return original.apply(this, args) }
    }
    return controller
  }
  function cancel (controller, owner, fn) {
    const record = records.get(controller)
    if (!current(owner) || record?.owner !== owner) return false
    record.owner = null; record.serial = ++sequence
    fn()
    return true
  }
  return { createOwner, run, track, cancel, currentOwner: () => context.getStore() ?? null, serial: controller => records.get(controller)?.serial ?? null, isCurrent: current }
}

module.exports = { createActionOwnerTracker }
