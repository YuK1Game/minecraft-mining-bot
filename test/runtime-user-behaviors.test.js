'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createSessionCache } = require('../src/session-cache')
const actualAutonomy = require('../src/autonomy')
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function scene (t, { realFacade = false, nativeStanding = false, runtimeOverrides = {} } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let worldReads = 0, tick = 1000n, sent = 0, running = false, predicted = null, movementState = { phase: 'idle', running: false, sent: 0 }, facadeOptions, recoveryOptions, autonomyOptions, historyRevision = 0
  const events = [], wire = [], facadeWire = [], movementStarts = [], recoverPreviews = { sync: 0, async: 0 }, counters = { invalidates: [], facadeTicks: 0, facadeCancels: 0, idleStarts: 0, inputStops: 0, autonomyStarts: 0 }
  const wireInputOptions = [], wireMovementOptions = []
  const raw = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'integration', startedAt: '2026-11-01T00:00:00Z', runtimeEntityId: '1', playerName: 'HouchiChan', dimension: 'overworld', gameMode: 'survival', health: 20, dead: false, spawnPending: false, position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 1, positionSource: 'server_post_move', rotation: { yaw: 0, pitch: 0 }, selectedSlot: 0, rawSelectedSlot: 0, rawServerSelectedSlot: 0, inventory: { known: true, items: [] }, capabilities: {} }
  const actors = []
  const shared = { userBehaviorsEnabled: false, autoWanted: false, safetyWanted: false, loadingScreenEnded: true, deathRespawn: { deathId: 0 }, prediction: null }
  const facadeState = { busy: false, claim: null, activeKind: null, sleeping: false, blocked: false, cleanupUnconfirmed: false, bed: {} }
  const facade = { snapshot: () => structuredClone(facadeState), tick: async () => { counters.facadeTicks++; return facade.snapshot() }, applyPacket: (name, p) => { facadeWire.push({ name, p: structuredClone(p), inventory: facadeOptions.crafting.snapshot().inventory }); if (name === 'set_entity_data' && String(p.runtime_entity_id) === raw.runtimeEntityId) { const flag = p.metadata?.find(e => e.key === 'player_flags'); if (flag) { facadeState.sleeping = (flag.value & 2) !== 0; facadeState.bed.sleepReceipt = { sleeping: facadeState.sleeping, source: 'own_server_metadata', scope: `own-sleep:${raw.connectionId}:${shared.deathRespawn.deathId}`, sequence: (facadeState.bed.sleepReceipt?.sequence ?? 0) + 1 } } } }, cancel: () => { counters.facadeCancels++ }, drain: async () => facade.snapshot(), ownsBedTarget: () => true }
  const physics = allowWater => ({ capabilities: { version: '1.26.60', water: allowWater ? 'experimental' : 'disabled' }, withWorld: (world, options = {}) => physics(options.allowWater ?? allowWater), fromServer: s => ({ position: { ...s.position, y: s.position.y - 1.62 }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true, isInWater: false, isInLava: false, yaw: s.rotation?.yaw ?? 0, pitch: s.rotation?.pitch ?? 0 }), toServerPosition: s => ({ ...s.position, y: s.position.y + 1.62 }), step: s => structuredClone(s), waterSurface: () => null, blockAt: p => ({ name: p.y < 65 ? 'stone' : 'air', known: true, shapes: p.y < 65 ? [[0, 0, 0, 1, 1, 1]] : [] }) })
  let hopSequence = 0
  const mockMovement = { snapshot: () => structuredClone(movementState), preview: () => ({ ready: true }), start: (target, options) => { movementStarts.push({ target, options }); movementState = { phase: 'moving', running: true, route: { operation: 'navigation' }, target }; return mockMovement.snapshot() }, previewHop: () => ({ ready: true }), startHop: options => { options.getAim?.(); movementState = { phase: 'moving', running: true, route: { operation: 'critical_hop' }, criticalHopId: ++hopSequence, queuedTick: '1001', queuedAt: Date.now(), queuedReceiptConfirmed: true }; return mockMovement.snapshot() }, stop: () => { movementState.phase = 'stopped'; movementState.running = false; movementState.queuedReceiptConfirmed = false }, resetLifecycle: () => mockMovement.stop(), applyPacket: () => {}, diagnostics: () => null }
  const mockAutonomy = { snapshot: () => ({ running: false, busy: false, actionActive: false }), start: () => { counters.autonomyStarts++; return mockAutonomy.snapshot() }, stop: () => mockAutonomy.snapshot(), tick: async () => mockAutonomy.snapshot() }
  const recovery = { snapshot: () => ({ phase: 'idle', busy: false }), preview: () => { recoverPreviews.sync++; return { ready: false } }, previewAsync: async () => { recoverPreviews.async++; return { ready: true, candidates: [], mode: 'destination' } }, execute: async () => {}, stop: async () => {} }
  const overrides = {
    './physics': { createPhysics: options => physics(options.allowWater) }, './navigation': { createNavigator: options => ({ physics: options.physics ?? physics(true), verifyOrigin: () => true }) }, './movement': { createMovement: options => { wireMovementOptions.push(options); return mockMovement } },
    './input-history': { createInputHistory: () => ({ snapshot: () => ({ revision: historyRevision, count: 0, latestTick: null, cursor: null }), invalidate: reason => { counters.invalidates.push(reason); historyRevision++ }, observeStationaryRaw () {}, recordQueued () {}, observeAnchor () {}, standingWitness: () => ({ ready: false }) }) },
    './input': { createInput: options => { wireInputOptions.push(options); return { stats: () => ({ running, tick: String(tick), sent, target: null }), start: () => { running = true; sent++; tick++ }, stop: () => { running = false; counters.inputStops++ }, release: () => {}, lookAt: () => {}, sendAction: () => {}, sendTransaction: () => {} } } },
    './idle-safety': { createIdleSafety: () => { let active = false; return { snapshot: () => ({ running: active, busy: false, phase: active ? 'observing' : 'stopped' }), start: () => { counters.idleStarts++; active = true }, stop: async () => { active = false }, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) } } },
    './autonomy': { ...actualAutonomy, createAutonomy: options => { autonomyOptions = options; return mockAutonomy } }, './recovery': { createRecovery: options => { recoveryOptions = options; return recovery } },
    './user-behaviors': { createUserBehaviors: options => { facadeOptions = options; return realFacade ? require('../src/user-behaviors').createUserBehaviors(options) : facade } }
  }
  if (nativeStanding) { delete overrides['./physics']; delete overrides['./navigation'] }
  Object.assign(overrides, runtimeOverrides)
  const game = { current_tick: 1000n, entity_id: 101n, runtime_entity_id: 1n, player_position: raw.position, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true }
  const cache = createSessionCache(); cache.observe('start_game', game); cache.observe('item_registry', { itemstates: [{ runtime_id: 300, name: 'minecraft:stick' }] }); cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, air) }); cache.observe('player_hotbar', { window_id: 'inventory', selected_slot: 0 })
  const host = { shared, cache, client: { queue: (name, p) => { wire.push({ name, p }); return name === 'player_auth_input' ? { tick: p.tick } : undefined }, close: () => assert.fail('Runtime must not close a client'), disconnect: () => assert.fail('Runtime must not disconnect'), connect: () => assert.fail('Runtime must not connect') }, meta: { profile: 'bot', version: '1.26.60', startGame: game, startGameReceivedAt: 0 }, apiUrl: 'http://127.0.0.1:49999',
    world: { getBlock: (x, y, z) => { worldReads++; return { known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', position: { x, y, z }, runtimeId: y < 65 ? 1 : 0, properties: {}, extra: [] } }, stats: () => ({ version: '1.26.60', initialized: true }) }, entities: { snapshot: () => structuredClone(actors), nearby: () => [], stats: () => ({ unknownPositions: 0 }), snapshotRemoved: () => [] }, getServerState: () => structuredClone(raw), getState: () => ({ ...structuredClone(raw), rawServerPosition: structuredClone(raw.position), rawServerPositionUpdatedAt: raw.positionUpdatedAt, rawSelectedSlot: raw.selectedSlot, ...(shared.prediction ? { position: structuredClone(shared.prediction.position), predicted: structuredClone(shared.prediction), positionSource: 'client_prediction' } : {}) }),
    setPrediction: p => { shared.prediction = structuredClone(p) }, setCapabilities: p => Object.assign(raw.capabilities, p), setEquipmentPrediction: () => {}, allocate: () => -3, commitInventory: () => {}, registerPacketEvents: names => events.push({ registered: names }), log: () => {}, noteProgress: () => {}
  }
  const filename = path.resolve(__dirname, '../src/runtime.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded.require = name => overrides[name] ?? Module.prototype.require.call(loaded, name)
  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)
  const runtime = loaded.exports.createRuntime(host)
  t.after(async () => { await runtime.dispose('test_cleanup') })
  const scope = () => ({ profile: raw.profile, realmId: raw.realm.id, connectionId: raw.connectionId, startedAt: raw.startedAt, runtimeEntityId: raw.runtimeEntityId, dimension: raw.dimension, deathId: shared.deathRespawn.deathId })
  return { runtime, host, raw, shared, facadeState, facadeWire, facadeOptions, recoveryOptions, recovery, recoverPreviews, autonomyOptions, actors, mockMovement, events, counters, wire, scope, wireInputOptions, wireMovementOptions, worldReads: () => worldReads, advance: ms => t.mock.timers.tick(ms), setMovement: value => { movementState = value }, unexpectedQueuedInput: () => { sent++; tick++ } }
}

function capturedPhantomScene (t) {
  const f = scene(t)
  // Actual same-life observation2026-11-01T15:18:58.577Z. This is admission
  // geometry only; the fixture does not claim a Native route or a server hit.
  f.raw.position = { x: 3.5082245295172827, y: 64.62, z: 15.530116905068875 }
  const target = { runtimeId: '14014', uniqueId: '-639950113273', kind: 'mob', entityType: 'minecraft:phantom', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, positionSource: 'move_entity_delta', position: { x: 3.328899621963501, y: 67, z: 13.169713020324707 } }
  f.actors.push(target)
  f.shared.autoWanted = true; f.shared.userBehaviorsEnabled = true
  return { ...f, target }
}

function manualArmorFixture (t, { includeDestination = true } = {}) {
  const f = scene(t), pieces = ['helmet', 'chestplate', 'leggings', 'boots']
  const rawItem = slot => ({ ...air(), network_id: 400 + slot, count: 1, has_stack_id: true, stack_id: 100 + slot, extra: { ...air().extra, has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { ench: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: 0 }, lvl: { type: 'short', value: 4 } }] } } } } } } })
  f.runtime.applyPacket('item_registry', { itemstates: pieces.map((piece, slot) => ({ runtime_id: 400 + slot, name: `minecraft:diamond_${piece}` })) })
  f.runtime.applyPacket('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, slot) => slot < 4 ? rawItem(slot) : air()) })
  f.runtime.applyPacket('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, air) })
  const queue = f.host.client.queue.bind(f.host.client), requests = []
  f.host.client.queue = (name, packet) => {
    const result = queue(name, packet)
    if (name === 'interact') queueMicrotask(() => f.runtime.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' }))
    if (name === 'item_stack_request') {
      const request = packet.requests[0], destination = request.actions[0].destination
      requests.push(destination.slot)
      assert.equal(destination.slot_type.container_id, 'armor')
      const containers = includeDestination ? [{ slot_type: { container_id: 'armor' }, slots: [{ slot: destination.slot, count: 1, item_stack_id: 550 + destination.slot }] }] : []
      queueMicrotask(() => f.runtime.applyPacket('item_stack_response', { responses: [{ request_id: request.request_id, status: 'ok', containers }] }))
    }
    return result
  }
  return { f, pieces, requests }
}

test('manual armor equip uses actual accepted armor moves while automatic behaviors stay off', async t => {
  const { f, pieces, requests } = manualArmorFixture(t)
  const task = f.runtime.operations.armor.equipBest()
  assert.equal(f.runtime.canReload(), false)
  const result = await task
  assert.equal(result.serverConfirmed, true, JSON.stringify(result)); assert.equal(result.moves.length, 4)
  assert.deepEqual(requests.sort(), [0, 1, 2, 3]); assert.deepEqual(result.worn.map(item => item.name), pieces.map(piece => `minecraft:diamond_${piece}`))
  assert.equal(f.shared.autoWanted, false); assert.equal(f.counters.autonomyStarts, 0)
})

test('manual armor equip refuses nearby hostiles and never credits a bare ACK without the matching worn piece', async t => {
  const { f, requests } = manualArmorFixture(t, { includeDestination: false })
  f.actors.push({ kind: 'mob', runtimeId: 'danger', hostile: true, alive: true, position: { ...f.raw.position } })
  await assert.rejects(f.runtime.operations.armor.equipBest(), /8m/)
  assert.equal(requests.length, 0)
  f.actors.length = 0
  const result = await f.runtime.operations.armor.equipBest()
  assert.equal(result.phase, 'blocked'); assert.equal(result.serverConfirmed, false)
  assert.equal(result.reason, 'ARMOR_SLOT_UNCONFIRMED'); assert.equal(result.moves.length, 0); assert.equal(requests.length, 1)
})

test('runtime shares observed portable-container ports for quarry supplies and keeps resync outside the action owner', async t => {
  const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
  const calls = [], signal = new AbortController().signal, checkpoint = async () => {}
  let held = false, busy = false, adapter
  const chest = { snapshot: () => ({ busy: false }), rawItem: slot => slot, applyPacket () {}, cancel () {}, depositDiamond () {},
    open (position, slot, settings) { calls.push(['open', settings.expectedSlots]); return { position, slotCount: settings.expectedSlots } },
    withdrawItem (request) { calls.push(['withdraw', request.chestSlot]); return { serverConfirmed: true } },
    depositItem (request) { calls.push(['deposit', request.sourceSlot]); return { serverConfirmed: true } }
  }
  const f = scene(t, { runtimeOverrides: {
    './chest': { createChest: () => chest },
    './quarry-runtime-adapter': { createQuarryRuntimeAdapter: ports => ({ ...createQuarryRuntimeAdapter(ports), resyncInventory: async options => {
      assert.strictEqual(options.signal, signal)
      assert.throws(() => f.runtime.operations.chest.depositItem({ sourceSlot: 17 }), /露天掘りの作業中/)
      calls.push(['resync']); return true
    } }) },
    './quarry-job': { createQuarryJob: options => {
      adapter = options.adapter
      return { holdsWork: () => held, document: () => null, status: () => ({ state: 'PAUSED' }),
        configureSupplies: () => adapter.discoverSupplies(),
        restockSuppliesNow: async () => { held = true; try { return await adapter.restockSupplies({ jobId: 'job', operationId: 'restock' }, { signal, onCheckpoint: checkpoint }) } finally { held = false } }
      }
    } },
    './quarry-portable-storage': { createQuarryPortableStorage: ports => ({ storeCarried: async (request, options) => {
      assert.equal(request.operationId, 'restock'); assert.strictEqual(options.signal, signal)
      return ports.workWithContainer({ request, position: { x: 2, y: 65, z: 2 } }, options)
    } }) },
    './quarry-supplies': { createQuarrySupplies: ports => ({
      discoverBindings: () => { calls.push(['discover']); return { ok: true, bindings: ['fixture'] } },
      snapshot: () => ({ busy }), cancel: reason => calls.push(['cancel', reason]),
      run: async (request, options) => {
        assert.strictEqual(options.onCheckpoint, checkpoint); busy = true
        try { await ports.refreshInventory(options); return await ports.getPortable().storeCarried(request, options) } finally { busy = false }
      },
      workWithContainer: async (context, options) => {
        assert.equal(f.runtime.canReload(), false); assert.strictEqual(options.signal, signal)
        await ports.chest.open(context.position, undefined, { expectedSlots: 27 })
        const receipt = await ports.chest.withdrawItem({ chestSlot: 3 }); await ports.chest.depositItem({ sourceSlot: 9 }); ports.chest.close()
        return receipt
      }
    }) }
  } })
  assert.deepEqual(await f.runtime.operations.quarry.configureSupplies(), { ok: true, bindings: ['fixture'] })
  assert.deepEqual(await f.runtime.operations.quarry.restockSuppliesNow(), { serverConfirmed: true })
  await adapter.stopAll('fixture-stop')
  assert.deepEqual(calls, [['discover'], ['resync'], ['open', 27], ['withdraw', 3], ['deposit', 9], ['cancel', 'fixture-stop']])
  assert.equal(f.shared.autoWanted, false); assert.equal(f.counters.autonomyStarts, 0)
})

test('captured Phantom3.501m uses the existing near approach lease rather than falsefar4.045m admission', async t => {
  const f = capturedPhantomScene(t), context = { kind: 'combat', claimId: 'combat:phantom', scope: f.scope(), target: structuredClone(f.target) }
  const range = offset => Math.hypot(f.raw.position.x - f.target.position.x, f.raw.position.y - f.target.position.y - offset, f.raw.position.z - f.target.position.z)
  assert.ok(range(0.2) > 2.8 && range(0.2) < 4); assert.ok(range(0.9) > 4)
  const token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false, 'Only the aim-height parity admits this existing near band')
  assert.equal(f.wire.length, 0, 'Protective admission itself sends no attack or movement packets')
  assert.equal(f.runtime.snapshot().userBehaviors.approachAdmission, null, 'No new healthy-far approach permission')
  await f.facadeOptions.resumeControl({ ...context, token })
})

test('far Phantom contact acquires combat priority without borrowing near approach admission', async t => {
  const f = capturedPhantomScene(t); f.target.position.x += 4
  const context = { kind: 'combat', claimId: 'combat:farphantom', scope: f.scope(), target: structuredClone(f.target) }
  const token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false)
  assert.equal(f.runtime.snapshot().userBehaviors.approachAdmission, null)
  assert.equal(f.wire.length, 0)
  await f.facadeOptions.resumeControl({ ...context, token })
})

