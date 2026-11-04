'use strict'

// Controlled received inventory/terrain only; real Native movement,
// Interactions, Mining, FreshBuilder, storage work and BaseContinuation.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createBaseContinuation, continuationScope } = require('../src/base-continuation')
const { createDepotStorageWork } = require('../src/depot-storage-work')
const { createChest } = require('../src/chest')
const { createPhysics } = require('../src/physics')
const { createSurfaceReturn } = require('../src/surface-return')
const { createInteractions } = require('../src/interactions')
const { planDepotStorageAccess } = require('../src/depot-storage-access')
const { setImmediate: turn } = require('node:timers/promises')
const filename = path.resolve(__dirname, '../src/depot-prebuild.js'), stage = new Module(filename, module)
stage.filename = filename; stage.paths = Module._nodeModulePaths(path.dirname(filename))
stage._compile(fs.readFileSync(process.env.DEPOT_PREBUILD_TEST_SOURCE ?? filename, 'utf8'), filename)
const { createDepotPrebuild, realStoneKit, realStarterKit, remainingDirt, planPrebuildChestStance } = stage.exports
const copy = value => structuredClone(value), key = p => `${p.x},${p.y},${p.z}`
const fixtureFile = path.join(__dirname, 'depot-builder.test.js'), scenes = new Module(fixtureFile, module)
scenes.filename = fixtureFile; scenes.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
let prefix = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
prefix = prefix.replace("const {createDepotBuilder}=require('../src/depot-builder')", "const {createFreshDepotBuilder:createDepotBuilder}=require('../src/fresh-depot-builder')")
prefix = prefix.replace("[299,'minecraft:iron_pickaxe']", "[299,'minecraft:iron_pickaxe'],[3,'minecraft:dirt'],[330,'minecraft:wooden_sword'],[331,'minecraft:wooden_pickaxe'],[332,'minecraft:chest']")
prefix = prefix.replace("raws.set(0,raw(4,64,42))", "raws.set(0,raw(4,64,42));raws.set(5,raw(3,24,43));raws.set(6,raw(330,1,44));raws.set(7,raw(331,1,45));raws.set(12,raw(332,1,46))")
prefix = prefix.replace('count:r.count,stackId:r.stack_id', 'count:r.count,networkId:r.network_id,metadata:r.metadata,stackId:r.stack_id,durabilityKnown:true,durabilityRemaining:100')
prefix = prefix.replace('function prediction(p){', "function prediction(p){p={...p,velocity:copy(p.physicsState.velocity),source:'client_prediction',serverConfirmed:false,updatedAt:new Date().toISOString()};")
prefix = prefix.replace('return {state,world,map,raws,', 'return {ownedMovement,state,world,map,raws,')
scenes._compile(prefix + '\nmodule.exports={fixture};', fixtureFile)

