'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const copy = value => structuredClone(value)
const immediate = () => new Promise(resolve => setImmediate(resolve))
function deferred () { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function fixture (t, { realSafety = false, wanted = false } = {}) {
  const calls = []; const packets = []; const logs = []; const safeties = []; const huts = []; const combats = []; const instances = []; const actors = []; const foodOptions = []
  const raw = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', runtimeEntityId: '41', gameMode: 'survival', health: 20, dead: false, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_move', rawSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }] }, capabilities: {} }
  raw.heldItem = copy(raw.inventory.items[0])
  const shared = { safetyWanted: wanted, autoWanted: false, loadingScreenEnded: false }
  let inventoryBusy = false; let inventoryGate = null; let openContainer = null
  const inventory = { snapshot: () => ({ busy: inventoryBusy }), applyPacket () {}, cancel: reason => { calls.push({ type: 'inventory_cancel', reason }); inventoryGate?.resolve({ serverConfirmed: false }); inventoryBusy = false }, equip: async slot => {
    calls.push({ type: 'equip', slot }); inventoryBusy = true
    try {
      const result = inventoryGate ? await inventoryGate.promise : { serverConfirmed: true }
      if (result.serverConfirmed) { const item = raw.inventory.items.find(item => item.slot === slot); if (!item) throw new Error('missing actual sword'); item.slot = raw.rawSelectedSlot; raw.heldItem = copy(item) }
      return result
    } finally { inventoryBusy = false }
  } }
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer, inventory: [], availableRecipes: [] }), rawItem: slot => slot === 0 ? { network_id: 1, count: 1, has_stack_id: true, stack_id: 32 } : { network_id: 0, count: 0 }, applyPacket () {}, preview: () => ({ ready: true }), cancel () {},
    openInventory: async () => { throw new Error('Inventory UI is unsupported by the idle Runtime fixture') },
    closeContainer: () => { calls.push({ type: 'close_gui' }); openContainer = null } }
  const host = { shared, meta: { version: '1.26.60', startGame: { current_tick: 1000n } }, apiUrl: 'http://127.0.0.1:49999', client: { queue: (name, params) => packets.push({ name, params }) }, world: {
    stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 9 }),
    getBlock: (x, y, z) => ({ known: true, name: y <= 64 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 64 ? 'block' : 'empty', properties: {}, runtimeId: y <= 64 ? 1 : 0, extra: [], position: { x, y, z } })
  }, entities: { snapshot: () => copy(actors), nearby: () => [], stats: () => ({ unknownPositions: 0 }) }, cache: { replay () {}, observe () {} }, getState: () => copy(raw), getServerState: () => copy(raw), allocate: () => -1, commitInventory () {}, setPrediction () {}, setEquipmentPrediction () {}, setCapabilities () {}, log: message => logs.push(message), noteProgress: event => calls.push({ type: 'progress', event: copy(event) }) }
  const filename = path.resolve(__dirname, '../src/runtime.js'); const nativeRequire = Module.createRequire(filename)
  const overrides = {
    './crafting': { createCrafting: () => crafting }, './inventory': { createInventory: () => inventory },
    './food': { createFood: options => { foodOptions.push(options); return { snapshot: () => ({ busy: false }), applyPacket () {}, cancel () {}, preview: () => ({ ready: false }) } }, isSupportedFood: () => false },
    './input': { createInput: () => { let running = false; return { start: () => { running = true }, stop: () => { running = false }, release () {}, stats: () => ({ running, sent: 0 }), lookAt () {}, sendAction () {}, sendTransaction () {} } } },
    './movement': { createMovement: () => { const actor = { phase: 'idle' }; return { snapshot: () => ({ phase: actor.phase }), preview: target => ({ ready: true, waypoints: [{ position: copy(target), action: 'walk', medium: 'land' }] }), start: () => { actor.phase = 'moving'; return actor }, stop: () => { actor.phase = 'stopped' }, applyPacket () {}, settle: () => ({}) } } },
    './combat': { createCombat: options => {
      const actor = { options, busy: false, engaging: false, calls: [], gate: null, cancel: [], previewReady: true }; combats.push(actor)
      return { snapshot: () => ({ busy: actor.busy, engaging: actor.engaging, defending: false }), applyPacket () {}, previewEngage: id => { actor.calls.push({ type: 'preview', id }); return { ready: actor.previewReady } }, preview: () => ({ ready: actor.strikeReady === true }), previewWaterCreeper: () => ({ ready: false }), waterCreeperAttack: async () => { throw new Error('Water counterattack is not enabled by this fixture') }, previewEmergency: (id, options) => { actor.calls.push({ type: 'emergency_preview', id, options }); return { ready: actor.emergencyReady === true, cooldownRemainingMs: 0 } }, emergencyAttack: async (id, options) => { actor.calls.push({ type: 'emergency_strike', id, options }); return { phase: 'observed', reaction: 'hurt_animation' } }, attack: async id => { actor.calls.push({ type: 'strike', id }); actors.splice(0); return { phase: 'observed' } }, engage: async (id, context) => {
        actor.calls.push({ type: 'engage', id, context }); actor.busy = actor.engaging = true
        try { if (actor.gate) return await actor.gate.promise; actors.splice(0); return { phase: 'observed', reaction: 'target_removed', serverConfirmed: true } } finally { actor.busy = actor.engaging = false }
      }, cancel: reason => { actor.cancel.push(reason); actor.gate?.resolve({ phase: 'cancelled' }); actor.busy = actor.engaging = false }, drain: async () => { if (actor.gate) await actor.gate.promise } }
    } },
    './hut': { createHut: options => {
      const actor = { busy: false, physical: { inside: false, closed: false, usable: false, serverConfirmed: false }, options, calls: [], reconciliations: 0, stops: [], gate: null }; huts.push(actor)
      return { memo: () => copy(options.memo ?? null), snapshot: () => ({ busy: actor.busy, ...copy(actor.physical) }), preview: () => ({ ready: true }), restoreMemo () {}, reconcileEmptyPlacement: () => { actor.reconciliations++; return { action: 'abandon_empty_target', serverConfirmed: false } }, execute: async (args, context) => { actor.calls.push({ args, context }); actor.busy = true; try { if (actor.gate) await actor.gate.promise; return { phase: 'completed' } } finally { actor.busy = false } }, leave: async () => ({}), stop: async reason => { actor.stops.push(reason); actor.gate?.resolve(); actor.busy = false } }
    } },
    './idle-safety': { createIdleSafety: options => {
      const actor = { options, starts: [], stops: [], running: false, busy: false, gate: null }; safeties.push(actor)
      if (realSafety) { actor.native = nativeRequire('./idle-safety').createIdleSafety(options); return actor.native }
      return { start: bounds => { actor.starts.push(bounds); actor.running = true; return { running: true } }, snapshot: () => ({ running: actor.running, busy: actor.busy, phase: actor.running ? 'observing' : 'stopped' }), stop: async reason => { actor.stops.push(reason); actor.running = false; if (actor.gate) await actor.gate.promise; actor.busy = false }, drain: async () => { if (actor.gate) await actor.gate.promise }, tick: async () => ({}) }
    } }
  }
  const target = { exports: {} }; const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
  compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  const create = () => { const runtime = target.exports.createRuntime(host); instances.push(runtime); return runtime }
  const runtime = create()
  t.after(async () => { inventoryGate?.resolve({ serverConfirmed: false }); for (const actor of [...safeties, ...combats, ...huts]) actor.gate?.resolve(); for (const instance of instances) await instance.dispose('test_cleanup') })
  const enemy = () => ({ kind: 'mob', runtimeId: '9', uniqueId: '9', entityType: 'minecraft:zombie', dimension: 'overworld', alive: true, hostile: true, positionKnown: true, position: { x: 2, y: 65, z: 0.5 } })
  return { runtime, create, host, raw, shared, actors, enemy, calls, packets, logs, safeties, combats, huts, inventory, crafting, foodOptions, delayInventory: () => { inventoryGate = deferred(); return inventoryGate } }
}

