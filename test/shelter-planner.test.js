'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createShelterPlanner, planShelter } = require('../src/shelter-planner')

const key = point => `${point.x},${point.y},${point.z}`
const block = name => ({ known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : name === 'dirt' ? 10 : 20, boundingBox: ['air', 'short_grass'].includes(name) ? 'empty' : 'block', extra: [] })
function fixture ({ hill = true, facing = { x: 1, z: 0 } } = {}) {
  const state = { phase: 'spawned', health: 20, runtimeEntityId: '41', dimension: 'overworld', connectionId: 'fixture', startedAt: 'session', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: '2026-10-31T00:00:00.000Z', inventory: { known: true, items: [] } }
  const overrides = new Map()
  const side = { x: -facing.z, z: facing.x }
  const world = { getBlock: (x, y, z) => {
    if (overrides.has(`${x},${y},${z}`)) return overrides.get(`${x},${y},${z}`)
    if (y < 65) return block('stone')
    const depth = x * facing.x + z * facing.z
    const lateral = x * side.x + z * side.z
    if (hill && depth >= 1 && depth <= 4 && lateral >= -2 && lateral <= 2 && y <= 67) return block(y === 67 ? 'grass_block' : 'dirt')
    return block('air')
  } }
  const planner = createShelterPlanner({ getState: () => state, world, clock: () => 'observed-now' })
  const set = (point, value) => overrides.set(key(point), typeof value === 'string' ? block(value) : value)
  return { state, world, planner, set }
}

test('a known soil hill yields staged two-cell access, an inner-first dirt door and a preserved 3x2x2 room', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  const plan = f.planner.preview({ radius: 0 })
  assert.equal(plan.ready, true)
  assert.equal(plan.type, 'soil_hill_shelter')
  assert.deepEqual(plan.entry, { x: 1, y: 65, z: 0 })
  assert.deepEqual(plan.innerStandpoint, { x: 2.5, y: 65, z: 0.5 })
  assert.deepEqual(plan.initialSteps.map(step => step.clearance.map(item => item.position.y)), [[66, 65], [66, 65]])
  assert.deepEqual(plan.initialSteps.map(step => step.target.x), [1.5, 2.5])
  assert.deepEqual(plan.doorCells.map(item => item.position.y), [65, 66])
  assert.ok(plan.doorCells.every(item => item.expectedBlock === 'minecraft:dirt' && item.needsPlacement))
  assert.equal(plan.finalInterior.footCells.length, 6)
  assert.equal(plan.finalInterior.bodyCells.length, 12)
  assert.equal(plan.expansion.length, 10)
  assert.equal(plan.materials.requiredForClosure.count, 2)
  assert.equal(plan.materials.requireActualInventory, true)
  assert.equal(plan.observedAt, 'observed-now')
  assert.equal(plan.ownTimestamp, before.positionUpdatedAt)
  const dig = new Set([...plan.initialExcavation, ...plan.expansion].map(item => key(item.position)))
  for (const item of [...plan.preserved.floor, ...plan.preserved.roof]) {
    assert.equal(dig.has(key(item.position)), false)
    assert.equal(item.preserve, true)
    assert.equal(item.needsMining, false)
  }
  assert.equal(plan.minimumInterior.footCells.length, 1)
  assert.equal(plan.minimumInterior.bodyCells.length, 2)
  assert.equal(plan.preserved.floor.length, 2)
  assert.equal(plan.preserved.roof.length, 2)
  assert.ok(plan.preserved.walls.every(item => item.preserve && !item.needsMining))
  assert.ok(plan.preserved.walls.some(item => item.releaseOnVerifiedExpansion))
  assert.deepEqual(plan.stages.map(stage => stage.type), ['excavate_passage', 'enter_inner', 'collect_material', 'close_entrance', 'expand_interior'])
  assert.deepEqual(f.state, before)
  assert.equal(plan.serverConfirmed, false)
})

