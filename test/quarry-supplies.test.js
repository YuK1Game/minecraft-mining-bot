'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { serialize } = require('node:v8')
const { discoverSupplyBindings, storageSupplyExclusions, supplyNeeds, supplyScope, createQuarrySupplies } = require('../src/quarry-supplies')
const { carriedContainerKey, selectCarriedStorage } = require('../src/quarry-inventory')
const data = require('minecraft-data')('bedrock_1.26.60')
const names = new Map(data.itemsArray.map(item => [item.id, `minecraft:${item.name}`]))
const tag = (type, value) => ({ type, value })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
function raw (name, count, stack, damage = null) {
  return { ...air(), network_id: data.itemsByName[name.replace(/^minecraft:/, '')].id, count, has_stack_id: true, stack_id: stack, extra: { has_nbt: damage !== null, can_place_on: [], can_destroy: [], ...(damage === null ? {} : { nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: tag('int', damage) } } } }) } }
}
function box (slot, itemName = null, stack = 100 + slot) {
  const out = raw('undyed_shulker_box', 1, stack)
  const entries = itemName ? Array.from({ length: 27 }, (_, index) => ({ Slot: tag('byte', index), Name: tag('string', `minecraft:${itemName}`), Count: tag('byte', /pickaxe|shovel/.test(itemName) ? 1 : 64), Damage: tag('short', 0), ...(/pickaxe|shovel/.test(itemName) ? { tag: { type: 'compound', value: { Damage: tag('int', 0) } } } : {}) })) : []
  out.extra = { has_nbt: true, can_place_on: [], can_destroy: [], nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Items: tag('list', { type: 'compound', value: entries }) } } } }
  return { slot, name: 'minecraft:undyed_shulker_box', count: 1, stackId: stack, raw: out }
}
const initialBoxes = () => [...Array.from({ length: 20 }, (_, slot) => box(slot)), ...['diamond_pickaxe', 'diamond_shovel', 'bread', 'dirt'].map((name, i) => box(20 + i, name))]

function layoutBox (slot, itemName, colour) {
  const result = box(slot, itemName)
  result.name = `minecraft:${colour}_shulker_box`
  result.raw.network_id = data.itemsByName[colour + '_shulker_box'].id
  // Totems are unstackable; an invalid64 fixture would never reach discovery.
  if (itemName === 'totem_of_undying') for (const entry of result.raw.extra.nbt.nbt.value.Items.value.value) entry.Count.value = 1
  return result
}
const legacyLayout = () => [layoutBox(20, 'diamond_pickaxe', 'blue'), layoutBox(21, 'diamond_shovel', 'light_blue'), layoutBox(22, 'bread', 'yellow'), layoutBox(23, 'dirt', 'brown')]
const v22Layout = () => [layoutBox(20, 'diamond_pickaxe', 'blue'), layoutBox(21, 'diamond_shovel', 'light_blue'), layoutBox(22, 'dirt', 'brown'), layoutBox(23, 'totem_of_undying', 'yellow')]