test('constructor remains passive with default disabled and remembered opt-in; explicit start and resume preserve the enable epoch', async t => {
  const f = fixture(t, { wanted: true })
  assert.equal(f.safeties[0].starts.length, 0)
  assert.equal(f.packets.length, 0)
  assert.equal(f.runtime.snapshot().safety.wanted, true)
  f.runtime.resumeRequested()
  assert.deepEqual(f.safeties[0].starts, [{ enableEpoch: 0 }])
  await f.runtime.operations.safety.stop()
  assert.equal(f.shared.safetyWanted, false)
  f.runtime.operations.safety.start()
  assert.equal(f.shared.safetyEnableEpoch, 1)
  f.runtime.operations.safety.start()
  assert.equal(f.shared.safetyEnableEpoch, 1)
  await f.runtime.dispose('reload')
  const next = f.create()
  assert.equal(f.safeties[1].starts.length, 0)
  next.resumeRequested()
  assert.deepEqual(f.safeties[1].starts, [{ enableEpoch: 1 }])
  await assert.rejects(f.runtime.operations.safety.stop('late old API'), /行動コードを更新/)
  assert.equal(f.shared.safetyWanted, true)
  assert.equal(f.packets.length, 0)
})

test('respawn handoff drains previous protection and cannot resume action planning while terrain is pending', async t => {
  const f = fixture(t, { wanted: true }); f.runtime.resumeRequested()
  const safety = f.safeties[0]; safety.gate = deferred()
  f.shared.respawnTerrain = { pending: true }
  let completed = false
  const handoff = f.runtime.onRespawn({ serverConfirmed: true, deathId: 1 }).then(() => { completed = true })
  await immediate()
  assert.equal(completed, false)
  f.runtime.resumeRequested(); f.runtime.operations.safety.start()
  assert.equal(safety.starts.length, 1)
  assert.equal(f.runtime.snapshot().safety.respawnTerrain.pending, true)
  safety.gate.resolve(); await handoff
  assert.equal(completed, true)
  assert.equal(safety.running, false)
  f.runtime.resumeRequested(); assert.equal(safety.starts.length, 1)
  f.shared.respawnTerrain.pending = false
  f.runtime.resumeRequested(); assert.equal(safety.starts.length, 2)
})