test('all cardinal hill faces use the same enclosure dimensions and lower-to-upper closure order', () => {
  for (const facing of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
    const f = fixture({ facing })
    const plan = f.planner.preview({ radius: 0 })
    assert.equal(plan.ready, true, JSON.stringify(facing))
    assert.deepEqual(plan.forward, facing)
    assert.equal(new Set(plan.finalInterior.bodyCells.map(item => key(item.position))).size, 12)
    assert.equal(plan.doorCells[0].position.y + 1, plan.doorCells[1].position.y)
  }
})

test('unknown cells, liquids, gravel, explicit player placement and constructed blocks reject the site', () => {
  for (const [point, value] of [
    [{ x: 2, y: 67, z: 0 }, { known: false }],
    [{ x: 2, y: 65, z: 1 }, 'water'],
    [{ x: 2, y: 68, z: 0 }, 'gravel'],
    [{ x: 2, y: 66, z: 0 }, 'crafting_table'],
    [{ x: 1, y: 65, z: 1 }, 'oak_planks'],
    [{ x: 3, y: 66, z: 0 }, 'bricks'],
    [{ x: 2, y: 65, z: 0 }, { ...block('dirt'), natural: false }],
    [{ x: 2, y: 67, z: 0 }, { ...block('grass_block'), protected: true }],
    [{ x: 2, y: 66, z: 0 }, { ...block('dirt'), extra: [block('water')] }]
  ]) {
    const f = fixture(); f.set(point, value)
    assert.equal(f.planner.preview({ radius: 0 }).ready, false, key(point))
  }
})

test('roof and floor holes and a dirt structure lacking a real grass cap are never offered as a shelter', () => {
  for (const point of [{ x: 2, y: 64, z: 0 }, { x: 2, y: 67, z: 0 }]) {
    const f = fixture(); f.set(point, 'air')
    assert.equal(f.planner.preview({ radius: 0 }).ready, false)
  }
  const unproven = fixture()
  const getBlock = (x, y, z) => { const observed = unproven.world.getBlock(x, y, z); return observed.name === 'minecraft:grass_block' ? block('dirt') : observed }
  assert.equal(planShelter(unproven.state, { getBlock }, { radius: 0 }).ready, false)
})

test('a known remote hill produces a live-preview approach proposal instead of digging from an unsafe distance', () => {
  const f = fixture()
  f.state.position.x = -3.5
  const result = f.planner.preview({ radius: 4 })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'APPROACH_REQUIRED')
  assert.equal(result.approach.shelterVerified, true)
  assert.deepEqual(result.proposal.target, result.candidate.outsideStandpoint)
  assert.equal(result.proposal.requiresLivePreview, true)
  assert.equal(result.candidate.initialExcavation.length, 4)
})

test('resuming recognizes actually cleared cells, keeps a closed door from inside and refreshes own observation stamps', () => {
  const f = fixture()
  const original = f.planner.preview({ radius: 0 })
  const untouched = structuredClone(original)
  for (const item of original.initialExcavation) f.set(item.position, 'air')
  f.state.position = { ...original.innerStandpoint, y: original.innerStandpoint.y + 1.62 }
  f.state.positionUpdatedAt = 'new-own-timestamp'
  const partial = f.planner.preview({ site: original })
  assert.equal(partial.ready, true)
  assert.ok(partial.initialExcavation.every(item => item.alreadyClear && !item.needsMining))
  assert.equal(partial.constructionState.inside, true)
  assert.equal(partial.constructionState.doorClosed, false)
  assert.equal(partial.ownTimestamp, 'new-own-timestamp')
  for (const item of original.doorCells) f.set(item.position, 'dirt')
  const closed = f.planner.preview({ site: original })
  assert.equal(closed.ready, true)
  assert.equal(closed.constructionState.doorClosed, true)
  assert.ok(closed.initialSteps[0].clearance.every(item => item.preserve && !item.needsMining))
  for (const item of original.expansion) f.set(item.position, 'air')
  const expanded = f.planner.preview({ site: original })
  assert.equal(expanded.constructionState.interiorClear, true)
  assert.equal(expanded.expansion.every(item => item.alreadyClear), true)
  assert.deepEqual(original, untouched)
})

