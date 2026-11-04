'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { createAutonomy } = require('../src/autonomy')

function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function loadRuntime (overrides) {
  const filename = path.resolve(__dirname, '../src/runtime.js')
  const nativeRequire = Module.createRequire(filename)
  const target = { exports: {} }
  const compiled = new vm.Script(Module.wrap(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')), { filename }).runInThisContext()
  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  return target.exports.createRuntime
}

// Actual runtime and autonomy; only service actors are controlled. No fetch,
// game socket, credentials, recipe request or fabricated live world is used.
function fixture (t) {
  const events = []
  const actors = []
  const shelters = []
  const movements = []
  const combatActors = []
  const autonomous = []
  const instances = []
  const raw = { phase: 'spawned', profile: 'survival-test', realm: { id: '42' }, health: 20, gameMode: 'survival', version: '1.26.60', dimension: 'overworld', connectionId: 'same-socket', startedAt: 'session', runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: 'server', selectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, capabilities: {} }
  const shared = { loadingScreenEnded: true, autoWanted: false, autoOptions: {}, prediction: null, equipment: null, shelterMemo: null }
  const host = {
    shared, meta: { version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: performance.now() }, apiUrl: 'http://127.0.0.1:49999',
    client: { queue: () => { throw new Error('The controlled runtime must not send a game packet') } }, cache: { replay: () => {} },
    world: { stats: () => ({ initialized: true, loadedSections: 27, version: '1.26.60' }), getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) },
    entities: { snapshot: () => structuredClone(actors), nearby: () => structuredClone(actors) },
    getServerState: () => structuredClone(raw),
    getState: () => ({ ...structuredClone(raw), rawSelectedSlot: raw.selectedSlot, rawServerPosition: { ...raw.position }, rawServerPositionUpdatedAt: raw.positionUpdatedAt, ...(shared.prediction ? { position: { ...shared.prediction.position }, positionSource: 'client_prediction', positionUpdatedAt: shared.prediction.updatedAt, predicted: structuredClone(shared.prediction) } : {}) }),
    setCapabilities: value => Object.assign(raw.capabilities, value), setPrediction: value => { shared.prediction = structuredClone(value) }, setEquipmentPrediction: () => {},
    allocate: () => -1, commitInventory: () => {}, noteProgress: () => {}, log: () => {}
  }
  const crafting = { applyPacket: () => {}, snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, availableRecipes: [] }), rawItem: () => null, preview: () => ({ ready: true }), craft: () => Promise.resolve({ phase: 'completed' }), openInventory: () => ({}), closeContainer: () => { events.push('close_gui'); return null }, cancel: () => {} }
  const mining = { preview: () => ({ ready: true, targets: [] }), start: targets => { events.push('mine'); return { phase: 'completed', targets } }, stop: () => ({ phase: 'stopped' }), snapshot: () => ({ phase: 'idle' }) }
  const inventory = { snapshot: () => ({ busy: false }), applyPacket: () => {}, cancel: () => {}, equip: async slot => {
    events.push('equip_begin')
    await Promise.resolve()
    const tool = raw.inventory.items.find(item => item.slot === slot)
    const selected = raw.inventory.items.find(item => item.slot === raw.selectedSlot)
    if (selected) selected.slot = slot
    if (tool) { tool.slot = raw.selectedSlot; raw.heldItem = { ...tool } }
    events.push('equip_done')
    return { phase: 'completed', serverConfirmed: true, slot: raw.selectedSlot }
  } }
  const interactions = { applyPacket: () => {}, snapshot: () => ({ pendingOperation: null }), cancel: () => {}, previewPlace: data => ({ ready: true, expectedBlock: 'minecraft:dirt', position: data.position }), placeBlock: async data => { events.push('place'); return { phase: 'completed', position: data.position } } }
  let foodReady = true
  let engageReady = true
  let foragePreview = { ready: false }
  const forageExecutions = []
  const food = { applyPacket: () => {}, snapshot: () => ({ busy: false }), cancel: () => {}, preview: () => ({ ready: foodReady }), eat: async ({ slot }) => { events.push(`eat:${slot}`); return { phase: 'completed', serverConfirmed: true } } }
  const overrides = {
    './crafting': { createCrafting: () => crafting }, './mining': { createMining: () => mining }, './inventory': { createInventory: () => inventory }, './interactions': { createInteractions: () => interactions },
    './food': { createFood: () => food, isSupportedFood: name => ['minecraft:bread', 'minecraft:beef'].includes(name) },
    './input': { createInput: () => ({ start: () => {}, stop: () => {}, release: () => {}, stats: () => ({ running: false }), lookAt: () => {}, sendAction: () => {}, sendTransaction: () => {} }) },
    './movement': { createMovement: options => {
      const actor = { options, phase: 'idle', stops: 0 }; movements.push(actor)
      return { preview: () => ({ ready: true }), start: () => { events.push('move'); actor.phase = 'awaiting_server_confirmation'; return { phase: actor.phase } }, settle: () => ({}), stop: () => { actor.stops++; actor.phase = 'stopped'; return { phase: 'stopped' } }, applyPacket: () => {}, snapshot: () => ({ phase: actor.phase }) }
    } },
    './combat': { createCombat: () => {
      const actor = { attacks: [], cooldown: 0 }; combatActors.push(actor)
      return { applyPacket: () => {}, cancel: () => {}, drain: async () => {}, engage: async id => { events.push(`engage:${id}`, `attack:${id}`); actor.attacks.push(id); return { phase: 'observed', mode: 'engage', serverConfirmed: true, targetRuntimeId: id } }, preview: () => ({ ready: true }), previewEngage: () => ({ ready: engageReady }), previewHunt: () => ({ ready: false }), hunt: async () => ({}), attack: async id => { events.push(`attack:${id}`); actor.attacks.push(id); return { phase: 'observed', targetRuntimeId: id } }, defend: () => { throw new Error('Defense must attack the selected exact target') }, snapshot: () => ({ busy: false, defending: false, cooldownRemainingMs: actor.cooldown }) }
    } },
    './recovery': { createRecovery: () => ({ preview: () => ({ ready: false, alreadyAshore: true }), execute: async () => ({}), stop: async () => ({}), snapshot: () => ({ busy: false }) }) },
    './foraging': { createForaging: () => ({ preview: () => structuredClone(foragePreview), execute: async args => { forageExecutions.push(structuredClone(args)); events.push('forage'); return { phase: 'predicted', serverConfirmed: false, collected: false } }, stop: async () => ({}), snapshot: () => ({ busy: false }) }) },
    './runner': {
      createHttpClient: () => () => { throw new Error('No HTTP request is allowed in these wiring tests') },
      createRunner: () => ({ request: () => { throw new Error('Unexpected HTTP request') }, refreshState: async () => host.getState(), getState: host.getState, observe: async () => ({ blocks: [], entities: actors, capabilities: {} }), actions: { avoid_threat: async () => { events.push('avoid'); return { phase: 'completed' } } } })
    },
    './autonomy': { createAutonomy: options => { autonomous.push(options); return createAutonomy({ ...options, intervalMs: 60000 }) } },
    './shelter': { createShelter: options => {
      const actor = { options, state: { phase: 'idle', busy: false }, memory: structuredClone(options.memo), executions: [], leaves: [], pending: null }
      shelters.push(actor)
      const run = (method, args, context) => { actor.state.busy = true; actor.pending = deferred(); actor[method].push({ args, context }); return actor.pending.promise }
      return { preview: () => ({ ready: false, code: 'NO_KNOWN_SOIL_HILL' }), execute: (args, context) => run('executions', args, context), leave: (args, context) => run('leaves', args, context), stop: async () => { actor.state.busy = false; actor.pending?.resolve({ phase: 'stopped' }); return actor.state }, snapshot: () => structuredClone({ ...actor.state, memo: actor.memory }), memo: () => structuredClone(actor.memory) }
    } }
  }
  const create = () => { const runtime = loadRuntime(overrides)(host); instances.push(runtime); return runtime }
  const runtime = create()
  t.after(async () => { for (const current of instances) await current.dispose('test_cleanup') })
  const setItems = values => { raw.inventory.items = values.map(([name, count, slot = 0]) => ({ name: `minecraft:${name}`, count, slot })); raw.heldItem = raw.inventory.items.find(item => item.slot === raw.selectedSlot) ?? null }
  const enemy = (type, distance, id = '55') => ({ kind: 'mob', entityType: `minecraft:${type}`, hostile: true, runtimeId: id, alive: true, positionKnown: true, dimension: 'overworld', position: { x: raw.position.x + distance, y: raw.position.y, z: raw.position.z } })
  const safety = () => autonomous.at(-1).planSafety(autonomous.at(-1).getState())
  const cover = () => Object.assign(shelters.at(-1).state, { inside: true, entranceClosed: true, closed: true, usable: true, established: true, geometryVerified: true, structureIntact: true, serverConfirmed: true })
  const returnProof = (innerStandpoint = { x: 0.5, y: 65, z: 0.5 }) => {
    const actor = shelters.at(-1)
    Object.assign(actor.state, { established: true, geometryVerified: true, structureIntact: true, serverConfirmed: true })
    actor.memory = { ownerProfile: raw.profile, scope: { realmId: String(raw.realm.id), dimension: raw.dimension }, site: { type: 'soil_hill_shelter', innerStandpoint, outsideStandpoint: { x: innerStandpoint.x + 2, y: innerStandpoint.y, z: innerStandpoint.z } } }
  }
  const daylight = () => { host.shared.worldClocks = { clock: { name: 'minecraft:overworld', time: 600, paused: false } } }
  const foodSource = () => { foragePreview = { ready: true, kind: 'prey', target: { runtimeId: '99', name: 'minecraft:pig', position: { x: 4.5, y: 65, z: 0.5 } } } }
  return { runtime, create, host, raw, actors, shelters, movements, combatActors, autonomous, events, forageExecutions, setItems, enemy, safety, cover, returnProof, daylight, foodSource, setFoodReady: value => { foodReady = value }, setEngageReady: value => { engageReady = value }, setForagePreview: value => { foragePreview = value } }
}

