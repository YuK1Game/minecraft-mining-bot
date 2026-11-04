'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { selectStarterGearDrop, starterGearScope } = require('../src/starter-gear')
function fixtureFrom (name) { const file = path.resolve(__dirname, '../test', name + '.test.js'), loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file)); loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', file); return loaded.exports.fixture }
const runnerFixture = fixtureFrom('runner'), survivalFixture = fixtureFrom('survival-planner'), plannerFixture = fixtureFrom('planner')
function scope (state) { Object.assign(state, { profile: 'bot', realm: { id: '21225335' }, dimension: state.dimension ?? 'overworld', connectionId: 'gear-session', startedAt: 'gear-start', runtimeEntityId: '273', lifecycle: { dead: false, phase: 'alive', deathId: 3 } }); return state }
const gear = (name = 'stone_sword', extra = {}) => ({ entityId: '501', runtimeId: '501', uniqueId: '-501', kind: 'item', known: true, positionKnown: true, positionSource: 'add_item_entity', dimension: 'overworld', name: 'minecraft:' + name, count: 1, alive: true, position: { x: 0.9, y: 65.125, z: 0.5 }, ...extra })
const observations = () => { const blocks = []; for (let x = -4; x <= 6; x++) for (let z = -4; z <= 4; z++) for (let y = 63; y <= 69; y++) blocks.push({ known: true, position: { x, y, z }, name: y <= 64 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 64 ? 'block' : 'empty', properties: {}, extra: [] }); return { blocks } }
function runnerScene (handler) { const f = runnerFixture(handler); scope(f.state); f.state.droppedItems = [gear()]; const target = selectStarterGearDrop(f.state, { drops: f.state.droppedItems }, { kind: 'sword' }); return { ...f, decision: { type: 'collect_drops', resource: 'starter_gear', count: 1, targets: [target] }, context: { observations: observations() } } }

test('missing first sword and first pick choose a nearby scoped real drop before rebuilding', () => {
  const sword = survivalFixture(); scope(sword.state); sword.observations.drops = [gear()]
  const a = sword.next({ firstWoodenSwordOnly: true }); assert.equal(a.type, 'collect_drops'); assert.equal(a.targets[0].name, 'minecraft:stone_sword'); assert.equal(a.count, 1); assert.deepEqual(a.targets[0].collectionScope, starterGearScope(sword.state)); assert.equal(a.targets[0].uniqueId, '-501'); assert.equal(a.requiresServerInventory, true)
  const pick = plannerFixture(); scope(pick.snapshot); pick.observations.drops = [gear('stone_pickaxe')]
  const b = pick.next(); assert.equal(b.type, 'collect_drops'); assert.equal(b.targets[0].name, 'minecraft:stone_pickaxe'); assert.equal(b.count, 1)
})

test('owned starter gear, excluded IDs and unusable or remote drops leave the existing resource fallback', () => {
  for (const invalid of [{ protected: true }, { owned: true }, { ownerUniqueId: '-10' }, { playerOwned: true }, { count: 0 }, { uniqueId: null }, { runtimeId: 'bad', entityId: 'bad' }, { known: false, positionKnown: false }, { alive: false }, { dimension: 'nether' }, { positionSource: 'client_prediction' }, { position: { x: 13, y: 65, z: 0.5 } }, { durabilityKnown: true, durabilityRemaining: 0 }]) {
    const f = plannerFixture(); scope(f.snapshot); f.observations.drops = [gear('stone_pickaxe', invalid)]; assert.equal(f.next().type, 'gather_logs')
  }
  const excluded = plannerFixture(); scope(excluded.snapshot); excluded.observations.drops = [gear('stone_pickaxe')]; excluded.observations.progress = { excludedDropIds: ['501'] }; assert.equal(excluded.next().type, 'gather_logs')
  const owns = plannerFixture(); scope(owns.snapshot); owns.items([['wooden_pickaxe', 1]]); owns.observations.drops = [gear('stone_pickaxe')]; assert.equal(owns.next().type, 'equip')
  const sword = survivalFixture(); scope(sword.state); sword.items([['wooden_sword', 1]]); sword.observations.drops = [gear('stone_sword')]; assert.equal(sword.next({ firstWoodenSwordOnly: true }), null)
})

test('unknown actual life/session cannot enable gear pickup and existing sword wood budget still selects logs', () => {
  const f = plannerFixture(); scope(f.snapshot); f.observations.drops = [gear('stone_pickaxe')]; f.snapshot.lifecycle.deathId = null; assert.equal(f.next().type, 'gather_logs')
  const sword = survivalFixture(); scope(sword.state); sword.observations.drops = [gear('wooden_pickaxe')]; const action = sword.next({ firstWoodenSwordOnly: true }); assert.equal(action.type, 'gather_logs'); assert.ok(action.count <= 2)
})

test('pure gear selection remains nearest, deterministic and mutation-free; no capability creates a fake pickup', () => {
  const f = plannerFixture(); scope(f.snapshot); f.observations.drops = [gear('iron_pickaxe', { entityId: '502', runtimeId: '502', uniqueId: '-502', position: { x: 3, y: 65.125, z: 0.5 } }), gear('wooden_pickaxe')]
  const before = structuredClone(f.observations), first = f.next(); assert.equal(first.targets[0].entityId, '501'); assert.deepEqual(f.next(), first); assert.deepEqual(f.observations, before)
  f.observations.capabilities.collect_drops = false; assert.equal(f.next().type, 'capability_required'); assert.equal(f.next().proposedAction.targets[0].uniqueId, '-501')
})