test('a remembered site never accepts changed walls, altered roofs or excavating below the current player column', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  f.state.position = { x: 2.5, y: 69.62, z: 0.5 }
  assert.equal(f.planner.preview({ site }).code, 'SITE_CHANGED')
  f.state.position = { x: 0.5, y: 66.62, z: 0.5 }
  f.set({ x: 3, y: 66, z: 0 }, 'air')
  assert.equal(f.planner.preview({ site }).code, 'SITE_CHANGED')
})

test('without a known hill, only a known safe observation standpoint is proposed and block-only input remains supported', () => {
  const f = fixture({ hill: false })
  const result = f.planner.preview({ radius: 3 })
  assert.equal(result.code, 'NO_KNOWN_SOIL_HILL')
  assert.equal(result.approach.shelterVerified, false)
  assert.equal(result.proposal.purpose, 'observe_more_terrain')
  const empty = planShelter(f.state, { blocks: [] }, { radius: 3 })
  assert.equal(empty.ready, false)
  assert.equal(empty.approach, null)
  const hill = fixture()
  const blocks = []
  for (let x = -2; x <= 5; x++) for (let y = 62; y <= 71; y++) for (let z = -3; z <= 3; z++) blocks.push({ ...hill.world.getBlock(x, y, z), position: { x, y, z } })
  assert.equal(planShelter(hill.state, { blocks, observedAt: 'offline-blocks' }, { radius: 0 }).ready, true)
  assert.equal(planShelter(hill.state, { blocks }, { radius: 13 }).code, 'INVALID_RADIUS')
  const invalidPosition = { ...hill.state, position: { ...hill.state.position, x: 1e20 } }
  assert.equal(planShelter(invalidPosition, { blocks }, { radius: 3 }).code, 'PLAYER_NOT_READY')
})

function observedBaseArea () {
  // Sanitized 6x5x6 geometry from the actual base-area observation. No profile,
  // realm, authentication, inventory or connection data and no .local reads.
  // Each row is X=-18..-13; rows are Z=18..22, layers are Y=66..71.
  const layers = [
    ['ssssss', 'sssssg', 'sssssg', 'sssssg', 'sssssg'],
    ['ddddda', 'ddddga', 'sdddaa', 'sdddga', 'sdddaa'],
    ['ddddga', 'ddddaa', 'gdddaa', 'gdddaa', 'gddgaa'],
    ['gggdaa', 'ggggaa', 'agggaa', 'agggaa', 'aggaaa'],
    ['ahagaa', 'aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa'],
    ['aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa']
  ]
  const names = { s: 'stone', d: 'dirt', g: 'grass_block', a: 'air', h: 'short_grass' }
  const blocks = []
  layers.forEach((rows, dy) => rows.forEach((row, dz) => [...row].forEach((code, dx) => blocks.push({ ...block(names[code]), position: { x: -18 + dx, y: 66 + dy, z: 18 + dz } }))))
  const state = { phase: 'spawned', gameMode: 'survival', health: 18, runtimeEntityId: 'fixture-player', dimension: 'overworld', position: { x: -19.7, y: 68.62, z: 25.7 }, positionUpdatedAt: 'observed-base-position', positionSource: 'client_prediction' }
  return { blocks, state }
}

