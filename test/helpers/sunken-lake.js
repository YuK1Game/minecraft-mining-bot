'use strict'
// The lake as received live on 2026-11-18 17:07 JST (rows z -4862..-4856,
// columns x -4915..-4895): W water two blocks deep (y 61 and 62 over sand at
// y 60), a/s a shore whose top block is y 62 (standing cell y 63), A a shore
// one higher. Everything north of z -4862 inside the read area is water; cells
// outside the read area are not received.
const ROWS = {
  [-4862]: 'WWWWWWWWWWWaaWWWWWWWW',
  [-4861]: 'WWWWWWWWWWWaaaWWaaaaa',
  [-4860]: 'WWWWWWWWWWaaaasWaaaaa',
  [-4859]: 'WWWWWWWWWWWaaaaWaaaaa',
  [-4858]: 'WWWWWWWWWWWWaaaaaaaaa',
  [-4857]: 'WWWWWWWWWWWWWWaaaaaaA',
  [-4856]: 'WWWWWWWWWWWWWWWaaaaaA'
}

function getBlock (x, y, z) {
  const column = x + 4915
  if (column < 0 || column > 20 || z < -4876 || z > -4856) return { known: false, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', properties: {}, extra: [] }
  const kind = ROWS[z]?.[column] ?? 'W'
  const top = kind === 'W' ? 60 : kind === 'A' ? 63 : 62
  const solid = y <= top, water = !solid && kind === 'W' && y <= 62
  const name = solid ? (kind === 's' ? 'minecraft:stone' : 'minecraft:sand') : water ? 'minecraft:water' : 'minecraft:air'
  return { known: true, position: { x, y, z }, name, properties: water ? { liquid_depth: 0 } : {}, boundingBox: solid ? 'block' : 'empty', extra: [] }
}

// Where the Bot was: one block north of the shore, on the bottom.
const FEET = { x: -4902.51, y: 61, z: -4863.24 }

module.exports = { getBlock, FEET }