function fixture (t) {
  const f = scenes.exports.fixture(t), intents = []
  f.map.clear()
  let surface = null, idle = true, takeovers = 0, resumes = 0, fakeBuilderResult = null
  f.state.food = { hunger: 17 }; f.state.crafting = { openContainer: null }
  const getState = () => copy(f.state), scope = () => continuationScope(f.state)
  const policy = createBaseContinuation({ getState, getRawItem: f.crafting.rawItem, world: f.world, now: Date.now })
  const returner = createSurfaceReturn({ getState, world: f.world, physics: createPhysics({ world: f.world }), movement: f.movement, getMovement: f.movement.snapshot, canAct: () => true })
  const saved = f.crafting.snapshot
  f.crafting.snapshot = () => ({ ...saved(), openContainer: f.state.crafting.openContainer })
  f.crafting.preview = () => { throw Error('Held real chest must not need invented recipes') }
  const chest = createChest({ client: { queue: () => assert.fail('No deposit without diamonds') }, getState, world: f.world, crafting: f.crafting, allocateRequestId: () => -101,
    interactions: { openChest: async position => {
      // Controlled ordinary server-open and27-slot descriptors enter the REAL
      // Chest receiver. They never imply a deposit or mutate the player bag.
      queueMicrotask(() => {
        f.state.crafting.openContainer = { id: 5, type: 'container', coordinates: copy(position) }
        chest.applyPacket('container_open', { window_id: 5, window_type: 'container', coordinates: copy(position) })
        chest.applyPacket('inventory_content', { window_id: 5, input: Array.from({ length: 27 }, () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } })) })
      })
      return { serverConfirmed: true }
    }, cancel: () => {} } })
  const chestWork = createDepotStorageWork({ getState, world: f.world, crafting: f.crafting, interactions: f.interactions,
    inventory: { equip: async sourceSlot => {
      const target = f.state.rawSelectedSlot, before = f.raws.get(target)
      f.raws.set(target, f.raws.get(sourceSlot)); f.raws.set(sourceSlot, before); f.sync()
      return { phase: 'completed', serverConfirmed: true }
    } }, chest, validate: () => true })
  const context = { policy, scope: scope(), extra: {}, signal: new AbortController().signal, setExtra: value => { context.extra = copy(value) } }
  const controller = createDepotPrebuild({ getState, getRawItem: f.crafting.rawItem, world: f.world,
    getSurface: () => copy(surface), getBuilder: () => ({ ...f.builder.snapshot(), protectedCells: f.builder.protectedCells() }), getStorage: chest.snapshot,
    isIdle: () => idle, takeover: async () => { takeovers++; return true }, resumeLegacy: async () => { resumes++ },
    dispatch: async (intent, ctx) => {
      intents.push(copy(intent))
      if (intent.kind === 'return_surface') {
        const r = await returner.execute({ maxLegs: 1 })
        assert.equal(r.surfaceReached, true)
        const proof = { scope: scope(), source: 'validated_surface_anchor', anchorId: 'received-current-sky', position: r.feetPosition, positionUpdatedAt: f.state.positionUpdatedAt, queuedAt: Date.now() }
        policy.acceptSurface(proof); surface = { scope: scope(), position: r.feetPosition }
        return r
      }
      if (intent.kind === 'establish_base') {
        const r = fakeBuilderResult ?? await f.builder.step({}, ctx)
        if (r.surfaceProof) { policy.acceptSurface(r.surfaceProof); surface = { scope: scope(), position: r.surfaceProof.position } }
        return r
      }
      if (intent.kind === 'ensure_chest' || intent.kind === 'observe_storage') {
        const result = await chestWork.step({ scope: scope(), storageCell: policy.memo().base.storageCell, ownedChest: policy.memo().chest }, ctx)
        if (result.kind !== 'need_access') return result
        // Match the existing Runtime access adapter: propose a current known
        // stance, then execute actual normal Native frames before reobserving.
        const access = planDepotStorageAccess({ state: getState(), world: f.world, target: result.position })
        let target = access.standpoint
        if (!target) {
          let projected
          const probe = createInteractions({ client: { queue: () => assert.fail('Passive probe') }, getState: () => projected, world: f.world, crafting: f.crafting, getInput: () => { throw Error('Passive probe') } })
          const fallback = planPrebuildChestStance({ state: getState(), scope: scope(), world: f.world, base: policy.memo().base, target: result.position,
            previewPlaceAt: ({ state, target, slot }) => { projected = state; return probe.previewPlace({ position: target, slot }) }, previewMove: f.ownedMovement.preview })
          assert.ok(fallback?.standpoint, 'Real placement preview and Native route must both accept the nonoverlapping base stance')
          target = fallback.standpoint
        }
        const options = { allowWater: false, maxDistance: 12, maxExpanded: 500 }
        assert.equal(f.ownedMovement.preview(target, options).ready, true)
        f.ownedMovement.start(target, options)
        for (let tick = 0; tick < 80 && f.movement.snapshot().running; tick++) { t.mock.timers.tick(50); await turn() }
        assert.equal(f.movement.snapshot().phase, 'awaiting_server_confirmation')
        f.ownedMovement.stop('Controlled current placement stance reached'); f.neutral()
        return { phase: 'predicted', serverConfirmed: false, reason: 'Current Native placement stance; reobserve next step' }
      }
      if (intent.kind === 'prebuild_close') { chest.applyPacket('container_close', { window_id: 5 }); f.state.crafting.openContainer = null; return { phase: 'requested', serverConfirmed: false } }
      return { phase: 'observing', code: intent.kind }
    }
  })
  return { ...f, policy, controller, context, intents, scope, getState, takeovers: () => takeovers, resumes: () => resumes, setIdle: value => { idle = value }, setSurface: value => { surface = value }, setBuilderResult: value => { fakeBuilderResult = value } }
}

