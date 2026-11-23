'use strict'

// A stand under unreceived sky is read by one rule (src/travel/open-sky.js skyOver), in the route of a long trip
// (coarse-route.js) and in its arrival (openSky).
// Real Realm 2026-11-23 14:48-15:40 JST, the trip back to the mine at (9808, 10178) from (9856, 68, 10164):
// 15:39 JST GET /blocks, one cell in the middle of each section of 25 chunks: y 64-79 received in all of them,
// y 80-95 in the Bot's chunk column and the one west of it, y 96-143 only in the Bot's own chunk (x 9856-9871,
// z 10128-10175: the trip had asked for the terrain above it). In every column west of x 9856 the lowest
// unreceived cell was y 96, over 26 to 29 received cells of air. The route of the trip, on the world as received:
//   from the feet                 ready, not reached, remaining 48-50, ends at x 9856 (the edge of that chunk)
//   from (9848, 68, 10167)        surfaced, remaining 49, 9 nodes back east to (9856, 67, 10169)
// and with eight received open cells under the unreceived read as the sky: reached, remaining 6, no dig, 43 and
// 37 nodes. The trip went round between two columns from 14:48:17 and ended 「同じ場所から先へ進めていません」
// 12 times by 15:32:51.
// Real: planCoarseRouteAsync with the arguments of the trip (long-travel-runtime.js findPoint), skyOver, openSky.
// Stand-in: the world. Its blocks y 58-76, x 9838-9862, z 10154-10178 are the ones received at 15:30 JST
// (test/fixtures/trip-plateau-sky.json); above them it is received as at 15:39.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planCoarseRouteAsync } = require('../src/travel/coarse-route')
const { openSky, skyOver } = require('../src/travel/open-sky')
const fx = require('./fixtures/trip-plateau-sky.json')

const MINE = { x: 9808, z: 10178 }, OWN_CHUNK_X = 9856
const unknown = (x, y, z) => ({ known: false, position: { x, y, z }, name: null })
function received (x, y, z) {
  if (x < fx.x0 || x > fx.x0 + 24 || z < fx.z0 || z > fx.z0 + 24) return unknown(x, y, z)
  let name
  if (y < fx.y0) name = 'stone'
  else if (y <= 76) name = fx.legend[fx.rows[y][z - fx.z0][x - fx.x0]]
  else if (y < 96 || (x >= OWN_CHUNK_X && y < 144)) name = 'air'
  if (!name) return unknown(x, y, z)
  return { known: true, position: { x, y, z }, name: 'minecraft:' + name, boundingBox: fx.boundingBox[name], extra: [] }
}
const route = start => planCoarseRouteAsync({ getBlock: received, start, goal: MINE, maxNodes: 200000, maxMs: 6000, allowDig: true, maxDrop: 1, surfaceOnly: true, blocked: new Set() })
const left = p => Math.hypot(MINE.x - p.x, MINE.z - p.z)

test('15:39 JST: from the feet the route leads west toward the mine, not to the edge of the chunk whose sky was asked for', async () => {
  const r = await route({ x: 9856.502, y: 68, z: 10164.611 })
  const end = r.path[r.path.length - 1]
  assert.equal(r.ready, true, JSON.stringify({ remaining: r.remaining, nodes: r.path.length }))
  assert.equal(r.surfaced, false)
  assert.ok(end.x < 9842 && left(end) < 34, `ends at ${end.x},${end.y},${end.z}, ${Math.round(left(end))} m left (the west edge of what was captured is 30 m from the mine)`)
  assert.equal(r.path.filter(p => p.dig).length, 0, 'the grass west of the Bot is walked, nothing is dug')
  assert.ok(r.frontier.length > 0, 'the way on is the terrain not received yet')
})

test('15:30 JST: from the standpoint the detour would reach, the route goes on west instead of back east', async () => {
  const r = await route({ x: 9848.5, y: 68, z: 10167.5 })
  const end = r.path[r.path.length - 1]
  assert.equal(r.surfaced, false, 'the standpoint is on the surface: there is no nearest sky to go back to')
  assert.ok(end.x < 9842, `ends at ${end.x},${end.y},${end.z}`)
  assert.ok(r.path.every(p => p.x <= 9849), 'no node east of the start')
})

test('eight received open cells under the unreceived are the sky; fewer, or cover in what is received, is not', () => {
  const column = ({ open, roofAt = null, top = 128 }) => (x, y, z) => y === roofAt ? { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    : y < 66 + 2 + open ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : y >= top ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : { known: false }
  const solid = b => b.boundingBox === 'block'
  assert.equal(skyOver(column({ open: 8, top: 400 }), 0, 66, 0, solid), true)
  assert.equal(skyOver(column({ open: 7, top: 400 }), 0, 66, 0, solid), false, 'seven received cells: a ceiling may be next')
  assert.equal(skyOver(column({ open: 28, roofAt: 80, top: 400 }), 0, 66, 0, solid), false, 'a received roof is cover however much is open above it')
  assert.equal(skyOver(column({ open: 0, top: 400 }), 0, 66, 0, solid), false, 'nothing received over the head')
  assert.equal(skyOver((x, y) => y < 128 ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : { known: false }, 0, 124, 0, solid), true, 'unreceived from y 128: the sky, as before')
  // The arrival of the trip reads the same rule: 16 m from the mine, under 13 received cells of air (column 9812,10178 at 15:39).
  const mine = (x, y, z) => y <= 66 ? { known: true, name: 'minecraft:grass_block', boundingBox: 'block' } : y < 80 ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : { known: false }
  assert.equal(openSky(mine, { x: 9812.5, y: 67, z: 10178.5 }), true)
  const planks = (x, y, z) => y === 70 ? { known: true, name: 'minecraft:oak_planks', boundingBox: 'block' } : mine(x, y, z)
  assert.equal(openSky(planks, { x: 9812.5, y: 67, z: 10178.5 }), true, 'a built roof is not cover for the arrival, as before')
  const rock = (x, y, z) => y === 75 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : mine(x, y, z)
  assert.equal(openSky(rock, { x: 9812.5, y: 67, z: 10178.5 }), false)
})
