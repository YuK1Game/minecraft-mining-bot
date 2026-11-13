'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createFood, isSupportedFood } = require('../src/food')
const { buildStationaryInput, createInput } = require('../src/input')
const { createCrafting } = require('../src/crafting')

const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: structuredClone(extra) })
const item = (id, count, stackId) => ({ ...air(), network_id: id, count, has_stack_id: true, stack_id: stackId })

function fixture ({ sourceSlot = 0, foodName = 'minecraft:apple', count = 3, health = 3.43, equip, canEmergencyEat = () => true } = {}) {
  let time = 1000
  const state = { phase: 'spawned', lifecycle: { deathId: 1, dead: false }, profile: 'bot', realm: { id: '42' }, startedAt: 'fixture-start', runtimeEntityId: '41', gameMode: 'survival', health, dimension: 'overworld', connectionId: 'fixture', position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, selectedSlot: 7, inventory: { known: true, items: [] } }
  const bag = new Map(Array.from({ length: 36 }, (_, slot) => [slot, air()]))
  if (count) bag.set(sourceSlot, item(300, count, 81))
  const names = new Map([[300, foodName], [301, 'minecraft:stone']])
  const context = { authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null }
  const crafting = { snapshot: () => ({ ...context, inventory: [...bag].filter(([, raw]) => raw.count).map(([slot, raw]) => ({ slot, name: names.get(raw.network_id), count: raw.count, stackId: raw.stack_id })) }), rawItem: slot => bag.has(slot) ? structuredClone(bag.get(slot)) : null, closeContainer: () => { context.openContainer = null } }
  const packets = []; const transactions = []; const commits = []; const uncertainties = []
  let running = false; let sent = 0; let allocations = 0
  const input = { start: () => { running = true; sent++ }, stop: () => { running = false }, stats: () => ({ running, sent, target: null }), sendTransaction: (transaction, options) => { transactions.push(structuredClone(transaction)); options.onSent(); sent++ } }
  const food = createFood({ client: { queue: (name, params) => packets.push({ name, params }) }, getState: () => state, crafting, getInput: () => input, equip, canEmergencyEat, allocateLegacyId: () => { allocations++; return -202 }, now: () => time,
    onInventory: packet => { commits.push(structuredClone(packet)); packet.input.forEach((raw, slot) => bag.set(slot, structuredClone(raw))) }, onUncertain: details => uncertainties.push(details)
  })
  const observeSlot = raw => { bag.set(0, structuredClone(raw)); food.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, container: null, item: raw }) }
  const observeHunger = current => food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current }] })
  const advanceHold = t => { time += 1700; sent += 33; t.mock.timers.tick(1700) }
  async function start (options) { const pending = food.eat(options); await nextTurn(); return { pending } }
  function response (id = -202, status = 'ok', responseCount = count - 1) { food.applyPacket('item_stack_response', { responses: [{ request_id: id, status, containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 0, count: responseCount, item_stack_id: responseCount ? 82 : null }] }] }] }) }
  return { state, bag, names, context, crafting, food, packets, transactions, commits, uncertainties, input, start, advanceHold, response, observeSlot, observeHunger, allocations: () => allocations }
}

test('learning chicken food requires explicit living policy and received hunger, reports real registry risk and confirms only actual consumption', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture({ foodName: 'minecraft:chicken', health: 1, count: 2 })
  assert.equal(isSupportedFood('chicken'), false)
  assert.equal(f.food.preview().ready, false)
  f.state.threatPolicy = 'online_learning'
  assert.equal(isSupportedFood('chicken', f.state), true)
  assert.equal(f.food.preview().code, 'HUNGER_UNKNOWN')
  f.observeHunger(16)
  const preview = f.food.preview()
  assert.equal(preview.ready, true); assert.equal(preview.foodRisk.nutrition, 2)
  assert.equal(preview.foodRisk.effect.name, 'hunger'); assert.equal(preview.foodRisk.effect.durationSeconds, 30)
  assert.ok(Math.abs(preview.foodRisk.effect.chance - 0.3) < 1e-6)
  const { pending } = await f.start(); f.advanceHold(t)
  assert.equal(f.bag.get(0).count, 2, 'elapsed use alone cannot spend an item or claim healing')
  f.response(-202, 'ok', 1)
  const result = await pending
  assert.equal(result.serverConfirmed, true); assert.equal(result.consumed, true); assert.equal(f.bag.get(0).count, 1)
  assert.equal(result.healthAfter, 1); assert.equal(result.healthIncreased, false)
  assert.equal(result.foodRisk.effect.durationSeconds, 30)
  assert.equal(isSupportedFood('chicken', { ...f.state, health: 0 }), false)
  assert.equal(isSupportedFood('chicken', { ...f.state, threatPolicy: 'balanced_mining' }), false)
  assert.equal(isSupportedFood('cooked_chicken'), true)
})