test('shelter action bridges forward live plan, return, exit and abort signals while owning child mining/move/equip/place', async t => {
  const f = fixture(t)
  const config = f.autonomous[0]
  const controller = new AbortController()
  const plan = { ready: true, id: 'soil-1' }
  const memo = { site: plan }
  const build = config.actions.build_shelter({ plan, memo }, { signal: controller.signal })
  const actor = f.shelters[0]
  assert.deepEqual(actor.executions[0].args, { plan, site: plan, memo })
  assert.equal(actor.executions[0].context.signal, controller.signal)
  assert.throws(() => f.runtime.operations.mining.start([{ x: 1, y: 65, z: 0 }]), /前の操作/)
  assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 65, z: 0.5 }), /前の操作/)
  await assert.rejects(f.runtime.operations.inventory.equip(1), /前の操作/)
  assert.throws(() => f.runtime.operations.interactions.placeBlock({ position: { x: 1, y: 65, z: 0 }, slot: 0 }), /前の操作/)
  assert.doesNotThrow(() => actor.options.mining.start([{ x: 1, y: 65, z: 0 }]))
  assert.doesNotThrow(() => actor.options.movement.preview({ x: 1.5, y: 65, z: 0.5 }))
  assert.doesNotThrow(() => actor.options.movement.start({ x: 1.5, y: 65, z: 0.5 }))
  await actor.options.inventory.equip(0)
  await actor.options.interactions.placeBlock({ position: { x: 1, y: 65, z: 0 }, slot: 0 })
  assert.equal(f.runtime.canReload(), false)
  await f.runtime.operations.shelter.stop('end build'); await build
  const returning = config.actions.return_shelter({}, { signal: controller.signal })
  assert.deepEqual(actor.executions[1].args, {})
  await f.runtime.operations.shelter.stop('end return'); await returning
  const leaving = config.actions.leave_shelter({}, { signal: controller.signal })
  assert.deepEqual(actor.leaves[0].args, {})
  assert.equal(actor.leaves[0].context.signal, controller.signal)
  await f.runtime.operations.shelter.stop('end leave'); await leaving
})

