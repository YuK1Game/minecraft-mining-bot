'use strict'

// Cache derived geometry by the sections actually read, including unknown
// sections. A relevant receipt, eviction or world reset invalidates only its
// bucket. Witness replay makes cache hits visible to a surrounding planner.
function createTerrainCache (world, { maxEntries = 32768 } = {}) {
  let buckets = new Map(), reader = world?.getBlock, revision = null, size = 0
  function clear () { buckets = new Map(); size = 0 }
  function begin () {
    const current = world?.revision?.() ?? null
    if (reader !== world?.getBlock || typeof world?.observeTerrain !== 'function' && (!Number.isSafeInteger(current) || current !== revision)) clear()
    reader = world?.getBlock; revision = current
  }
  function read (x, y, z, load) {
    if (reader !== world?.getBlock || typeof world?.observeTerrain !== 'function' && world?.revision?.() !== undefined && world.revision() !== revision) begin()
    const sx = Math.floor(x / 16), sy = Math.floor(y / 16), sz = Math.floor(z / 16)
    // Numeric keys retain the planner's packed-key fast path. Section buckets
    // need only the 12-bit local voxel index, including negative coordinates.
    const range = 1048576, span = range * 2
    const section = sx >= -range && sx < range && sz >= -range && sz < range && sy >= -512 && sy < 512 ? ((sx + range) * span + (sz + range)) * 1024 + sy + 512 : `${sx},${sy},${sz}`
    let bucket = buckets.get(section)
    if (bucket?.witness && !bucket.witness.reuse?.()) {
      size -= bucket.values.size; buckets.delete(section); bucket = null
    }
    if (!bucket) {
      if (size >= maxEntries) clear()
      bucket = { values: new Map(), witness: world?.observeTerrain?.() ?? null }
      buckets.set(section, bucket)
    }
    const id = ((x & 15) << 8) | ((z & 15) << 4) | (y & 15)
    let entry = bucket.values.get(id)
    if (!entry) {
      try { entry = { value: bucket.witness ? bucket.witness.run(load) : load() } } catch (error) { entry = { error } }
      if (size < maxEntries) { bucket.values.set(id, entry); size++ }
    }
    if (entry.error) throw entry.error
    return entry.value
  }
  return { read, begin, clear, get size () { return size } }
}

module.exports = { createTerrainCache }