test('actual base-area hill is rejected at strict radius8 but becomes a valid minimal refuge approach at radius9', () => {
  const f = observedBaseArea()
  const before = structuredClone(f)
  assert.equal(planShelter(f.state, { blocks: f.blocks }, { radius: 8 }).code, 'NO_KNOWN_SOIL_HILL')
  const near = planShelter(f.state, { blocks: f.blocks }, { radius: 9 })
  assert.equal(near.code, 'APPROACH_REQUIRED')
  assert.deepEqual(near.approach.target, { x: -13.5, y: 67, z: 20.5 })
  assert.equal(near.approach.requiresLivePreview, true)
  const ownAtOutside = { ...f.state, position: { ...near.approach.target, y: 68.62 } }
  const plan = planShelter(ownAtOutside, { blocks: f.blocks }, { radius: 0 })
  assert.equal(plan.ready, true)
  assert.deepEqual(plan.forward, { x: -1, z: 0 })
  assert.equal(plan.geometryScope, 'minimum_refuge')
  assert.equal(plan.minimumInterior.footCells.length, 1)
  assert.equal(plan.minimumInterior.bodyCells.length, 2)
  assert.ok(plan.initialExcavation.every(item => item.name === 'minecraft:dirt'))
  assert.equal(plan.preserved.floor.length, 2)
  assert.equal(plan.preserved.roof.length, 2)
  assert.equal(plan.preserved.walls.length, 10)
  assert.equal(plan.expansionPlan.barehandReady, true)
  assert.ok(plan.expansionPlan.preserved.walls.some(item => item.name === 'minecraft:stone'), 'unexcavated natural stone boundaries do not require a pickaxe')
  assert.deepEqual(f, before)
})

test('future stone, unknown cells or liquids defer expansion without invalidating the intact minimal refuge', () => {
  for (const replacement of [block('stone'), { known: false, name: null }, { ...block('water'), boundingBox: 'empty' }]) {
    const f = observedBaseArea()
    f.state.position = { x: -13.5, y: 68.62, z: 20.5 }
    const target = f.blocks.find(item => key(item.position) === '-17,67,19')
    Object.assign(target, replacement)
    const plan = planShelter(f.state, { blocks: f.blocks }, { radius: 0 })
    assert.equal(plan.ready, true)
    assert.equal(plan.expansionPlan.ready, false)
    assert.ok(plan.expansion.every(item => item.deferred))
    assert.equal(plan.stages.at(-1).deferred, true)
    if (replacement.name === 'minecraft:stone') {
      assert.equal(plan.expansionPlan.safe, true)
      assert.equal(plan.expansionPlan.requiresPickaxe, true)
      assert.equal(plan.expansionPlan.requiredToolTier, 1)
    } else assert.equal(plan.expansionPlan.safe, false)
    assert.ok(plan.preserved.floor.every(item => item.known && item.preserve))
    assert.ok(plan.preserved.roof.every(item => item.known && item.preserve))
    const back = f.blocks.find(item => key(item.position) === '-17,67,20')
    Object.assign(back, { known: false, name: null })
    assert.equal(planShelter(f.state, { blocks: f.blocks }, { radius: 0 }).ready, false, 'unknown in the actual initial back wall remains forbidden')
  }
})

test('a new refuge cannot treat an unexecuted future-room cell as inside or require its grass cap', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  f.set({ x: 3, y: 67, z: 1 }, 'stone')
  const plan = f.planner.preview({ radius: 0 })
  assert.equal(plan.ready, true)
  assert.equal(plan.expansionPlan.safe, true)
  f.set({ x: 3, y: 65, z: 1 }, 'air'); f.set({ x: 3, y: 66, z: 1 }, 'air')
  f.state.position = { x: 3.5, y: 66.62, z: 1.5 }
  const elsewhere = f.planner.preview({ site })
  assert.equal(elsewhere.code, 'APPROACH_REQUIRED')
  assert.equal(elsewhere.candidate.constructionState.inside, false)
})

test('empty natural litter above the retained grass roof does not require an action or broaden the supported outside stance', () => {
  const f = fixture()
  const litter = { ...block('leaf_litter'), boundingBox: 'empty' }
  f.set({ x: 2, y: 68, z: 0 }, litter)
  assert.equal(f.planner.preview({ radius: 0 }).ready, true)
  f.set({ x: 0, y: 65, z: 0 }, litter)
  assert.equal(f.planner.preview({ radius: 0 }).ready, false)
})
