'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { planQuarryExit, permitsExitAction } = require('../src/quarry-exit-plan')
const { buildRegions } = require('../src/quarry-region')

// 1.26.60 Realm, (-3,-13), 2026-11-06. Received east landing column:
// (-31,93,-199) grass_block, then 226 consecutive air cells through Y319.
// The quarry still had solid stone at its bottom when sampled. The synthetic
// cut face below lets the offline test examine its future, cleared entrance.
function hillside (override) {
  const regions = buildRegions({ target: { chunks: [{ x: -3, z: -13 }] }, yTop: 95, yBottom: -59 })
  const entry = { x: -33, y: -59, z: -199 }
  function getBlock (x, y, z) {
    let name = y < -59 ? 'deepslate' : 'air'
    if (x >= -32 && y <= 93) name = y === 93 ? 'grass_block' : y >= 91 ? 'dirt' : y >= 0 ? 'stone' : 'deepslate'
    const patch = override?.(x, y, z)
    if (patch === 'unknown') return { known: false }
    if (patch) name = patch
    const runtimeId = name === 'grass_block' ? 3727763636 : name === 'air' ? 3690217760 : 2
    return { known: true, name: 'minecraft:' + name, runtimeId, boundingBox: name === 'air' ? 'empty' : 'block', position: { x, y, z }, extra: [] }
  }
  const inventory = [0, 1, 2].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))
  inventory.push({ slot: 3, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1561 })
  return planQuarryExit({ regions, feet: entry, reachable: new Set(['-33,-59,-199']), getBlock, inventory, minFreeSlots: 1, exit: { side: 'auto' } })
}

test('a confirmed lower surface is a landing and dirt uses the local height', () => {
  const result = hillside()
  assert.equal(result.ok, true, JSON.stringify(result))
  const { plan } = result
  assert.equal(plan.side, 'east')
  assert.deepEqual(plan.column, { x: -32, z: -199 })
  assert.deepEqual(plan.landing, { x: -31, y: 94, z: -199 })
  assert.equal(plan.requiredDirt, 153)
  assert.equal(plan.totalDirt, 161)
  assert.equal(permitsExitAction(plan, 'travel', plan.landing), true)
  assert.equal(permitsExitAction(plan, 'break', plan.landing), false)
  assert.equal(permitsExitAction(plan, 'place', { ...plan.column, y: plan.targetFeetY }), false)
})

test('a cave roof, unknown sky, unsafe floor or hazardous shaft disqualifies the lower landing', () => {
  for (const [x, y, name] of [
    [-31, 129, 'stone'], [-31, 296, 'unknown'], [-31, 93, 'water'], [-31, 93, 'gravel'], [-31, 93, 'magma'],
    [-31, 93, 'diamond_ore'], [-32, 30, 'lava'], [-32, -33, 'gravel'], [-32, 10, 'ancient_debris']
  ]) {
    const result = hillside((ax, ay, az) => ax === x && ay === y && az === -199 ? name : undefined)
    assert.equal(result.reason, 'EXIT_COLUMN_UNAVAILABLE', [x, y, name].join(','))
  }
})

test('a listed ore inside the exit shaft is mined instead of disqualifying the column', () => {
  const result = hillside((ax, ay, az) => ax === -32 && ay === 10 && az === -199 ? 'diamond_ore' : undefined)
  assert.equal(result.ok, true, JSON.stringify(result.details ?? {}))
  assert.ok(result.plan.shaftCells.some(c => c.name === 'minecraft:diamond_ore' && c.position.y === 10))
})
