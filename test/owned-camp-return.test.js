'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const { planOwnedCampReturn } = require('../src/owned-camp-return')
const { createNavigator } = require('../src/navigation')
const { createBaseContinuation, continuationScope } = require('../src/base-continuation')
const copy = v => structuredClone(v), key = p => `${p.x},${p.y},${p.z}`, finger = b => ({ name: b.name, runtimeId: b.runtimeId, properties: b.properties })
function fixture () {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'CONTROLLED', startedAt: '2026-11-01T17:00:00Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { phase: 'alive', deathId: 1 }, health: 20, food: { hunger: 20 }, gameMode: 'survival', threatPolicy: 'online_learning', position: { x: .5, y: 66.62, z: .5 }, positionUpdatedAt: 1, predicted: { physicsState: { onGround: true, isInWater: false, isInLava: false } }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:diamond', count: 1, stackId: 3 }] }, entityStats: { unknownPositions: 0 }, entities: [], world: { initialized: true, loadedSections: 1 } }
  const changes = new Map(), block = (x, y, z, name) => ({ known: true, position: { x, y, z }, name, runtimeId: name === 'minecraft:air' ? 0 : name === 'minecraft:stone' ? 1 : name === 'minecraft:crafting_table' ? 2 : 3, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', properties: {}, extra: [] })
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? block(x, y, z, y < 65 ? 'minecraft:stone' : 'minecraft:air') }
  const scope = continuationScope(state), tableCell = { x: 20, y: 65, z: 0 }, storageCell = { x: 21, y: 65, z: 0 }
  changes.set(key(tableCell), block(20, 65, 0, 'minecraft:crafting_table')); changes.set(key(storageCell), block(21, 65, 0, 'minecraft:chest'))
  const campMemo = { version: 1, kind: 'worksite_camp', id: 'CONTROLLED_owned', worldScope: JSON.stringify([scope.profile, scope.realmId, scope.dimension]), tableCell, storageCell, floorFingerprints: [20, 21].map(x => finger(world.getBlock(x, 64, 0))), pending: null, table: { operation: 'place', blockName: 'minecraft:crafting_table', position: tableCell, scope, serverConfirmed: true, inventoryConfirmed: true, confirmedBy: 'server_block_and_inventory', beforeCount: 1, afterCount: 0, fingerprint: finger(world.getBlock(20, 65, 0)) } }
  const ownedChest = { position: storageCell, placementScope: scope, fingerprint: finger(world.getBlock(21, 65, 0)) }
  const navigator = createNavigator({ world }), calls = []
  const previewMove = (target, options) => { calls.push({ target, options }); return navigator.plan(navigator.physics.fromServer(state), target, options) }
  return { state, world, changes, block, scope, campMemo, ownedChest, navigator, calls, previewMove }
}
function runnerFixture () {
  const file = path.join(__dirname, 'runner.test.js'), source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  const m = { exports: {} }; new vm.Script(Module.wrap(source + '\nmodule.exports=fixture'), { filename: file }).runInThisContext()(m.exports, Module.createRequire(file), m, file, __dirname); return m.exports
}

test('existing policy counterexample: far remembered current camp chooses deposit, helper instead proposes one real Native progressive prefix without arrival credit', async () => {
  const f = fixture(), before = copy(f.state), current = createBaseContinuation({ getState: () => f.state, world: f.world, getRawItem: () => ({ network_id: 306, count: 1, has_stack_id: true, stack_id: 3 }), now: () => 1000, memo: { version: 1, world: f.campMemo.worldScope, deposited: 0, base: { id: f.campMemo.id, position: f.campMemo.tableCell, storageCell: f.campMemo.storageCell, floorCells: [20, 21].map(x => ({ x, y: 64, z: 0 })) }, chest: f.ownedChest } })
  current.acceptSurface({ scope: f.scope, source: 'validated_surface_anchor', anchorId: 'CONTROLLED_here', position: { x: .5, y: 65, z: .5 }, positionUpdatedAt: 1, queuedAt: 990 })
  assert.equal(current.plan().kind, 'deposit_diamond')
  const p = planOwnedCampReturn(f)
  assert.equal(p.ready, true); assert.ok(p.targetDistance < p.initialDistance); assert.ok(Math.hypot(p.target.x - .5, p.target.y - 65, p.target.z - .5) <= 6); assert.ok(p.previews <= 4)
  assert.equal(p.reachedCamp, false); assert.equal(p.serverConfirmed, false); assert.equal(p.requiresReobservation, true); assert.deepEqual(f.state, before)
  const build = runnerFixture(), r = build(({ path, body, state }) => {
    if (path === '/move/preview') return f.previewMove(body.target, { ...body.options, maxDistance: 6, maxExpanded: 300 })
    if (path === '/move/start') { state.position = { ...body.target, y: body.target.y + 1.62 }; state.rawServerPosition = copy(state.position); state.rawServerPositionUpdatedAt = 20; state.positionUpdatedAt = 20; state.positionSource = 'move_player'; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: state.position }; return state.movement }
  })
  Object.assign(r.state, copy(f.state), { rawServerPosition: copy(f.state.position), rawServerPositionUpdatedAt: 0, positionSource: 'start_game' })
  const moved = await r.runner.actions.move_to(p.decision)
  assert.equal(moved.serverConfirmed, true, 'Only this controlled fixture supplies a received position; planner itself remains unconfirmed')
  assert.equal(r.state.inventory.items[0].count, 1); assert.equal(current.memo().deposited, 0)
})

