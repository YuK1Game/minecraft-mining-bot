'use strict'

// Grouped port views over the runtime closure object (`rt`).
// Extracted runtime modules previously read 55-106 flat `rt.*` bindings directly.
// New and refactored modules can receive cohesive port groups (`host`, `world`,
// `inventory`, `motion`, `lifecycle`) to keep dependencies explicit and unit-testable.

function createRuntimePorts (rt) {
  if (!rt || typeof rt !== 'object') throw new Error('runtime binding object is required')
  const host = {
    get raw () { return rt.host },
    get shared () { return rt.host?.shared },
    get world () { return rt.host?.world },
    get entities () { return rt.host?.entities },
    log: message => rt.host?.log?.(message),
    getLife: () => rt.host?.getLife?.() ?? null
  }
  const state = {
    raw: () => rt.raw?.() ?? null,
    working: () => rt.working?.() ?? null,
    lightweight: () => rt.lightweightUserState?.() ?? null
  }
  const inventory = {
    read: () => rt.inventory?.() ?? null,
    refresh: source => rt.requestInventoryResyncWithReceipt?.(source),
    isUncertain: () => rt.host?.shared?.inventoryUncertain === true
  }
  const lifecycle = {
    isDisposed: () => rt.disposed === true || rt.disposing === true,
    require: spec => rt.require(spec),
    get dirname () { return rt.__dirname }
  }
  const motion = {
    get operations () { return rt.operations },
    snapshot: () => rt.operations?.movement?.snapshot?.() ?? null,
    stop: reason => rt.operations?.movement?.stop?.(reason)
  }
  return { host, state, inventory, lifecycle, motion }
}

module.exports = { createRuntimePorts }