test('an already running autonomy loop waits for respawn terrain before planning or previewing another action', async t => {
  const f = fixture(t)
  f.host.shared.respawnTerrain = { pending: true }
  const state = f.host.getState()
  state.inventory = null
  assert.deepEqual(f.autonomous[0].planSafety(state), { type: 'wait', stage: 'safety', code: 'respawn_terrain_pending', reason: 'リスポーン先の地形と前の操作の終了を確認しています。' })
  assert.equal(f.events.length, 0)
})

test('confirmed shelter progress persists into the next runtime and disposed callbacks cannot overwrite it', async t => {
  const f = fixture(t)
  const memo = { version: 1, site: { id: 'soil-1' }, established: true, placements: [{ serverConfirmed: true }] }
  f.shelters[0].options.onProgress({ phase: 'closed', memo })
  assert.deepEqual(f.host.shared.shelterMemo, memo)
  await f.runtime.dispose('hot_reload')
  f.create()
  assert.deepEqual(f.shelters[1].options.memo, memo)
  f.shelters[0].options.onProgress({ phase: 'stale', memo: { site: { id: 'old-corrupted' } } })
  assert.deepEqual(f.host.shared.shelterMemo, memo)
  const previous = structuredClone(f.host.shared.prediction)
  f.movements[0].options.onPrediction({ position: { x: 100, y: 100, z: 100 } })
  assert.deepEqual(f.host.shared.prediction, previous)
})

