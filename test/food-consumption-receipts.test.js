'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createFood } = require('../src/food')
const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
const wire = (name, params) => parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const item = (count, stack = 81) => ({ ...air(), network_id: 300, count, has_stack_id: true, stack_id: stack })
const decoded = raw => wire('inventory_slot', { window_id: 'inventory', slot: 0, item: raw, container: null, storage_item: null }).item
function fixture (t, count = 2) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, startedAt: 'one-start', runtimeEntityId: '41', connectionId: 'same-session', lifecycle: { deathId: 132, dead: false }, dimension: 'overworld', gameMode: 'survival', health: 4, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerSelectedSlot: 0, inventory: { known: true, uncertain: false } }
  const bag = Array.from({ length: 36 }, () => decoded(air())); bag[0] = decoded(item(count))
  const transactions = [], packets = [], uncertainty = [], commits = []
  let running = false, sent = 0, time = 1000
  const input = { start () { running = true; sent++ }, stop () { running = false }, stats: () => ({ running, sent, target: null }), sendTransaction (tx, options) { transactions.push(structuredClone(tx)); options.onSent(); sent++ } }
  const crafting = { rawItem: slot => structuredClone(bag[slot]), snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, inventory: bag.flatMap((raw, slot) => raw.count ? [{ name: 'minecraft:apple', slot, count: raw.count, stackId: raw.stack_id }] : []) }) }
  const food = createFood({ client: { queue: (name, params) => packets.push({ name, params }) }, getState: () => state, crafting, getInput: () => input, allocateLegacyId: () => -26, now: () => time, onUncertain: e => uncertainty.push(e), onInventory: p => commits.push(p) })
  const hunger = (current, runtime = 41n) => food.applyPacket('update_attributes', wire('update_attributes', { runtime_entity_id: runtime, tick: 1n, attributes: [{ min: 0, max: 20, current, default_min: 0, default_max: 20, default: 20, name: 'minecraft:player.hunger', modifiers: [] }] }))
  const slot = (raw, options = {}) => {
    const packet = wire('inventory_slot', { window_id: options.window ?? 'inventory', slot: options.slot ?? 0, container: options.container ?? null, storage_item: null, item: raw })
    if (options.cache !== false) bag[0] = structuredClone(options.canonicalEmpty && !packet.item.count ? air() : packet.item)
    food.applyPacket('inventory_slot', packet)
  }
  const ack = id => food.applyPacket('completed_using_item', wire('completed_using_item', { used_item_id: id ?? 300, use_method: 'eat' }))
  async function start () { const pending = food.eat(); const outcome = pending.then(value => ({ value }), error => ({ error })); await nextTurn(); return outcome }
  async function close (outcome) { if (food.snapshot().busy) food.cancel('fixture cleanup'); return outcome }
  const tick = ms => { time += ms; t.mock.timers.tick(ms) }
  return { state, bag, food, transactions, packets, uncertainty, commits, hunger, slot, ack, start, close, tick }
}

test('latched wire hunger increase survives later natural hunger fall before exact received decrement', async t => {
  const f = fixture(t); f.hunger(16); const pending = f.start(); await nextTurn()
  f.hunger(18); f.hunger(16); f.slot(item(1, 82))
  const completed = f.food.snapshot().lastResult?.phase === 'completed'
  const outcome = await f.close(pending)
  assert.equal(completed, true, 'actual earlier hunger increase must remain an acknowledgement')
  assert.equal(outcome.value.confirmedBy, 'server_hunger_increase_and_inventory_consumption')
  assert.equal(f.transactions.length, 1, 'receipt during holding prevents stale completion')
  assert.equal(f.commits.length, 0); assert.equal(f.uncertainty.length, 0)
})

test('real ItemV4 no-NBT AIR equals only its otherwise identical cached canonical AIR', async t => {
  const f = fixture(t, 1); f.hunger(16); const pending = f.start(); await nextTurn()
  assert.equal(decoded(air()).extra.has_nbt, 0)
  f.slot(air(), { canonicalEmpty: true }); f.ack()
  const completed = f.food.snapshot().lastResult?.phase === 'completed'
  const outcome = await f.close(pending)
  assert.equal(completed, true, 'numeric no-NBT marker is the same valid empty slot')
  assert.equal(outcome.value.confirmedBy, 'completed_using_item_and_server_inventory')
  assert.equal(f.transactions.length, 1); assert.equal(f.packets.length, 0); assert.equal(f.commits.length, 0)
})

test('actual decoded use acknowledgement and inventory work in either early order without duplicate use or credit', async t => {
  const f = fixture(t, 1); f.hunger(16); const pending = f.start(); await nextTurn()
  f.ack(); assert.equal(f.food.snapshot().busy, true)
  f.slot(air()); f.ack(); f.slot(air()); const outcome = await pending
  assert.equal(outcome.value.consumed, true); assert.equal(outcome.value.count, 1)
  assert.equal(outcome.value.healthAfter, 4); assert.equal(f.transactions.length, 1)
  assert.equal(f.commits.length, 0); assert.equal(f.uncertainty.length, 0)
})