test('foreign world, unowned table, pending placement and changed table/floor/chest identities deny without preview', () => {
  for (const change of [f => { f.campMemo.worldScope = 'foreign' }, f => { f.campMemo.table.serverConfirmed = false }, f => { f.campMemo.pending = {} }, f => { f.changes.set('20,65,0', f.block(20, 65, 0, 'minecraft:air')) }, f => { f.campMemo.floorFingerprints[0].runtimeId = 99 }, f => { f.ownedChest.fingerprint.runtimeId = 99 }]) {
    const f = fixture(); change(f); assert.equal(planOwnedCampReturn(f).ready, false); assert.equal(f.calls.length, 0)
  }
})

test('dead/missing life, wet, partial support, unknown body/actors and real canonical danger remain denied', () => {
  for (const change of [f => { delete f.state.lifecycle }, f => { f.state.health = 0 }, f => { f.state.predicted.physicsState.isInWater = true }, f => { f.changes.set('0,64,0', { ...f.block(0, 64, 0, 'minecraft:stone'), shapes: [[0, 0, 0, .5, 1, 1]] }) }, f => { f.changes.set('0,65,0', { known: false }) }, f => { f.state.entityStats.unknownPositions = 1 }, f => { f.state.entities = [{ runtimeId: '99', uniqueId: '100', entityType: 'minecraft:skeleton', dimension: 'overworld', positionKnown: true, position: { x: 5, y: 66.62, z: .5 } }] }]) {
    const f = fixture(); change(f); assert.equal(planOwnedCampReturn(f).ready, false); assert.equal(f.calls.length, 0)
  }
})

test('unchanged ordinary Native route is checked against current outside circles, unknown paths fail within four previews and nearby camp returns to validation', () => {
  const blocked = fixture(); blocked.state.entities = [{ runtimeId: '99', uniqueId: '100', entityType: 'minecraft:skeleton', dimension: 'overworld', positionKnown: true, position: { x: 10.5, y: 66.62, z: 6.5 } }]
  assert.equal(planOwnedCampReturn(blocked).ready, false); assert.ok(blocked.calls.length <= 4)
  const unknown = fixture(), read = unknown.world.getBlock; unknown.world.getBlock = (x, y, z) => x >= 1 && x < 19 ? { known: false } : read(x, y, z)
  assert.equal(planOwnedCampReturn(unknown).ready, false); assert.ok(unknown.calls.length <= 4)
  const near = fixture(); near.state.position.x = 15.5
  assert.equal(planOwnedCampReturn(near).reason, 'within_camp_revalidation_range'); assert.equal(near.calls.length, 0)
})

test('reported Grass3727763636 to Dirt2186211206 support transition uses actual shared Camp predicate at the same cell, never accepts air/water/foreign/partial support', () => {
  const transitioned = () => {
    const f = fixture()
    f.campMemo.floorFingerprints[0] = { name: 'minecraft:grass_block', runtimeId: 3727763636, properties: {} }
    f.changes.set('20,64,0', { ...f.block(20, 64, 0, 'minecraft:dirt'), runtimeId: 2186211206, natural: true })
    return f
  }
  const positive = transitioned(), before = copy(positive.campMemo)
  assert.equal(planOwnedCampReturn(positive).ready, true)
  assert.deepEqual(positive.campMemo, before, 'Historical fingerprint remains historical; no receipt rewrite')
  for (const change of [
    b => ({ ...b, name: 'minecraft:air', boundingBox: 'empty' }),
    b => ({ ...b, name: 'minecraft:water', boundingBox: 'empty' }),
    b => ({ ...b, natural: false }),
    b => ({ ...b, protected: true, protectionSource: 'foreign' }),
    b => ({ ...b, shapes: [[0, 0, 0, .5, 1, 1]] }),
    b => ({ ...b, properties: { changed: true } }),
    b => ({ ...b, extra: [{ known: true, name: 'minecraft:water' }] }),
    b => ({ ...b, known: false }),
  ]) {
    const f = transitioned(); f.changes.set('20,64,0', change(f.world.getBlock(20, 64, 0)))
    assert.equal(planOwnedCampReturn(f).reason, 'camp_floor_fingerprint_changed'); assert.equal(f.calls.length, 0)
  }
})
