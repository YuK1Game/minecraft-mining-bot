'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHutPlanner, planHut } = require('../src/hut-planner')

const key = point => `${point.x},${point.y},${point.z}`
const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : 1, extra: [] })
function fixture ({ feetY = 72 } = {}) {
  const state = { phase: 'spawned', health: 20, dimension: 'overworld', runtimeEntityId: '1', realm: { id: 'test-realm' }, position: { x: 0.5, y: feetY + 1.62, z: 0.5 }, positionSource: 'server', positionUpdatedAt: 'observed-position', inventory: { known: true, items: [] } }
  const overrides = new Map()
  const actors = []
  let reads = 0
  const world = { getBlock: (x, y, z) => { reads++; return overrides.get(`${x},${y},${z}`) ?? block(y === feetY - 1 ? 'grass_block' : y < feetY - 1 ? 'stone' : 'air') } }
  const planner = createHutPlanner({ world, getState: () => state, getEntities: () => actors, clock: () => 'observed-now' })
  return { state, overrides, world, actors, planner, reads: () => reads, set: (point, value) => overrides.set(key(point), typeof value === 'string' ? block(value) : value) }
}
function at (f, point) { return f.world.getBlock(point.x, point.y, point.z) }

test('the passive planner proposes an immutable 3x3 hut, seventeen dirt and a real recovery barrier', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  assert.equal(f.reads(), 0, 'constructor must be passive')
  const plan = f.planner.preview({ radius: 0 })
  assert.equal(plan.ready, true)
  assert.equal(plan.type, 'soil_hut')
  assert.equal(plan.footprint.length, 9)
  assert.equal(plan.walls.length, 14)
  assert.equal(plan.temporaryPillar.length, 2)
  assert.equal(plan.doorCells.length, 2)
  assert.equal(new Set(plan.ownedBuildCells.map(key)).size, 19)
  assert.equal(new Set(plan.buildCells.map(key)).size, 17)
  assert.equal(plan.materials.initialRequired, 17)
  assert.equal(plan.materials.totalPlacements, 19)
  assert.equal(plan.materials.finalPlaced, 17)
  assert.equal(plan.materials.observedDirt, 0)
  assert.equal(plan.materials.initialAvailable, false)
  assert.equal(plan.serverConfirmed, false)
  assert.equal(plan.usable, false)
  const recover = plan.steps.findIndex(step => step.type === 'wait_material')
  const door = plan.steps.findIndex(step => step.kind === 'door')
  assert.ok(recover > plan.steps.findIndex(step => step.stage === 'enter_hut') && recover < door)
  assert.equal(plan.steps[recover].requireServerInventory, true)
  assert.ok(plan.steps.filter(step => step.type === 'mine').every(step => step.alreadyClear === false), 'a future temporary pillar is not already removed just because its initial cell is air')
  assert.deepEqual(plan.steps.filter(step => step.kind === 'door').map(step => step.position.y), [72, 73])
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.steps[0].standpoints[0]))
  assert.throws(() => { plan.center.x = 100 }, TypeError)
  assert.deepEqual(f.state, before)
  assert.equal(f.overrides.size, 0)
  assert.ok(plan.preserved.floor.every(item => item.preserve && item.needsMining === false))
})

