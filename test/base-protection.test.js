'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBaseProtection } = require('../src/base-protection')
const { createNavigator } = require('../src/navigation')
const { createTunneling } = require('../src/tunneling')

const key = p => `${p.x},${p.y},${p.z}`
const point = (x, y, z) => ({ x, y, z })
const receipt = position => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true })
const scope = () => ({ profile: 'bot', realmId: '42', dimension: 'overworld' })
const memo = () => ({ established: true, scope: scope(), site: { type: 'soil_hut', center: point(-9, 67, 11), forward: { x: 0, z: 1 } }, placements: [receipt(point(-10, 67, 10))] })

function fixture (options = {}) {
  const state = { profile: 'bot', realm: { id: '42' }, dimension: 'overworld', position: point(-8.5, 68.62, 11.5), inventory: { known: true, items: [] } }
  const rawBlocks = new Map()
  const getBlock = (x, y, z) => {
    const id = `${x},${y},${z}`
    if (!rawBlocks.has(id)) rawBlocks.set(id, { known: true, position: point(x, y, z), name: 'minecraft:dirt', properties: {}, runtimeId: 123, type: 9, stateId: 456, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], extra: [] })
    return rawBlocks.get(id)
  }
  const world = { getBlock, getArea: (center, radius) => {
    const result = []
    for (let x = center.x - radius; x <= center.x + radius; x++) for (let y = center.y - radius; y <= center.y + radius; y++) for (let z = center.z - radius; z <= center.z + radius; z++) result.push(getBlock(x, y, z))
    return result
  } }
  let hut = options.hut ?? memo()
  let shelter = options.shelter ?? null
  const view = createBaseProtection({ world, getState: () => state, getHutMemo: () => hut, getShelterMemo: () => shelter, ...options.factory })
  return { state, rawBlocks, world, view, setHut: value => { hut = value }, setShelter: value => { shelter = value } }
}

test('confirmed hut protects its complete floor, perimeter and roof without changing the world, block identity or player state', () => {
  const f = fixture()
  const originalState = structuredClone(f.state)
  const c = memo().site.center
  const protectedPoints = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    protectedPoints.push(point(c.x + dx, c.y - 1, c.z + dz))
    if (dx || dz) for (const dy of [0, 1]) protectedPoints.push(point(c.x + dx, c.y + dy, c.z + dz))
  }
  protectedPoints.push({ ...c, y: c.y + 2 })
  assert.equal(protectedPoints.length, 26)
  for (const p of protectedPoints) {
    const raw = f.world.getBlock(p.x, p.y, p.z)
    const protectedBlock = f.view.getBlock(p.x, p.y, p.z)
    assert.equal(protectedBlock.protected, true)
    assert.equal(protectedBlock.protectionSource, 'bot_base')
    assert.deepEqual({ ...protectedBlock, protected: undefined, protectionSource: undefined }, { ...raw, protected: undefined, protectionSource: undefined })
    assert.equal(raw.protected, undefined)
    assert.equal(f.view.getRawBlock(p.x, p.y, p.z), raw)
  }
  for (const p of [c, { ...c, y: c.y + 1 }, point(c.x + 2, c.y, c.z)]) assert.equal(f.view.getBlock(p.x, p.y, p.z).protected, undefined, 'temporary pillar/interior and surrounding terrain remain outside the protected shell')
  assert.deepEqual(f.state, originalState)
  assert.deepEqual(f.view.stats(), { protectedBlocks: 26, rebuilds: 1 })
})