test('learning chicken use prefers existing safe food and cancels if the explicit policy is revoked before completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture({ foodName: 'minecraft:chicken', count: 2, equip: async () => ({ serverConfirmed: true }) })
  f.state.threatPolicy = 'online_learning'; f.observeHunger(16)
  f.names.set(302, 'minecraft:cooked_chicken'); f.bag.set(1, item(302, 1, 82))
  assert.equal(f.food.preview().name, 'minecraft:cooked_chicken')
  f.bag.set(1, air())
  const { pending } = await f.start(), rejected = assert.rejects(pending, /学習方針/)
  f.state.threatPolicy = 'balanced_mining'; t.mock.timers.tick(50); await rejected
  assert.equal(f.bag.get(0).count, 2); assert.equal(f.transactions.length, 1)
})

test('no food is an explicit acquisition capability and unhealthy/dead or invented stacks cannot start use', async () => {
  const empty = fixture({ count: 0 })
  assert.equal(empty.food.preview().capability, 'food_acquisition')
  await assert.rejects(empty.food.eat(), error => error.code === 'FOOD_NOT_IN_INVENTORY')
  assert.equal(empty.allocations(), 0)
  assert.equal(empty.transactions.length, 0)
  for (const foodName of ['minecraft:rotten_flesh', 'minecraft:poisonous_potato', 'minecraft:pufferfish', 'minecraft:stone']) assert.equal(fixture({ foodName }).food.preview().ready, false)
  assert.equal(isSupportedFood('cooked_beef'), true)
  const invalid = fixture()
  invalid.bag.get(0).stack_id = 0
  assert.equal(invalid.food.preview().ready, false)
  assert.equal(fixture({ health: 0 }).food.preview().ready, false)
})

test('rotten flesh at thirteen HP requires explicit permission, received hunger and no safer food', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let safe = true
  const f = fixture({ foodName: 'minecraft:rotten_flesh', count: 2, health: 13, canEmergencyEat: () => safe })
  assert.equal(isSupportedFood('rotten_flesh'), false)
  assert.equal(f.food.preview({ allowEmergencyRotten: true }).ready, false, 'unknown hunger')
  f.food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current: 16 }] })
  assert.equal(f.food.preview().ready, false)
  assert.equal(f.food.preview({ allowEmergencyRotten: true }).ready, true)
  f.state.health = 20; assert.equal(f.food.preview({ allowEmergencyRotten: true }).ready, true); f.state.health = 13
  safe = false; assert.equal(f.food.preview({ allowEmergencyRotten: true }).ready, false); safe = true
  f.names.set(302, 'minecraft:apple'); f.bag.set(1, item(302, 1, 83))
  assert.equal(f.food.preview({ slot: 0, allowEmergencyRotten: true }).ready, false)
  f.bag.set(1, air())
  const { pending } = await f.start({ allowEmergencyRotten: true })
  f.advanceHold(t); f.response(-202, 'ok', 1)
  const result = await pending
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.bag.get(0).count, 1)
  assert.equal(result.count, 1)
  assert.equal(result.healthBefore, 13)
  assert.equal(result.healthAfter, 13)
  assert.equal(result.healthIncreased, false)
  assert.equal(f.uncertainties.length, 0)
})

test('emergency rotten flesh cancels if the safe observation changes during use', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let safe = true
  const f = fixture({ foodName: 'minecraft:rotten_flesh', count: 1, health: 10, canEmergencyEat: () => safe })
  f.food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current: 17 }] })
  const { pending } = await f.start({ allowEmergencyRotten: true }); const rejected = assert.rejects(pending)
  safe = false; t.mock.timers.tick(50); await rejected
  assert.equal(f.transactions.length, 1)
  assert.equal(f.uncertainties.length, 1)
})

