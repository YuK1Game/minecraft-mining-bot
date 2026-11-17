'use strict'

// Blocks lower than a whole block that the Bot can stand on: a chest is 0.95
// high on Bedrock, a bed 9/16, a slab half. The received world gives them the
// boundingBox "block" like a full cube, so a stand chosen on top of one leaves
// the feet off the planner's half-block grid, and from there no walk can be
// planned (real Realm 2026-11-17 14:48-14:57 JST: the base trip chose the
// cell above the second half of the base chest as the stand beside it, the
// Bot stood on the chest at 77.95 and every walk was refused with "Wait for a
// supported landing before planning" for ten minutes).
const LOW = /^minecraft:(?:.*chest|.*_bed|bed|.*_slab|.*_stairs|.*_trapdoor|.*carpet|snow_layer|farmland|grass_path|dirt_path|enchanting_table|lectern|.*campfire|.*_fence|.*_fence_gate|.*_wall|.*_door|.*_pane|glass_pane|iron_bars|cake|.*_candle|candle|stonecutter_block|.*_pressure_plate|daylight_detector.*|end_portal_frame|composter|cauldron|hopper|brewing_stand|anvil|.*_anvil|bell|grindstone|.*_head|.*_skull|scaffolding|chain|lantern|soul_lantern|ladder|vine|flower_pot)$/
const low = found => found?.known === true && LOW.test(found.name ?? '')

// The feet off the half-block grid: standing on a low block.
const offGrid = feet => !!feet && Number.isFinite(feet.y) && Math.abs(feet.y * 2 - Math.round(feet.y * 2)) > 0.02

module.exports = { LOW, low, offGrid }