test('the whole proposed timeline has supported clear stances, real top-face sight and the exact material budget', () => {
  const f = fixture()
  const plan = f.planner.preview({ radius: 0 })
  let dirt = 17
  let dropped = 0
  let maximumSpent = 0
  const empty = point => at(f, point).name === 'minecraft:air'
  function standable (point) {
    assert.equal(at(f, { ...point, x: Math.floor(point.x), y: point.y - 1, z: Math.floor(point.z) }).boundingBox, 'block')
    for (const y of [point.y, point.y + 1]) assert.equal(empty({ x: Math.floor(point.x), y, z: Math.floor(point.z) }), true, `stance blocked at ${key(point)}`)
  }
  for (const step of plan.steps) {
    if (step.type === 'move') { standable(step.target); continue }
    if (step.type === 'wait_material') {
      assert.equal(dirt, 0, 'the seventeen starting dirt have actually been placed before recovery')
      assert.equal(dropped, 2)
      dirt += dropped; dropped = 0
      assert.ok(dirt >= step.count)
      continue
    }
    for (const stance of step.standpoints) standable(stance)
    const stance = step.standpoints[0]
    const eye = { ...stance, y: stance.y + 1.62 }
    const point = { x: step.position.x + 0.5, y: step.position.y + (step.type === 'mine' ? 0.5 : 0), z: step.position.z + 0.5 }
    if (step.type === 'place') {
      assert.ok(eye.y > point.y + 0.01, 'the top face must be seen from above, not through the support side')
      assert.equal(empty(step.position), true)
      assert.equal(at(f, step.support).boundingBox, 'block')
      assert.deepEqual(step.support, { ...step.position, y: step.position.y - 1 })
      assert.equal(step.face, 1)
      assert.ok(dirt > 0)
    } else {
      assert.ok(plan.temporaryPillar.some(position => key(position) === key(step.position)))
      assert.equal(at(f, step.position).name, 'minecraft:dirt')
      assert.equal(step.ownReceiptRequired, true)
    }
    const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
    assert.ok(distance <= 4.25)
    for (let t = 0; t < 1 - 1e-6; t += 0.005) {
      const cell = { x: Math.floor(eye.x + (point.x - eye.x) * t), y: Math.floor(eye.y + (point.y - eye.y) * t), z: Math.floor(eye.z + (point.z - eye.z) * t) }
      if (step.type === 'mine' && key(cell) === key(step.position)) continue
      assert.equal(empty(cell), true, `${step.stage}: blocked ray at ${key(cell)}`)
    }
    if (step.type === 'place') { dirt--; f.set(step.position, 'dirt'); maximumSpent = Math.max(maximumSpent, 17 - dirt) } else { dropped++; f.set(step.position, 'air') }
  }
  assert.equal(maximumSpent, 17)
  assert.equal(dirt, 0)
  assert.ok(plan.buildCells.every(point => at(f, point).name === 'minecraft:dirt'))
  assert.ok(plan.temporaryPillar.every(empty))
  assert.equal(plan.preserved.floor.every(point => at(f, point.position).name === 'minecraft:grass_block'), true)
})

test('a deferred front-corner upper wall gives one-block supported ascent and descent before the entrance closes', () => {
  const plan = fixture().planner.preview({ radius: 0 })
  const roofIndex = plan.steps.findIndex(step => step.kind === 'roof')
  const finish = plan.steps.findIndex(step => step.stage === 'finish_front_corner')
  const deferredKey = key(plan.staircase.deferredUpper)
  assert.equal(plan.steps.slice(0, roofIndex).some(step => step.type === 'place' && key(step.position) === deferredKey), false)
  assert.ok(finish > roofIndex)
  assert.deepEqual(plan.steps.filter(step => ['climb_one_block', 'climb_wall', 'descend_one_block', 'descend_to_ground'].includes(step.stage)).map(step => step.target.y), [73, 74, 73, 72])
  const roof = plan.steps[roofIndex]
  assert.deepEqual(roof.standpoints, [plan.staircase.elevatedStandpoint])
  assert.ok(roof.standpoints[0].y + 1.62 > roof.position.y)
})

test('each cardinal door orientation can be planned from the corresponding outside stance', () => {
  const f = fixture()
  const first = f.planner.preview({ radius: 0 })
  for (const forward of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
    const site = { type: 'soil_hut', outsideFootCell: first.outsideFootCell, forward, id: `soil-hut:${forward.x * 2},72,${forward.z * 2}:${forward.x},${forward.z}` }
    const plan = f.planner.preview({ site })
    assert.equal(plan.ready, true, JSON.stringify(forward))
    assert.deepEqual(plan.center, { x: forward.x * 2, y: 72, z: forward.z * 2 })
    assert.equal(plan.wallCells.length, 14)
    assert.equal(plan.preserved.floor.length, 9)
  }
})

test('unknown floors and protected, constructed, wet, falling or tree cells are never treated as a buildable footprint', () => {
  const original = fixture().planner.preview({ radius: 0 })
  for (const [point, value] of [
    [original.preserved.floor[0].position, { known: false }],
    [original.preserved.floor[0].position, 'air'],
    [original.preserved.floor[0].position, 'sand'],
    [original.preserved.floor[0].position, { ...block('grass_block'), protected: true }],
    [original.preserved.floor[0].position, { ...block('dirt'), natural: false }],
    [original.wallCells[0], 'oak_log'],
    [original.wallCells[0], 'oak_leaves'],
    [original.wallCells[0], 'crafting_table'],
    [original.wallCells[0], 'short_grass'],
    [original.wallCells[0], 'water'],
    [original.wallCells[0], 'gravel'],
    [original.roof, { ...block('air'), extra: [block('water')] }]
  ]) {
    const f = fixture(); f.set(point, value)
    assert.equal(f.planner.preview({ site: original }).ready, false, JSON.stringify(value))
  }
})