test('emergency food forwards the scoped permission during a real-slot equip', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let f; let received
  f = fixture({ foodName: 'minecraft:rotten_flesh', sourceSlot: 14, count: 1, health: 10, equip: async (slot, options) => {
    received = { slot, options }; const source = f.bag.get(slot); const old = f.bag.get(0); f.bag.set(0, source); f.bag.set(slot, old)
    return { serverConfirmed: true }
  } })
  f.food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current: 17 }] })
  const { pending } = await f.start({ allowEmergencyRotten: true })
  assert.deepEqual(received, { slot: 14, options: { allowEmergencyRotten: true } })
  f.advanceHold(t); f.response(-202, 'ok', 0)
  assert.equal((await pending).serverConfirmed, true)
})

test('use holds normal input then sends a schema-valid completion air-use and requires matching server consumption', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture()
  const { pending } = await f.start()
  assert.equal(f.transactions.length, 1)
  assert.equal(f.transactions[0].data.action_type, 'click_air')
  assert.equal(f.transactions[0].legacy.legacy_request_id, 0)
  assert.equal(f.food.snapshot().busy, true)
  f.advanceHold(t)
  assert.equal(f.transactions.length, 2)
  const second = f.transactions[1]
  assert.equal(second.legacy.legacy_request_id, -202)
  assert.equal(second.data.trigger_type, 'simulation_tick')
  assert.equal(second.data.hotbar_slot, 0)
  assert.equal(second.data.held_item.stack_id, 81)
  assert.equal(f.bag.get(0).count, 3)
  const packet = buildStationaryInput({ position: f.state.position, pitch: 0, yaw: 0, tick: 1n })
  packet.transaction = second; packet.input_data = ['item_interact']
  const serializer = createSerializer('1.26.60'); const parser = createDeserializer('1.26.60')
  const actual = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'player_auth_input', params: packet })).data.params.transaction
  assert.equal(actual.actions[0].new_item.count, 2)
  assert.equal(f.commits.length, 0)
  f.state.health = 4
  f.food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 4 }] })
  assert.equal(f.food.snapshot().busy, true, 'health or time alone cannot prove eating')
  f.response()
  const result = await pending
  assert.equal(result.consumed, true)
  assert.equal(result.count, 1)
  assert.equal(result.healthIncreased, true)
  assert.equal(f.bag.get(0).count, 2)
  assert.equal(f.bag.get(0).stack_id, 82)
  const released = parser.parsePacketBuffer(serializer.createPacketBuffer(f.packets.at(-1))).data.params.transaction
  assert.equal(released.transaction_type, 'item_release')
  assert.equal(released.transaction_data.action_type, 'release')
  assert.equal(f.uncertainties.length, 0)
})

test('fresh real slot consumption plus CompletedUsingItem is an alternative acknowledgement, not animation or health', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture({ count: 1 })
  const { pending } = await f.start()
  f.advanceHold(t)
  f.observeSlot(air())
  assert.equal(f.food.snapshot().busy, true)
  f.food.applyPacket('completed_using_item', { used_item_id: 301, use_method: 'eat' })
  assert.equal(f.food.snapshot().busy, true)
  f.food.applyPacket('entity_event', { runtime_entity_id: 41n, event_id: 'eating_item' })
  assert.equal(f.food.snapshot().busy, true)
  f.food.applyPacket('completed_using_item', { item_id: 300, use_method: 'eat' })
  assert.equal(f.food.snapshot().busy, true, 'the nonexistent 1.26.60 field cannot acknowledge use')
  const serializer = createSerializer('1.26.60'); const parser = createDeserializer('1.26.60')
  const actual = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'completed_using_item', params: { used_item_id: 300, use_method: 'eat' } })).data.params
  assert.equal(actual.used_item_id, 300)
  assert.equal(actual.item_id, undefined)
  f.food.applyPacket('completed_using_item', actual)
  const result = await pending
  assert.equal(result.confirmedBy, 'completed_using_item_and_server_inventory')
  assert.equal(result.healthIncreased, false)
  assert.equal(f.commits.length, 0, 'an actual inventory packet needs no fabricated commit')
})

