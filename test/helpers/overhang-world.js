'use strict'

// The received terrain west of the starter house as a block world, for the
// tests of the way down from the overhang. Built from the height map read on
// the real Realm (fixtures/overhang-heights.json, 2026-11-18 12:45 JST) and
// the columns read at 15:36-15:38 JST:
// - the high layer is grass over dirt, one to four blocks thick, with 18-20
//   blocks of air under it and the ground (grass, dirt, stone) below;
// - the pillar the Bot stacked on the 12:06-12:10 climb stands at
//   (-4905, 66..88, -4996): cobblestone, one dirt block at y 86;
// - the house (origin (-4901, 76, -4993), 7 x 7, roof at y 80) is planks.
const heights = require('../fixtures/overhang-heights.json')

const PILLAR = { x: -4905, z: -4996, bottom: 66, top: 88 }
const HOUSE = { x: -4901, z: -4993, y: 76 }
const LAYER = 2 // blocks of the high layer where the map only gives its top
// The chests outside the south door (the map gives a chest as the top of its column).
const CHESTS = [[-4897, 75, -4986], [-4898, 75, -4985], [-4896, 75, -4985], [-4895, 75, -4985], [-4897, 75, -4983], [-4896, 75, -4982], [-4895, 75, -4982], [-4898, 76, -4982], [-4899, 77, -4981]]

function createOverhangWorld () {
  const changed = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const solid = (name, extra = {}) => ({ known: true, name: `minecraft:${name}`, boundingBox: 'block', ...extra })
  const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const column = (x, z) => { const row = heights.top[z - heights.z0]; return row && x - heights.x0 >= 0 && x - heights.x0 < row.length ? { top: row[x - heights.x0], under: heights.under[z - heights.z0][x - heights.x0] } : null }
  const ground = (y, top) => y === top ? solid('grass_block') : y >= top - 2 ? solid('dirt') : solid('stone')
  function natural (x, y, z) {
    const col = column(x, z)
    if (!col || y < 60 || y > 100) return { known: false }
    if (col.top === null) return air
    if (x === PILLAR.x && z === PILLAR.z) return y > PILLAR.top ? air : y >= PILLAR.bottom ? solid(y === 86 ? 'dirt' : 'cobblestone') : ground(y, PILLAR.bottom - 1)
    const inHouse = x >= HOUSE.x && x <= HOUSE.x + 6 && z >= HOUSE.z && z <= HOUSE.z + 6
    if (inHouse && y >= HOUSE.y) return y <= col.top ? solid('oak_planks', { natural: false }) : air
    if (col.under === null) return y <= col.top ? ground(y, col.top) : air
    if (y <= col.under) return ground(y, col.under)
    return y <= col.top && y > col.top - LAYER ? (y === col.top ? solid('grass_block') : solid('dirt')) : air
  }
  for (const [x, y, z] of CHESTS) changed.set(key(x, y, z), solid('chest'))
  changed.set(key(-4897, 76, -4986), solid('cobblestone', { natural: false })) // the door step over the first chest
  const getBlock = (x, y, z) => changed.get(key(x, y, z)) ?? natural(x, y, z)
  const setBlock = (x, y, z, name) => changed.set(key(x, y, z), name === 'air' ? air : solid(name))
  return { getBlock, setBlock, PILLAR, HOUSE, changed }
}

module.exports = { createOverhangWorld, PILLAR, HOUSE }