test('low-health recovery requires an explicit bounded duration and survives runtime reload without extending its deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = fixture(t)
  assert.throws(() => f.runtime.operations.safety.start({ lowHealthRecoveryMs: 60001 }), /待機時間/)
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 })
  assert.deepEqual(f.safeties[0].starts, [{ enableEpoch: 1, recoveryDeadline: 40000 }])
  assert.throws(() => f.runtime.operations.safety.start({ lowHealthRecoveryMs: 1 }), /期限/)
  await f.runtime.dispose('reload'); t.mock.timers.tick(5000)
  const next = f.create(); next.resumeRequested()
  assert.deepEqual(f.safeties[1].starts, [{ enableEpoch: 1, recoveryDeadline: 40000 }])
})

test('combat receives the same explicit threat policy used by idle protection', t => {
  const f = fixture(t)
  f.raw.health = 13
  const state = f.combats[0].options.getState()
  assert.equal(state.threatPolicy, 'balanced_mining')
  assert.equal(state.health, 13)
})

test('emergency food checks fresh known threat observations', t => {
  const f = fixture(t); const check = f.foodOptions[0].canEmergencyEat
  assert.equal(check(), true)
  f.actors.push(f.enemy()); assert.equal(check(), false)
  f.actors[0] = { ...f.enemy(), entityType: 'minecraft:creeper', position: { x: 10, y: 65, z: 0.5 } }; assert.equal(check(), false, 'nearby outside creeper can close during eating')
  f.actors[0].position.x = 17; assert.equal(check(), true, 'a distant known creeper leaves the extra margin')
  f.actors.splice(0); f.host.entities.stats = () => ({ unknownPositions: 1 }); assert.equal(check(), false)
})

