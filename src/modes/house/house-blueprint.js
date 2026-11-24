'use strict'

// Player mode: the starter house the user drew (user 2026-11-17 03:06 JST:
// 「序盤にこの設計で拠点を作るようにしてほしい、最優先で」, with the blueprint
// starter-base.json). A 7x7 house on a cobblestone floor with a porch to the
// south: log pillars, plank walls, six glass windows, a bottom-slab roof, a
// door, a bed, two large chests, a crafting table, two furnaces, four torches.
// - Positions are relative to the north-west floor corner (y 0 is the floor).
// - "oak" in the blueprint stands for any one wood: the Bot builds with the wood
//   it has (live 2026-11-17: only birch near the respawn point).
const BLUEPRINT = require('./starter-base.json')
const { yardSteps } = require('./house-yard')

const WOOD = { oak_log: 'log', oak_planks: 'planks', oak_slab: 'slab', oak_door: 'door' }
const ITEMS = Object.freeze([...new Set(BLUEPRINT.placements.map(step => step.item))])

// The placement steps in build order, with world positions for `origin`.
function placements (origin = { x: 0, y: 0, z: 0 }) {
  return BLUEPRINT.placements.map(step => {
    const at = point => point && { x: origin.x + point.x, y: origin.y + point.y, z: origin.z + point.z }
    return {
      id: step.id,
      phase: step.phase,
      item: step.item,
      wood: WOOD[step.item] ?? null,
      position: at(step.target_position),
      cells: step.creates.map(id => at(BLUEPRINT.blocks.find(block => block.id === id)?.position)),
      look: step.placement_look_direction ?? null,
      half: step.desired_half ?? null,
      support: step.attachment ? { position: at(step.attachment.support_position), face: step.attachment.support_face } : null
    }
  })
}

// Whether a received block is what the blueprint puts there ("oak" = any wood).
function matches (item, block) {
  if (block?.known !== true) return false
  const name = String(block.name ?? '').replace(/^minecraft:/, '')
  switch (item) {
    case 'oak_log': return /_(?:log|stem)$/.test(name) && !/^stripped_/.test(name)
    case 'oak_planks': return /_planks$/.test(name)
    case 'oak_slab': return /_slab$/.test(name) && !/double/.test(name)
    case 'oak_door': return /_door$/.test(name) && !/iron/.test(name)
    case 'white_bed': return /_?bed$/.test(name)
    case 'furnace': return /^(?:lit_)?furnace$/.test(name)
    case 'torch': return /^(?:wall_)?torch$/.test(name)
    default: return name === item
  }
}

// The steps not yet standing in the received world (every cell they create), then the ground round the house
// received dug away (house-yard.js: steps marked `ground`, not in the blueprint).
function remaining (getBlock, origin) {
  if (!origin) return placements()
  return [...placements(origin).filter(step => !step.cells.every(cell => matches(step.item, getBlock(cell.x, cell.y, cell.z)))), ...yardSteps(getBlock, origin)]
}

const counts = steps => steps.reduce((sum, step) => { sum[step.item] = (sum[step.item] ?? 0) + 1; return sum }, {})

module.exports = { BLUEPRINT, ITEMS, placements, remaining, matches, counts }