for (const mode of ['health_only', 'no_ack', 'no_slot', 'wrong_self', 'wrong_item_ack', 'wrong_window', 'wrong_slot', 'shadow', 'wrong_item', 'changed_metadata', 'changed_nbt', 'same_count', 'two_decrements', 'missing_stack', 'cache_only']) test('receipt cannot consume from ' + mode, async t => {
  const f = fixture(t, 3); f.hunger(16); const pending = f.start(); await nextTurn()
  f.state.health = 6
  const raw = mode === 'same_count' ? item(3) : mode === 'two_decrements' ? item(1, 82) : item(2, 82)
  if (mode === 'wrong_item') raw.network_id = 301
  if (mode === 'changed_metadata') raw.metadata = 3
  if (mode === 'changed_nbt') raw.extra = { ...raw.extra, has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { food_marker: { type: 'int', value: 1 } } } } }
  if (mode === 'missing_stack') raw.has_stack_id = false
  if (!['health_only', 'no_slot'].includes(mode)) {
    if (mode === 'cache_only') f.bag[0] = decoded(raw)
    else f.slot(raw, { window: mode === 'wrong_window' ? 'offhand' : 'inventory', slot: mode === 'wrong_slot' ? 1 : 0, container: mode === 'shadow' ? { container_id: 'inventory', dynamic_container_id: 23 } : null })
  }
  if (mode === 'wrong_self') f.hunger(18, 42n)
  else if (mode === 'wrong_item_ack') f.ack(301)
  else if (!['health_only', 'no_ack'].includes(mode)) f.hunger(18)
  assert.equal(f.food.snapshot().busy, true)
  const outcome = await f.close(pending)
  assert.ok(outcome.error); assert.equal(f.commits.length, 0); assert.equal(f.food.snapshot().lastResult.phase, 'failed')
})

for (const field of ['profile', 'connectionId', 'runtimeEntityId', 'dimension', 'life']) test('unknown ' + field + ' cannot start an unsafe use', async t => {
  const f = fixture(t)
  if (field === 'life') f.state.lifecycle.deathId = null; else f.state[field] = null
  assert.equal(f.food.preview().code, 'SESSION_UNKNOWN')
  await assert.rejects(f.food.eat(), error => error.code === 'SESSION_UNKNOWN')
  assert.equal(f.transactions.length, 0); assert.equal(f.uncertainty.length, 0)
})

for (const field of ['profile', 'connectionId', 'runtimeEntityId', 'dimension', 'life', 'death', 'spawnPending']) test('a changed ' + field + ' cannot complete an old operation or release into a new life', async t => {
  const f = fixture(t, 1); f.hunger(16); const pending = f.start(); await nextTurn()
  if (field === 'life') f.state.lifecycle.deathId++
  else if (field === 'death') { f.state.health = 0; f.state.lifecycle.dead = true }
  else if (field === 'spawnPending') f.state.spawnPending = true
  else f.state[field] = 'different'
  f.slot(air()); f.ack(); f.hunger(18)
  const outcome = await pending
  assert.ok(outcome.error); assert.equal(f.food.snapshot().lastResult.phase, 'failed')
  assert.equal(f.commits.length, 0); assert.equal(f.packets.length, 0)
})

test('cancelled operation ignores late actual receipts and cannot credit or send completion', async t => {
  const f = fixture(t, 1); f.hunger(16); const pending = f.start(); await nextTurn()
  f.food.cancel('manual cancellation'); f.slot(air()); f.ack(); f.hunger(18)
  const outcome = await pending
  assert.ok(outcome.error); assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.transactions.length, 1)
  assert.equal(f.uncertainty.length, 1); assert.equal(f.commits.length, 0)
})

test('only a fresh complete matching received baseline restores module authority without claiming consumption', async t => {
  const f = fixture(t, 1); f.hunger(16); const pending = f.start(); await nextTurn()
  f.slot(air()); f.tick(12000); const outcome = await pending
  assert.ok(outcome.error); assert.equal(f.food.snapshot().inventoryUncertain, true)
  f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [air()] })
  assert.equal(f.food.snapshot().inventoryUncertain, true, 'partial content is no authority reset')
  const packet = wire('inventory_content', { window_id: 'inventory', input: f.bag, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() })
  f.food.applyPacket('inventory_content', packet)
  assert.equal(f.food.snapshot().inventoryUncertain, false)
  assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.commits.length, 0)
})

test('Runtime constructor forwards actual Host life or unknown null without changing position or lifecycle flags', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime.js'), 'utf8')
  const line = source.split('\n').find(line => line.includes('const food = createFood('))
  const state = { position: { x: 1, y: 2, z: 3 }, lifecycle: { dead: false, phase: 'alive', custom: 7 } }, host = { shared: { deathRespawn: { deathId: 132 } }, client: {} }
  const options = Function('host', 'working', 'crafting', 'input', 'inventory', 'canEmergencyEatHere', 'onUncertain', `let options; const createFood = o => { options = o }; const foodKnownLife = () => Number.isSafeInteger(host.shared.deathRespawn?.deathId) && host.shared.deathRespawn.deathId >= 0 ? host.shared.deathRespawn.deathId : null; ${line}; return options`)(host, () => state, {}, null, {}, () => false, () => {})
  assert.deepEqual(options.getState(), { ...state, lifecycle: { ...state.lifecycle, deathId: 132 } })
  assert.equal(options.getState().position, state.position)
  host.shared.deathRespawn = {}; assert.equal(options.getState().lifecycle.deathId, null)
  host.shared.deathRespawn.deathId = -1; assert.equal(options.getState().lifecycle.deathId, null)
})