test('manual work is timestamped only on accepted outside operations and safety yields to real active foreign actors', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = fixture(t); const options = f.safeties[0].options
  assert.equal(options.isIdle(), true)
  f.runtime.operations.movement.preview({ x: 0.5, y: 65, z: 0.5 })
  assert.equal(f.shared.safetyManualActionAt, 10000)
  assert.equal(options.isIdle(), false)
  assert.equal(options.isIdle({ episodeActive: true, defenseEpisode: true }), true)
  t.mock.timers.tick(501)
  f.runtime.operations.movement.start({ x: 1.5, y: 65, z: 0.5 })
  assert.equal(options.isIdle({ episodeActive: true, defenseEpisode: true }), false)
  t.mock.timers.tick(100)
  assert.throws(() => f.runtime.operations.movement.start({ x: 2.5, y: 65, z: 0.5 }), /前の操作/)
  assert.equal(f.shared.safetyManualActionAt, 10501)
  f.runtime.operations.movement.stop()
  t.mock.timers.tick(501)
  const before = f.shared.safetyManualActionAt
  await options.equipSword({ operationId: 5, signal: new AbortController().signal })
  assert.equal(f.shared.safetyManualActionAt, before)
})

test('matching ownership permits only its own confirmed equip and combat; busy safety excludes external mutation and reload', async t => {
  const f = fixture(t); const actor = f.safeties[0]; const options = actor.options; const gate = f.delayInventory()
  actor.busy = true
  const equipping = options.equipSword({ operationId: 6 })
  await Promise.resolve()
  assert.equal(options.isIdle({ operationId: 6, episodeActive: true }), true)
  assert.equal(options.isIdle({ operationId: 7, episodeActive: true }), false)
  assert.equal(f.runtime.canReload(), false)
  assert.throws(() => f.runtime.operations.movement.preview({ x: 1.5, y: 65, z: 0.5 }), /前の操作/)
  gate.resolve({ serverConfirmed: true }); assert.equal((await equipping).serverConfirmed, true)
  f.combats[0].gate = deferred()
  const fighting = options.engage('9', { operationId: 6, durationMs: 3000, maxHits: 4 })
  await Promise.resolve()
  assert.equal(options.isIdle({ operationId: 6, episodeActive: true }), true)
  assert.equal(options.isIdle({ operationId: 7, episodeActive: true }), false)
  await options.cancelOwned({ operationId: 7, reason: 'foreign' })
  assert.equal(f.combats[0].cancel.length, 0)
  await options.cancelOwned({ operationId: 6, reason: 'own' }); await fighting
  assert.deepEqual(f.combats[0].cancel, ['own'])
  assert.equal(f.combats[0].calls.at(-1).context.durationMs, 3000)
})

test('only actual inside established open Hut with two known dirt can begin immediate closure', async t => {
  const f = fixture(t); f.shared.loadingScreenEnded = true; f.shared.hutMemo = { site: { type: 'soil_hut' } }
  const options = f.safeties[0].options; const hut = f.huts[0]
  hut.physical = { inside: true, established: true, structureIntact: true, serverConfirmed: true, closed: false, usable: false }
  const dirt = { slot: 1, name: 'minecraft:dirt', count: 1 }; f.raw.inventory.items.push(dirt)
  assert.equal((await options.closeHut({ operationId: 2 })).supported, false)
  assert.equal(hut.calls.length, 0)
  dirt.count = 2
  hut.physical.pendingPlacement = { position: { x: 1, y: 65, z: 1 } }
  assert.equal((await options.closeHut({ operationId: 2 })).supported, false)
  delete hut.physical.pendingPlacement
  f.raw.inventory.known = false
  assert.equal((await options.closeHut({ operationId: 2 })).supported, false)
  f.raw.inventory.known = true
  const controller = new AbortController(); hut.gate = deferred()
  const closing = options.closeHut({ operationId: 2, signal: controller.signal })
  await Promise.resolve()
  assert.equal(options.isIdle({ operationId: 2, episodeActive: true }), true)
  assert.equal(options.isIdle({ operationId: 3, episodeActive: true }), false)
  assert.equal(hut.calls.length, 1)
  assert.equal(hut.calls[0].context.signal, controller.signal)
  hut.gate.resolve(); await closing
  hut.physical.closed = true
  assert.equal((await options.closeHut({ operationId: 2 })).supported, false)
})

