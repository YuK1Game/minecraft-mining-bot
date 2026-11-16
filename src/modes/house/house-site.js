'use strict'

// Where the starter house goes: a flat patch of received ground near the Bot.
// The house with its porch takes 7 x 8 cells (x 0..6, z 0..7 from the
// north-west corner); its floor is laid on the ground, one above it.
// - Every column of the patch has received solid ground (not leaves, logs,
//   liquid or a falling block) at the same height or one lower, and received
//   cells that are air or a plant (the plants are cut before placing) from
//   the floor up five. The floor goes one above the highest ground; over a
//   lower column it is placed against the side of the floor beside it, with
//   a one-block gap under it (live 2026-11-17 04:17 JST: on hilly ground no
//   perfectly flat 7 x 8 patch was found and the house never started).
// - The nearest such patch within `radius` of the Bot, preferring flatter
//   ones.
const WIDTH = 7, DEPTH = 8, HEIGHT = 5
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const PLANT = /^minecraft:(?:short_grass|tall_grass|grass|fern|large_fern|dandelion|poppy|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|dead_bush|leaf_litter|pink_petals|wildflowers|bush|firefly_bush|short_dry_grass|tall_dry_grass|snow_layer)$/
const BAD_GROUND = /leaves|_log$|_stem$|water|lava|sand$|gravel$|concrete_powder|ice$|snow$|_slab$|_stairs$|fence|wall|torch|chest|furnace|crafting_table|bed$|door/

const open = block => block?.known === true && !block.extra?.length && (AIR.test(block.name ?? '') || PLANT.test(block.name ?? ''))
const ground = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && !AIR.test(block.name ?? '') && !BAD_GROUND.test(String(block.name ?? '').replace(/^minecraft:/, ''))

// For each column (x, z) near `center`: the y of the floor cell (ground top + 1)
// when the column has ground with HEIGHT open cells above, else null.
function columns (getBlock, center, radius) {
  const cx = Math.floor(center.x), cz = Math.floor(center.z), cy = Math.floor(center.y)
  const map = new Map()
  for (let x = cx - radius; x <= cx + radius + WIDTH; x++) for (let z = cz - radius; z <= cz + radius + DEPTH; z++) {
    let found = null
    for (let y = cy + 6; y >= cy - 8; y--) {
      if (!ground(getBlock(x, y, z))) continue
      let clear = true
      for (let up = 1; up <= HEIGHT && clear; up++) clear = open(getBlock(x, y + up, z))
      found = clear ? y + 1 : null
      break
    }
    map.set(`${x},${z}`, found)
  }
  return map
}

function findSite (getBlock, center, { radius = 24 } = {}) {
  if (!center || ![center.x, center.y, center.z].every(Number.isFinite)) return null
  const map = columns(getBlock, center, radius)
  const cx = Math.floor(center.x), cz = Math.floor(center.z)
  let best = null
  for (let ox = cx - radius; ox <= cx + radius; ox++) for (let oz = cz - radius; oz <= cz + radius; oz++) {
    const y = map.get(`${ox},${oz}`)
    if (y == null) continue
    for (const top of [y, y + 1]) {
      let fits = true, low = 0
      for (let dx = 0; dx < WIDTH && fits; dx++) for (let dz = 0; dz < DEPTH && fits; dz++) {
        const v = map.get(`${ox + dx},${oz + dz}`)
        if (v === top) continue
        // One lower: the column was checked open up to top + HEIGHT - 2.
        fits = v === top - 1 && open(getBlock(ox + dx, top + HEIGHT - 1, oz + dz))
        low++
      }
      if (!fits) continue
      const distance = Math.hypot(ox + WIDTH / 2 - center.x, oz + DEPTH / 2 - center.z) + Math.abs(top - center.y) * 2 + low * 0.5
      if (!best || distance < best.distance) best = { origin: { x: ox, y: top, z: oz }, distance }
    }
  }
  return best?.origin ?? null
}

module.exports = { findSite, WIDTH, DEPTH, HEIGHT, PLANT }
