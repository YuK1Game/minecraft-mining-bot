'use strict'

// Canonical world & life scope identifiers shared by player mode, workstations,
// field chests, and legacy survival station catalogs.
function supplyScope (state) {
  if (
    typeof state?.profile !== 'string' ||
    !state.profile ||
    state.realm?.id == null ||
    !state.connectionId ||
    !state.startedAt ||
    !['overworld', 'nether', 'end'].includes(state.dimension) ||
    !/^\d+$/.test(String(state.runtimeEntityId ?? '')) ||
    !Number.isSafeInteger(state.lifecycle?.deathId) ||
    state.lifecycle.deathId < 0
  ) {
    return null
  }
  return JSON.stringify([
    state.profile,
    String(state.realm.id),
    state.dimension,
    state.connectionId,
    state.startedAt,
    String(state.runtimeEntityId),
    state.lifecycle.deathId
  ])
}

function stationWorldScope (state) {
  return typeof state?.profile === 'string' &&
    state.profile &&
    state.realm?.id != null &&
    ['overworld', 'nether', 'end'].includes(state.dimension)
    ? JSON.stringify([state.profile, String(state.realm.id), state.dimension])
    : null
}

module.exports = { supplyScope, stationWorldScope }