test('supply layout regression: complete legacy supplies ignore an additional yellow totem box', () => {
  const items = [...legacyLayout(), layoutBox(24, 'totem_of_undying', 'yellow')], before = structuredClone(items)
  const result = discoverSupplyBindings(items, { resolveName: id => names.get(id), layout: 'legacy' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.bindings.map(binding => binding.role), ['pickaxe', 'shovel', 'food', 'dirt'])
  assert.deepEqual(result.bindings.map(binding => binding.key), items.slice(0, 4).map(carriedContainerKey))
  assert.deepEqual(items, before, 'discovery cannot consume or rewrite carried boxes')
})

test('supply layout regression: complete v22 supplies ignore an additional legacy bread box', () => {
  const items = [...v22Layout(), layoutBox(24, 'bread', 'yellow')], before = structuredClone(items)
  const result = discoverSupplyBindings(items, { resolveName: id => names.get(id), layout: 'v22' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.bindings.map(binding => binding.role), ['pickaxe', 'shovel', 'dirt', 'totem'])
  assert.deepEqual(result.bindings.map(binding => binding.key), items.slice(0, 4).map(carriedContainerKey))
  assert.deepEqual(items, before)
})

test('supply layout regression: a v22-only kit remains missing legacy food rather than inventing a binding', () => {
  const result = discoverSupplyBindings(v22Layout(), { resolveName: id => names.get(id), layout: 'legacy' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'SUPPLY_BOXES_UNCONFIRMED')
  assert.deepEqual(Object.keys(result.candidates), ['pickaxe', 'shovel', 'food', 'dirt'])
  assert.deepEqual(result.candidates.food, [])
  assert.equal(Object.hasOwn(result.candidates, 'totem'), false)
  assert.equal(result.bindings, undefined)
})

test('supply layout regression: dashboard chunk125 rectangle reaches real planning without world or kit mutations', () => {
  const { quarryConfig } = require('../src/dashboard-control')
  const { createQuarryJob } = require('../src/quarry-job')
  const items = [...v22Layout(), box(0)], before = structuredClone(items), layouts = []
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'bot', realm: { id: '42' }, connectionId: 'planning-only', startedAt: '2026-11-12T00:00:00Z', runtimeEntityId: '1', lifecycle: { deathId: 0 },
    dimension: 'overworld', health: 20, position: { x: 2008.5, y: 76.62, z: 2008.5 }, inventory: { known: true, items } }
  const forbidden = () => assert.fail('plan/discovery must not send world actions or stop existing work')
  let discovery
  const adapter = { getState: () => structuredClone(state), getBlock: () => ({ known: false }),
    discoverSupplies: layout => { layouts.push(layout); discovery = discoverSupplyBindings(items, { resolveName: id => names.get(id), layout }); return discovery },
    stopAll: forbidden, mine: forbidden, moveTo: forbidden, equip: forbidden, place: forbidden, restockSupplies: forbidden, entities: () => [], combatActive: () => false }
  const input = quarryConfig({ x1: 125, z1: 125, top: 75, bottom: -59 }, state)
  assert.equal(input.permissions, undefined)
  const job = createQuarryJob({ adapter, storageMode: 'shulker' }), summary = job.plan(input)
  assert.deepEqual(layouts, ['legacy'])
  assert.equal(discovery.ok, false); assert.equal(discovery.reason, 'SUPPLY_BOXES_UNCONFIRMED')
  assert.deepEqual(summary.chunks, [{ x: 125, z: 125 }])
  assert.ok(Array.isArray(summary.issues))
  assert.deepEqual(items, before)
  assert.equal(job.status().state, 'IDLE')
})

test('initial discovery separates all four full supply boxes from twenty empty output boxes without inferring unknown contents', () => {
  const items = initialBoxes(), result = discoverSupplyBindings(items, { resolveName: id => names.get(id) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.bindings.map(b => b.role), ['pickaxe', 'shovel', 'food', 'dirt'])
  const excluded = storageSupplyExclusions(result.bindings)
  assert.equal(excluded.length, 4)
  assert.ok(!excluded.includes(carriedContainerKey(items[0])))
  assert.equal(selectCarriedStorage(items, { excludedShulkerKeys: excluded }).sources[0].slot, 0)
  items[0].raw.extra = air().extra
  const unknown = discoverSupplyBindings(items, { resolveName: id => names.get(id) })
  assert.equal(unknown.ok, true)
  assert.deepEqual(unknown.unknown, [carriedContainerKey(items[0])])
  items[23].raw.extra = air().extra
  assert.equal(discoverSupplyBindings(items, { resolveName: id => names.get(id) }).reason, 'SUPPLY_BOXES_UNCONFIRMED')
  items[23] = box(23, 'dirt'); items.push(box(24, 'dirt'))
  assert.equal(discoverSupplyBindings(items, { resolveName: id => names.get(id) }).reason, 'SUPPLY_BOXES_AMBIGUOUS')
})

test('tool wear, safe food and dirt requirements distinguish exit192 from seal32 and keep their exact item-count totals', () => {
  const items = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1 }, { slot: 1, name: 'minecraft:diamond_shovel', count: 1, durabilityKnown: true, durabilityRemaining: 2 }, { slot: 2, name: 'minecraft:cooked_beef', count: 10 }, ...[3, 4, 5].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))]
  const needs = supplyNeeds(items)
  assert.deepEqual(needs.missing, { pickaxe: 1, shovel: 0, food: 54, dirt: 32 })
  assert.deepEqual(needs.returns, [{ role: 'pickaxe', slot: 0, name: 'minecraft:diamond_pickaxe', count: 1 }])
  assert.deepEqual(needs.exitDirt, { required: 192, available: 192 })
  assert.deepEqual(needs.sealDirt, { required: 32, available: 0 })
  assert.equal(supplyNeeds(items, { keepSealBlocks: 0 }).missing.dirt, 0)
})