test('damage preserves supervisor history while explicit stop and disposal drain owned work; old callbacks cannot act after respawn', async t => {
  const f = fixture(t); const actor = f.safeties[0]; const old = actor.options
  f.runtime.operations.safety.start(); actor.busy = true
  await f.runtime.stopActions('ダメージを検知しました。')
  assert.equal(actor.stops.length, 0)
  assert.equal(actor.running, true)
  actor.gate = deferred()
  let finished = false
  const stopping = f.runtime.stopActions('explicit stop').then(() => { finished = true })
  await Promise.resolve(); assert.equal(finished, false)
  assert.equal(f.runtime.canReload(), false)
  actor.gate.resolve(); await stopping
  await f.runtime.onSpawn()
  assert.equal(old.isCurrentGeneration(), false)
  assert.throws(() => old.getState(), /スポーン前/)
  await assert.rejects(old.engage('9', { operationId: 1 }), /スポーン前/)
  const count = f.combats[1].cancel.length
  await old.cancelOwned({ operationId: 1, reason: 'late cleanup' })
  assert.equal(f.combats[1].cancel.length, count)
  assert.equal(f.shared.safetyWanted, true)
})

test('online emergency reporting is scoped, retains protection and never waits for an HTTP disconnect', async t => {
  const f = fixture(t); const requests = []; const notices = []; const gate = deferred()
  f.host.onEmergency = details => { notices.push(details); return gate.promise }
  t.mock.method(globalThis, 'fetch', (url, options) => { requests.push({ url: String(url), options }); return Promise.resolve({ ok: true }) })
  f.runtime.operations.safety.start()
  const details = { enableEpoch: 1, reason: 'Actual idle damage cannot be defended', health: 8 }
  assert.equal(f.safeties[0].options.onEmergencyStop(details), undefined)
  assert.equal(requests.length, 0)
  assert.equal(f.runtime.canReload(), true)
  await immediate()
  assert.equal(requests.length, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].continuedOnline, true)
  assert.equal(f.shared.safetyWanted, true)
  assert.equal(f.runtime.snapshot().safety.running, true)
  assert.equal(f.safeties[0].stops.length, 0)
  assert.deepEqual(f.logs.filter(message => message.startsWith('待機保護の非常停止:')), ['待機保護の非常停止: reasonCode=IDLE_PROTECTION_UNRESOLVED health=20 phase=spawned sameScope=true'])
  assert.equal(f.shared.safetyEmergency.status, 'remaining_online')
  f.safeties[0].options.onEmergencyStop(details)
  await immediate()
  assert.equal(notices.length, 2)
  await f.runtime.dispose('explicit reload')
  const next = f.create(); next.resumeRequested()
  assert.equal(f.safeties[1].starts.length, 1)
  assert.equal(next.snapshot().safety.wanted, true)
  f.safeties[0].options.onEmergencyStop(details); await immediate()
  assert.equal(notices.length, 2, 'Disposed scope cannot report into its replacement')
  gate.resolve({ ok: false, status: 503 }); await immediate()
  assert.equal(f.shared.safetyEmergency.status, 'remaining_online')
  assert.equal('safe' in f.shared.safetyEmergency, false)
  await next.operations.safety.stop()
  f.safeties[1].options.onEmergencyStop(details); await immediate()
  assert.equal(notices.length, 2, 'Manual safety stop revokes reporting')
  assert.equal(requests.length, 0)
  assert.equal(f.logs.filter(message => message.startsWith('待機保護の非常停止:')).length, 1)
})

test('emergency log identifies a nearby hostile without exposing position or inventory', async t => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true }))
  f.actors.push(f.enemy())
  f.runtime.operations.safety.start()
  f.safeties[0].options.onEmergencyStop({ enableEpoch: 1, reason: 'Idle danger cannot be safely defended', health: 20 })
  await immediate(); await immediate()
  const line = f.logs.find(message => message.startsWith('待機保護の近傍敵:'))
  assert.match(line, /type=minecraft:zombie distance=2\.2 cover=unverified/)
  assert.doesNotMatch(line, /position|inventory|stone_sword|0\.5/)
  assert.match(f.logs.find(message => message.startsWith('待機保護の敵一覧')), /minecraft:zombie:2\.2:E/)
})