test('healthy armed melee defense equips then closes the GUI before attacking the selected exact entity', async t => {
  const f = fixture(t)
  f.raw.health = 16
  f.setItems([['dirt', 2, 0], ['stone_sword', 1, 5]])
  f.actors.push(f.enemy('zombie', 2, '55'), f.enemy('zombie', 2.6, '66'))
  f.runtime.operations.agent.start()
  await f.runtime.operations.agent.tick()
  assert.equal(f.runtime.snapshot().agent.lastDecision.type, 'defend')
  assert.deepEqual(f.combatActors[0].attacks, ['55'])
  assert.ok(f.events.indexOf('equip_done') < f.events.indexOf('close_gui'))
  assert.ok(f.events.indexOf('close_gui') < f.events.indexOf('attack:55'))
  assert.equal(f.raw.heldItem.name, 'minecraft:stone_sword')
})

test('creeper or boss alongside melee selects retreat instead of attacking', async t => {
  for (const type of ['creeper', 'wither']) {
    const f = fixture(t)
    f.setItems([['stone_sword', 1, 0]])
    f.actors.push(f.enemy('zombie', 2, '55'), f.enemy(type, 3, '99'))
    f.runtime.operations.agent.start(); await f.runtime.operations.agent.tick()
    assert.equal(f.runtime.snapshot().agent.lastDecision.type, 'avoid_threat')
    assert.deepEqual(f.combatActors[0].attacks, [])
    assert.ok(f.events.includes('avoid'))
  }
})

test('closed usable refuge prioritizes eating or waiting over melee combat', async t => {
  const f = fixture(t)
  f.cover()
  f.raw.health = 16
  f.setItems([['stone_sword', 1, 0], ['bread', 1, 1]])
  f.actors.push(f.enemy('zombie', 2, '55'))
  assert.equal(f.safety().type, 'eat')
  f.setItems([['stone_sword', 1, 0]])
  assert.equal(f.safety().code, 'shelter_cover')
  assert.deepEqual(f.combatActors[0].attacks, [])
})

test('a named observed overworld clock keeps a closed base occupied at night and permits daylight departure', t => {
  const f = fixture(t)
  f.cover()
  f.foodSource()
  f.raw.health = 20
  f.host.shared.worldClocks = { clock: { name: 'minecraft:overworld', time: 18000, paused: false } }
  assert.equal(f.safety().code, 'shelter_night')
  f.host.shared.worldClocks.clock.time = 24050
  assert.equal(f.safety().code, 'shelter_night')
  f.host.shared.worldClocks.clock.time = 24600
  assert.equal(f.safety().type, 'leave_shelter')
  f.host.shared.worldClocks.clock.name = 'custom:other_clock'
  f.host.shared.worldClocks.clock.time = 18000
  assert.notEqual(f.safety().code, 'shelter_night')
})

test('leaving cover requires observed health above fourteen and every actual enemy farther than eight blocks', async t => {
  const f = fixture(t)
  f.cover()
  f.foodSource(); f.daylight()
  f.raw.health = 15
  f.actors.push(f.enemy('zombie', 9, '55'))
  assert.equal(f.safety().type, 'leave_shelter')
  f.raw.health = 14
  assert.equal(f.safety().code, 'shelter_cover')
  f.raw.health = 15
  f.actors[0].position.x = f.raw.position.x + 8
  assert.equal(f.safety().code, 'shelter_cover')
  f.actors.length = 0
  f.raw.health = 12
  assert.equal(f.safety()?.code, 'shelter_cover', 'no enemies does not waive the healing threshold')
  f.raw.health = 16
  f.actors.push({ ...f.enemy('zombie', 1), position: null, positionKnown: false })
  assert.notEqual(f.safety()?.type, 'leave_shelter', 'unknown actors are not an empty safe enemy set')
})

