'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn, setTimeout: sleep } = require('node:timers/promises')
const portable = require('../src/portable-worksite')
const { supplyScope } = require('../src/supply-return')
const { nextDiamondAction } = require('../src/diamond-planner')
const { resourceMinHealth } = require('../src/learning-health')
const { evaluateThreats } = require('../src/threats')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createExcavation } = require('../src/excavation')
const { createInteractions } = require('../src/interactions')
const { makeActions } = require('../src/runner')
const { createDiamondActions } = require('../src/diamond-actions')
const { buildStationaryInput } = require('../src/input')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const sample = require('./fixtures/stone-kit176-supply.json')
const copy = v => structuredClone(v), key = p => `${p.x},${p.y},${p.z}`
const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: copy(extra) })
function scene ({ kit = true, iron = 3 } = {}) {
  const state = copy(sample.state), cells = new Map(sample.local.map(b => [key(b.position), copy(b)]))
  state.entities = []; state.entityStats = { unknownPositions: 0 }; state.crafting = { openContainer: null }
  if (kit) state.inventory.items.push({ name: 'minecraft:crafting_table', count: 1, slot: 12, networkId: 777 }, { name: 'minecraft:furnace', count: 1, slot: 13, networkId: 778 })
  if (iron) state.inventory.items.push({ name: 'minecraft:raw_iron', count: iron, slot: 14, networkId: 780 })
  const world = { getBlock: (x, y, z) => copy(cells.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } }) }
  const physics = createPhysics({ world }), floors = copy(sample.floors)
  return { state, cells, world, physics, floors, site: () => portable.selectPortableWorksite({ state, world, physics, preservedFloors: floors }) }
}
function plannerFixture () {
  const filename = require.resolve('./diamond-planner.test.js'), source = fs.readFileSync(filename, 'utf8').split("test('online learning HP1")[0], loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded._compile(source + '\nmodule.exports={fixture}', filename)
  const f = loaded.exports.fixture()
  Object.assign(f.state, { profile: 'bot', realm: { id: '21225335' }, connectionId: 'kit-fixture', startedAt: '2026-11-01T00:00:00Z', lifecycle: { deathId: 1 } })
  const next = (extra = {}) => { f.observations.portableWorksite = { enabled: true, scope: supplyScope(f.state), deployed: false, ...extra }; return nextDiamondAction(f.state, f.observations) }
  return { ...f, next }
}