function transferFixture ({ role = 'dirt', sourceCount = 64, stock = 0, policy = {}, worn = false } = {}) {
  const itemName = { pickaxe: 'minecraft:diamond_pickaxe', shovel: 'minecraft:diamond_shovel', food: 'minecraft:bread', dirt: 'minecraft:dirt' }[role]
  const main = Array.from({ length: 36 }, air), slots = Array.from({ length: 27 }, air)
  if (['pickaxe', 'shovel'].includes(role)) for (let i = 0; i < 26; i++) slots[i] = raw(itemName, 1, 100 + i, 0)
  else for (let i = 0; i < 27; i++) slots[i] = raw(itemName, sourceCount, 100 + i)
  if (worn) main[0] = raw(itemName, 1, 80, (role === 'pickaxe' ? 1561 : 1561) - 1)
  else if (stock) main[0] = raw(itemName, stock, 80)
  const state = { phase: 'spawned', profile: 'test', realm: { id: 'realm' }, connectionId: 'socket', startedAt: '2026-11-06T00:00:00.000Z', runtimeEntityId: '1', dimension: 'overworld', health: 20, lifecycle: { deathId: 1 }, inventory: { known: true } }
  const scope = supplyScope(state), position = { x: 1, y: 65, z: 1 }, logs = [], docs = []
  let epoch = 1, mode = null, saves = 0, failSave = null, fresh = true
  const crafting = { rawItem: slot => structuredClone(main[slot]), itemNameOf: id => names.get(id), status: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null }) }
  const window = () => ({ busy: false, contentsKnown: true, slotCount: 27, observationSource: 'server_inventory_content', window: { id: 5, epoch, replayed: false, position, scope } })
  const move = async (direction, options) => {
    logs.push({ direction, ...options })
    const playerSlot = direction === 'withdraw' ? options.targetSlot : options.sourceSlot, chestSlot = options.chestSlot, count = options.count
    const playerBefore = structuredClone(main[playerSlot]), chestBefore = structuredClone(slots[chestSlot])
    if (mode === 'unchanged') throw new Error('controlled interruption before transfer')
    const source = direction === 'withdraw' ? chestBefore : playerBefore
    const sourceCount = source.count - count, destination = direction === 'withdraw' ? playerBefore : chestBefore
    const afterSource = sourceCount ? { ...structuredClone(source), count: sourceCount } : air()
    const afterDestination = { ...structuredClone(source), count: destination.count + count, stack_id: destination.count ? destination.stack_id : 1000 + logs.length }
    if (direction === 'withdraw') { slots[chestSlot] = afterSource; main[playerSlot] = afterDestination } else { main[playerSlot] = afterSource; slots[chestSlot] = afterDestination }
    if (mode === 'changed_id') { if (slots[chestSlot].count) slots[chestSlot].stack_id++; throw new Error('controlled changed-ID interruption') }
    if (mode === 'applied') throw new Error('controlled interruption after transfer')
    const result = { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, item: itemName, count, playerSlot, chestSlot, requestId: -1 - logs.length * 2, scope, confirmedBy: 'matching_response_and_actual_inventory_slots', before: { playerCount: playerBefore.count, chestCount: chestBefore.count }, after: { playerCount: main[playerSlot].count, chestCount: slots[chestSlot].count, playerStackId: main[playerSlot].count ? main[playerSlot].stack_id : 0, chestStackId: slots[chestSlot].count ? slots[chestSlot].stack_id : 0 } }
    if (mode === 'unconfirmed') result.serverConfirmed = false
    return result
  }
  const chest = { snapshot: window, rawItem: slot => structuredClone(slots[slot]), close: () => {}, open: async () => { if (mode !== 'stale_open') epoch++; return { serverConfirmed: true, confirmedBy: 'server_container_open_and_full_content' } }, withdrawItem: options => move('withdraw', options), depositItem: options => move('return', options) }
  const controller = createQuarrySupplies({ getState: () => state, crafting, chest, refreshInventory: async () => { logs.push({ fresh: true }); if (mode === 'life_change') state.lifecycle.deathId++; return fresh }, getPortable: () => null })
  const request = { jobId: 'supplies', operationId: 'supplies:food:1', supply: { binding: { role, itemName, key: 'test' }, policy } }
  const run = (checkpoint = null, extra = {}) => controller.workWithContainer({ request, position, checkpoint }, { onCheckpoint: async cp => { saves++; if (saves === failSave) throw new Error('controlled persistence failure'); docs.push(structuredClone(cp)) }, ...extra })
  return { controller, request, main, slots, logs, docs, state, crafting, chest, run, setMode: value => { mode = value }, setFresh: value => { fresh = value }, failSave: at => { failSave = at }, setSaves: value => { saves = value } }
}