test('an emergency scheduled by an obsolete generation or revoked opt-in never disconnects a new controller', async t => {
  const f = fixture(t); const requests = []
  t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); return Promise.resolve({ ok: true }) })
  f.runtime.operations.safety.start()
  f.safeties[0].options.onEmergencyStop({ enableEpoch: 1, reason: 'test', health: 8 })
  await f.runtime.onSpawn(); await immediate()
  assert.equal(requests.length, 0)
  assert.equal(f.shared.safetyEmergency.status, 'cancelled')
  assert.equal(f.logs.some(message => message.startsWith('待機保護の非常停止:')), false)
  await f.runtime.operations.safety.stop(); f.runtime.operations.safety.start()
  assert.equal(f.shared.safetyEnableEpoch, 2)
  f.safeties[1].options.onEmergencyStop({ enableEpoch: 2, reason: 'test', health: 8 })
  await f.runtime.operations.safety.stop(); await immediate()
  assert.equal(requests.length, 0)
  assert.equal(f.shared.safetyWanted, false)
  assert.equal(f.logs.some(message => message.startsWith('待機保護の非常停止:')), false)
})

test('explicit stop or death revokes a queued emergency before the local request is sent', async t => {
  for (const reason of ['明示停止しました。', '死亡を検知しました。']) {
    const f = fixture(t); const requests = []
    t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); return Promise.resolve({ ok: true }) })
    f.runtime.operations.safety.start()
    f.safeties[0].options.onEmergencyStop({ enableEpoch: 1, reason: 'test', health: 8 })
    if (reason.includes('死亡')) { f.raw.dead = true; f.raw.health = 0 }
    await f.runtime.stopActions(reason); await immediate()
    assert.equal(requests.length, 0)
    assert.equal(f.shared.safetyEmergency.status, 'cancelled')
  }
})

test('real monitor remains passive for dead/loading then grants recovery work grace before confirmed bounded melee defense', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = fixture(t, { realSafety: true }); const safety = f.safeties[0].native
  let requests = 0
  t.mock.method(globalThis, 'fetch', () => { requests++; return Promise.resolve({ ok: true }) })
  f.raw.dead = true; f.raw.health = 0
  f.runtime.operations.safety.start(); await safety.tick()
  t.mock.timers.tick(2000); await safety.tick()
  assert.equal(safety.snapshot().phase, 'dead')
  f.raw.dead = false; f.raw.health = 20; f.shared.loadingScreenEnded = true; f.actors.push(f.enemy())
  await safety.tick()
  assert.equal(safety.snapshot().phase, 'grace')
  assert.equal(f.combats[0].calls.length, 0)
  t.mock.timers.tick(501); await safety.tick(); await immediate()
  assert.equal(f.combats[0].calls.filter(call => call.type === 'engage').length, 1)
  assert.equal(safety.snapshot().defenses, 1)
  assert.equal(f.calls.filter(call => call.type === 'equip').length, 1)
  assert.equal(requests, 0)
  assert.equal(f.packets.length, 0)
  assert.equal(f.shared.safetyManualActionAt, undefined)
})

test('real monitor uses one verified airborne strike against a close melee enemy', async t => {
  const f = fixture(t, { realSafety: true }); const safety = f.safeties[0].native
  const requests = []; t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); return Promise.resolve({ ok: true }) })
  f.shared.loadingScreenEnded = true
  f.raw.predicted = { physicsState: { onGround: false, isInWater: false, isInLava: false } }
  f.actors.push(f.enemy()); f.combats[0].strikeReady = true
  f.runtime.operations.safety.start(); await safety.tick(); await immediate()
  assert.equal(f.combats[0].calls.filter(call => call.type === 'strike').length, 1)
  assert.equal(safety.snapshot().lastResult.action, 'strike')
  assert.equal(safety.snapshot().lastResult.enemyDefeated, null)
  assert.equal(requests.length, 0)
})