test('real material budget prepares furnace first, spare table last and reserves devices/fuel/sticks before iron descent', () => {
  const f = plannerFixture(); f.table(); f.items([['stone_pickaxe', 1], ['cobblestone', 24], ['oak_planks', 7], ['stick', 2]]); f.hold('stone_pickaxe'); f.preview('furnace')
  assert.equal(f.next().output, 'minecraft:furnace')
  f.items([['stone_pickaxe', 1], ['cobblestone', 16], ['oak_planks', 7], ['stick', 2], ['furnace', 1]]); f.hold('stone_pickaxe'); f.preview('crafting_table')
  assert.equal(f.next().output, 'minecraft:crafting_table')
  f.items([['stone_pickaxe', 1], ['cobblestone', 16], ['oak_planks', 3], ['stick', 2], ['furnace', 1], ['crafting_table', 1]]); f.hold('stone_pickaxe')
  const action = f.next(); assert.equal(action.resource, 'iron'); assert.ok(['prospect', 'tunnel', 'mine_ore'].includes(action.type))
  assert.equal(portable.portableKit(f.state).ready, true)
  f.state.inventory.items.find(i => i.name === 'minecraft:stick').count = 1
  assert.equal(portable.portableKit(f.state).ready, false); assert.notEqual(f.next().resource, 'iron')
  const reserve = plannerFixture(); reserve.items([['stone_pickaxe', 1], ['cobblestone', 24], ['oak_planks', 3], ['stick', 2], ['crafting_table', 1]]); reserve.hold('stone_pickaxe')
  assert.notEqual(reserve.next().type, 'place_crafting_table')
})
test('missing existing table gets a validated preparation target or bounded native continuation, not an endless scan', () => {
  const f = plannerFixture(); f.items([['stone_pickaxe', 1], ['cobblestone', 24], ['oak_planks', 3], ['stick', 2], ['crafting_table', 1]]); f.hold('stone_pickaxe')
  const world = { getBlock: (x, y, z) => f.map.get(`${x},${y},${z}`) ?? { known: false } }
  const target = portable.preparationTableTarget({ state: f.state, world, preservedFloors: [] })
  assert.ok(target)
  const prepared = f.next({ preparationTarget: target })
  assert.equal(prepared.type, 'place_crafting_table'); assert.deepEqual(prepared.target, target)
  const follow = f.next({ preparationStep: { type: 'move_to', target: { x: 1.5, y: 65, z: 0.5 }, requiresReobservation: true } })
  assert.equal(follow.type, 'move_to')
  assert.equal(f.next().type, 'capability_required', 'missing verified options are an explicit finite blocker')
})
test('actual176 terrain supports only a private projected four-cell niche, with intact reserved floor/roof and original passage', () => {
  const f = scene(), before = JSON.stringify([...f.cells]), site = f.site()
  assert.ok(site); assert.deepEqual(site.furnace, { x: -21, y: 57, z: 13 }); assert.deepEqual(site.table, { x: -21, y: 57, z: 14 })
  assert.equal(site.clearance.length, 4); assert.equal(site.reserved.length, 4)
  const passage = new Set(f.floors.flatMap(p => [0, 1, 2, 3].map(dy => key({ ...p, y: p.y + dy }))))
  assert.ok(site.clearance.every(p => !passage.has(key(p))))
  assert.equal(JSON.stringify([...f.cells]), before, 'Native projection never mutates actual received rows')
  assert.equal(site.serverConfirmed, false)
})
test('unknown/liquid/protected clearances and missing or unsafe preserved corridor cannot become a site', () => {
  for (const mode of ['unknown', 'water', 'protected']) {
    const f = scene(), c = { x: -21, y: 57, z: 12 }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const p = { x: c.x + dx, y: 57, z: c.z + dz }; f.cells.set(key(p), mode === 'unknown' ? { known: false, position: p } : { ...f.world.getBlock(p.x, p.y, p.z), ...(mode === 'water' ? { name: 'minecraft:water', boundingBox: 'empty', properties: { liquid_depth: 0 } } : { protected: true }) }) }
    assert.equal(f.site(), null, mode)
  }
  const noKit = scene({ kit: false }); assert.equal(noKit.site(), null)
  const missingFloor = scene(); missingFloor.floors.length = 0; assert.equal(missingFloor.site(), null)
})