test('dirt top-up withdraws exactly224 and preserves192 exit plus32 seal dirt', async () => {
  const f = transferFixture(), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.deepEqual(f.logs.filter(l => l.direction === 'withdraw').map(l => l.count), [64, 64, 64, 32])
  assert.equal(f.main.reduce((sum, raw) => sum + raw.count, 0), 224)
  assert.equal(f.slots.reduce((sum, raw) => sum + raw.count, 0) + 224, 27 * 64)
  assert.equal(result.withdrawn.reduce((sum, row) => sum + row.count, 0), 224)
  const prior = f.logs.length, replayed = await f.run(result.checkpoint)
  assert.equal(replayed.status, 'completed')
  assert.equal(f.logs.length, prior, 'completed child replay does not withdraw more')
})

test('a worn tool goes back into the original supply box and a usable one replaces it without changing total27', async () => {
  const f = transferFixture({ role: 'pickaxe', worn: true }), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.deepEqual(f.logs.filter(l => l.direction).map(l => l.direction), ['return', 'withdraw'])
  assert.equal(f.main.filter(r => r.count > 0).length, 1)
  assert.equal(f.main.find(r => r.count).extra.nbt.nbt.value.Damage.value, 0)
  assert.equal(f.slots.reduce((sum, r) => sum + r.count, 0) + f.main.reduce((sum, r) => sum + r.count, 0), 27)
  assert.equal(f.slots.filter(r => r.extra?.nbt?.nbt?.value?.Damage?.value === 1560).length, 1)
})

test('before-only interrupted withdrawal needs fresh main and a newly opened full box before retrying', async () => {
  const f = transferFixture({ role: 'food', policy: { keepFood: 5 } })
  f.setMode('unchanged')
  const blocked = await f.run()
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.checkpoint.intent.count, 5)
  f.setMode(null)
  const result = await f.run(blocked.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.reconciliation.outcome, 'unchanged')
  assert.equal(result.withdrawn.reduce((sum, row) => sum + row.count, 0), 5)
  assert.equal(f.main[0].count, 5)
  assert.equal(f.logs.filter(row => row.fresh).length, 1)
})

test('a fresh exact applied delta is credited once without sending the withdrawal again', async () => {
  const f = transferFixture({ role: 'food', policy: { keepFood: 5 } })
  f.setMode('applied'); const blocked = await f.run()
  f.setMode(null); const result = await f.run(blocked.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.reconciliation.outcome, 'applied')
  assert.equal(result.withdrawn.reduce((sum, row) => sum + row.count, 0), 5)
  assert.equal(f.logs.filter(row => row.direction === 'withdraw').length, 1)
})

