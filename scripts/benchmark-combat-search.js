'use strict'

// No connection, credentials or Minecraft account: exercise real route search
// against a bounded synthetic voxel world and print diagnostic timings.
const { createCombatSearchBudget } = require('../src/combat-search-budget')
const { seekCells } = require('../src/threat-reachability')
const world = {
  revision: () => 1,
  getBlock: (x, y, z) => ({ known: true, name: y < 0 || x === 5 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 0 || x === 5 ? 'block' : 'empty', extra: [] })
}
const budget = createCombatSearchBudget(), started = performance.now()
for (let i = 0; i < 100; i++) budget.search(maxMs => seekCells(world, { x: 0, y: 0, z: i % 4 }, { x: 10, y: 0, z: 0 }, { maxMs, maxNodes: 5000 }))
console.log(JSON.stringify({ fixture: '100 bounded enemy-route queries behind a wall', elapsedMs: performance.now() - started, ...budget.snapshot() }, null, 2))