test('fresh own hunger increase and exactly one received food decrement confirm either packet order before or after completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  for (const completionSent of [false, true]) for (const hungerFirst of [false, true]) for (const fullInventory of [false, true]) {
    const count = fullInventory ? 1 : 2
    const f = fixture({ foodName: 'minecraft:porkchop', count })
    f.observeHunger(16)
    const { pending } = await f.start()
    if (completionSent) f.advanceHold(t)
    const consume = () => {
      const raw = count === 1 ? air() : item(300, count - 1, 92)
      if (!fullInventory) return f.observeSlot(raw)
      f.bag.set(0, raw)
      f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [...f.bag.values()], container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() })
    }
    if (hungerFirst) f.observeHunger(19); else consume()
    assert.equal(f.food.snapshot().busy, true, 'either observation alone is insufficient')
    if (hungerFirst) consume(); else f.observeHunger(19)
    const result = await pending
    assert.equal(result.serverConfirmed, true)
    assert.equal(result.confirmedBy, 'server_hunger_increase_and_inventory_consumption')
    assert.equal(result.count, 1)
    assert.equal(result.healthIncreased, false)
    assert.equal(f.bag.get(0).count, count - 1)
    assert.equal(f.transactions.length, completionSent ? 2 : 1)
    assert.equal(f.commits.length, 0, 'received consumption needs no additional decrement')
    assert.equal(f.uncertainties.length, 0)
  }
})

test('hunger confirmation requires fresh own selected inventory evidence and rejects cached, shadow, wrong item and non-consumption receipts', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  for (const mode of ['missing_inventory', 'cached_inventory', 'other_slot', 'shadow', 'wrong_window', 'wrong_item', 'changed_identity', 'no_decrement', 'two_decrements', 'partial_full', 'missing_hunger', 'other_hunger', 'same_hunger', 'decreased_hunger', 'unknown_baseline', 'old_hunger']) {
    const f = fixture({ count: 3 })
    if (mode !== 'unknown_baseline') f.observeHunger(16)
    if (mode === 'old_hunger') f.observeHunger(19)
    const { pending } = await f.start()
    const rejected = assert.rejects(pending, /確認できません/)
    const raw = mode === 'wrong_item' ? item(301, 2, 92) : mode === 'no_decrement' ? item(300, 3, 81) : mode === 'two_decrements' ? item(300, 1, 92) : mode === 'changed_identity' ? { ...item(300, 2, 92), metadata: 1 } : item(300, 2, 92)
    if (mode !== 'missing_inventory') {
      f.bag.set(0, raw)
      if (mode === 'partial_full') f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [raw] })
      else if (mode !== 'cached_inventory') f.food.applyPacket('inventory_slot', { window_id: mode === 'wrong_window' ? 'offhand' : 'inventory', slot: mode === 'other_slot' ? 1 : 0, item: raw, container: mode === 'shadow' ? { container_id: 'inventory', dynamic_container_id: 23 } : null })
    }
    if (mode === 'other_hunger') f.food.applyPacket('update_attributes', { runtime_entity_id: 42n, attributes: [{ name: 'minecraft:player.hunger', current: 19 }] })
    else if (mode !== 'missing_hunger' && mode !== 'old_hunger') f.observeHunger(mode === 'same_hunger' ? 16 : mode === 'decreased_hunger' ? 15 : 19)
    assert.equal(f.food.snapshot().busy, true, mode)
    t.mock.timers.tick(12000)
    await rejected
    assert.equal(f.food.snapshot().lastResult.phase, 'failed', mode)
    assert.equal(f.commits.length, 0, mode)
  }
})

