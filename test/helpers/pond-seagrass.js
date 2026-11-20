'use strict'
// The pond south of the house as received on the real Realm, 2026-11-20 23:55:18 JST
// (fixtures/pond-seagrass-shore.json: x 9874..9887, y 60..65, z 10167..10181, every cell received). A seagrass
// cell is given as the server gave (9876, 62, 10175) at 00:09 JST: the plant is the block, the water its second layer.
const pond = require('../fixtures/pond-seagrass-shore.json')

const SOLID = new Set(['grass_block', 'dirt', 'stone', 'sand', 'clay', 'oak_log', 'birch_log', 'oak_leaves', 'birch_leaves'])
const WATER = { name: 'minecraft:water', properties: { liquid_depth: 0 }, boundingBox: 'empty', hardness: 100, diggable: false }

function getBlock (x, y, z) {
  const row = pond.rows[y]?.[z - pond.z], kind = row?.[x - pond.x]
  if (kind === undefined) return { known: false, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', properties: {}, extra: [] }
  const name = pond.legend[kind], position = { x, y, z }
  if (name === 'water') return { known: true, position, ...WATER, extra: [] }
  if (name === 'seagrass') return { known: true, position, name: 'minecraft:seagrass', properties: { sea_grass_type: 'default' }, boundingBox: 'empty', hardness: 0, diggable: true, extra: [{ ...WATER }] }
  return { known: true, position, name: 'minecraft:' + name, properties: {}, boundingBox: SOLID.has(name) ? 'block' : 'empty', extra: [] }
}

// The seagrass cell the Bot stood in (one block of water over dirt), and the feet the log showed there.
const SEAGRASS = { x: 9876, y: 62, z: 10175 }
const FEET = [{ x: 9876.5, y: 62, z: 10175.7 }, { x: 9876.5, y: 62.7, z: 10175.8 }, { x: 9876.5, y: 62.2, z: 10176.1 }, { x: 9876.5, y: 62, z: 10175.5 }]
// The grass shore two blocks north: the standing cell.
const SHORE = { x: 9876.5, y: 63, z: 10173.5 }

module.exports = { getBlock, SEAGRASS, FEET, SHORE }
