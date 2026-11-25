'use strict'

// Live ports retain closure timing (some bindings are initialized after a
// factory is created). A factory's declared groups are its complete boundary;
// accessors do not automatically grant the right to replace their source.
const contracts = require('./runtime-port-contracts')
const groupViews = new WeakMap()

function createRuntimePorts (rt, contract = null) {
  if (!rt || typeof rt !== 'object') throw new Error('runtime binding object is required')
  if (contract) {
    const writable = new Set(contract.writable), declared = new Set(), ports = {}
    for (const [group, names] of Object.entries(contract.groups)) {
      const port = Object.create(null)
      for (const name of names) {
        if (declared.has(name)) throw new Error(`Duplicate Runtime port: ${name}`)
        declared.add(name)
        Object.defineProperty(port, name, { enumerable: true, get: () => rt[name], ...(writable.has(name) ? { set: value => {
          if (!Reflect.set(rt, name, value)) throw new Error(`Runtime binding is not writable: ${name}`)
        } } : {}) })
      }
      ports[group] = Object.freeze(port)
    }
    for (const name of writable) if (!declared.has(name)) throw new Error(`Undeclared writable Runtime port: ${name}`)
    return Object.freeze(ports)
  }
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
    // `inventory` in production is the action controller, not a function.
    read: () => typeof rt.inventory === 'function' ? rt.inventory() : rt.working?.()?.inventory ?? rt.raw?.()?.inventory ?? null,
    get actions () { return rt.inventory },
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
  return Object.freeze({ host: Object.freeze(host), state: Object.freeze(state), inventory: Object.freeze(inventory), lifecycle: Object.freeze(lifecycle), motion: Object.freeze(motion) })
}

function bindRuntimePorts (bindings, name) {
  const contract = contracts[name]
  if (!contract) throw new Error(`Unknown Runtime port contract: ${name}`)
  const ports = createRuntimePorts(bindings, contract), aliases = Object.create(null)
  for (const port of Object.values(ports)) for (const key of Object.keys(port)) {
    const descriptor = Object.getOwnPropertyDescriptor(port, key)
    Object.defineProperty(aliases, key, { enumerable: true, get: () => port[key], ...(descriptor.set ? { set: value => { port[key] = value } } : {}) })
  }
  Object.freeze(aliases)
  groupViews.set(aliases, ports)
  return aliases
}

const runtimePortGroups = bindings => groupViews.get(bindings) ?? null

module.exports = { createRuntimePorts, bindRuntimePorts, runtimePortGroups }
