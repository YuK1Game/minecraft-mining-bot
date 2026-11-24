'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineGeometry, upgradeMineGeometry, defaultDropEstimate, MAX_SIDE, MAX_STORAGE_PAIRS } = require('../src/modes/mining/mine-geometry')
const { planMine, PLAN_RULES } = require('../src/modes/mining/mine-plan')
const { supplyNeeds } = require('../src/modes/mining/mine-needs')
const { observationWorld } = require('./helpers/branch-mine-observation-world')

const scope = { profile: 'test', realmId: 'realm', dimension: 'overworld' }

test('128x128 mine geometry sizes storage room with all required cargo + supply large chests', () => {
  assert.equal(MAX_SIDE, 128)
  assert.equal(MAX_STORAGE_PAIRS, 16)
  assert.ok(PLAN_RULES >= 5)

  const plan = createMineGeometry({ scope, anchor: { x: 0, z: 0 }, direction: 'east', width: 128, length: 128, surfaceY: 64, upperY: 48, lowerY: -54 })
  assert.equal(plan.site.width, 128)
  assert.equal(plan.site.length, 128)
  const expectedDrops = defaultDropEstimate(128, 128)
  const expectedCargo = Math.ceil(Math.ceil(expectedDrops / 64) / 43)
  assert.ok(expectedCargo >= 7, `expected at least 7 cargo large chests, got ${expectedCargo}`)

  for (const room of plan.storage) {
    assert.equal(room.estimatedDrops, expectedDrops)
    assert.equal(room.pairs.filter(p => p.purpose === 'cargo').length, expectedCargo)
    assert.equal(room.pairs.filter(p => p.purpose === 'supply').length, 1)
    assert.equal(room.pairs.length, expectedCargo + 1)
    // Every chest pair stays separated by at least 1 block from all others.
    for (const a of room.pairs) {
      for (const b of room.pairs) {
        if (a === b) continue
        for (const p of a.positions) for (const q of b.positions) {
          assert.ok(Math.abs(p.x - q.x) + Math.abs(p.z - q.z) > 1, `${a.id} collides with ${b.id}`)
        }
      }
    }
  }

  // Supply needs request all 2 chests per large-chest pair for a fresh layer.
  const needs = supplyNeeds(plan, 'upper', {
    inventory: { known: true, items: [] },
    getBlock: () => ({ known: true, name: 'minecraft:stone' })
  })
  assert.equal(needs.chest, (expectedCargo + 1) * 2)

  // Scales up beyond 8 pairs when extra vein drops are expected (up to MAX_STORAGE_PAIRS).
  const huge = createMineGeometry({ scope, anchor: { x: 0, z: 0 }, direction: 'east', width: 128, length: 128, surfaceY: 64, upperY: 48, expectedDrops: { upper: 30000 } })
  assert.equal(huge.storage[0].pairs.length, Math.ceil(Math.ceil(30000 / 64) / 43) + 1)
  assert.ok(huge.storage[0].pairs.length > 8 && huge.storage[0].pairs.length <= MAX_STORAGE_PAIRS)
})

test('planMine plans a default 128x128 site within 4-chunk received terrain and keeps full large-chest capacity', async () => {
  const f = observationWorld({ index: 0 })
  f.receiveSite(0, 0)
  const out = await planMine({ world: f.world, getState: f.getState, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'raw_iron', targetCount: 1 })
  assert.equal(out.status, 'planned', JSON.stringify(out))
  assert.equal(out.plan.site.width, 128)
  assert.equal(out.plan.site.length, 128)
  const upperRoom = out.plan.storage.find(r => r.layer === 'upper')
  assert.ok(upperRoom.pairs.length >= 8, `expected >= 8 large chest pairs, got ${upperRoom.pairs.length}`)
  assert.equal(upperRoom.pairs.filter(p => p.purpose === 'supply').length, 1)
  assert.ok(out.plan.evaluation.availableTargetOre >= 1)
})

test('planMine still rejects unreceived shaft/storage or barren 4-chunk areas on 128x128', async () => {
  // Unreceived site -> observing (MINE_TERRAIN_UNKNOWN)
  const unreceived = observationWorld({ index: 0 })
  const obs = await planMine({ world: unreceived.world, getState: unreceived.getState, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'raw_iron', targetCount: 1 })
  assert.equal(obs.status, 'observing')
  assert.equal(obs.code, 'MINE_TERRAIN_UNKNOWN')

  // Barren received 4-chunk area (stone only, no ore) -> blocked (MINE_NO_SAFE_RESOURCE_PLAN)
  const barren = observationWorld({ index: 0 })
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    barren.announce(x, z)
    for (let y = 0; y <= 5; y++) barren.section(x, y, z, y >= 4 ? 'air' : 'stone')
  }
  const none = await planMine({ world: barren.world, getState: barren.getState, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'raw_iron', targetCount: 1 })
  assert.equal(none.status, 'blocked', JSON.stringify(none))
  assert.equal(none.code, 'MINE_NO_SAFE_RESOURCE_PLAN')
})

test('upgradeMineGeometry expands an unstarted 48x48 site to 128x128 with identical shaft in all four directions', () => {
  for (const direction of ['east', 'south', 'west', 'north']) {
    const oldPlan = createMineGeometry({ scope, anchor: { x: 9797, z: 10266 }, direction, width: 48, length: 48, surfaceY: 70, upperY: 16 })
    const upgraded = upgradeMineGeometry(oldPlan, { width: 128, length: 128 })
    assert.ok(upgraded, `upgrade failed for ${direction}`)
    assert.equal(upgraded.site.width, 128)
    assert.equal(upgraded.site.length, 128)
    assert.deepEqual(upgraded.shaft, oldPlan.shaft, `shaft must stay identical for ${direction}`)
    assert.ok(upgraded.storage[0].pairs.length >= 8, `expected >= 8 large chests for ${direction}`)
    assert.equal(upgradeMineGeometry(upgraded, { width: 128, length: 128 }), null)
  }
})