test('float32 wall contact permits defense, but actual wall penetration does not', async t => {
  for (const [x, expected] of [[-32.29999923706055, true], [-32.298, false]]) {
    const f = fixture(t, { realSafety: true }); const safety = f.safeties[0].native
    t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true }))
    f.shared.loadingScreenEnded = true
    f.raw.position = { x, y: 74.62, z: 16.5 }
    f.raw.predicted = { physicsState: { onGround: true, isInWater: false, isInLava: false } }
    f.host.world.getBlock = (bx, y, z) => {
      const solid = y <= 72 || bx === -32 && y === 73
      return { known: true, name: solid ? 'minecraft:stone' : 'minecraft:air', boundingBox: solid ? 'block' : 'empty', properties: {}, runtimeId: solid ? 1 : 0, extra: [], position: { x: bx, y, z } }
    }
    f.actors.push({ ...f.enemy(), position: { x: -34, y: 73, z: 16.5 } }); f.combats[0].strikeReady = true
    f.runtime.operations.safety.start(); await safety.tick(); await immediate()
    assert.equal(f.combats[0].calls.some(call => call.type === 'strike' || call.type === 'engage'), expected, String(x))
    t.mock.reset()
  }
})

test('stationary melee support requires known harmless floor contact and a clear body', t => {
  const f = fixture(t); const options = f.safeties[0].options
  f.raw.position = { x: 0.9, y: 66.62, z: 0.5 }
  f.raw.predicted = { physicsState: { onGround: true } }
  let mode = 'partial'
  f.host.world.getBlock = (x, y, z) => {
    if (mode === 'unknown' && x === 1 && y === 64) return { known: false }
    const name = y === 64 && x === 0 && mode !== 'no_support' ? 'minecraft:stone' : y === 64 && x === 1 && mode === 'hazard' ? 'minecraft:magma' : y === 65 && x === 1 && mode === 'blocked' ? 'minecraft:stone' : 'minecraft:air'
    return { known: true, name, properties: {}, extra: [], position: { x, y, z } }
  }
  const check = () => options.verifyMeleeBody(options.getState(), {})
  assert.equal(check(), true)
  for (mode of ['unknown', 'no_support', 'hazard', 'blocked']) assert.equal(check(), false, mode)
  mode = 'partial'; f.raw.predicted.physicsState.onGround = false
  assert.equal(check(), false)
  f.raw.predicted.physicsState.onGround = true; f.raw.predicted.physicsState.isInWater = true
  assert.equal(check(), false)
})

test('runtime wires low-health emergency defense to one bounded attack and online retry', async t => {
  const f = fixture(t, { realSafety: true }); const safety = f.safeties[0].native; const requests = []; const notices = []
  f.host.onEmergency = details => notices.push(details)
  t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); return Promise.resolve({ ok: true }) })
  f.shared.loadingScreenEnded = true; f.raw.health = 9.631
  f.raw.predicted = { physicsState: { onGround: false, isInWater: false, isInLava: false } }
  f.combats[0].emergencyReady = true; f.actors.push(f.enemy())
  f.runtime.operations.safety.start(); await safety.tick(); await immediate(); await immediate()
  assert.equal(f.combats[0].calls.filter(call => call.type === 'emergency_strike').length, 1)
  assert.equal(requests.length, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].continuedOnline, true)
  assert.equal(f.shared.safetyEmergency.status, 'remaining_online')
  assert.equal(f.shared.safetyWanted, true)
  assert.equal(safety.snapshot().running, true)
  assert.equal(safety.snapshot().emergencySent, false)
  assert.equal(safety.snapshot().lastDefense.enemyDefeated, null)
})

test('runtime carries the specific distant-skeleton condition through the emergency attack', async t => {
  const f = fixture(t, { realSafety: true }); const safety = f.safeties[0].native
  t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true }))
  f.shared.loadingScreenEnded = true; f.raw.health = 10
  f.raw.predicted = { physicsState: { onGround: true, isInWater: false } }
  f.combats[0].emergencyReady = true; f.actors.push(f.enemy(), { ...f.enemy(), runtimeId: '10', uniqueId: '10', entityType: 'minecraft:skeleton', position: { x: 21, y: 65, z: 0.5 } })
  f.runtime.operations.safety.start(); await safety.tick(); await immediate(); await immediate()
  const attack = f.combats[0].calls.find(call => call.type === 'emergency_strike')
  assert.equal(attack.id, '9')
  assert.equal(attack.options.allowDistantRanged, true)
})