test('changed PhantomUID after near acquisition rejects the actual approach before movement', async t => {
  const f = capturedPhantomScene(t), context = { kind: 'combat', claimId: 'combat:changedphantom', scope: f.scope(), target: structuredClone(f.target) }
  context.token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(context.token.acquired, false)
  f.target.uniqueId = '-639950113999'
  await assert.rejects(f.facadeOptions.approach(context.target, context), /target changed/)
  assert.equal(f.wire.length, 0)
  await f.facadeOptions.resumeControl(context)
})

test('staged Runtime constructs facade after dependencies and offers lightweight current-life state', t => {
  const f = scene(t); assert.ok(f.facadeOptions); assert.equal(f.facadeWire.length, 0, 'cache replay is never forwarded')
  for (const name of ['getState', 'getRawState', 'getSelfUniqueId', 'previewHop', 'startHop', 'getMovement', 'stopHop', 'getClock', 'getBedMemory', 'setBedMemory', 'placeBed', 'useBed', 'wakeBed', 'mineBed', 'collectBed', 'moveBed', 'acquireControl', 'resumeControl', 'canAct']) assert.equal(typeof f.facadeOptions[name], 'function', name)
  const before = f.worldReads(); f.shared.deathRespawn.deathId = 4; f.raw.dead = true; const state = f.facadeOptions.getState(); assert.equal(state.lifecycle.deathId, 4); assert.equal(state.dead, true); assert.equal(f.worldReads(), before)
  assert.equal(f.facadeOptions.getSelfUniqueId(), 101n); assert.equal(f.shared.userBehaviorError, undefined)
})
test('actual Runtime factory shares the actual wire cursor between both senders and preserves its age across new lives', t => {
  const f = scene(t), wrapped = f.host.client.queue
  f.host.client.queue('player_auth_input', { tick: 1003n })
  const before = f.runtime.snapshot().queuedWireClock
  assert.equal(before.tick, '1003'); assert.equal(before.serverConfirmed, false)
  assert.equal(f.wireInputOptions.at(-1).getQueuedCursor, f.wireMovementOptions.at(-1).getQueuedCursor)
  assert.deepEqual(f.wireInputOptions.at(-1).getQueuedCursor(), { tick: '1003', queuedAt: before.queuedAt })
  f.shared.deathRespawn.deathId++
  f.runtime.onSpawn()
  assert.equal(f.host.client.queue, wrapped)
  assert.equal(f.runtime.snapshot().queuedWireClock.queuedAt, before.queuedAt)
  assert.equal(f.wireInputOptions.at(-1).getQueuedCursor().tick, '1003')
  f.raw.connectionId = 'different-connection'
  assert.throws(() => f.wireInputOptions.at(-1).getQueuedCursor(), /connection changed/)
  assert.equal(f.runtime.snapshot().queuedWireClock, null)
})
test('opaque Root token and namespaced claim identity prevent late bed release from clearing combat', async t => {
  const f = scene(t), opts = f.facadeOptions
  const first = { kind: 'bed', claimId: 'bed:1', scope: f.scope() }, bedToken = await opts.acquireControl(first)
  assert.equal(Object.getPrototypeOf(bedToken), Object.prototype); assert.equal((await opts.resumeControl({ ...first, token: {} })).resumed, false)
  assert.equal((await opts.resumeControl({ ...first, token: bedToken })).resumed, true)
  const second = { kind: 'combat', claimId: 'combat:1', scope: f.scope() }, combatToken = await opts.acquireControl(second)
  assert.equal((await opts.resumeControl({ ...first, token: bedToken })).resumed, false)
  assert.throws(() => f.runtime.operations.movement.preview({ x: 1.5, y: 65, z: 0.5 }), /操作|使用中/)
  assert.equal((await opts.resumeControl({ ...second, token: combatToken })).resumed, true); assert.equal(f.shared.safetyWanted, false)
})
test('wire packets arrive after crafting updates, replay never leaks, and actual OW clock is used', t => {
  const f = scene(t)
  f.runtime.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: { ...air(), network_id: 300, count: 4, has_stack_id: true, stack_id: 9 } })
  assert.equal(f.facadeWire.at(-1).inventory[0].name, 'minecraft:stick'); assert.equal(f.facadeWire.at(-1).inventory[0].count, 4)
  f.runtime.applyPacket('sync_world_clocks', { payload_type: 'initialize_registry', clocks: [{ id: 1n, name: 'minecraft:overworld', time: 14000, paused: false }] }); assert.deepEqual(f.facadeOptions.getClock(), { time: 14000, source: 'server_sync_world_clocks' })
  f.runtime.applyPacket('sync_world_clocks', { payload_type: 'sync_state', sync_states: [{ clock_id: 1n, time: 1000, paused: false }] }); assert.equal(f.facadeOptions.getClock().time, 1000)
  assert.ok(f.events[0].registered.includes('animate'))
})
test('actual sleep stops idle input and invalidates once; wake waits for a fresh raw pose', async t => {
  const f = scene(t); f.runtime.resumeRequested(); const before = f.counters.invalidates.length
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] }); const after = f.counters.invalidates.filter(v => v === 'user_behavior_sleep').length
  f.advance(250); assert.equal(after, 1); assert.equal(f.counters.invalidates.filter(v => v === 'user_behavior_sleep').length, 1); assert.equal(f.runtime.canReload(), false)
  f.unexpectedQueuedInput()
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 0 }] }); assert.equal(f.runtime.snapshot().userBehaviors.wakePending, true)
  f.raw.positionUpdatedAt = 2; f.runtime.applyPacket('server_post_move', { position: f.raw.position }); await turn(); assert.equal(f.runtime.snapshot().userBehaviors.wakePending, false)
})
test('living exact-damage callback preserves a claimed fight; manual stop cancels it', async t => {
  const f = scene(t), ctx = { kind: 'combat', claimId: 'combat:1', scope: f.scope() }; const token = await f.facadeOptions.acquireControl(ctx)
  f.raw.health = 1; const before = f.counters.facadeCancels; await f.runtime.stopActions('ダメージを検知しました。'); assert.equal(f.counters.facadeCancels, before)
  await f.runtime.stopActions('manual_stop'); assert.equal(f.counters.facadeCancels, before + 1); await f.facadeOptions.resumeControl({ ...ctx, token })
})
test('Native hop wrappers pin motion and refuse generic input until ID-matched stop', t => {
  const f = scene(t), opts = f.facadeOptions; const started = opts.startHop({ getAim: () => ({ x: 2, y: 66, z: 0.5 }) })
  assert.throws(() => opts.getInput(), /Native movement/); opts.stopHop('stale', started.criticalHopId + 1); assert.equal(opts.getMovement().running, true)
  opts.stopHop('done', started.criticalHopId); assert.equal(opts.getMovement().running, false); assert.doesNotThrow(() => opts.getInput())
})
test('ordinary NAV intent is scoped, while recovery water waypoints cannot overwrite it', t => {
  const f = scene(t), destination = { x: 4.5, y: 63, z: 4.5 }
  f.runtime.operations.movement.start(destination, { allowWater: true }); f.mockMovement.stop(); assert.deepEqual(f.recoveryOptions.getDestination(f.facadeOptions.getState()).position, destination)
  f.recoveryOptions.movement.start({ x: 2.5, y: 63, z: 2.5 }, { allowWater: true, emergency: true }); assert.deepEqual(f.recoveryOptions.getDestination(f.facadeOptions.getState()).position, destination)
  f.shared.deathRespawn.deathId++; assert.equal(f.recoveryOptions.getDestination(f.facadeOptions.getState()), null); assert.equal(f.recoveryOptions.flatShoreOnly, true)
})
test('wet planSafety uses async preview; dry planner remains synchronous', async t => {
  const f = scene(t), state = f.facadeOptions.getState(); const dry = f.autonomyOptions.planSafety(state); assert.equal(typeof dry?.then, 'undefined'); assert.equal(f.recoverPreviews.async, 0)
  state.predicted = { physicsState: { isInWater: true } }; const wet = f.autonomyOptions.planSafety(state); assert.equal(typeof wet.then, 'function'); assert.equal((await wet).type, 'recover'); assert.equal(f.recoverPreviews.async, 1)
})
test('real facade constructor is compatible with staged Runtime wiring, without game actions', t => {
  const f = scene(t, { realFacade: true }); assert.equal(f.shared.userBehaviorError, undefined); assert.equal(f.runtime.snapshot().userBehaviors.ready, true); assert.equal(f.wire.length, 0)
})
test('Runtime reload waits for the currently mined block to finish or stop', t => {
  const f = scene(t), getBlock = f.host.world.getBlock
  f.host.world.getBlock = (x, y, z) => x === 1 && y === 65 && z === 0 ? { known: true, name: 'minecraft:dirt', runtimeId: 3, boundingBox: 'block', position: { x, y, z }, properties: {}, extra: [] } : getBlock(x, y, z)
  f.runtime.operations.mining.start([{ x: 1, y: 65, z: 0 }]); assert.equal(f.runtime.canReload(), false)
  f.runtime.operations.mining.stop('fixture done'); assert.equal(f.runtime.canReload(), true)
})
test('own awake receipt can resume an unchanged authoritative raw pose with full Native standing proof', t => {
  const f = scene(t, { nativeStanding: true }), before = structuredClone(f.raw)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] })
  f.advance(200)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 0 }] })
  assert.equal(f.runtime.snapshot().userBehaviors.wakePending, false); assert.deepEqual(f.raw, before); assert.equal(f.shared.prediction, null); assert.equal(f.counters.invalidates.filter(x => x === 'unchanged_authoritative_wake').length, 1)
  f.advance(200); assert.equal(f.counters.invalidates.filter(x => x === 'unchanged_authoritative_wake').length, 1)
})
test('unchanged wake with unknown support or body/head remains pending', t => {
  const f = scene(t), getBlock = f.host.world.getBlock
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] })
  f.host.world.getBlock = (x, y, z) => x === 0 && z === 0 && y === 64 ? { known: false } : getBlock(x, y, z)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 0 }] })
  assert.equal(f.runtime.snapshot().userBehaviors.wakePending, true); assert.equal(f.counters.invalidates.includes('unchanged_authoritative_wake'), false)
})
test('any queued producer during sleep denies unchanged wake proof', t => {
  const f = scene(t)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] }); f.unexpectedQueuedInput()
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 0 }] })
  assert.equal(f.runtime.snapshot().userBehaviors.wakePending, true); assert.equal(f.counters.invalidates.includes('unchanged_authoritative_wake'), false)
})
test('received own external motion denies unchanged wake even when the raw coordinates stayed unchanged', t => {
  const f = scene(t), before = structuredClone(f.raw.position)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] })
  f.runtime.applyPacket('motion_prediction_hints', { entity_runtime_id: 1n, velocity: { x: 0.2, y: 0, z: 0 }, on_ground: true })
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 0 }] })
  assert.equal(f.runtime.snapshot().userBehaviors.wakePending, true); assert.deepEqual(f.raw.position, before); assert.equal(f.counters.invalidates.includes('unchanged_authoritative_wake'), false)
})
test('unchanged pose from a changed life or missing own awake receipt cannot authorize stationary wake', t => {
  const f = scene(t)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] }); f.shared.deathRespawn.deathId++
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 0 }] })
  assert.equal(f.runtime.snapshot().userBehaviors.wakePending, true); assert.equal(f.counters.invalidates.includes('unchanged_authoritative_wake'), false)
})
test('a cached sleeping=false value without a verified own awake receipt cannot release unchanged wake', t => {
  const f = scene(t)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] })
  f.facadeState.sleeping = false; f.facadeState.bed.sleepReceipt = null
  f.runtime.applyPacket('set_time', { time: 1000 })
  assert.equal(f.runtime.snapshot().userBehaviors.wakePending, true); assert.equal(f.counters.invalidates.includes('unchanged_authoritative_wake'), false)
})
