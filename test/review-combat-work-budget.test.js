'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTerrainObservers } = require('../src/host/terrain-observer')
const { combatSearchBudgetFor } = require('../src/combat/combat-search-budget')
const { createCombatExposure } = require('../src/combat/combat-exposure')
const reach = require('../src/combat/threat-reachability')

const air = { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
const state = () => ({ phase: 'spawned', health: 20, dimension: 'overworld', runtimeEntityId: '1', lifecycle: { deathId: 0 }, position: { x: 0.5, y: 65.62, z: 0.5 } })
const actor = x => ({ runtimeId: '2', uniqueId: '-2', entityType: 'minecraft:zombie', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y: 64, z: 0.5 } })
function terrain ({ read = () => {}, corridor = false } = {}) {
  let revision = 0, epoch = 0, reads = 0
  const versions = new Map(), blocks = new Map(), observers = createTerrainObservers({ epoch: () => epoch, version: key => versions.get(key) ?? 0 })
  const world = {
    revision: () => revision, observeTerrain: observers.observe,
    getBlock (x, y, z) {
      reads++; read()
      observers.read(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16))
      return blocks.get(`${x},${y},${z}`) ?? (y < 64 || corridor && (z !== 0 || x < 0 || x > 8 || y > 65) ? stone : air)
    }
  }
  return {
    world, reads: () => reads, unrelated: () => { revision++; versions.set('100,4,100', revision) },
    change (x, y, z, block) { revision++; blocks.set(`${x},${y},${z}`, block); versions.set(`${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`, revision) },
    reset () { epoch++; revision++ }
  }
}

test('refresh, enemy attack routes and a second exposure instance spend one world budget, retaining urgent allowance', t => {
  let cpu = 0
  t.mock.method(performance, 'now', () => cpu)
  const f = terrain({ read: () => { cpu += 0.02 } }), current = state(), enemy = actor(25.5)
  const exposure = () => createCombatExposure({ world: f.world, entities: {}, scopeOf: () => 'same-life' })
  const first = exposure(), second = exposure(), budget = combatSearchBudgetFor(f.world)
  reach.clear(); reach.refresh(current, [enemy], { world: f.world, now: 1000 })
  assert.equal(reach.snapshot().pending, true)
  assert.ok(budget.snapshot().normalUsed >= 8)
  assert.ok(budget.snapshot().normalUsed < 9, 'a single node, rather than three full target probes, bounds the overrun')
  const searches = budget.snapshot().searches
  const close = actor(6.5)
  first.evaluate(close, current); second.evaluate(close, current)
  assert.equal(budget.snapshot().searches, searches)
  assert.ok(budget.snapshot().deferred >= 2)
  assert.equal(reach.knownUnreachable(current, enemy, 1001), false, 'pending work cannot manufacture safe/unreachable evidence')
  assert.equal(budget.search(() => { cpu += 1; return true }, { urgent: true }).executed, true)
  const consumed = reach.snapshot().elapsedMs
  let windows = 0
  while (reach.snapshot().pending && windows++ < 20) {
    cpu += 50
    f.unrelated()
    reach.refresh(current, [enemy], { world: f.world, now: 1000 + windows * 50 })
  }
  assert.equal(reach.snapshot().pending, false)
  assert.ok(reach.snapshot().elapsedMs > consumed, 'CPU totals include resumed fill and targeted work')
  assert.ok(windows > 0)
  reach.clear()
})

test('combat cell and route caches survive unrelated revisions but invalidate received geometry, unknowns and reset', () => {
  const f = terrain({ corridor: true }), current = state(), enemy = actor(6.5)
  const exposure = createCombatExposure({ world: f.world, entities: {}, scopeOf: () => 'same-life' })
  reach.clear()
  assert.equal(reach.seekCells(f.world, enemy.position, { ...current.position, y: 64 }), true)
  const first = f.reads()
  f.unrelated()
  assert.equal(reach.seekCells(f.world, enemy.position, { ...current.position, y: 64 }), true)
  assert.equal(f.reads(), first, 'the derived walk grid is reused without fresh block reads')
  assert.equal(exposure.evaluate(enemy, current).evidence.routeToBot, true)
  const searched = exposure.snapshot().searches
  f.unrelated()
  assert.equal(exposure.evaluate(enemy, current).evidence.routeToBot, true)
  assert.equal(exposure.snapshot().searches, searched)
  f.change(3, 64, 0, { known: false })
  assert.equal(exposure.evaluate(enemy, current).evidence.routeToBot, null)
  assert.ok(exposure.snapshot().searches > searched, 'a route cache populated from cached cells still retained their dependencies')
  f.change(3, 64, 0, air)
  assert.equal(exposure.evaluate(enemy, current).evidence.routeToBot, true)
  f.change(3, 64, 0, stone); f.change(3, 65, 0, stone)
  assert.equal(exposure.evaluate(enemy, current).evidence.routeToBot, false)
  const before = f.reads()
  f.reset()
  reach.seekCells(f.world, enemy.position, { ...current.position, y: 64 })
  assert.ok(f.reads() > before)
  reach.clear()
})

test('refresh invalidates pending and completed evidence when the actual observed terrain or life changes', t => {
  let cpu = 0
  t.mock.method(performance, 'now', () => cpu)
  const f = terrain({ corridor: true, read: () => { cpu += 0.01 } }), current = state(), enemy = actor(6.5)
  reach.clear(); reach.refresh(current, [enemy], { world: f.world, now: 1000 })
  assert.equal(reach.verdict(current, enemy, 1001), true)
  f.unrelated()
  assert.equal(reach.verdict(current, enemy, 1001), true)
  f.change(3, 64, 0, { known: false })
  assert.equal(reach.verdict(current, enemy, 1001), null)
  reach.refresh(current, [enemy], { world: f.world, force: true, now: 1001 })
  assert.equal(reach.verdict(current, enemy, 1002), null)
  current.lifecycle.deathId++
  assert.equal(reach.verdict(current, enemy, 1002), null)
  reach.clear()
})