test('real wooden kit at health9.594 and hunger16 builds base and empty chest before mining, with no remote food hunt', async t => {
  const f = fixture(t), initial = copy(f.state.inventory.items)
  f.state.health = 9.594; f.state.food.hunger = 16
  assert.equal(initial.some(i => i.name === 'minecraft:diamond'), false)
  assert.equal(realStarterKit(f.state, f.crafting.rawItem), true); assert.equal(realStoneKit(f.state, f.crafting.rawItem), false)
  let result
  for (let n = 0; n < 150; n++) {
    result = await f.controller.step(f.context)
    assert.notEqual(result.result?.phase, 'blocked', JSON.stringify(result))
    if (result.result?.phase === 'prebuilt') break
  }
  assert.equal(result.result.phase, 'prebuilt', JSON.stringify({ result, intents: f.intents.slice(-5), builder: f.builder.snapshot(), policy: f.policy.memo(), inventory: f.state.inventory.items }))
  assert.equal(f.policy.memo().deposited, 0); assert.equal(f.policy.snapshot().depositConfirmedForCurrentLife, false)
  assert.equal(f.state.health, 9.594); assert.equal(f.state.food.hunger, 16, 'No food or healing was invented by the prebuild flow')
  assert.equal(f.resumes(), 1)
  const own = f.policy.memo().chest
  assert.equal(f.world.getBlock(own.position.x, own.position.y, own.position.z).name, 'minecraft:chest')
  assert.equal(f.state.inventory.items.some(i => i.name === 'minecraft:chest'), false, 'Real placement consumed the controlled server stack')
  assert.equal(f.intents.some(i => i.kind === 'maintain' || i.kind === 'prebuild_eat_owned' || i.resource === 'food'), false)
  assert.ok(f.events.filter(e => e.type === 'place_wire').length >= 25)
  assert.equal((await f.controller.step(f.context)).handled, false, 'Legacy diamond objective can continue after real prebuild')
})

test('missing local dirt requests only two additional items and excludes the builders protected cells', async t => {
  const f = fixture(t); f.raws.set(5, { ...f.raws.get(5), count: 11 }); f.sync()
  await f.controller.step(f.context)
  await f.controller.step(f.context)
  const intent = f.intents.at(-1)
  assert.equal(intent.kind, 'prebuild_gather_dirt'); assert.equal(intent.count, 2); assert.equal(intent.maxDistance, 12)
  assert.deepEqual(intent.excludedPositions, f.builder.protectedCells())
})

test('busy action or canonical danger does not stop or take over the existing owner', async t => {
  const f = fixture(t); f.setIdle(false)
  assert.equal((await f.controller.step(f.context)).result.phase, 'yielding'); assert.equal(f.takeovers(), 0); assert.equal(f.intents.length, 0)
  f.setIdle(true); f.state.entities = [{ runtimeId: '777', uniqueId: '-777', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: .5, y: 65, z: 3 } }]
  assert.equal((await f.controller.step(f.context)).result.owner, 'survival'); assert.equal(f.takeovers(), 0)
})

test('no site uses normal bounded exploration then retries the real builder; historical scope is never dirt credit', async t => {
  const f = fixture(t)
  await f.controller.step(f.context)
  f.setBuilderResult({ phase: 'observing', code: 'NO_KNOWN_FLAT_SITE' })
  await f.controller.step(f.context)
  await f.controller.step(f.context)
  assert.equal(f.intents.at(-1).kind, 'prebuild_explore'); assert.equal(f.intents.at(-1).maxDistance, 12)
  await f.controller.step(f.context); assert.equal(f.intents.at(-1).kind, 'establish_base')
  assert.equal(remainingDirt({ kind: 'fresh_surface_depot', version: 1, worldScope: 'other-world', placements: [], removals: [] }, f.scope(), f.world), null)
})

