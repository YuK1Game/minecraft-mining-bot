'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { planHut } = require('../src/hut-planner')
const registry = require('prismarine-registry')('bedrock_1.26.60')
const copy = value => structuredClone(value)
function deferred () { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function block (name) {
  const local = name.replace(/^minecraft:/, '')
  const entry = registry.blocksByName[local]
  const state = registry.blockStates[entry.defaultState]
  return { known: true, name: `minecraft:${local}`, boundingBox: entry.boundingBox, properties: Object.fromEntries(Object.entries(state.states ?? {}).map(([key, value]) => [key, value.value])), runtimeId: 1, extra: [] }
}
function fixture (t, { realRoute = false, realMovement = false, delayedCleanup = false, sword = true } = {}) {
  const calls = []; const packets = []; const progresses = []; const guards = []; const movements = []; const combats = []; const huts = []; const instances = []; const actors = []
  const gate = deferred(); if (!delayedCleanup) gate.resolve()
  const raw = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', runtimeEntityId: '41', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 1, rawSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: sword ? [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }] : [] }, capabilities: {} }
  raw.heldItem = raw.inventory.items[0] ?? null
  const shared = { autoWanted: false, loadingScreenEnded: false, vitals: { hunger: { value: 20, source: 'server_attribute' } } }
  const overrides = new Map()
  let floorName = 'stone'; let floorY = 64; let stamp = 1
  const world = { stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 9 }), getBlock: (x, y, z) => ({ ...copy(overrides.get(`${x},${y},${z}`) ?? block(y === floorY ? floorName : y < floorY ? 'stone' : 'air')), position: { x, y, z } }) }
  const current = () => ({ ...copy(raw), rawServerPosition: copy(raw.position), ...(shared.prediction ? { position: copy(shared.prediction.position), positionSource: 'client_prediction', positionUpdatedAt: shared.prediction.updatedAt, positionServerConfirmed: false, predicted: copy(shared.prediction) } : {}) })
  let openContainer = null
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer, inventory: [], availableRecipes: [] }), rawItem: () => null, applyPacket () {}, preview: () => ({ ready: true }), cancel () {}, closeContainer: () => { calls.push({ type: 'close_gui' }); openContainer = null }, openInventory: async () => { openContainer = { id: 1 }; return openContainer } }
  const inventory = { snapshot: () => ({ busy: false }), applyPacket () {}, cancel: reason => calls.push({ type: 'inventory_cancel', reason }), equip: async slot => {
    calls.push({ type: 'equip', slot }); const item = raw.inventory.items.find(item => item.slot === slot)
    if (!item) throw new Error('missing real item')
    const selected = raw.inventory.items.find(item => item.slot === raw.rawSelectedSlot)
    if (selected && selected !== item) selected.slot = slot
    item.slot = raw.rawSelectedSlot; raw.heldItem = copy(item)
    return { phase: 'completed', serverConfirmed: true, slot: raw.rawSelectedSlot }
  } }
  const host = { shared, world, meta: { version: '1.26.60', startGame: { current_tick: 1000n } }, apiUrl: 'http://127.0.0.1:49999', cache: { replay () {}, observe () {} }, client: { queue: (name, params) => packets.push({ name, params }) }, entities: { snapshot: () => copy(actors), nearby: () => [], stats: () => ({ unknownPositions: 0 }) }, getState: current, getServerState: () => copy(raw), allocate: () => -1, commitInventory () {}, setPrediction: prediction => { shared.prediction = { ...copy(prediction), updatedAt: ++stamp } }, setEquipmentPrediction () {}, setCapabilities () {}, log () {}, noteProgress: event => progresses.push(copy(event)) }
  const filename = path.resolve(__dirname, '../src/runtime.js'); const nativeRequire = Module.createRequire(filename)
  const realCreateGuard = nativeRequire('./guarded-route').createGuardedRoute
  const overridesModules = {
    './crafting': { createCrafting: () => crafting }, './inventory': { createInventory: () => inventory },
    './food': { createFood: () => ({ snapshot: () => ({ busy: false, hunger: 20 }), applyPacket () {}, cancel () {}, preview: () => ({ ready: false }) }), isSupportedFood: () => false },
    './input': { createInput: () => { let running = false; return { start: () => { running = true }, stop: () => { running = false }, release () {}, stats: () => ({ running, sent: 0 }), lookAt () {}, sendAction () {}, sendTransaction () {} } } },
    './combat': { createCombat: () => { const actor = { stops: [] }; combats.push(actor); return { snapshot: () => ({ busy: false, defending: false, engaging: false }), applyPacket () {}, previewEngage: () => ({ ready: false }), engage: async () => ({}), preview: () => ({ ready: false }), attack: async () => ({}), cancel: reason => actor.stops.push(reason), drain: async () => {} } } },
    './hut': { createHut: options => {
      const actor = { options, calls: [], busy: false, memory: copy(options.memo), physical: { inside: false, closed: false, usable: false, serverConfirmed: false } }; huts.push(actor)
      return { memo: () => copy(actor.memory), restoreMemo: memo => { actor.memory = copy(memo) }, snapshot: () => ({ busy: actor.busy, ...copy(actor.physical) }), preview: () => ({ ready: true }), execute: async (args, context) => { actor.calls.push({ args, context }); actor.options.movement.preview({ x: 0.5, y: 65, z: 0.5 }); return { phase: 'completed' } }, leave: async () => ({}), stop: async () => ({ busy: false }) }
    } },
    './guarded-route': { createGuardedRoute: options => {
      const actor = { options, busy: false, calls: [], stops: [], work: null }; guards.push(actor)
      if (realRoute) { const route = realCreateGuard(options); actor.route = route; return route }
      const snapshot = () => ({ phase: actor.busy ? 'moving' : 'idle', busy: actor.busy, safe: false })
      const start = (method, nodes, bounds) => { actor.busy = true; actor.calls.push({ method, nodes, bounds }); actor.work = deferred(); return actor.work.promise }
      return { execute: (nodes, bounds) => start('execute', nodes, bounds), returnRoute: (nodes, bounds) => start('returnRoute', nodes, bounds), escape: (nodes, bounds) => start('escape', nodes, bounds), snapshot, stop: reason => { actor.stops.push(reason); return gate.promise.then(() => { actor.busy = false; actor.work?.resolve({ ok: false, returned: false }); return snapshot() }) } }
    } }
  }
  if (!realMovement) overridesModules['./movement'] = { createMovement: options => {
    const actor = { options, phase: 'idle', stops: [], previews: [], starts: [] }; movements.push(actor)
    return { preview: (target, opts) => { actor.previews.push({ target: copy(target), opts }); return { ready: true, origin: { ...current().position, y: current().position.y - 1.62 }, waypoints: [{ position: copy(target), medium: 'land', action: 'walk' }] } }, start: (target, opts) => { actor.starts.push({ target: copy(target), opts }); actor.phase = 'awaiting_server_confirmation'; shared.prediction = { position: { ...copy(target), y: target.y + 1.62 }, updatedAt: ++stamp, physicsState: { onGround: true, velocity: { x: 0, y: -0.0784, z: 0 } } }; return { phase: actor.phase } }, settle: () => ({}), stop: reason => { actor.stops.push(reason); actor.phase = 'stopped'; return { phase: 'stopped' } }, applyPacket () {}, snapshot: () => ({ phase: actor.phase }) }
  } }
  const target = { exports: {} }; const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
  compiled(target.exports, name => overridesModules[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  const create = () => { const runtime = target.exports.createRuntime(host); instances.push(runtime); return runtime }
  const runtime = create()
  t.after(async () => { gate.resolve(); for (const instance of instances) await instance.dispose('test_cleanup') })
  return { runtime, create, raw, shared, current, host, calls, packets, progresses, guards, movements, combats, huts, inventory, crafting, world, overrides, gate, actors, setFloor: name => { floorName = name }, setFloorY: y => { floorY = y }, scope: { profile: 'bot', realmId: '42', dimension: 'overworld' } }
}

test('guardRoute construction is passive, API forwards explicit options and busy/cleanup exclude external actors', async t => {
  const f = fixture(t, { delayedCleanup: true })
  assert.equal(f.packets.length, 0)
  assert.equal(f.guards.length, 1)
  const bounds = { scope: f.scope, visitedPrefix: [{ x: 0.5, y: 65, z: 0.5 }], allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 16 }
  const nodes = [{ x: 1.5, y: 65, z: 0.5 }]
  const run = f.runtime.operations.guardRoute.execute(nodes, bounds)
  assert.deepEqual(f.guards[0].calls[0], { method: 'execute', nodes, bounds })
  assert.equal(f.runtime.snapshot().guardRoute.busy, true)
  assert.equal(f.runtime.canReload(), false)
  assert.throws(() => f.runtime.operations.movement.start(nodes[0]), /前の操作/)
  await assert.rejects(f.runtime.operations.inventory.equip(0), /前の操作/)
  assert.throws(() => f.runtime.operations.guardRoute.execute(nodes), /前の操作/)
  assert.doesNotThrow(() => f.guards[0].options.movement.preview(nodes[0]))
  f.guards[0].options.onProgress({ phase: 'retreating', reached: nodes[0], position: { ...nodes[0], y: 66.62 } })
  const snapshot = f.runtime.operations.guardRoute.snapshot()
  assert.deepEqual(snapshot.lastReached, nodes[0])
  snapshot.lastReached.x = 100
  assert.equal(f.runtime.snapshot().guardRoute.lastReached.x, 1.5)
  let finished = false
  const stopping = f.runtime.operations.guardRoute.stop('explicit stop').then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  assert.equal(f.runtime.canReload(), false)
  f.gate.resolve(); await stopping; await run
  const returning = f.runtime.operations.guardRoute.returnRoute(nodes, bounds)
  assert.equal(f.guards[0].calls.at(-1).method, 'returnRoute')
  await f.runtime.operations.guardRoute.stop('end return'); await returning
})

test('actual physical standing validation accepts furnace/table shapes and empty torches without rewriting any pose', t => {
  const f = fixture(t, { realMovement: true })
  const hook = f.guards[0].options
  const target = { x: 0.5, y: 65, z: 0.5 }
  const before = copy(f.raw.position)
  for (const name of ['stone', 'furnace', 'crafting_table']) { f.setFloor(name); assert.equal(hook.verifyStanding(f.current(), target), true, name) }
  f.overrides.set('0,65,0', block('torch'))
  assert.equal(hook.verifyStanding(f.current(), target), true)
  for (const invalid of [{ known: false }, block('water'), block('air')]) {
    f.overrides.set('0,64,0', invalid)
    assert.equal(hook.verifyStanding(f.current(), target), false)
  }
  f.overrides.delete('0,64,0')
  f.overrides.set('0,65,0', { known: false })
  assert.equal(hook.verifyStanding(f.current(), target), false)
  f.overrides.set('0,65,0', block('air'))
  f.overrides.set('0,66,0', block('stone'))
  assert.equal(hook.verifyStanding(f.current(), target), false)
  f.overrides.delete('0,66,0')
  f.shared.prediction = { position: before, physicsState: { onGround: false } }
  assert.equal(hook.verifyStanding(f.current(), target), false)
  assert.deepEqual(f.raw.position, before)
  assert.deepEqual(f.packets, [])
})

test('onReturned closes only the captured own Hut near its actual origin and matching world scope', async t => {
  const f = fixture(t)
  const site = planHut(f.current(), { getBlock: (x, y, z) => f.world.getBlock(x, y, z) }, { radius: 0 })
  f.shared.hutMemo = { version: 1, scope: { realmId: '42', dimension: 'overworld' }, site }
  const hook = f.guards[0].options
  const origin = site.outsideStandpoint
  const controller = new AbortController()
  const context = { scope: f.scope, visitedPrefix: [origin], signal: controller.signal }
  await hook.onReturned(f.current(), context)
  assert.equal(f.huts[0].calls.length, 1)
  assert.strictEqual(f.huts[0].calls[0].context.signal, controller.signal)
  controller.abort(new Error('return closure cancelled'))
  await assert.rejects(hook.onReturned(f.current(), context), /return closure cancelled/)
  const liveContext = { ...context, signal: new AbortController().signal }
  const far = { x: 20.5, y: 65, z: 20.5 }
  f.shared.prediction = { position: { ...far, y: 66.62 }, physicsState: { onGround: true } }
  assert.equal((await hook.onReturned(f.current(), { ...liveContext, visitedPrefix: [far] })).skipped, true)
  assert.equal((await hook.onReturned(f.current(), { ...liveContext, scope: { ...f.scope, realmId: '99' } })).skipped, true)
  assert.equal(f.huts[0].calls.length, 1)
  assert.deepEqual(f.raw.position, { x: 0.5, y: 66.62, z: 0.5 })
})

test('a proven coplanar full-footprint floor tolerates only float32 contact skin without snapping raw coordinates', t => {
  const f = fixture(t, { realMovement: true })
  f.setFloorY(36)
  f.raw.position.y = Math.fround(38.62)
  const before = copy(f.raw.position)
  const hook = f.guards[0].options
  assert.ok(before.y - 1.62 < 37 && 37 - (before.y - 1.62) < 1e-4)
  assert.equal(hook.verifyStanding(f.current(), { x: 0.5, y: 37, z: 0.5 }), true)
  assert.deepEqual(f.raw.position, before)
  assert.equal(f.shared.prediction, undefined)
  f.raw.position.y = 38.618
  assert.equal(hook.verifyStanding(f.current(), { x: 0.5, y: 37, z: 0.5 }), false, 'a real overlap larger than the contact tolerance is still blocked')
  f.raw.position = { ...before, x: 0.9 }
  f.overrides.set('1,36,0', { known: false })
  assert.equal(hook.verifyStanding(f.current(), { x: 0.9, y: 37, z: 0.5 }), false, 'every footprint column needs known support before any contact skin is allowed')
  f.overrides.delete('1,36,0')
  f.overrides.set('1,37,0', block('stone'))
  assert.equal(hook.verifyStanding(f.current(), { x: 0.9, y: 37, z: 0.5 }), false, 'the vertical floor tolerance must not loosen a horizontal wall collision')
  assert.deepEqual(f.packets, [])
})

test('generation replacement fences old reads/starts/progress and late cleanup only touches captured movement and combat', async t => {
  const f = fixture(t)
  const old = f.guards[0].options
  await f.runtime.onSpawn()
  const latestMovement = f.movements.at(-1); const latestCombat = f.combats.at(-1)
  const movementStops = latestMovement.stops.length; const combatStops = latestCombat.stops.length
  assert.throws(() => old.getState(), /スポーン前|更新/)
  assert.throws(() => old.movement.start({ x: 1.5, y: 65, z: 0.5 }), /スポーン前|更新/)
  const beforeCancels = f.calls.filter(call => call.type === 'inventory_cancel').length
  old.movement.stop('old cleanup'); old.combat.cancel('old cleanup'); old.inventory.cancel('old cleanup')
  assert.equal(latestMovement.stops.length, movementStops)
  assert.equal(latestCombat.stops.length, combatStops)
  assert.equal(f.calls.filter(call => call.type === 'inventory_cancel').length, beforeCancels)
  old.onProgress({ phase: 'retreating', reached: { x: 100, y: 65, z: 100 } })
  assert.equal(f.runtime.snapshot().guardRoute.lastReached, null)
})

test('damage stops motion while preserving the route supervisor, but explicit/death/dispose await route cleanup', async t => {
  const f = fixture(t, { delayedCleanup: true })
  const task = f.runtime.operations.guardRoute.execute([{ x: 1.5, y: 65, z: 0.5 }])
  await f.runtime.stopActions('ダメージを検知しました。')
  assert.equal(f.guards[0].stops.length, 0)
  assert.ok(f.movements[0].stops.length > 0)
  assert.equal(f.runtime.snapshot().guardRoute.busy, true)
  let disposed = false
  const disposing = f.runtime.dispose('hot_reload').then(() => { disposed = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(disposed, false)
  assert.equal(f.guards[0].stops.includes('hot_reload'), true)
  assert.throws(() => f.guards[0].options.getState(), /スポーン前|更新/)
  f.gate.resolve(); await disposing; await task
  const latest = f.create()
  const newMovement = f.movements.at(-1); const stops = newMovement.stops.length
  f.guards[0].options.movement.stop('late old cleanup')
  assert.equal(newMovement.stops.length, stops)
  assert.equal(latest.snapshot().guardRoute.busy, false)
})

test('the real guarded module uses the Runtime API with explicit bootstrap bounds and keeps predicted arrival unconfirmed', async t => {
  const f = fixture(t, { realRoute: true, sword: false })
  const node = { x: 1.5, y: 65, z: 0.5 }
  const refused = await f.runtime.operations.guardRoute.execute([node])
  assert.equal(refused.ok, false)
  assert.equal(f.movements[0].starts.length, 0, 'default route must not silently become unarmed bootstrap')
  const result = await f.runtime.operations.guardRoute.execute([node], { allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
  assert.equal(result.ok, true)
  assert.equal(result.arrived, true)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.runtime.snapshot().guardRoute.lastReached, node)
  const returned = await f.runtime.operations.guardRoute.returnRoute(result.visitedPrefix, { scope: f.scope, allowUnarmedBootstrap: true, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
  assert.equal(returned.returned, true)
  assert.equal(returned.safe, false)
  assert.equal(returned.serverConfirmed, false)
  assert.deepEqual(f.raw.position, { x: 0.5, y: 66.62, z: 0.5 })
  assert.deepEqual(f.packets, [])
})

test('ordinary mining cannot destroy same-scope observed tunnel floors or bypass them with caller properties', async t => {
  const f = fixture(t)
  const floor = { x: 1, y: 65, z: 0 }
  f.overrides.set('1,65,0', block('dirt'))
  const scopeKey = JSON.stringify([f.scope.profile, f.scope.realmId, f.scope.dimension])
  f.shared.tunnelFloors = { version: 1, scopes: { [scopeKey]: { floors: [floor] } } }
  const before = f.calls.filter(call => call.type === 'close_gui').length
  assert.throws(() => f.runtime.operations.mining.start([floor]), error => error.code === 'PROTECTED_BLOCK' && error.protectionSource === 'tunnel_floor')
  assert.throws(() => f.runtime.operations.mining.start([{ ...floor, ownedCall: true }]), error => error.code === 'PROTECTED_BLOCK')
  assert.equal(f.runtime.snapshot().mining.activeTarget, null)
  assert.equal(f.calls.filter(call => call.type === 'close_gui').length, before)
  assert.doesNotThrow(() => f.huts[0].options.mining.start([floor]), 'only private validated actor callbacks retain their owned-call path')
  f.runtime.operations.mining.stop('test cleanup')
  f.raw.realm.id = '43'
  await f.runtime.onSpawn(); await new Promise(resolve => setImmediate(resolve))
  assert.doesNotThrow(() => f.runtime.operations.mining.start([floor]), 'another Realm does not inherit the old floor ownership')
  f.runtime.operations.mining.stop('test cleanup')
})

test('malformed or unscoped tunnel-floor journals fail before ordinary mining emits input', t => {
  const f = fixture(t)
  const floor = { x: 1, y: 65, z: 0 }
  f.overrides.set('1,65,0', block('dirt'))
  const scopeKey = JSON.stringify([f.scope.profile, f.scope.realmId, f.scope.dimension])
  for (const journal of [{ version: 2, scopes: {} }, { version: 1, scopes: { [scopeKey]: { floors: null } } }, { version: 1, scopes: { [scopeKey]: { floors: [{ ...floor, x: 0.5 }] } } }]) {
    f.shared.tunnelFloors = journal
    assert.throws(() => f.runtime.operations.mining.start([floor]), /帰路の床/)
    assert.equal(f.runtime.snapshot().mining.activeTarget, null)
  }
  f.shared.tunnelFloors = { version: 1, scopes: { [scopeKey]: { floors: [floor] } } }
  f.raw.realm = null
  assert.throws(() => f.runtime.operations.mining.start([floor]), error => error.code === 'TUNNEL_FLOOR_SCOPE_UNKNOWN')
  assert.deepEqual(f.packets, [])
})

test('escape is exposed without a fake prefix, uses actual threat state and cannot claim a home return or safe refuge', async t => {
  const f = fixture(t, { realRoute: true })
  f.actors.push({ runtimeId: '99', uniqueId: '-99', kind: 'mob', entityType: 'minecraft:creeper', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 3.5, y: 65, z: 0.5 } })
  const target = { x: -0.5, y: 65, z: 0.5 }
  const ordinary = await f.runtime.operations.guardRoute.execute([target])
  assert.equal(ordinary.outwardCompleted, false)
  assert.equal(f.movements[0].starts.length, 0, 'ordinary outward movement must not inherit the explicit escape exemption')
  const escaped = await f.runtime.operations.guardRoute.escape([target])
  assert.equal(escaped.escaped, true)
  assert.equal(escaped.arrived, true)
  assert.equal(escaped.returned, false)
  assert.equal(escaped.refugeConfirmed, false)
  assert.equal(escaped.safe, false)
  assert.equal(escaped.riskRemains, true)
  assert.equal(f.movements[0].starts.at(-1).opts.emergency, true)
  assert.equal(f.movements[0].starts.at(-1).opts.sprint, true)
  assert.equal(f.huts[0].calls.length, 0)
  assert.deepEqual(f.raw.position, { x: 0.5, y: 66.62, z: 0.5 })
})