test('a verified nearby shelter permits a low-health return while an endangered approach waits', async t => {
  const f = fixture(t)
  Object.assign(f.shelters[0].state, { established: true, inside: false })
  f.returnProof({ x: 4.5, y: 65, z: 0.5 })
  f.raw.health = 12
  assert.equal(f.safety().type, 'return_shelter')
  f.raw.health = 20
  f.host.shared.worldClocks = { clock: { name: 'minecraft:overworld', time: 18000, paused: false } }
  f.actors.push(f.enemy('creeper', 9))
  assert.equal(f.safety().type, 'wait')
  assert.equal(f.safety().code, 'shelter_approach_unsafe')
})

test('an absent sword permits only an honest push-back attempt, and unknown inventory cannot authorize defense', async t => {
  const f = fixture(t)
  f.actors.push(f.enemy('zombie', 2))
  f.raw.health = 20
  f.setItems([['stone_sword', 0, 0]])
  assert.equal(f.safety()?.type, 'defend')
  assert.equal(f.safety()?.purpose, 'push_back')
  f.setItems([['stone_sword', 1, 0]])
  f.raw.inventory.known = false
  assert.notEqual(f.safety()?.type, 'defend')
  await assert.rejects(f.autonomous[0].actions.defend({ targetRuntimeId: '55' }, { signal: new AbortController().signal }))
  assert.deepEqual(f.combatActors[0].attacks, [])
})

test('a hungry closed base leaves for a known daylight food source and keeps that purpose outside instead of immediately returning', async t => {
  const f = fixture(t)
  f.cover(); f.daylight(); f.foodSource()
  f.setItems([['wooden_sword', 1]])
  f.returnProof()
  f.raw.health = 12
  f.host.shared.vitals = { hunger: { value: 17, source: 'server_attribute' } }
  const leaving = f.safety()
  assert.equal(leaving.type, 'leave_shelter')
  assert.equal(leaving.purpose, 'food')
  assert.equal(f.host.shared.nutritionTask.phase, 'seeking_food')
  const work = f.autonomous[0].actions.leave_shelter(leaving, { signal: new AbortController().signal })
  await f.runtime.operations.shelter.stop('completed exit'); await work
  Object.assign(f.shelters[0].state, { inside: false, entranceClosed: false, closed: false, usable: false })
  const seeking = f.safety()
  assert.equal(seeking.type, 'forage', 'health below fourteen must not undo the intentional food exit')
  await f.autonomous[0].actions.forage(seeking, { signal: new AbortController().signal })
  assert.ok(f.events.includes('forage'))
  assert.equal(f.host.shared.nutritionTask.phase, 'seeking_food', 'a predicted forage result is not food acquisition')
  assert.equal(f.raw.inventory.items.some(item => ['minecraft:bread', 'minecraft:beef'].includes(item.name)), false)
  f.setItems([['beef', 2]])
  assert.equal(f.safety().type, 'return_shelter', 'actual food acquisition restores the ordinary low-health return policy')
  assert.equal(f.host.shared.nutritionTask, null)
  f.cover()
  assert.equal(f.safety().type, 'eat')
  f.setItems([])
  f.host.shared.vitals.hunger.value = 18
  assert.equal(f.safety().code, 'shelter_cover', 'received adequate hunger permits sheltered healing before another trip')
})

test('full-health empty food reserves are replenished before mining and ordinary hunger is fed even at full health', t => {
  const f = fixture(t)
  f.cover(); f.daylight(); f.foodSource()
  f.setItems([['wooden_sword', 1]])
  f.raw.health = 20
  f.host.shared.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  assert.equal(f.safety().purpose, 'food')
  Object.assign(f.shelters[0].state, { inside: false, entranceClosed: false, usable: false })
  assert.equal(f.safety().type, 'forage')
  f.setItems([['bread', 1]])
  f.host.shared.vitals.hunger.value = 17
  assert.equal(f.safety().type, 'eat')
  f.host.shared.vitals.hunger.value = 20
  f.setFoodReady(false)
  assert.equal(f.safety(), null, 'actual food reserve and known full hunger release the original resource goal')
})

