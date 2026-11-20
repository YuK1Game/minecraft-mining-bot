'use strict'

// Whether a received cell holds water: the block itself, or water in the cell's second layer.
//
// Bedrock keeps a sea plant (seagrass, kelp) and the water it stands in as two blocks of one cell: the plant is the
// cell's block and the water is its second layer (world.js `extra`). The physics and the route planner already read
// such a cell as water (physics.js `readBlock`). The water exit's own readers asked the block's name alone, so a
// seagrass cell was an empty dry cell with a floor: a place to stand.
//
// Real Realm 2026-11-20 23:53 - 2026-11-21 00:01 JST, the pond south of the house (9877, 64, 10138): the Bot stood in
// one block of water on dirt, in the seagrass cell (9876, 62, 10175), received as
// { name: 'minecraft:seagrass', boundingBox: 'empty', extra: [{ name: 'minecraft:water', properties: { liquid_depth: 0 } }] }.
// 「水から上がりました」 came ten times in eight minutes, five of them 0.3 s after 「先に水から上がります」, and after each the
// feet were in the same cell ((9876.5, 62.0-62.8, 10175.6-10176.1)); the trip that followed found no walkable point
// (「歩ける中継点が見つかりません」 16 times, CHUNK_TRAVEL_NO_ROUTE 18 times, walked 0.0 m). The grass shore was two
// blocks north.
const WATER = /water/
const water = found => WATER.test(found?.name ?? '') || (found?.extra ?? []).some(layer => WATER.test(String(layer?.name ?? '')))

module.exports = { water }