test('production Food, Crafting and Input drop an unsent completion when received consumption proves the meal', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture({ count: 2, health: 8 })
  f.state.rotation = { pitch: 0, yaw: 0 }
  let clock = 1000
  const packets = []; const commits = []
  const client = { queue: (name, params) => packets.push({ name, params: structuredClone(params) }) }
  const crafting = createCrafting({ client, getState: () => f.state })
  const serializer = createSerializer('1.26.60'); const parser = createDeserializer('1.26.60')
  const wire = (name, params) => parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
  crafting.applyPacket('start_game', { server_authoritative_inventory: true, itemstates: [{ runtime_id: 300, name: 'minecraft:porkchop' }] })
  crafting.applyPacket('inventory_content', wire('inventory_content', { window_id: 'inventory', input: [...f.bag.values()], container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() }))
  const input = createInput({ client, getState: () => f.state, version: '1.26.60', startGame: { server_authoritative_block_breaking: true, player_gamemode: 'survival', current_tick: 10n }, clock: () => clock })
  const food = createFood({ client, getState: () => f.state, crafting, getInput: () => input, allocateLegacyId: () => -202, now: () => clock, onInventory: packet => commits.push(packet) })
  const hunger = current => food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current }] })
  const consume = () => {
    const packet = wire('inventory_slot', { window_id: 'inventory', slot: 0, container: null, storage_item: null, item: item(300, 1, 92) })
    crafting.applyPacket('inventory_slot', packet)
    food.applyPacket('inventory_slot', packet)
    hunger(19)
  }
  const queue = input.sendTransaction
  let completionQueued = false
  input.sendTransaction = (transaction, options) => {
    queue(transaction, options)
    if (transaction.legacy.legacy_request_id === -202) { completionQueued = true; consume() }
  }
  hunger(16)
  const pending = food.eat()
  for (let tick = 0; tick < 36 && !completionQueued; tick++) { clock += 50; t.mock.timers.tick(50) }
  const result = await pending
  assert.equal(completionQueued, true)
  assert.equal(result.confirmedBy, 'server_hunger_increase_and_inventory_consumption')
  assert.equal(result.healthIncreased, false)
  assert.equal(crafting.rawItem(0).count, 1)
  assert.equal(commits.length, 0)
  assert.equal(input.stats().running, false)
  const sentUses = packets.filter(packet => packet.name === 'player_auth_input' && packet.params.transaction)
  assert.equal(sentUses.length, 1, 'the queued stale completion never reaches the wire')
  assert.equal(sentUses[0].params.transaction.legacy.legacy_request_id, 0)
})

test('pre-wire inventory and hunger receipts cannot confirm a queued start', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture({ count: 2 })
  f.observeHunger(16)
  let onSent
  f.input.sendTransaction = (transaction, options) => { onSent = options.onSent }
  const { pending } = await f.start()
  const rejected = assert.rejects(pending, /確認できません/)
  f.observeSlot(item(300, 1, 92)); f.observeHunger(19)
  assert.equal(f.food.snapshot().busy, true)
  onSent()
  f.food.applyPacket('completed_using_item', { used_item_id: 300, use_method: 'eat' })
  t.mock.timers.tick(12000)
  await rejected
  assert.equal(f.food.snapshot().lastResult.phase, 'failed')
})

test('food must be moved by a confirmed inventory swap before air-use; requested equipment is insufficient', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const unsupported = fixture({ sourceSlot: 14 })
  assert.equal(unsupported.food.preview().capability, 'inventory_operations')
  const rejected = fixture({ sourceSlot: 14, equip: async () => ({ phase: 'requested', serverConfirmed: false }) })
  await assert.rejects(rejected.food.eat(), /未確定/)
  assert.equal(rejected.transactions.length, 0)
  const f = fixture({ sourceSlot: 14 })
  // Construct a callback-backed module using the same actual observed bag.
  const module = createFood({ client: { queue () {} }, getState: () => f.state, crafting: f.crafting, getInput: () => f.input, allocateLegacyId: () => -204,
    equip: async slot => { assert.equal(slot, 14); const source = f.bag.get(14); f.bag.set(14, f.bag.get(0)); f.bag.set(0, { ...source, stack_id: 91 }); return { phase: 'completed', serverConfirmed: true, slot: 0 } }
  })
  const pending = module.eat({ slot: 14 })
  await nextTurn()
  assert.equal(f.transactions[0].data.hotbar_slot, 0)
  assert.equal(f.transactions[0].data.held_item.stack_id, 91)
  module.cancel('test cleanup')
  await assert.rejects(pending)
})

test('sent timeout, cancellation and death fail closed; rejection and unsent failures do not fake inventory changes', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const timed = fixture()
  const { pending: timeout } = await timed.start()
  t.mock.timers.tick(12000)
  await assert.rejects(timeout, /確認できません/)
  assert.equal(timed.uncertainties.length, 1)
  assert.equal(timed.food.snapshot().inventoryUncertain, true)
  const refused = fixture()
  const { pending: refusal } = await refused.start()
  refused.advanceHold(t)
  refused.response(-202, 'error')
  await assert.rejects(refusal, /拒否/)
  assert.equal(refused.uncertainties.length, 0)
  assert.equal(refused.bag.get(0).count, 3)
  const dead = fixture()
  const { pending: death } = await dead.start()
  dead.state.health = 0
  dead.food.applyPacket('set_health', { health: 0 })
  await assert.rejects(death)
  assert.equal(dead.uncertainties.length, 1)
  assert.equal(dead.packets.length, 0, 'no release is sent after death')
  const unsent = fixture()
  unsent.input.sendTransaction = () => { throw new Error('invalid transaction') }
  await assert.rejects(unsent.food.eat(), /invalid transaction/)
  assert.equal(unsent.uncertainties.length, 0)
})