test('a fed unarmed respawn prepares only its first wooden sword before livestock, while actual food retains priority', t => {
  const f = fixture(t); f.daylight(); f.foodSource(); f.raw.health = 20
  f.host.shared.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  f.setItems([])
  assert.equal(f.safety().preparation, 'wooden_sword', 'only the bounded first weapon planner can collect wood')
  f.setForagePreview({ ready: true, kind: 'drop', target: { runtimeId: '99', name: 'minecraft:beef', position: { x: 4.5, y: 65, z: 0.5 } } })
  assert.equal(f.safety().type, 'forage', 'observed food items do not require an unarmed hunt')
  f.host.shared.nutritionTask = null; f.foodSource(); f.host.shared.vitals.hunger.value = 17
  assert.equal(f.safety().preparation, 'wooden_sword')
  f.host.shared.nutritionTask = null; f.host.shared.vitals.hunger.value = 20; f.raw.health = 19
  assert.equal(f.safety().preparation, 'wooden_sword')
  f.host.shared.nutritionTask = null; f.raw.health = 20; f.setItems([['wooden_sword', 1]])
  assert.equal(f.safety().type, 'forage')
})

test('received adequate vitals permit only a first wooden sword without food, even when a pickaxe already exists', t => {
  const f = fixture(t); f.raw.health = 20; f.host.shared.vitals = { hunger: { value: 20, source: 'server_attribute' } }; f.setItems([])
  f.host.shared.worldClocks = {}
  assert.equal(f.safety().preparation, 'wooden_sword')
  f.setItems([['wooden_pickaxe', 1]])
  assert.equal(f.safety().preparation, 'wooden_sword')
  f.setItems([]); f.host.shared.vitals.hunger.value = 17
  assert.equal(f.safety().preparation, 'wooden_sword')
  f.host.shared.vitals.hunger.value = 20; f.raw.health = 19
  assert.equal(f.safety().preparation, 'wooden_sword')
  f.raw.health = 20; f.actors.push({ ...f.enemy('zombie', 2), position: null, positionKnown: false })
  assert.notEqual(f.safety(), null)
})

test('food exits do not bypass night, dusk, unknown actors, low health, uncertain inventory or absent observed sources', async t => {
  for (const change of [
    f => { f.host.shared.worldClocks.clock.time = 18000 },
    f => { f.host.shared.worldClocks.clock.time = 11999 },
    f => { f.host.shared.worldClocks = {} },
    f => { f.actors.push({ ...f.enemy('zombie', 2), position: null, positionKnown: false }) },
    f => { f.actors.push(f.enemy('zombie', 5)) },
    f => { f.raw.health = 6 },
    f => { f.raw.inventory.uncertain = true },
    f => { f.setForagePreview({ ready: false, code: 'NO_KNOWN_FOOD_SOURCE' }) }
  ]) {
    const f = fixture(t)
    f.cover(); f.daylight(); f.foodSource(); f.raw.health = 12
    f.host.shared.vitals = { hunger: { value: 17, source: 'server_attribute' } }
    change(f)
    const action = f.safety()
    assert.notEqual(action?.type, 'leave_shelter')
    assert.notEqual(action?.type, 'forage')
    assert.notEqual(f.host.shared.nutritionTask?.phase, 'seeking_food')
  }
})

test('food purpose survives hot reload but is cancelled by a changed scope, new danger or its bounded deadline', async t => {
  const f = fixture(t)
  f.cover(); f.daylight(); f.foodSource(); f.raw.health = 12
  f.setItems([['wooden_sword', 1]])
  f.host.shared.vitals = { hunger: { value: 17, source: 'server_attribute' } }
  f.returnProof()
  f.safety()
  const intent = structuredClone(f.host.shared.nutritionTask)
  await f.runtime.dispose('reload')
  f.create()
  f.returnProof()
  Object.assign(f.shelters[1].state, { established: true, inside: false })
  assert.equal(f.safety().type, 'forage')
  assert.deepEqual(f.host.shared.nutritionTask, intent)
  f.host.shared.nutritionTask.startedAt = Date.now() - 200000
  f.host.shared.nutritionTask.expiresAt = f.host.shared.nutritionTask.startedAt + 180000
  assert.equal(f.safety().type, 'return_shelter')
  assert.equal(f.host.shared.nutritionTask.phase, 'cooldown')
  f.host.shared.nutritionTask = intent
  f.raw.realm = { id: 'another-realm' }
  f.setForagePreview({ ready: false, code: 'NO_KNOWN_FOOD_SOURCE' })
  assert.equal(f.safety().type, 'wait')
  assert.equal(f.safety().code, 'shelter_approach_unsafe')
  assert.equal(f.host.shared.nutritionTask, null)
  f.raw.realm = { id: '42' }
  f.foodSource()
  f.host.shared.nutritionTask = intent
  f.actors.push(f.enemy('zombie', 5))
  assert.notEqual(f.safety()?.type, 'return_shelter', 'An active nearby danger remains survival work, not a trip toward the base')
  assert.equal(f.host.shared.nutritionTask, null)
})