test('ambiguous IDs, failed refresh, stale reopen and life changes preserve pending intent without duplicate credit', async t => {
  for (const mode of ['changed_id', 'refresh_failed', 'stale_open', 'life_change']) await t.test(mode, async () => {
    const f = transferFixture({ role: 'food', policy: { keepFood: 5 } })
    f.setMode(mode === 'changed_id' ? 'changed_id' : 'unchanged'); const blocked = await f.run()
    f.setMode(mode === 'refresh_failed' ? null : mode); if (mode === 'refresh_failed') f.setFresh(false)
    const result = await f.run(blocked.checkpoint)
    assert.equal(result.status, 'blocked')
    assert.ok(result.checkpoint.intent)
    assert.equal(result.withdrawn.length, 0)
    assert.equal(f.logs.filter(row => row.direction).length, 1)
  })
})

test('persistence failure before a transfer sends nothing and after confirmed transfer keeps reconcilable intent', async () => {
  const before = transferFixture({ role: 'food', policy: { keepFood: 5 } })
  before.failSave(2); const blockedBefore = await before.run()
  assert.equal(blockedBefore.reason, 'SUPPLY_PERSISTENCE_FAILED'); assert.equal(before.logs.length, 0)
  const after = transferFixture({ role: 'food', policy: { keepFood: 5 } })
  after.failSave(3); const blockedAfter = await after.run()
  assert.equal(blockedAfter.reason, 'SUPPLY_PERSISTENCE_FAILED'); assert.ok(blockedAfter.checkpoint.intent)
  after.failSave(null); const result = await after.run(blockedAfter.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.withdrawn.length, 1)
  assert.equal(after.logs.filter(row => row.direction).length, 1)
})

test('capacity, exhausted tools, unknown scope and abort never create supplies or move the box', async () => {
  const capacity = transferFixture({ role: 'food', policy: { keepFood: 5 } })
  for (let slot = 0; slot < 36; slot++) capacity.main[slot] = raw('cobblestone', 64, 500 + slot)
  assert.equal((await capacity.run()).reason, 'SUPPLY_CAPACITY_REQUIRED'); assert.equal(capacity.logs.length, 0)
  const exhausted = transferFixture({ role: 'pickaxe' })
  for (let slot = 0; slot < 27; slot++) exhausted.slots[slot] = raw('diamond_pickaxe', 1, 100 + slot, 1560)
  assert.equal((await exhausted.run()).reason, 'SUPPLY_EXHAUSTED')
  const dead = transferFixture(); dead.state.lifecycle.dead = true
  assert.equal((await dead.run()).reason, 'SUPPLY_SCOPE_UNKNOWN')
  const f = transferFixture(), controller = new AbortController(); controller.abort()
  assert.equal((await f.run(null, { signal: controller.signal })).status, 'blocked'); assert.equal(f.logs.length, 0)
})

test('food is refilled only when absent and dirt waits until the dedicated192 are all that remains', () => {
  const food = { slot: 0, name: 'minecraft:bread', count: 63 }
  const dirt = [1, 2, 3].map(slot => ({ slot, name: 'minecraft:dirt', count: 64 }))
  assert.equal(supplyNeeds([food, ...dirt, { slot: 4, name: 'minecraft:dirt', count: 31 }]).required.food, false)
  assert.equal(supplyNeeds([food, ...dirt, { slot: 4, name: 'minecraft:dirt', count: 31 }]).required.dirt, false)
  assert.equal(supplyNeeds(dirt).required.food, true)
  assert.equal(supplyNeeds(dirt).required.dirt, true)
})

test('a mounted box keeps one real inventory slot available for its own recovery', async () => {
  const f = transferFixture({ role: 'food', policy: { keepFood: 64 } })
  for (let slot = 0; slot < 35; slot++) f.main[slot] = raw('cobblestone', 64, 500 + slot)
  const result = await f.run()
  assert.equal(result.reason, 'SUPPLY_RECOVERY_SLOT_REQUIRED')
  assert.equal(f.logs.length, 0)
  assert.equal(f.slots[0].count, 64)
})