test('initial health9/hunger10 and real tools gate takeover; health8 uses urgent maintenance and old scope still denies', async t => {
  const f = fixture(t)
  f.state.health = 8.999
  assert.equal((await f.controller.step(f.context)).handled, false)
  f.state.health = 20; f.state.food.hunger = 9
  assert.equal((await f.controller.step(f.context)).handled, false)
  f.state.food.hunger = 17; const tool = f.state.inventory.items.find(i => i.name === 'minecraft:wooden_sword'); tool.stackId++
  assert.equal((await f.controller.step(f.context)).handled, false); tool.stackId--
  f.state.lifecycle.deathId++
  assert.equal((await f.controller.step(f.context)).result.owner, 'scope_changed')
  assert.equal(f.takeovers(), 0); assert.equal(f.intents.length, 0)
  f.context.scope = f.scope(); f.state.health = 8
  const urgent = await f.controller.step(f.context)
  assert.equal(urgent.handled, true); assert.equal(f.takeovers(), 1, 'Actual idle/drained fixture enters the existing urgent path')
  assert.equal(f.intents.at(-1).kind, 'maintain'); assert.equal(f.intents.at(-1).priority, 'food_health')
})

test('actual Host DTO without stackId is matched to raw network/count; unknown identity and missing tools still deny', async t => {
  const f = fixture(t), sword = f.state.inventory.items.find(i => i.name === 'minecraft:wooden_sword'), pick = f.state.inventory.items.find(i => i.name === 'minecraft:wooden_pickaxe')
  delete sword.stackId; delete pick.stackId
  assert.equal(realStarterKit(f.state, f.crafting.rawItem), true)
  assert.equal(realStoneKit(f.state, f.crafting.rawItem), false, 'The exported stone-tier helper does not claim wooden harvesting tier')
  assert.equal((await f.controller.step(f.context)).result.surfaceReached, true, 'Real Host-shaped inventory can activate the surface/base path')
  sword.networkId++; assert.equal(realStarterKit(f.state, f.crafting.rawItem), false); sword.networkId--
  sword.count = 2; assert.equal(realStarterKit(f.state, f.crafting.rawItem), false); sword.count = 1
  sword.stackId = -1; assert.equal(realStarterKit(f.state, f.crafting.rawItem), false); delete sword.stackId
  const actual = f.raws.get(pick.slot); f.raws.set(pick.slot, { ...actual, stack_id: 0 }); assert.equal(realStarterKit(f.state, f.crafting.rawItem), false); f.raws.set(pick.slot, actual)
  pick.durabilityRemaining = 0; assert.equal(realStarterKit(f.state, f.crafting.rawItem), false); pick.durabilityRemaining = 100
  f.state.inventory.items = f.state.inventory.items.filter(i => i !== pick); assert.equal(realStarterKit(f.state, f.crafting.rawItem), false)
  const stone = { ...f.state, inventory: { known: true, items: [{ ...sword, name: 'minecraft:stone_sword' }, { ...pick, name: 'minecraft:stone_pickaxe' }] } }
  assert.equal(realStoneKit(stone, f.crafting.rawItem), true)
})

test('the close chest stance still rejects unknown support, a stale scope and a future actor circle', async t => {
  const f = fixture(t), target = { x: 1, y: 65, z: 0 }, base = { position: { x: 0, y: 65, z: 0 }, storageCell: target, floorCells: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }] }
  const selected = f.state.rawSelectedSlot, old = f.raws.get(selected)
  f.raws.set(selected, f.raws.get(12)); f.raws.set(12, old); f.sync()
  let projected
  const probe = createInteractions({ client: { queue: () => assert.fail('Passive stance probe') }, getState: () => projected, world: f.world, crafting: f.crafting, getInput: () => { throw Error('Passive stance probe') } })
  const options = () => ({ state: f.getState(), scope: f.scope(), world: f.world, base, target, previewPlaceAt: ({ state, target, slot }) => { projected = state; return probe.previewPlace({ position: target, slot }) }, previewMove: f.ownedMovement.preview })
  assert.ok(planPrebuildChestStance(options())?.standpoint)
  const stale = options(); stale.scope.life++; assert.equal(planPrebuildChestStance(stale), null)
  f.map.set('0,64,0', { known: false }); assert.equal(planPrebuildChestStance(options()), null); f.map.delete('0,64,0')
  f.state.entities = [{ runtimeId: '888', uniqueId: '-888', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: .5, y: 65, z: -4.2 } }]
  assert.equal(planPrebuildChestStance(options()), null, 'Other actor hard radius is kept in the actual Native preview')
})