function integration (options = {}) {
  const f = scene(), raw = new Map(Array.from({ length: 36 }, (_, i) => [i, air()])), names = new Map(), original = new Map()
  for (const item of f.state.inventory.items) { const id = item.networkId ?? 900 + item.slot; raw.set(item.slot, { ...air(), network_id: id, count: item.count, has_stack_id: true, stack_id: 100 + item.slot }); names.set(id, item.name); original.set(item.name, copy(item)) }
  const packets = [], packed = [], serverEvents = [], context = { authority: true, inventoryKnown: true, openContainer: null }
  let stamp = 0, inputRunning = false, miningPhase = 'idle', pendingMine = null, motion = { phase: 'idle' }, time = 0
  const state = () => {
    const items = [...raw].filter(([, r]) => r.count > 0).map(([slot, r]) => ({ ...(original.get(names.get(r.network_id)) ?? {}), name: names.get(r.network_id), slot, count: r.count, stackId: r.stack_id }))
    const selected = f.state.rawServerSelectedSlot ?? f.state.rawSelectedSlot ?? f.state.selectedSlot
    return { ...copy(f.state), inventory: { known: true, items }, heldItem: items.find(i => i.slot === selected) ?? null, rawServerSelectedSlot: selected, rawSelectedSlot: selected, selectedSlot: selected, crafting: copy(context), entities: copy(f.state.entities ?? []) }
  }
  const crafting = { rawItem: slot => copy(raw.get(slot)), snapshot: () => ({ ...context, inventory: state().inventory.items }), applyPacket: (name, packet) => { if (name === 'inventory_slot') raw.set(packet.slot, copy(packet.item)) }, closeContainer: () => { context.openContainer = null } }
  const input = { lookAt: () => {}, start: () => { inputRunning = true }, stop: () => { inputRunning = false }, stats: () => ({ running: inputRunning, target: null }), sendTransaction: (tx, options) => { packed.push(copy(tx)); options.onSent?.() } }
  const interactions = createInteractions({ client: { queue: (name, packet) => packets.push({ name, packet }) }, getState: state, crafting, world: f.world, getInput: () => input, timeoutMs: 1500 })
  function serverBlock (p, name, runtimeId = 300) { f.cells.set(key(p), { known: true, position: copy(p), name, runtimeId, properties: {}, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [] }); serverEvents.push({ name: 'update_block', position: p }); interactions.applyPacket('update_block', { position: p, block_runtime_id: runtimeId }) }
  function serverSlot (slot, value) { raw.set(slot, copy(value)); serverEvents.push({ name: 'inventory_slot', slot }); interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot, item: copy(value) }) }
  function nativeMove (target) {
    const physics = createPhysics({ world: f.world }), nav = createNavigator({ world: f.world, physics }), initial = physics.fromServer(state()), route = nav.plan(initial, target, { maxDistance: 4, maxExpanded: 200 })
    assert.equal(route.ready, true, route.reason)
    const stepper = nav.createStepper(route, initial, { maxTicks: 80 }); let final
    for (let i = 0; i < 80; i++) { const frame = stepper.next(); if (frame.phase === 'awaiting_server_confirmation') { final = frame.predictedState; break } assert.equal(frame.phase, 'moving') }
    assert.ok(final); f.state.position = physics.toServerPosition(final); f.state.positionSource = 'client_prediction'; f.state.positionUpdatedAt = new Date(Date.now() + ++stamp).toISOString(); f.state.predicted = { position: copy(f.state.position), physicsState: copy(final), updatedAt: f.state.positionUpdatedAt }; motion = { phase: 'awaiting_server_confirmation' }
    return { phase: 'predicted', serverConfirmed: false }
  }
  const movement = { preview: target => { const physics = createPhysics({ world: f.world }); return createNavigator({ world: f.world, physics }).plan(physics.fromServer(state()), target, { maxDistance: 4, maxExpanded: 200 }) }, start: nativeMove, stop: () => { motion = { phase: 'stopped' } } }
  const mining = { preview: () => ({ ready: true }), start: targets => { pendingMine = targets[0]; miningPhase = 'mining'; return options.holdMiningStart?.promise }, stop: () => { miningPhase = 'stopped' } }
  const excavation = createExcavation({ getState: state, world: f.world, mining, movement, getMining: () => ({ phase: miningPhase }), getMovement: () => motion, clock: () => time, delay: async ms => { time += ms; if (pendingMine) { serverBlock(pendingMine, 'minecraft:air', 0); pendingMine = null; miningPhase = 'completed' } } })
  const host = { shared: { deathRespawn: { deathId: 176 } }, world: f.world, entities: { snapshot: () => copy(f.state.entities ?? []), stats: () => ({ unknownPositions: 0 }) } }
  let mode = 'both', pendingPlacement = null
  async function place (data) {
    const item = names.get(raw.get(data.slot).network_id), pending = interactions.placeBlock(data)
    pendingPlacement = { data, item }
    if (mode !== 'none') queueMicrotask(() => { serverBlock(data.position, item, item === 'minecraft:furnace' ? 301 : 300); if (mode === 'both') queueMicrotask(() => serverSlot(data.slot, air())) })
    return pending
  }
  async function request (method, pathname, body) {
    if (method === 'GET' && pathname === '/status') return state()
    if (method === 'GET' && pathname.startsWith('/blocks?')) { const q = new URL(pathname, 'http://fake').searchParams, p = { x: Number(q.get('x')), y: Number(q.get('y')), z: Number(q.get('z')) }; return { blocks: [f.world.getBlock(p.x, p.y, p.z)] } }
    if (pathname === '/equipment/select') {
      const selected = state().rawServerSelectedSlot, source = raw.get(body.slot), previous = raw.get(selected); serverSlot(selected, source); serverSlot(body.slot, previous)
      return { phase: 'completed', serverConfirmed: true, slot: selected }
    }
    if (pathname === '/blocks/place') return place(body)
    if (pathname === '/craft/close') { context.openContainer = null; return {} }
    if (pathname === '/action' && body.group === 'interactions') {
      if (body.method === 'previewPlace') return interactions.previewPlace(body.args[0])
      if (body.method === 'placeBlock') return place(body.args[0])
      if (body.method === 'cancel') return interactions.cancel(body.args?.[0])
    }
    throw Error('Unexpected fake RPC ' + method + ' ' + pathname)
  }
  const runner = { actions: makeActions({ request, refreshState: async () => state(), getState: state, observe: async () => ({}), timeoutMs: 2000, pollIntervalMs: 1 }) }
  const diamondActions = createDiamondActions({ request, refreshState: async () => state(), getState: state, baseActions: runner.actions, timeoutMs: 2500, pollIntervalMs: 1 })
  const source = fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js'), 'utf8'), start = source.indexOf('  function portablePolicyError (' ), end = source.indexOf('  async function observeStationSupplies (', start)
  assert.ok(start >= 0 && end > start)
  const bindings = { host, observedState: state, resourceMinHealth, evaluateThreats: options.evaluateThreats ?? evaluateThreats, supplyScope, readStationPages: require('../src/supply-return').readStationPages, nextDiamondAction, planningWorld: f.world, working: state, userBehaviorOwns: () => false, recoveryMotionDepth: 0, movement, requireIdle: () => {}, excavation, runner, diamondActions, interactions, ...portable, readCurrentTunnelFloors: () => f.floors, idlePhysics: f.physics }
  if (options.selectPortableWorksite) bindings.selectPortableWorksite = options.selectPortableWorksite
  const functions = Function(...Object.keys(bindings), 'const disposed=false,disposing=false; let portableMovementLease=null,portableMovementOwner=null,portableMovementSerial=0,portableFallbackProposal=null; ' + source.slice(start, end) + ';return {portablePrimitive,portableGuard,observePortableWorksite,replaceControllers:(nextExcavation,nextInteractions)=>{excavation=nextExcavation;interactions=nextInteractions}}')(...Object.values(bindings))
  const site = portable.selectPortableWorksite({ state: state(), world: f.world, physics: f.physics, preservedFloors: f.floors }); assert.ok(site)
  host.shared.portableWorksiteMemo = { site, receipts: {} }
  return { ...f, backing: f.state, request, state, raw, names, host, site, interactions, excavation, input, packed, packets, serverEvents, serverBlock, serverSlot, nativeMove, functions, setMode: value => { mode = value }, pendingPlacement: () => pendingPlacement }
}

test('real Excavation plus real Interactions/Runner/Diamond placement controllers advance one primitive per turn only after AIR and inventory receipts', async t => {
  const f = integration(); t.after(() => f.interactions.cancel('cleanup'))
  const step = () => portable.nextPortableStep({ state: f.state(), memo: f.host.shared.portableWorksiteMemo, world: f.world })
  assert.equal(step().type, 'excavate_worksite_step')
  const a = await f.functions.portablePrimitive(step(), {}, 'excavate')
  assert.equal(a.phase, 'completed'); assert.equal(step().type, 'excavate_worksite_step')
  await f.functions.portablePrimitive(step(), {}, 'excavate')
  assert.equal(f.serverEvents.filter(e => e.name === 'update_block').length, 4)
  const back = step(); assert.equal(back.type, 'move_to'); f.nativeMove(back.target)
  const table = step(); assert.equal(table.type, 'place_worksite_block'); assert.equal(table.item, 'minecraft:crafting_table')
  f.setMode('blockOnly')
  let settled = false; const tableTask = f.functions.portablePrimitive(table, {}, 'place').finally(() => { settled = true })
  for (let i = 0; i < 8 && !f.pendingPlacement(); i++) await turn()
  assert.ok(f.pendingPlacement()); await turn(); assert.equal(settled, false)
  assert.equal(f.host.shared.portableWorksiteMemo.receipts.table, undefined)
  assert.equal(f.world.getBlock(f.site.table.x, f.site.table.y, f.site.table.z).name, 'minecraft:crafting_table')
  const selected = f.state().rawServerSelectedSlot; f.serverSlot(selected, air())
  const tableResult = await tableTask; assert.equal(tableResult.serverConfirmed, true); assert.equal(f.host.shared.portableWorksiteMemo.receipts.table.serverConfirmed, true)
  f.setMode('both'); const furnace = step(); assert.equal(furnace.item, 'minecraft:furnace')
  assert.equal(Math.hypot(f.site.furnace.x + 0.5 - f.state().position.x, f.site.furnace.z + 0.5 - f.state().position.z) < 1.3, true, 'explicit existing-controller adjacent placement is used without relaxing global picker')
  const result = await f.functions.portablePrimitive(furnace, {}, 'place')
  assert.equal(result.serverConfirmed, true); assert.equal(f.host.shared.portableWorksiteMemo.receipts.furnace.serverConfirmed, true)
  const observed = f.functions.observePortableWorksite({ state: f.state(), blocks: [...f.cells.values()] })
  assert.equal(observed.portableWorksite.deployed, true)
  assert.equal(f.host.shared.portableWorksiteMemo.deployedProof.serverConfirmed, false, 'use/return geometry remains a prediction, not an arrival receipt')
  assert.equal(portable.useRays(f.state(), f.site, f.world), true)
  for (const floor of sample.floors) assert.equal(f.world.getBlock(floor.x, floor.y, floor.z).name, sample.local.find(b => key(b.position) === key(floor)).name)
  const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
  assert.equal(f.packed.length, 2)
  for (const tx of f.packed) { const input = buildStationaryInput({ position: f.state().position, yaw: 0, pitch: 0, tick: 50n }); input.transaction = tx; input.input_data.push('item_interact'); assert.equal(parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'player_auth_input', params: input })).data.params.transaction.data.face, 1) }
  const obs = { blocks: [...f.cells.values()], portableWorksite: observed.portableWorksite, crafting: { previews: {} }, furnace: {}, ores: {}, capabilities: { equip: true, craft: true, use_table: true, open_furnace: true, prospect: true } }
  const selectedPick = f.state().inventory.items.find(i => i.name === 'minecraft:stone_pickaxe'); const state = f.state(); state.heldItem = { ...selectedPick }; state.rawSelectedSlot = state.rawServerSelectedSlot = state.selectedSlot = selectedPick.slot
  const open = nextDiamondAction(state, obs); assert.equal(open.type, 'open_furnace'); assert.deepEqual(open.target, f.site.furnace)
})
test('world identity alone cannot create own deployment receipts, while wrong life/death/danger invalidate a primitive before packets', () => {
  const f = integration(), memo = f.host.shared.portableWorksiteMemo
  f.serverBlock(f.site.table, 'minecraft:crafting_table')
  assert.equal(portable.nextPortableStep({ state: f.state(), memo, world: f.world }).code, 'portable_placement_unconfirmed')
  const state = f.state(), keys = portable.reservedWorksiteCells(memo, state)
  assert.equal(keys.length, 4); assert.equal(portable.reservedWorksiteCells(memo, { ...state, dimension: 'nether' }).length, 0)
  const changed = { ...state, lifecycle: { deathId: 999 } }
  assert.equal(portable.nextPortableStep({ state: changed, memo, world: f.world }).code, 'portable_site_changed')
  assert.equal(f.packed.length, 0)
  const baseline = f.state()
  f.backing.health = 19; assert.throws(() => f.functions.portableGuard(f.site, baseline), /再確認/)
  f.backing.health = 0; assert.throws(() => f.functions.portableGuard(f.site), /再確認/)
  f.backing.health = 20; f.host.shared.deathRespawn.deathId = 177; assert.throws(() => f.functions.portableGuard(f.site), /再確認/)
  f.host.shared.deathRespawn.deathId = 176
  f.backing.entities = [{ runtimeId: '999', uniqueId: '-999', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: f.backing.position.x + 1, y: f.backing.position.y - 1.62, z: f.backing.position.z } }]
  assert.throws(() => f.functions.portableGuard(f.site), /actor/); assert.equal(f.packed.length, 0)
})
test('no-site fallback inspects at most three actual origins and retains suppressed actors at their full radius', () => {
  let seen
  const covered = { runtimeId: 'covered-skeleton', position: { x: 100, y: 80, z: 100 }, dangerRadius: 10 }
  const f = integration({ evaluateThreats: () => ({ threats: [], outsideDanger: [], suppressedByTerrain: [covered], unknownPositions: [], requiresObservation: false }), selectPortableWorksite: args => { seen = args.avoidance; return null } })
  delete f.host.shared.portableWorksiteMemo
  let observed = f.functions.observePortableWorksite({ state: f.state(), blocks: [...f.cells.values()] })
  assert.equal(seen[0].minDistance, 10); assert.equal(seen[0].padding, 0.5)
  assert.equal(observed.portableWorksite.step.type, 'move_to')
  assert.equal(f.host.shared.portableWorksiteSearch.inspectedOrigins.length, 1)
  const searched = f.host.shared.portableWorksiteSearch
  f.host.shared.portableWorksiteSearch = { ...searched, inspectedOrigins: [searched.inspectedOrigins[0], 'inspected-stop-2', 'inspected-stop-3'] }
  observed = f.functions.observePortableWorksite({ state: f.state(), blocks: [...f.cells.values()] })
  assert.equal(observed.portableWorksite.step.type, 'capability_required')
  assert.equal(f.host.shared.portableWorksiteSearch.visitedPrefix, undefined)
  assert.equal(f.packed.length, 0)
})
test('external primitive abort cancels its real placement controller and cannot leave a false receipt or active input', async () => {
  const f = integration(); f.setMode('none')
  for (const p of f.site.clearance) f.serverBlock(p, 'minecraft:air', 0)
  const decision = portable.nextPortableStep({ state: f.state(), memo: f.host.shared.portableWorksiteMemo, world: f.world }), controller = new AbortController()
  const pending = f.functions.portablePrimitive(decision, { signal: controller.signal }, 'place').then(value => ({ value }), error => ({ error }))
  for (let i = 0; i < 10 && !f.pendingPlacement(); i++) await turn()
  assert.ok(f.pendingPlacement()); controller.abort(new Error('test owned cancellation'))
  const outcome = await pending
  assert.ok(outcome.error); assert.equal(f.input.stats().running, false)
  assert.equal(f.interactions.snapshot().pendingOperation, null)
  assert.deepEqual(f.host.shared.portableWorksiteMemo.receipts, {})
})
test('controller replacement cannot redirect outer abort or lease cleanup away from its actually started child', async () => {
  for (const kind of ['excavate', 'place']) {
    let release
    const hold = { promise: new Promise(resolve => { release = resolve }) }, f = integration({ holdMiningStart: kind === 'excavate' ? hold : undefined }), controller = new AbortController()
    let replacementStops = 0, replacementCancels = 0, oldStops = 0, oldCancels = 0
    const oldStop = f.excavation.stop, oldCancel = f.interactions.cancel
    f.excavation.stop = (...args) => { oldStops++; return oldStop(...args) }
    f.interactions.cancel = (...args) => { oldCancels++; return oldCancel(...args) }
    if (kind === 'place') { f.setMode('none'); for (const p of f.site.clearance) f.serverBlock(p, 'minecraft:air', 0) }
    const decision = portable.nextPortableStep({ state: f.state(), memo: f.host.shared.portableWorksiteMemo, world: f.world })
    const pending = f.functions.portablePrimitive(decision, { signal: controller.signal }, kind).then(value => ({ value }), error => ({ error }))
    for (let i = 0; i < 20 && (kind === 'place' ? !f.pendingPlacement() : f.excavation.snapshot().phase !== 'clearing'); i++) await turn()
    assert.ok(kind === 'place' ? f.pendingPlacement() : f.excavation.snapshot().busy)
    f.functions.replaceControllers({ stop: async () => { replacementStops++ } }, { cancel: () => { replacementCancels++ } })
    controller.abort(new Error('owned child replaced during kernel change'))
    const outcome = await pending; release()
    assert.ok(outcome.error); assert.equal(replacementStops, 0); assert.equal(replacementCancels, 0)
    if (kind === 'excavate') { assert.ok(oldStops > 0); assert.equal(f.excavation.snapshot().busy, false) }
    else { assert.ok(oldCancels > 0); assert.equal(f.interactions.snapshot().pendingOperation, null); assert.equal(f.input.stats().running, false) }
    assert.deepEqual(f.host.shared.portableWorksiteMemo.receipts, {})
  }
})