function outerFixture () {
  const boxes = initialBoxes(), main = Array.from({ length: 36 }, air)
  boxes.forEach(item => { main[item.slot] = structuredClone(item.raw) })
  main[24] = raw('diamond_pickaxe', 1, 200, 0); main[25] = raw('diamond_shovel', 1, 201, 0)
  for (let slot = 26; slot < 29; slot++) main[slot] = raw('dirt', 64, 200 + slot)
  main[29] = raw('dirt', 32, 229); main[30] = raw('arrow', 64, 230)
  const bindings = discoverSupplyBindings(boxes, { resolveName: id => names.get(id) }).bindings
  const state = { phase: 'spawned', profile: 'test', realm: { id: 'realm' }, connectionId: 'socket', startedAt: '2026-11-06T00:00:00.000Z', runtimeEntityId: '1', dimension: 'overworld', health: 20, lifecycle: { deathId: 1 }, inventory: { known: true } }
  const scope = supplyScope(state), docs = [], requests = []
  let mutations = 0, response = null, badRecovery = false, failCommit = false
  const crafting = { rawItem: slot => structuredClone(main[slot]), itemNameOf: id => names.get(id), status: () => ({ authority: true, inventoryKnown: true }) }
  const chest = { snapshot: () => ({}), rawItem: () => null, open: async () => {}, close: () => {}, withdrawItem: async () => {}, depositItem: async () => {} }
  const portable = { storeCarried: async (request, { onCheckpoint }) => {
    requests.push(structuredClone(request))
    if (request.checkpoint?.stage === 'completed') return response
    assert.equal(request.purpose, 'supply'); assert.equal(request.supply.binding.role, 'food')
    assert.deepEqual(request.deposits, [])
    const source = request.selection.sources[0], original = structuredClone(main[source.slot])
    main[source.slot] = raw('bread', 64, 800)
    const recovered = structuredClone(original)
    recovered.stack_id = 900; recovered.extra.nbt.nbt.value.Items.value.value.shift()
    const slot = main.findIndex(item => item.count === 0)
    if (!badRecovery) main[slot] = recovered
    const expected = Array.from({ length: 27 }, (_, i) => i === 0 ? air() : raw('bread', 64, 1000 + i))
    const cp = { stage: 'completed', recovered: { slot, name: 'minecraft:undyed_shulker_box', stackId: 900, key: 'undyed_shulker_box:stack:900', confirmedBy: 'received_air_and_new_inventory_box_with_exact_contents' }, expectedContents: serialize(expected).toString('base64'), supplyResult: { serverConfirmed: true, withdrawn: [{ role: 'food', name: 'minecraft:bread', count: 64 }], returned: [] } }
    response = { status: 'completed', serverConfirmed: true, recovered: true, checkpoint: cp }
    mutations++; await onCheckpoint(cp)
    return response
  } }
  const controller = createQuarrySupplies({ getState: () => state, crafting, chest, refreshInventory: async () => true, getPortable: () => portable })
  const request = { jobId: 'outer', operationId: 'outer:supplies:1', bindings, policy: {} }
  const run = (checkpoint = null) => controller.run({ ...request, checkpoint }, { onCheckpoint: async cp => { if (failCommit && cp.index === 3 && cp.child === null) throw new Error('controlled binding commit failure'); docs.push(structuredClone(cp)) } })
  return { run, main, docs, requests, controller, mutations: () => mutations, badRecovery: value => { badRecovery = value }, failCommit: value => { failCommit = value } }
}

test('outer supply work updates a recovered box binding and excludes its new key from output storage', async () => {
  const f = outerFixture(), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(f.requests.length, 1)
  assert.equal(result.bindings.find(b => b.role === 'food').key, 'undyed_shulker_box:stack:900')
  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.count, 0), 64)
  assert.equal(f.main.filter(item => item.count && names.get(item.network_id) === 'minecraft:undyed_shulker_box').length, 24)
  assert.ok(storageSupplyExclusions(result.bindings).includes('undyed_shulker_box:stack:900'))
  const replay = await f.run(result.checkpoint)
  assert.equal(replay.status, 'completed')
  assert.equal(f.requests.length, 1)
})