test('safe additional stances are proposed when far walls cannot be reached from the initial outside position', () => {
  const f = fixture()
  const plan = f.planner.preview({ radius: 0 })
  assert.equal(plan.ready, true)
  assert.ok(plan.steps.filter(step => step.type === 'place').some(step => step.standpoints[0].x !== plan.outsideStandpoint.x || step.standpoints[0].z !== plan.outsideStandpoint.z))
  for (const step of plan.steps.filter(step => step.type === 'place')) {
    assert.ok(step.standpoints.length > 0)
    assert.equal(step.requiresLivePreview, true)
    assert.equal(step.requireServerBlockAndInventory, true)
  }
})

test('a known actor at a build cell and an obstructed elevated body stance reject the saved site', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  f.actors.push({ kind: 'player', runtimeId: '2', dimension: 'overworld', position: { x: site.center.x + 0.5, y: site.center.y + 1.62, z: site.center.z + 0.5 } })
  assert.equal(f.planner.preview({ site }).code, 'SITE_CHANGED')
  f.actors.length = 0
  f.set({ x: Math.floor(site.staircase.elevatedStandpoint.x), y: site.center.y + 3, z: Math.floor(site.staircase.elevatedStandpoint.z) }, 'oak_leaves')
  assert.equal(f.planner.preview({ site }).code, 'SITE_CHANGED')
})

test('the field deathdrop beside a receipted closed wall and drops inside the hut do not invalidate its geometry', () => {
  const f = fixture({ feetY: 67 })
  f.state.position.x = -9.5
  f.state.position.z = 11.5
  const site = f.planner.preview({ radius: 0 })
  assert.ok(site.wallCells.some(point => key(point) === '-9,67,10'))
  for (const position of site.buildCells) f.set(position, 'dirt')
  const memo = { site, established: true, placements: site.buildCells.map(position => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true })) }
  f.state.position = { ...site.insideStandpoint, y: site.insideStandpoint.y + 1.62 }
  const drop = { kind: 'item', entityType: 'minecraft:item', runtimeId: '1362', alive: true, positionKnown: true, dimension: 'overworld', name: 'minecraft:oak_planks', count: 4, position: { x: -8.588, y: 67.125, z: 9.875 } }
  f.actors.push(drop, { ...drop, runtimeId: '1363', position: { ...site.insideStandpoint, y: site.center.y + 0.125 } })
  const beforeMemo = structuredClone(memo)
  const preview = f.planner.preview({ memo })
  assert.equal(preview.ready, true)
  assert.equal(preview.constructionState.inside, true)
  assert.equal(preview.constructionState.roofPresent, true)
  assert.equal(preview.constructionState.doorClosed, true)
  assert.equal(preview.constructionState.existingOwnedPlacements, 17)
  assert.equal(preview.materials.observedDirt, 0, 'a drop is not an inventory pickup')
  assert.equal(preview.serverConfirmed, false)
  assert.deepEqual(memo, beforeMemo)
  for (const kind of ['mob', 'player', 'entity']) {
    f.actors.splice(0, f.actors.length, { ...drop, kind, entityType: kind === 'player' ? 'minecraft:player' : kind === 'mob' ? 'minecraft:zombie' : 'custom:living_actor' })
    assert.equal(f.planner.preview({ memo }).code, 'SITE_CHANGED', `a living ${kind} at the exact drop position must still block the wall`)
  }
})

test('dead and item actors are excluded before unknown-position checks while unknown living actors remain blocking', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  const inside = { ...site.insideStandpoint, y: site.center.y + 0.5 }
  const nonLiving = [
    { kind: 'item', alive: true },
    { kind: 'entity', entityType: 'minecraft:item', alive: true },
    { kind: 'mob', alive: false },
    { kind: 'mob', dead: true },
    { kind: 'mob', isDead: true },
    { kind: 'mob', alive: true, health: 0 }
  ]
  for (const entity of nonLiving) for (const position of [inside, null]) {
    f.actors.splice(0, f.actors.length, { runtimeId: '2', dimension: 'overworld', position, positionKnown: position !== null, ...entity })
    assert.equal(f.planner.preview({ site }).ready, true, `${JSON.stringify(entity)} at ${JSON.stringify(position)}`)
  }
  for (const kind of ['player', 'mob', 'entity']) {
    for (const position of [null, inside]) {
      f.actors.splice(0, f.actors.length, { runtimeId: '2', dimension: 'overworld', kind, alive: true, position, positionKnown: false })
      assert.equal(f.planner.preview({ site }).code, 'ACTOR_POSITION_UNKNOWN')
    }
  }
  f.actors.splice(0, f.actors.length, { runtimeId: 1, kind: 'player', alive: true, positionKnown: false })
  assert.equal(f.planner.preview({ site }).ready, true, 'the known self runtime ID is not an unknown other actor')
})

