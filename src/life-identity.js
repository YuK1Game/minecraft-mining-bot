'use strict'

// One answer to "which life is the Bot on?" for every Runtime module.
//
// The Host lifecycle counts every death seen on the current connection. The
// Runtime used to read the automatic-respawn record instead, which is only
// written when respawn safety is enabled and survives a reconnect. The two
// numbers then disagreed after a reconnect or an unmanaged death, so checks
// that compared a Runtime scope with a Host scope refused valid work
// (2026-11-13: debug chest placement after a death).
//
// The Host counter is used whenever it belongs to the current connection.
// Older Hosts (before a restart) have no counter hook; then the previous rule
// (respawn record, else 0) is kept so a hot reload changes nothing.
function currentLifeId ({ hostLife = null, connectionId = null, respawnRecord = null } = {}) {
  if (hostLife && typeof connectionId === 'string' && hostLife.connectionId === connectionId && Number.isSafeInteger(hostLife.deathId) && hostLife.deathId >= 0) return hostLife.deathId
  return Number.isSafeInteger(respawnRecord?.deathId) ? respawnRecord.deathId : 0
}

module.exports = { currentLifeId }
