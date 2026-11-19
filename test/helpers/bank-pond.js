'use strict'
// The pond as received live on 2026-11-19 09:25 JST (rows z -5016..-5010,
// columns x -4813..-4807): ~ water, . air, # solid. Water two blocks deep
// (y 61 and 62 over dirt at y 60); the west bank is two blocks above the
// surface beside the Bot and one block above it at both ends. The read area
// was seven by seven; here its edge rows and columns repeat for four more
// cells so that a tape is not cut by the size of the fixture. Cells farther
// out are not received.
const LAYERS = {
  63: ['##.....', '###....', '###....', '###....', '###....', '##.....', '##.....'],
  62: ['###~~~~', '###~~~~', '###~~~~', '###~~~~', '###~~~~', '###~~~~', '##~~~~~'],
  61: ['###~~~~', '###~~~~', '###~~~~', '###~~~~', '####~~~', '###~~~~', '##~~~~~']
}
const block = (name, solid, position) => ({ known: true, position, name: `minecraft:${name}`, properties: name === 'water' ? { liquid_depth: 0 } : {}, boundingBox: solid ? 'block' : 'empty', extra: [] })

function getBlock (x, y, z) {
  const column = x + 4813, row = z + 5016, position = { x, y, z }
  if (column < -4 || column > 10 || row < -4 || row > 10 || y < 56 || y > 70) return { known: false, position, name: 'minecraft:air', boundingBox: 'empty', properties: {}, extra: [] }
  if (y <= 60) return block('dirt', true, position)
  if (y >= 64) return block('air', false, position)
  const kind = LAYERS[y][Math.max(0, Math.min(6, row))][Math.max(0, Math.min(6, column))]
  return kind === '#' ? block('grass_block', true, position) : kind === '~' ? block('water', false, position) : block('air', false, position)
}

// Where the Bot floated: against the bank, the nearest ledges 2.4 m and 3.1 m to the side.
const FEET = { x: -4809.7, y: 62.78, z: -5013.1 }

module.exports = { getBlock, FEET }
