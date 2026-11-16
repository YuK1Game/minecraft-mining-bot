'use strict'

// A tunnel search that found no route gives the same answer until something
// it read changes. The failure is remembered under a key made of everything
// the search depends on (target, start cell, tool, limits, the received
// terrain version, preserved floors, refused cells); a caller with the same
// key gets the answer back without searching. Entries also expire, because
// protection overlays (base, depot) are not part of the terrain version.
function createFailureMemo ({ ttlMs = 60000, limit = 16, now = () => Date.now() } = {}) {
  const entries = new Map()
  return {
    get (key) {
      if (key == null) return null
      const entry = entries.get(key)
      if (!entry) return null
      if (now() - entry.at > ttlMs) { entries.delete(key); return null }
      return entry.failure
    },
    set (key, failure) {
      if (key == null) return
      entries.delete(key)
      entries.set(key, { at: now(), failure })
      while (entries.size > limit) entries.delete(entries.keys().next().value)
    }
  }
}

module.exports = { createFailureMemo }