test('scope mismatches, an unconfirmed mere plan, unrelated receipts and uncertain placements do not claim a base', () => {
  for (const mutate of [
    m => { m.scope.profile = 'someone-else' }, m => { m.scope.realmId = 'another-realm' }, m => { m.scope.dimension = 'nether' },
    m => { delete m.scope.profile }, m => { delete m.scope.realmId }, m => { m.placements = [] },
    m => { m.placements[0].serverConfirmed = false }, m => { m.placements[0].position = point(200, 67, 200) },
    m => { m.placements[0].item = 'minecraft:grass_block' }, m => { m.pendingPlacement = { position: m.placements[0].position } },
    m => { delete m.site }
  ]) {
    const m = memo(); mutate(m)
    const f = fixture({ hut: m })
    assert.equal(f.view.getBlock(-10, 67, 10).protected, undefined)
    assert.equal(f.view.stats().protectedBlocks, 0)
  }
  const legacy = memo(); delete legacy.scope.profile
  const bound = fixture({ hut: legacy, factory: { ownerProfile: 'bot' } })
  assert.equal(bound.view.getBlock(-10, 67, 10).protected, true)
  bound.state.profile = 'another-profile'
  assert.equal(bound.view.getBlock(-10, 67, 10).protected, undefined)
})

test('unknown cells stay unknown and pre-existing protection and all actual collision fields survive the overlay', () => {
  const f = fixture()
  const unknown = { known: false, position: point(-10, 67, 10), reason: 'subchunk_not_received', runtimeId: 999 }
  f.rawBlocks.set(key(unknown.position), unknown)
  assert.equal(f.view.getBlock(-10, 67, 10), unknown)
  const existing = { ...f.world.getBlock(-10, 68, 10), protected: true, protectionSource: 'world_rule', natural: false }
  f.rawBlocks.set('-10,68,10', existing)
  assert.equal(f.view.getBlock(-10, 68, 10), existing)
  assert.equal(f.view.getBlock(-10, 68, 10).protectionSource, 'world_rule')
})

test('memo references and scope invalidate the bounded coordinate cache, while repeated block reads do not rescan receipts', () => {
  const m = memo(); let scans = 0
  const placements = m.placements
  Object.defineProperty(m, 'placements', { get: () => { scans++; return placements }, enumerable: true })
  const f = fixture({ hut: m })
  f.view.getBlock(-10, 67, 10)
  const initialScans = scans
  for (let i = 0; i < 1000; i++) f.view.getBlock(-10, 67, 10)
  assert.equal(scans, initialScans)
  assert.equal(f.view.stats().rebuilds, 1)
  f.setHut({ ...memo(), site: { ...memo().site, center: point(20, 67, 11) }, placements: [receipt(point(19, 67, 10))] })
  assert.equal(f.view.getBlock(-10, 67, 10).protected, undefined)
  assert.equal(f.view.getBlock(19, 67, 10).protected, true)
  f.state.dimension = 'nether'
  assert.equal(f.view.getBlock(19, 67, 10).protected, undefined)
  assert.equal(f.view.stats().rebuilds, 3)
})

test('only an established confirmed soil shelter protects its preserved boundary and own doorway', () => {
  const entry = point(3, 65, 0); const inner = point(4, 65, 0)
  const doors = [entry, { ...entry, y: 66 }]
  const preserved = { floor: [{ position: point(3, 64, 0) }, { position: point(4, 64, 0) }], roof: [{ position: point(3, 67, 0) }, { position: point(4, 67, 0) }], walls: [{ position: point(4, 65, 1) }] }
  const shelter = { established: true, scope: scope(), site: { type: 'soil_hill_shelter', entry, inner, doorCells: doors.map(position => ({ position })), preserved }, placements: doors.map(receipt) }
  const f = fixture({ hut: {}, shelter })
  for (const p of [...Object.values(preserved).flat().map(value => value.position), ...doors]) assert.equal(f.view.getBlock(p.x, p.y, p.z).protected, true)
  assert.equal(f.view.getBlock(inner.x, inner.y, inner.z).protected, undefined)
  for (const change of [m => { m.established = false }, m => { m.placements = [] }, m => { m.scope.realmId = 'elsewhere' }]) {
    const next = structuredClone(shelter); change(next); f.setShelter(next)
    assert.equal(f.view.getBlock(3, 64, 0).protected, undefined)
  }
})

