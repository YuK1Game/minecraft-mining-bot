'use strict'

// Keys for the per-plan caches of the route search. Building a string for
// every block read and every classified position was a third of a search's
// time (CPU profile 2026-11-16: geometryBlockAt 24%, safeClassify 23%, garbage
// collection 13%). Coordinates inside the range pack into one number; anything
// else keeps the string key, so the cached answers are the same.
const RANGE = 1 << 20 // blocks either side of zero
const SPAN = RANGE * 2

// Integer block cells: x and z within +-1048576, y within +-512.
function cellKey (x, y, z) {
  if (x >= -RANGE && x < RANGE && z >= -RANGE && z < RANGE && y >= -512 && y < 512) return ((x + RANGE) * SPAN + (z + RANGE)) * 1024 + (y + 512)
  return `${x},${y},${z}`
}

// Positions on the half-block search grid, any height. One map per column.
function createPointCache (limit = 32768) {
  const columns = new Map(), strays = new Map()
  let size = 0
  const column = (x, z) => {
    const x2 = x * 2, z2 = z * 2
    return Number.isInteger(x2) && Number.isInteger(z2) && x2 >= -SPAN && x2 < SPAN && z2 >= -SPAN && z2 < SPAN ? (x2 + SPAN) * SPAN * 2 + (z2 + SPAN) : null
  }
  return {
    // undefined: not cached. A cached null is a real answer.
    get (position) {
      const id = column(position.x, position.z)
      return id === null ? strays.get(`${position.x},${position.y},${position.z}`) : columns.get(id)?.get(position.y)
    },
    set (position, value) {
      if (size >= limit) return
      size++
      const id = column(position.x, position.z)
      if (id === null) { strays.set(`${position.x},${position.y},${position.z}`, value); return }
      let heights = columns.get(id)
      if (!heights) columns.set(id, heights = new Map())
      heights.set(position.y, value)
    },
    get size () { return size }
  }
}

module.exports = { cellKey, createPointCache }