test('partial construction resumes only with verified own-placement receipts and remains a proposal', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  const placed = site.steps.slice(0, 4).filter(step => step.type === 'place')
  for (const step of placed) f.set(step.position, { ...block('dirt'), natural: false })
  assert.equal(f.planner.preview({ site }).code, 'SITE_CHANGED')
  const memo = { site: structuredClone(site), placements: placed.map(step => ({ position: step.position, item: 'minecraft:dirt', count: 1, serverConfirmed: true })), scope: { dimension: 'overworld', realmId: 'test-realm' } }
  const before = structuredClone(memo)
  const resumed = f.planner.preview({ memo })
  assert.equal(resumed.ready, true)
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.steps.filter(step => step.type === 'place' && step.alreadyPlaced).length, placed.length)
  assert.equal(resumed.usable, false)
  assert.equal(resumed.serverConfirmed, false)
  assert.deepEqual(memo, before)
  memo.pendingPlacement = { position: placed[0].position, requiresReconciliation: true }
  assert.equal(f.planner.preview({ memo }).code, 'PLACEMENT_UNCERTAIN')
})

test('scope and malformed saved sites are rejected instead of relocating or granting ownership', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  assert.equal(f.planner.preview({ memo: { site, scope: { dimension: 'nether', realmId: 'test-realm' } } }).code, 'SITE_SCOPE_CHANGED')
  assert.equal(f.planner.preview({ memo: { site, scope: { dimension: 'overworld', realmId: 'another-realm' } } }).code, 'SITE_SCOPE_CHANGED')
  assert.equal(f.planner.preview({ site: { ...site, forward: { x: 1, z: 1 } } }).code, 'INVALID_SITE')
  assert.equal(f.planner.preview({ site: { ...site, id: 'different' } }).code, 'SITE_CHANGED')
})

test('a received closed hut can be revalidated from inside without trusting its historic completion label', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  for (const position of site.buildCells) f.set(position, { ...block('dirt'), natural: false })
  const memo = { site, established: true, placements: site.buildCells.map(position => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true })) }
  f.state.position = { ...site.insideStandpoint, y: site.insideStandpoint.y + 1.62 }
  const closed = f.planner.preview({ memo })
  assert.equal(closed.ready, true)
  assert.equal(closed.constructionState.inside, true)
  assert.equal(closed.constructionState.roofPresent, true)
  assert.equal(closed.constructionState.doorClosed, true)
  assert.equal(closed.usable, false, 'the executor must still verify completion, a plan is not a completion receipt')
  assert.ok(closed.steps.filter(step => step.type === 'mine').every(step => step.alreadyClear))
  f.set(site.roof, { known: false })
  assert.equal(f.planner.preview({ memo }).code, 'SITE_CHANGED')
})

test('grass spreading onto receipted full-cube walls, roof and doors preserves the closed hut proposal', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  for (const position of site.buildCells) f.set(position, { ...block('dirt'), natural: false })
  const grown = [site.wallCells[0], site.roof, ...site.doorCells]
  for (const position of grown) f.set(position, block('grass_block'))
  const memo = { site, established: true, placements: site.buildCells.map(position => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true })) }
  const beforeMemo = structuredClone(memo)
  const beforeState = structuredClone(f.state)
  f.state.position = { ...site.insideStandpoint, y: site.insideStandpoint.y + 1.62 }
  const plan = f.planner.preview({ memo })
  assert.equal(plan.ready, true)
  assert.equal(plan.constructionState.inside, true)
  assert.equal(plan.constructionState.roofPresent, true)
  assert.equal(plan.constructionState.doorClosed, true)
  assert.equal(plan.constructionState.existingOwnedPlacements, 17)
  for (const position of grown) {
    const step = plan.steps.find(step => step.type === 'place' && key(step.position) === key(position))
    assert.equal(step.alreadyPlaced, true)
    assert.equal(step.observed.observedName, 'minecraft:grass_block')
    assert.equal(step.item, 'minecraft:dirt', 'new placement still needs actual dirt, not a fabricated grass item')
    assert.equal(step.requireServerBlockAndInventory, true)
  }
  assert.equal(plan.materials.initialRequired, 17)
  assert.equal(plan.materials.observedDirt, 0)
  assert.equal(plan.materials.initialAvailable, false)
  assert.equal(plan.serverConfirmed, false)
  assert.equal(plan.usable, false)
  assert.deepEqual(memo, beforeMemo)
  assert.deepEqual(f.state.inventory, beforeState.inventory)
})