test('outer recovery without the actual box is rejected and failed binding persistence replays the completed child once', async () => {
  const bad = outerFixture(); bad.badRecovery(true)
  const rejected = await bad.run()
  assert.equal(rejected.reason, 'SUPPLY_RECOVERY_UNCONFIRMED')
  assert.equal(rejected.withdrawn.length, 0)
  const f = outerFixture(); f.failCommit(true)
  const blocked = await f.run()
  assert.equal(blocked.reason, 'SUPPLY_PERSISTENCE_FAILED')
  assert.equal(blocked.checkpoint.child.stage, 'completed')
  assert.equal(blocked.checkpoint.index, 2)
  f.failCommit(false)
  const result = await f.run(blocked.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(f.mutations(), 1)
  assert.equal(result.withdrawn.length, 1)
})

test('when every pickaxe use is held for the exit, worn pickaxes go back and one fresh one is wanted', () => {
  const pick = (slot, left) => ({ slot, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: left, maxDurability: 1561 })
  const shovel = { slot: 4, name: 'minecraft:diamond_shovel', count: 1, durabilityKnown: true, durabilityRemaining: 1400, maxDurability: 1561 }
  const worn = [pick(3, 71), pick(13, 19), pick(14, 19), pick(32, 19), shovel]
  assert.equal(supplyNeeds(worn).missing.pickaxe, 0, 'not exhausted: nothing changes')
  assert.deepEqual(supplyNeeds(worn).returns, [])
  const counted = supplyNeeds(worn, { miningExhausted: { pickaxe: 0 } })
  assert.equal(counted.available.pickaxe, 0, 'worn tools of the exhausted kind are not counted')
  assert.deepEqual(counted.returns.map(r => r.slot), [3, 13, 14, 32], 'they are returned')
  const wanted = supplyNeeds(worn, { miningExhausted: { pickaxe: 1 } })
  assert.equal(wanted.missing.pickaxe, 1); assert.equal(wanted.required.pickaxe, true)
  assert.equal(wanted.missing.shovel, 0, 'the shovel is untouched')
  // After the restock: worn ones back in the box, one fresh pickaxe carried.
  const after = supplyNeeds([pick(5, 1561), shovel], { miningExhausted: { pickaxe: 1 } })
  assert.equal(after.missing.pickaxe, 0); assert.deepEqual(after.returns, [])
  assert.equal(supplyNeeds(worn, { miningExhausted: { pickaxe: 9 } }).desired.pickaxe, 4, 'bounded at four')
})

test('a partly used box in its supply colour still binds; an uncoloured partial box never does', () => {
  const colours = { diamond_pickaxe: 'blue', diamond_shovel: 'light_blue', bread: 'yellow', dirt: 'brown' }
  const partial = (b, keep) => { b.raw.extra.nbt.nbt.value.Items.value.value.splice(keep); return b }
  const make = () => [...Array.from({ length: 8 }, (_, slot) => box(slot)), ...Object.entries(colours).map(([name, colour], i) => ({ ...box(20 + i, name), name: `minecraft:${colour}_shulker_box` }))]
  const items = make()
  partial(items[8], 26) // one pickaxe taken from the blue box
  partial(items[11], 3) // most dirt taken from the brown box
  items[11].raw.extra.nbt.nbt.value.Items.value.value[2].Count = tag('byte', 32) // and one stack only half full
  const result = discoverSupplyBindings(items, { resolveName: id => names.get(id) })
  assert.equal(result.ok, true, JSON.stringify(result.reason))
  assert.deepEqual(result.bindings.map(b => b.role), ['pickaxe', 'shovel', 'food', 'dirt'])
  // The same partial dirt box without the supply colour is not a supply.
  const other = make(); other[11] = partial({ ...box(23, 'dirt') }, 3)
  assert.equal(discoverSupplyBindings(other, { resolveName: id => names.get(id) }).ok, false)
})
