'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createWorkDanger, NEAR_M, ARCHER_M, HURT_MS, FRESH_MS } = require('../src/modes/work-danger')

// The side jobs of player mode share one danger check: work-danger.js, wired once in mode-runtime.js.
test('player side jobs are held by an archer within 24 m or recent damage, not only a hostile within 12 m', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/modes/mode-runtime.js'), 'utf8')
  assert.equal((source.match(/createWorkDanger\(/g) ?? []).length, 1, 'one danger check')
  assert.match(source, /const danger = dangerOf\.near/)
  assert.ok((source.match(/danger\(\)/g) ?? []).length >= 8)
  assert.doesNotMatch(source, /nearestHostile\(\) < \d/, 'no distance rule of its own beside it')
  assert.deepEqual([NEAR_M, ARCHER_M, HURT_MS, FRESH_MS], [12, 24, 10000, 60000])

  // The rule itself, on open ground (every block received, all of it air).
  const f = { clock: 1e9, health: 20, at: { x: 0.5, y: 65.62, z: 0.5 }, actors: [], nearest: Infinity, noRoute: false }
  const danger = createWorkDanger({ health: () => f.health, where: () => f.at, hostiles: () => f.actors, nearest: () => f.nearest, unreachable: () => f.noRoute, world: () => ({ getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }) }), now: () => f.clock })
  const mob = (type, x, extra = {}) => ({ entityType: 'minecraft:' + type, hostile: true, alive: true, position: { x: x + 0.5, y: 64, z: 0.5 }, ...extra })
  const moved = ms => new Date(f.clock - ms).toISOString()
  f.actors = [mob('zombie', 12.5)]
  assert.equal(danger.near(), false)
  f.actors = [mob('zombie', 11)]
  assert.equal(danger.near(), true)
  f.noRoute = true
  assert.equal(danger.near(), false, 'a walker with no route does not hold side jobs')
  f.actors = [mob('creeper', 11)]
  assert.equal(danger.near(), true, 'a creeper does')
  f.noRoute = false
  f.actors = [mob('skeleton', 23, { positionUpdatedAt: moved(1000) })]
  assert.equal(danger.why().code, 'ARCHER')
  f.actors = [mob('skeleton', 24.5, { positionUpdatedAt: moved(1000) })]
  assert.equal(danger.near(), false)
  f.actors = [mob('skeleton', 23, { positionUpdatedAt: moved(FRESH_MS + 1) })]
  assert.equal(danger.near(), false, 'an archer unmoved for a minute is not aiming')
  f.actors = []
  f.health = 18
  assert.equal(danger.why().code, 'HURT')
  f.clock += HURT_MS
  assert.equal(danger.near(), false)
  // The Bot's own position not known: the nearest hostile's distance alone.
  f.at = null; f.nearest = 11.9
  assert.equal(danger.near(), true)
  f.nearest = 12
  assert.equal(danger.near(), false)
})
