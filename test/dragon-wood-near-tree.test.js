'use strict'

// A received tree nearer than the long trip's arrival distance (20 m) is reached by the dig-and-stack road, not by
// a trip (src/modes/supply-roam.js `roam`, dragon-supply-gather.js `buildToWood`).
// Real Realm 2026-11-24 02:55:29-02:56:55 JST, by the starter house (origin 9877,64,10138) whose ground is dug away,
// 「いま用意する物: log 0/5」: eleven 「出発: 目的地 (9867, 10145)」… one every 8 s, twelve 「目的地に着きました（残り
// 14〜20m・0区間）」, feet unchanged. Every four looks with no hop to walk, the search asked the long trip for the
// nearest received tree; the trip counts 20 m as arrived. (Seen before at 23:08, 23:48, 00:27 and 01:23-01:31 JST.)
// The ground at 02:55 was not read. The scene is a stand-in: a pit four deep in flat stone with a tree 15 cells away,
// which gives the same answers (no hop on any heading, a received tree within 20 m).
// Real: `explore` and `collect`, the roam, the dig-and-stack road, the scaffold's hands, the navigation and physics.
// Stand-in: the server (test/helpers/dig-world.js). Its success is not the game's.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { collect, explore } = require('../src/modes/dragon-supply-gather')
const { MISSES } = require('../src/modes/supply-roam')
const { createDigWorld } = require('./helpers/dig-world')

const TREE = { x: 16, z: 1 }
const pit = (x, y, z) => x >= 0 && x <= 2 && z >= 0 && z <= 2 && y >= 60
function scene (tree = TREE) {
  const outside = (x, y, z) => x === tree.x && z === tree.z && y >= 64 && y <= 67 ? 'oak_log' : y >= 64 || pit(x, y, z) ? 'air' : 'stone'
  return createDigWorld({ x0: 0, z0: 0, rows: {}, legend: {}, feet: { x: 1.5, y: 60, z: 1.5 } }, { outside, logs: true, items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100 }] })
}
const far = w => { const at = w.cell(); return Math.max(Math.abs(at.x - TREE.x), Math.abs(at.z - TREE.z)) }

test('with no road to give (hands without a block reader), the tree 15 m away is skipped and the search leaves along its heading', async () => {
  const w = scene()
  delete w.ctx.hands.block
  for (let look = 0; look < MISSES; look++) await explore(w.ctx, 'log')
  assert.equal(w.trips.length, 1)
  assert.notDeepEqual(w.trips[0].destination, TREE, 'a trip to a place it has already "arrived" at is not asked for')
})

test('02:55 JST: no hop on any heading and a received tree 15 m away: the road is dug to it, no trip is asked for, and the log is taken', async () => {
  const w = scene()
  for (let look = 0; look < MISSES; look++) await explore(w.ctx, 'log')
  assert.equal(w.trips.length, 0, w.lines.join('\n'))
  assert.equal(w.lines.filter(line => /近くの受信済みの原木 \(16, 1\) へ歩く道がないため、掘る・積む道で向かいます/.test(line)).length, 1, w.lines.join('\n'))
  assert.ok(far(w) <= 8, `${JSON.stringify(w.cell())}\n${w.lines.join('\n')}`)
  for (let look = 0; look < 6 && w.count('oak_log') === 0; look++) await collect(w.ctx, 'log')
  assert.ok(w.count('oak_log') >= 1, w.lines.join('\n'))
})

test('a received tree farther than the arrival distance is still a trip', async () => {
  const w = scene({ x: 31, z: 1 })
  for (let look = 0; look < MISSES; look++) await explore(w.ctx, 'log')
  assert.deepEqual(w.trips.map(trip => trip.destination), [{ x: 31, z: 1 }])
})