test('oversized or invalid saved geometry does not cause unbounded memo scanning or fabricated protection', () => {
  const m = memo(); m.placements = Array.from({ length: 65 }, () => receipt(point(-10, 67, 10)))
  const f = fixture({ hut: m })
  assert.equal(f.view.stats().protectedBlocks, 0)
  const invalid = memo(); invalid.site.center.y = 319; f.setHut(invalid)
  assert.equal(f.view.stats().protectedBlocks, 0)
  assert.throws(() => createBaseProtection({ world: f.world, getState: () => f.state, maxBlocks: 2000 }), /bound/)
})

test('open protected doorway air remains traversable by ordinary navigation and raw observations remain air', () => {
  const c = point(-9, 67, 11)
  const f = fixture()
  const world = { getBlock: (x, y, z) => {
    const relative = Math.abs(x - c.x) <= 1 && Math.abs(z - c.z) <= 1
    const door = x === c.x && z === c.z - 1
    const solid = y < c.y || relative && (x !== c.x || z !== c.z) && !door && (y === c.y || y === c.y + 1) || x === c.x && z === c.z && y === c.y + 2
    return { known: true, position: point(x, y, z), name: solid ? 'minecraft:dirt' : 'minecraft:air', properties: {}, extra: [] }
  } }
  const view = createBaseProtection({ world, getState: () => f.state, getHutMemo: memo })
  assert.equal(view.getBlock(-9, 67, 10).name, 'minecraft:air')
  assert.equal(view.getBlock(-9, 67, 10).protected, true)
  const navigator = createNavigator({ world: view })
  const initial = navigator.physics.fromServer({ position: point(-8.5, 68.62, 9.5), gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } })
  const route = navigator.plan(initial, point(-8.5, 67, 11.5), { maxDistance: 3 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial)
  let result
  for (let tick = 0; tick < 200; tick++) { result = stepper.next(); if (result.phase !== 'moving') break }
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.predictedState.onGround, true)
  assert.equal(world.getBlock(-9, 67, 10).protected, undefined)
})

test('real tunneling plans route around the protected base floor instead of treating it as resource clearance', () => {
  const target = point(0, 0, 0)
  const base = { ...memo(), site: { type: 'soil_hut', center: point(0, 6, 0), forward: { x: 0, z: 1 } }, placements: [receipt(point(-1, 6, -1))] }
  const tool = { slot: 0, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, durabilityUsed: 0 }
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, profile: 'bot', realm: { id: '42' }, dimension: 'overworld', position: point(0.5, 7.62, -1.5), rawSelectedSlot: 0, heldItem: tool, inventory: { known: true, items: [tool] }, entities: [] }
  const world = { getBlock: (x, y, z) => {
    const isOre = key(point(x, y, z)) === key(target)
    const shell = Math.abs(x) <= 1 && Math.abs(z) <= 1 && ((x || z) && (y === 6 || y === 7) || x === 0 && z === 0 && y === 8)
    const name = isOre ? 'diamond_ore' : y < 6 ? 'stone' : shell ? 'dirt' : 'air'
    return { known: true, position: point(x, y, z), name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, extra: [] }
  } }
  const view = createBaseProtection({ world, getState: () => state, getHutMemo: () => base })
  const tunnel = createTunneling({ world: view, getState: () => structuredClone(state), excavation: { preview: () => { throw new Error('Pure preview only') }, execute: () => { throw new Error('Pure preview only') }, stop: () => {} }, movement: { preview: () => {}, start: () => {}, stop: () => {} }, getMovement: () => ({ phase: 'idle' }), mining: { preview: () => {} } })
  const plan = tunnel.preview({ target, resource: 'diamond', requiredToolTier: 3 })
  assert.equal(plan.ready, true, plan.reason)
  assert.ok(plan.plannedDigBlocks > 0)
  for (const step of plan.steps) for (const p of step.blocksToMine) assert.notEqual(view.getBlock(p.x, p.y, p.z).protected, true, `The tunnel would remove base block ${key(p)}`)
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) assert.equal(view.getBlock(x, 5, z).protected, true)
  assert.equal(world.getBlock(0, 5, 0).protected, undefined)
  assert.equal(world.getBlock(0, 5, 0).name, 'minecraft:stone')
})