test('grass requires the exact confirmed dirt-one receipt and never creates ownership or skips an unproven placement', () => {
  for (const modify of [
    receipt => ({ ...receipt, serverConfirmed: false }),
    receipt => ({ ...receipt, item: 'minecraft:grass_block' }),
    receipt => ({ ...receipt, count: 2 }),
    receipt => ({ ...receipt, position: { ...receipt.position, x: receipt.position.x + 100 } })
  ]) {
    const f = fixture()
    const site = f.planner.preview({ radius: 0 })
    const position = site.wallCells[0]
    f.set(position, block('grass_block'))
    const receipt = { position, item: 'minecraft:dirt', count: 1, serverConfirmed: true }
    assert.equal(f.planner.preview({ site }).code, 'SITE_CHANGED', 'unreceipted grass must not be treated as a completed wall')
    assert.equal(f.planner.preview({ memo: { site, placements: [modify(receipt)] } }).code, 'SITE_CHANGED')
  }
})

test('a receipt does not make unknown, liquid, hollow or replacement blocks into owned soil', () => {
  for (const replacement of [{ known: false }, block('lava'), block('stone'), block('crafting_table'), { ...block('grass_block'), boundingBox: 'empty' }, { ...block('grass_block'), extra: [block('water')] }]) {
    const f = fixture()
    const site = f.planner.preview({ radius: 0 })
    const position = site.wallCells[0]
    f.set(position, replacement)
    const memo = { site, placements: [{ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true }] }
    assert.equal(f.planner.preview({ memo }).code, 'SITE_CHANGED', JSON.stringify(replacement))
  }
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  const position = site.wallCells[0]
  const memo = { site, placements: [{ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true }] }
  const missing = f.planner.preview({ memo })
  const step = missing.steps.find(step => step.type === 'place' && key(step.position) === key(position))
  assert.equal(step.alreadyPlaced, false, 'received air can propose a repair, but cannot reuse the old receipt as an existing wall')
  assert.equal(step.requireServerBlockAndInventory, true)
})

test('remote construction returns an explicit approach and unknown terrain or invalid state stays bounded', () => {
  const f = fixture()
  const site = f.planner.preview({ radius: 0 })
  f.state.position.x = -0.15
  const remote = f.planner.preview({ radius: 2 })
  assert.equal(remote.code, 'APPROACH_REQUIRED')
  assert.equal(remote.approach.hutVerified, true)
  assert.deepEqual(remote.proposal.target, remote.candidate.outsideStandpoint)
  assert.equal(planHut(f.state, { blocks: [] }, { radius: 2 }).code, 'NO_KNOWN_FLAT_SITE')
  assert.equal(f.planner.preview({ radius: 11 }).code, 'INVALID_RADIUS')
  f.state.health = 0
  assert.equal(f.planner.preview().code, 'PLAYER_NOT_READY')
  assert.equal(site.materialBudget.initial, 17)
})

test('block-only observations and actual dirt inventory evidence do not turn a planned hut into completion', () => {
  const f = fixture()
  f.state.inventory.items = [{ name: 'minecraft:dirt', count: 17, slot: 0 }, { name: 'minecraft:grass_block', count: 64, slot: 1 }]
  const blocks = []
  for (let x = -3; x <= 5; x++) for (let z = -3; z <= 3; z++) for (let y = 71; y <= 76; y++) blocks.push({ ...f.world.getBlock(x, y, z), position: { x, y, z } })
  const plan = planHut(f.state, { blocks, observedAt: 'fixture-observed' }, { radius: 0 })
  assert.equal(plan.ready, true)
  assert.equal(plan.materials.initialAvailable, true)
  assert.equal(plan.materials.observedDirt, 17)
  assert.equal(plan.observedAt, 'fixture-observed')
  assert.equal(plan.constructionState.roofPresent, false)
  assert.equal(plan.serverConfirmed, false)
  assert.equal(plan.usable, false)
})
