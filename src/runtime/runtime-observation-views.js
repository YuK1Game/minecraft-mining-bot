'use strict'

// Entity snapshots contain scalar observations plus position and lastEvent.
// Share only the private received revision; each caller owns these records.
function createActorReader (entities) {
  if (typeof entities?.snapshot !== 'function') throw new TypeError('An entity snapshot reader is required')
  let memo = null, memoVersion = null
  return function allActors () {
    const version = typeof entities.version === 'function' ? entities.version() : null
    if (version == null) {
      memo = null; memoVersion = null
      return entities.snapshot({ kind: 'all' })
    }
    if (!memo || memoVersion !== version) {
      memo = entities.snapshot({ kind: 'all' })
      memoVersion = version
    }
    return memo.map(entity => ({ ...entity, position: entity.position ? { ...entity.position } : entity.position, ...(entity.lastEvent ? { lastEvent: { ...entity.lastEvent } } : {}) }))
  }
}

// Create this reader inside one synchronous control decision. It preserves
// short-circuit checks and is discarded before any later operation/receipt.
function createSnapshotReader () {
  const snapshots = new Map()
  return controller => {
    if (controller == null) return undefined
    if (!snapshots.has(controller)) snapshots.set(controller, controller.snapshot())
    return snapshots.get(controller)
  }
}

module.exports = { createActorReader, createSnapshotReader }
