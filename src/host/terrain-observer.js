'use strict'

// A synchronous slice can read through Physics, support probes and the planner.
// Record all of those reads, including unknown sections. Unrelated packets do
// not invalidate the slice, while replacement, eviction or a lifecycle reset do.
function createTerrainObservers ({ epoch, version }) {
  let reading = null
  function read (x, y, z) { if (reading) reading(`${x},${y},${z}`) }
  function observe () {
    const generation = epoch(), sections = new Map()
    let valid = true
    const note = id => {
      const current = version(id)
      if (sections.has(id)) { if (sections.get(id) !== current) valid = false }
      else if (sections.size < 4096) sections.set(id, current)
      else valid = false
    }
    return {
      run (fn) {
        const previous = reading
        reading = id => { previous?.(id); note(id) }
        try { return fn() } finally { reading = previous }
      },
      current () {
        if (!valid || epoch() !== generation) return false
        for (const [id, value] of sections) if (version(id) !== value) return false
        return true
      },
      // A cached calculation still depends on its original reads. Replaying
      // that witness into an enclosing observation keeps cache hits visible
      // without decoding every block again. Validation and replay are one
      // synchronous operation, so a packet cannot intervene between them.
      reuse () {
        if (!this.current()) return false
        for (const id of sections.keys()) reading?.(id)
        return true
      }
    }
  }
  return { read, observe }
}

module.exports = { createTerrainObservers }