test('closed Hut health loss remains visible and reports locally while online protection continues', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = fixture(t, { realSafety: true }); const safety = f.safeties[0].native; const requests = []; const notices = []
  f.host.onEmergency = details => notices.push(details)
  t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); return Promise.resolve({ ok: true }) })
  f.shared.loadingScreenEnded = true; f.shared.hutMemo = { site: { type: 'soil_hut' } }
  f.huts[0].physical = { inside: true, closed: true, usable: true, established: true, structureIntact: true, serverConfirmed: true }
  f.runtime.operations.safety.start(); await safety.tick()
  assert.equal(safety.snapshot().phase, 'covered')
  f.raw.health = 17
  await f.runtime.stopActions('ダメージを検知しました。')
  await safety.tick(); await immediate(); await immediate()
  assert.equal(requests.length, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].continuedOnline, true)
  assert.equal(f.shared.safetyEmergency.health, 17)
  assert.equal(f.shared.safetyEmergency.status, 'remaining_online')
  assert.equal(f.shared.safetyWanted, true)
  assert.equal(safety.snapshot().running, true)
  assert.equal(f.combats[0].calls.some(call => call.type === 'engage'), false)
  assert.equal(f.runtime.snapshot().safety.emergencySent, false)
  assert.deepEqual(f.logs.filter(message => message.startsWith('待機保護の非常停止:')), ['待機保護の非常停止: reasonCode=DEFENSE_UNAVAILABLE health=17 phase=spawned sameScope=true'])
})

test('the explicit hut reconciliation API respects inventory, actor and generation exclusion and never silently invokes during construction', async t => {
  const f = fixture(t)
  assert.equal(f.huts[0].reconciliations, 0)
  f.shared.inventoryUncertain = { reason: 'pending server inventory' }
  assert.throws(() => f.runtime.operations.hut.reconcileEmptyPlacement(), /持ち物が未確定/)
  assert.equal(f.huts[0].reconciliations, 0)
  f.shared.inventoryUncertain = null
  f.safeties[0].busy = true
  assert.throws(() => f.runtime.operations.hut.reconcileEmptyPlacement(), /前の操作/)
  assert.equal(f.huts[0].reconciliations, 0)
  f.safeties[0].busy = false
  const result = f.runtime.operations.hut.reconcileEmptyPlacement()
  assert.deepEqual(result, { action: 'abandon_empty_target', serverConfirmed: false })
  assert.equal(f.huts[0].reconciliations, 1)
  assert.equal(f.calls.some(call => ['equip', 'close_gui'].includes(call.type)), false)
  assert.equal(f.packets.length, 0)
  await f.runtime.dispose('reload')
  assert.throws(() => f.runtime.operations.hut.reconcileEmptyPlacement(), /行動コードを更新/)
  assert.equal(f.huts[0].reconciliations, 1)
})

test('an online emergency record is marked resolved (display only) once protection is back to plain observation', async t => {
  const f = fixture(t)
  f.host.onEmergency = () => undefined
  f.runtime.operations.safety.start()
  f.safeties[0].options.onEmergencyStop({ enableEpoch: 1, reason: 'Work pause needs clearance from observed pursuers', health: 20 })
  await immediate()
  assert.equal(f.shared.safetyEmergency.status, 'remaining_online')
  const progress = f.safeties[0].options.onProgress
  for (const busy of [{ phase: 'work_clearance_pending' }, { phase: 'observing', busy: true }, { phase: 'observing', workClearancePending: true }, { phase: 'observing', active: { kind: 'escape' } }]) {
    progress({ busy: false, active: null, workClearancePending: false, ...busy })
    assert.equal(f.shared.safetyEmergency.status, 'remaining_online', JSON.stringify(busy))
  }
  progress({ phase: 'observing', busy: false, active: null, workClearancePending: false })
  assert.equal(f.shared.safetyEmergency.status, 'resolved')
  assert.equal(f.shared.safetyEmergency.reason, 'Work pause needs clearance from observed pursuers', 'the original reason is kept')
  assert.ok(f.shared.safetyEmergency.resolvedAt)
  assert.equal(f.logs.filter(line => line.includes('解決済み')).length, 1)
  progress({ phase: 'observing', busy: false, active: null, workClearancePending: false })
  assert.equal(f.logs.filter(line => line.includes('解決済み')).length, 1, 'logged once')
  await f.runtime.operations.safety.stop()
})