test('food actions recheck source, scope, health and daytime before opening a door or beginning forage', async t => {
  const f = fixture(t)
  f.cover(); f.daylight(); f.foodSource(); f.raw.health = 12
  f.setItems([['wooden_sword', 1]])
  f.host.shared.vitals = { hunger: { value: 17, source: 'server_attribute' } }
  const decision = f.safety()
  f.host.shared.worldClocks.clock.time = 18000
  await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.leave_shelter(decision, { signal: new AbortController().signal })), error => error.code === 'STALE_OBSERVATION')
  assert.equal(f.shelters[0].leaves.length, 0)
  f.daylight()
  Object.assign(f.shelters[0].state, { inside: false, entranceClosed: false, usable: false })
  const forage = f.safety()
  f.raw.health = 5
  await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.forage(forage, { signal: new AbortController().signal })), error => error.code === 'STALE_OBSERVATION')
  f.raw.health = 12
  f.raw.realm = { id: 'another' }
  await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.forage(forage, { signal: new AbortController().signal })), error => error.code === 'STALE_OBSERVATION')
  assert.equal(f.events.includes('forage'), false)
})

test('one received night uses a fixed finite deadline and daylight resumes food preparation without resetting the goal', t => {
  const f = fixture(t)
  f.cover(); f.foodSource()
  f.host.shared.worldClocks = { clock: { name: 'minecraft:overworld', time: 18000, paused: false } }
  const waiting = f.safety()
  assert.equal(waiting.code, 'shelter_night')
  assert.equal(waiting.waitBudget, 'shelter_night')
  assert.ok(waiting.waitUntil > Date.now() && waiting.waitUntil <= Date.now() + 900000)
  f.host.shared.worldClocks.clock.time = 18010
  assert.equal(f.safety().waitUntil, waiting.waitUntil)
  f.daylight()
  assert.equal(f.safety().purpose, 'food')
  assert.equal(f.host.shared.shelterNightWait, null)
})

test('armed ranged attackers retreat instead of selecting an unsupported melee engagement', async t => {
  for (const type of ['skeleton', 'stray', 'bogged']) {
    const f = fixture(t)
    f.setItems([['dirt', 1, 0], ['stone_sword', 1, 5]])
    f.actors.push(f.enemy(type, 2, '55'))
    f.runtime.operations.agent.start(); await f.runtime.operations.agent.tick()
    assert.equal(f.runtime.snapshot().agent.lastDecision.type, 'avoid_threat')
    assert.deepEqual(f.combatActors[0].attacks, [])
    assert.equal(f.events.includes('equip_begin'), false)
  }
})

test('engagement eligibility is checked after confirmed equip and can fall back to a regular exact-target single attack', async t => {
  const f = fixture(t)
  f.setItems([['dirt', 1, 0], ['stone_sword', 1, 5]])
  f.setEngageReady(false)
  f.actors.push(f.enemy('zombie', 2, '55'))
  assert.equal(f.safety().type, 'defend', 'a sword awaiting equip must not make the initial melee choice impossible')
  await f.autonomous[0].actions.defend(f.safety(), { signal: new AbortController().signal })
  assert.equal(f.raw.heldItem.name, 'minecraft:stone_sword')
  assert.ok(f.events.indexOf('equip_done') < f.events.indexOf('attack:55'))
  assert.equal(f.events.includes('engage:55'), false)
  assert.deepEqual(f.combatActors[0].attacks, ['55'])
})
