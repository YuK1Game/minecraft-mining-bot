'use strict'

// A controller may have been awaiting a walk, a chest receipt or hotbar equip
// when play stopped. Check the owner again at the point of its next action.
function guardDragonOperations (operations, cancelled) {
  const guarded = {}
  for (const [group, methods] of Object.entries(operations)) {
    if (!methods || typeof methods !== 'object') continue
    guarded[group] = {}
    for (const [name, fn] of Object.entries(methods)) {
      if (typeof fn === 'function') guarded[group][name] = (...args) => {
        if (cancelled()) throw Object.assign(new Error('遠征の操作を中断しました。'), { code: 'EXPEDITION_CANCELLED' })
        return fn.apply(methods, args)
      }
    }
  }
  return guarded
}

function createDragonRuntimePorts (rt) {
  return {
    dragonItems: {
      commit: delta => rt.commitBrewMainDelta({ ...delta, brewing: true }),
      id: name => rt.crafting.itemIdOf(name),
      rawItem: slot => rt.crafting.rawItem(slot),
      name: id => rt.crafting.itemNameOf(id),
      input: () => { rt.requireIdle(); return rt.dragonInput },
      openStand: position => {
        rt.requireIdle()
        rt.crafting.closeContainer()
        return rt.interactions.openBrewingStand(position)
      }
    },
    expeditionStrike: (actor, weapon, options) => {
      if (!rt.host.shared.playerWanted || !rt.userBehaviors) throw Error('プレイヤーの遠征を待ちます。')
      return rt.userBehaviors.expeditionStrike(actor, weapon, options)
    },
    enterEndPortal: (cell, { signal } = {}) => rt.startMotion('navigation', cell, { endPortalEntry: true, signal })
  }
}

module.exports = { createDragonRuntimePorts, guardDragonOperations }
