'use strict'

// The starter house standing in a small block world, as received: every blueprint block in place at ORIGIN (the
// live house), air elsewhere. Blocks are taken away, put back or made unreceived by blueprint step.
const { placements } = require('../../src/modes/house/house-blueprint')

const ORIGIN = Object.freeze({ x: -4901, y: 76, z: -4993 })
const NAME = { oak_door: 'wooden_door', white_bed: 'bed' }
const THIN = new Set(['oak_door', 'torch'])
const key = (x, y, z) => `${x},${y},${z}`

function createHouseWorld (origin = ORIGIN) {
  const blocks = new Map(), hidden = new Set()
  const steps = placements(origin), step = id => steps.find(found => found.id === id)
  const stand = one => { for (const cell of one.cells) blocks.set(key(cell.x, cell.y, cell.z), one.item) }
  for (const one of steps) stand(one)
  const world = {
    origin, steps, away: false,
    getBlock (x, y, z) {
      if (world.away || hidden.has(key(x, y, z))) return { known: false }
      const item = blocks.get(key(x, y, z))
      if (!item) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
      return { known: true, name: 'minecraft:' + (NAME[item] ?? item), boundingBox: THIN.has(item) ? 'empty' : 'block', ...(item === 'oak_door' ? { properties: { open_bit: true } } : {}) }
    },
    // Blueprint steps by id ('p_173') or by item ('white_bed').
    pick: (...names) => steps.filter(one => names.includes(one.id) || names.includes(one.item)),
    take (...names) { for (const one of world.pick(...names)) for (const cell of one.cells) blocks.delete(key(cell.x, cell.y, cell.z)) },
    mend (...names) { for (const one of names.length ? world.pick(...names) : steps) stand(one) },
    hide (...names) { for (const one of world.pick(...names)) for (const cell of one.cells) hidden.add(key(cell.x, cell.y, cell.z)) },
    show () { hidden.clear() },
    set (x, y, z, item) { if (item) blocks.set(key(x, y, z), item); else blocks.delete(key(x, y, z)) },
    at: id => ({ ...step(id).position }),
    // A place to stand inside the room, one block east of a thing on the west or north wall.
    beside: id => { const at = step(id).position; return { x: at.x + (at.x - origin.x < 3 ? 1.5 : -0.5), y: at.y, z: at.z + (at.z - origin.z < 2 ? 1.5 : 0.5) } },
    porch: () => ({ x: origin.x + 3.5, y: origin.y + 1, z: origin.z + 9.5 })
  }
  return world
}

module.exports = { createHouseWorld, ORIGIN }