test('a fresh complete inventory after the last use keeps inventory known without claiming consumption', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture({ count: 1 })
  const { pending } = await f.start()
  f.bag.set(0, air())
  f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [...f.bag.values()] })
  t.mock.timers.tick(12000)
  await assert.rejects(pending, /確認できません/)
  assert.equal(f.uncertainties.length, 0)
  assert.equal(f.food.snapshot().inventoryUncertain, false)
  assert.equal(f.food.snapshot().lastResult.phase, 'failed')
  assert.equal(f.packets.length, 0, 'no late release using an empty hand')
})

test('slot-only or older complete inventory cannot clear uncertainty after a later use', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  for (const mode of ['slot_only', 'old_full', 'later_use', 'partial_full']) {
    const f = fixture({ count: 1 })
    if (mode === 'old_full') f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [...f.bag.values()] })
    const { pending } = await f.start()
    if (mode === 'later_use') {
      f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [...f.bag.values()] })
      f.advanceHold(t)
    }
    f.observeSlot(air())
    if (mode === 'partial_full') f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [air()] })
    t.mock.timers.tick(12000)
    await assert.rejects(pending)
    assert.equal(f.uncertainties.length, 1, mode)
  }
})

test('known full hunger refuses ordinary food and a changed raw selection cancels without using another item', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture()
  f.food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current: 20 }] })
  assert.equal(f.food.preview().code, 'HUNGER_FULL')
  const selected = fixture()
  const { pending } = await selected.start()
  selected.state.rawSelectedSlot = 1
  selected.food.applyPacket('player_hotbar', { selected_slot: 1, window_id: 'inventory' })
  await assert.rejects(pending, /選択/)
  assert.equal(selected.transactions.length, 1)
  assert.equal(selected.packets.length, 0)
})

test('holding duration without sent input ticks, unrelated responses and partial acceptance cannot prove consumption', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture()
  const { pending } = await f.start()
  t.mock.timers.tick(2000)
  assert.equal(f.transactions.length, 1, 'elapsed wall time alone cannot complete the held input')
  f.advanceHold(t)
  f.response(-204)
  assert.equal(f.food.snapshot().busy, true)
  f.food.applyPacket('item_stack_response', { responses: [{ request_id: -202, status: 'ok', containers: [] }] })
  assert.equal(f.food.snapshot().busy, true)
  assert.equal(f.bag.get(0).count, 3)
  f.observeSlot(item(300, 2, 93))
  const result = await pending
  assert.equal(result.confirmedBy, 'matching_response_and_server_inventory')
  assert.equal(f.commits.length, 0)
  const invalid = fixture()
  invalid.bag.set(35, { ...air(), has_stack_id: true, stack_id: 99 })
  assert.equal(invalid.food.preview().ready, false)
})

// Live 2026-11-14 03:55-04:00: a meal interrupted by combat left the food
// module uncertain; 15 full server inventories arrived but did not match the
// local slots exactly, every meal failed and the bot died. A complete received
// main inventory with no sent use unresolved clears it.
test('a fresh full server inventory clears the meal uncertainty even when slots differ from the local copy', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let safe = true
  const f = fixture({ foodName: 'minecraft:rotten_flesh', count: 1, health: 10, canEmergencyEat: () => safe })
  f.food.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:player.hunger', current: 17 }] })
  const { pending } = await f.start({ allowEmergencyRotten: true }); const rejected = assert.rejects(pending)
  safe = false; t.mock.timers.tick(50); await rejected
  assert.equal(f.uncertainties.length, 1)
  safe = true
  assert.equal(f.food.preview({ allowEmergencyRotten: true }).code, 'INVENTORY_UNKNOWN')
  const fresh = [...f.bag.values()].map(raw => ({ ...structuredClone(raw), stack_id: raw.count ? (raw.stack_id ?? 0) + 1000 : raw.stack_id }))
  f.food.applyPacket('inventory_content', { window_id: 'inventory', input: fresh, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() })
  assert.notEqual(f.food.preview({ allowEmergencyRotten: true }).code, 'INVENTORY_UNKNOWN')
})
