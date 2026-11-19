'use strict'

// One key for "the same connection, dimension and life". Whoever holds
// something of the Bot's input (the expedition's step, a walk away from
// enemies) records it at the start and may act only while it still reads the
// same; readers of such a record compare it the same way.
const FIELDS = ['connectionId', 'startedAt', 'dimension']

function lifeKey (host, raw = () => ({})) {
  const state = host.getServerFields?.(FIELDS) ?? raw()
  return JSON.stringify([state.connectionId, state.startedAt, state.dimension, host.getLife?.()?.deathId])
}

module.exports = { lifeKey }