test('real Runner confirms only actual same-life inventory gain even when natural removal arrives first', async () => {
  let reads = 0
  const f = runnerScene(({ path, state }) => { if (path === '/status' && ++reads >= 3) { state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; state.droppedItems = [] } })
  const r = await f.runner.actions.collect_drops(f.decision, f.context)
  assert.equal(r.serverConfirmed, true); assert.equal(r.confirmedBy, 'server_inventory'); assert.equal(r.count, 1); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0)
})

test('removal alone and runtime-ID reuse cannot become gear collection credit', async () => {
  for (const mutation of ['removed', 'uid', 'name', 'zero', 'owned']) {
    let reads = 0
    const f = runnerScene(({ path, state }) => { if (path === '/status' && ++reads >= 3) { if (mutation === 'removed') state.droppedItems = []; else if (mutation === 'uid') state.droppedItems[0].uniqueId = '-502'; else if (mutation === 'name') state.droppedItems[0].name = 'minecraft:dirt'; else if (mutation === 'zero') state.droppedItems[0].count = 0; else state.droppedItems[0].ownerUniqueId = '-10' } })
    await assert.rejects(f.runner.actions.collect_drops(f.decision, f.context), error => error.code === 'DROP_TARGET_CHANGED')
    assert.equal(f.state.inventory.items.length, 0); assert.equal(f.calls.filter(c => c.path === '/move/start').length, 0)
  }
})

test('new life/session rejects even received gear growth and rejects before an item settle can start', async () => {
  for (const mutation of ['life', 'connection', 'self', 'world']) {
    const f = runnerScene(); if (mutation === 'life') f.state.lifecycle.deathId++; if (mutation === 'connection') f.state.connectionId += '-new'; if (mutation === 'self') f.state.runtimeEntityId = '274'; if (mutation === 'world') f.state.dimension = 'nether'
    f.state.position.y += 0.7; f.state.predicted = { physicsState: { onGround: false } }; f.state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]
    await assert.rejects(f.runner.actions.collect_drops(f.decision, f.context), error => error.code === 'STALE_SESSION')
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0)
  }
})

test('life change while waiting cannot attach a new-life sword to an old collection', async () => {
  let reads = 0
  const f = runnerScene(({ path, state }) => { if (path === '/status' && ++reads >= 3) { state.lifecycle.deathId++; state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; state.droppedItems = [] } })
  await assert.rejects(f.runner.actions.collect_drops(f.decision, f.context), error => error.code === 'STALE_SESSION')
})

test('current UID is rechecked after preview and during actual movement waits', async () => {
  for (const point of ['preview', 'moving']) {
    let moving = false
    const f = runnerScene(({ path, state }) => {
      if (path === '/move/preview') { if (point === 'preview') state.droppedItems[0].uniqueId = '-502'; return { ready: true, waypoints: [] } }
      if (path === '/move/start') { moving = true; state.movement = { phase: 'moving' }; return state.movement }
      if (path === '/status' && moving && point === 'moving') state.droppedItems[0].uniqueId = '-502'
    })
    f.state.droppedItems[0].position.x = 3.5; f.decision.targets[0].position.x = 3.5
    await assert.rejects(f.runner.actions.collect_drops(f.decision, f.context), error => error.code === 'DROP_TARGET_CHANGED')
    assert.equal(f.calls.filter(c => c.path === '/move/start').length, point === 'preview' ? 0 : 1)
  }
})

test('inventory gain while a real Runner approach waits survives natural target removal without route credit', async () => {
  let moved = false
  const f = runnerScene(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true, waypoints: [] }
    if (path === '/move/start') { moved = true; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
    if (path === '/status' && moved) { state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; state.droppedItems = [] }
  })
  f.state.droppedItems[0].position.x = 3.5; f.decision.targets[0].position.x = 3.5
  const result = await f.runner.actions.collect_drops(f.decision, f.context)
  assert.equal(result.serverConfirmed, true); assert.equal(result.confirmedBy, 'server_inventory'); assert.equal(result.count, 1)
  assert.equal(f.calls.filter(c => c.path === '/move/start').length, 1)
})

test('predicted or explicitly unconfirmed inventory growth cannot bypass a removed UID', async () => {
  for (const mutation of ['prediction', 'unconfirmed']) {
    let reads = 0
    const f = runnerScene(({ path, state }) => { if (path === '/status' && ++reads >= 3) { state.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; state.droppedItems = []; if (mutation === 'prediction') state.inventory.source = 'client_prediction'; else state.inventory.serverConfirmed = false } })
    await assert.rejects(f.runner.actions.collect_drops(f.decision, f.context), error => error.code === 'INVENTORY_UNKNOWN')
  }
})

test('unknown route and actual damage remain blockers; ordinary unbound log pickup keeps its old semantics', async () => {
  const unsafe = runnerScene(({ path }) => { if (path === '/move/preview') return { ready: false, reason: 'Unknown body terrain' } }); unsafe.state.droppedItems[0].position.x = 3.5; unsafe.decision.targets[0].position.x = 3.5
  await assert.rejects(unsafe.runner.actions.collect_drops(unsafe.decision, unsafe.context), error => error.code === 'NO_SAFE_ROUTE'); assert.equal(unsafe.calls.filter(c => c.path === '/move/start').length, 0)
  let reads = 0
  const hurt = runnerScene(({ path, state }) => { if (path === '/status' && ++reads >= 3) state.health = 19 })
  await assert.rejects(hurt.runner.actions.collect_drops(hurt.decision, hurt.context), error => error.code === 'TOOK_DAMAGE')
  const old = runnerFixture(); await assert.rejects(old.runner.actions.collect_drops({ count: 1, targets: [{ name: 'minecraft:oak_log', position: { x: 0.5, y: 65.125, z: 0.5 } }] }), error => error.code === 'PICKUP_NOT_CONFIRMED')
})
