'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto')
const file = path.resolve(__dirname, '../test/food.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file)); loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture,item,air,createSerializer,createDeserializer}\n', file)
const { fixture, item, air, createSerializer, createDeserializer } = loaded.exports
const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60'), wire = (name, params) => parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
const actual = require('./fixtures/food-main-placeholder.json')
const capturedContent = actual.events.find(e => e.name === 'inventory_content'), capturedAck = actual.events.find(e => e.name === 'completed_using_item')
const bds = require('../test/fixtures/inventory-resync-nonempty.json')
function foodRaw (count, stack) { return wire('inventory_slot', { window_id: 'inventory', slot: 0, item: item(262, count, stack), container: null, storage_item: null }).item }
function setup (t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); const f = fixture({ foodName: 'minecraft:porkchop', count: 2 })
  f.state.lifecycle.deathId = 176; f.bag.set(0, foodRaw(2, 373)); f.names.set(262, 'minecraft:porkchop'); f.observeHunger(17)
  return f
}
function mainPacket (f, { window = 'inventory', container = 'anvil_input', dynamic, length = 36, count = 1, cache = true } = {}) {
  const input = [...f.bag.values()].map(raw => structuredClone(raw)); input[0] = foodRaw(count, 441)
  const packet = wire('inventory_content', { window_id: window, input: input.slice(0, Math.min(36, length)), container: { container_id: container, dynamic_container_id: null }, storage_item: air() })
  if (length > 36) packet.input.push(packet.input[1]); if (typeof container === 'number') packet.container.container_id = container
  if (dynamic !== undefined) packet.container.dynamic_container_id = dynamic
  if (cache) packet.input.forEach((raw, slot) => { if (slot < 36) f.bag.set(slot, structuredClone(raw)) })
  return packet
}
const ack = f => f.food.applyPacket('completed_using_item', wire('completed_using_item', { used_item_id: capturedAck.usedItemId, use_method: capturedAck.useMethod }))

test('captured life176 request48 exact full-main anvil placeholder joins real eat ACK and2-to1 inventory receipt', async t => {
  const f = setup(t), digest = raw => crypto.createHash('sha256').update(JSON.stringify(raw.extra)).digest('hex').slice(0, 16)
  assert.equal(actual.life, 176); assert.equal(actual.requestId, -48); assert.equal(capturedContent.length, 36); assert.equal(capturedContent.container, 'anvil_input'); assert.equal(capturedContent.rawMatches, true)
  assert.equal(bds.freshMain.window_id, 'inventory'); assert.equal(bds.freshMain.input.length, 36); assert.equal(bds.freshMain.container.container_id, capturedContent.container)
  assert.equal(digest(f.bag.get(0)), actual.initialRaw.extraHash)
  const { pending } = await f.start(); const settled = pending.then(value => ({ value }), error => ({ error }))
  ack(f); f.food.applyPacket('inventory_content', mainPacket(f)); f.observeHunger(20)
  const completed = f.food.snapshot().lastResult?.phase === 'completed'
  if (!completed) f.food.cancel('old-code reproduction cleanup')
  const outcome = await settled
  assert.equal(completed, true, 'captured full main placeholder must not discard the exact received consumption')
  assert.equal(outcome.value.confirmedBy, 'completed_using_item_and_server_inventory'); assert.equal(outcome.value.name, 'minecraft:porkchop'); assert.equal(outcome.value.count, 1)
  assert.equal(f.bag.get(0).count, 1); assert.equal(f.bag.get(0).stack_id, 441); assert.equal(f.transactions.length, 1); assert.equal(f.commits.length, 0); assert.equal(f.uncertainties.length, 0)
})

test('numeric vanilla container0 works only as a full main content receipt with exact cache and a real acknowledgement', async t => {
  const f = setup(t), { pending } = await f.start(); ack(f)
  const packet = mainPacket(f, { container: 0 }); packet.window_id = 0
  f.food.applyPacket('inventory_content', packet)
  assert.equal((await pending).serverConfirmed, true); assert.equal(f.transactions.length, 1); assert.equal(f.uncertainties.length, 0)
})

for (const mode of ['armor', 'offhand', 'ui', 'dynamic0', 'dynamic23', 'foreign_container', 'short35', 'long37', 'cache_mismatch', 'invalid_unrelated_slot', 'no_ack', 'wrong_self_hunger', 'two_decrements']) test('main placeholder rejects ' + mode + ' without consumption credit', async t => {
  const f = setup(t), { pending } = await f.start(); const rejected = assert.rejects(pending)
  if (!['no_ack', 'wrong_self_hunger'].includes(mode)) ack(f)
  const packet = mainPacket(f, { window: ['armor', 'offhand', 'ui'].includes(mode) ? mode : 'inventory', dynamic: mode === 'dynamic0' ? 0 : mode === 'dynamic23' ? 23 : undefined, container: mode === 'foreign_container' ? 'anvil_result' : 'anvil_input', length: mode === 'short35' ? 35 : mode === 'long37' ? 37 : 36, count: mode === 'two_decrements' ? 0 : 1 })
  if (mode === 'cache_mismatch') packet.input[8] = foodRaw(1, 442)
  if (mode === 'invalid_unrelated_slot') { packet.input[8] = { network_id: 0, count: 1 }; f.bag.set(8, structuredClone(packet.input[8])) }
  f.food.applyPacket('inventory_content', packet)
  if (mode === 'wrong_self_hunger') f.food.applyPacket('update_attributes', { runtime_entity_id: 999n, attributes: [{ name: 'minecraft:player.hunger', current: 20 }] })
  assert.equal(f.food.snapshot().busy, true); f.food.cancel('fixture cleanup'); await rejected
  assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.commits.length, 0)
})

test('the anvil placeholder never becomes an inventory_slot scope even with attached full data', async t => {
  const f = setup(t), { pending } = await f.start(), rejected = assert.rejects(pending); ack(f)
  const packet = mainPacket(f)
  f.food.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, container: { container_id: 'anvil_input' }, item: packet.input[0], input: packet.input })
  assert.equal(f.food.snapshot().busy, true); f.food.cancel('fixture cleanup'); await rejected; assert.equal(f.commits.length, 0)
})

test('actual fresh full main placeholder clears local uncertainty after failure without inventing consumption', async t => {
  const f = setup(t), { pending } = await f.start(), rejected = assert.rejects(pending)
  f.food.cancel('no receipt'); await rejected; assert.equal(f.food.snapshot().inventoryUncertain, true)
  const bad = mainPacket(f, { dynamic: 23 }); f.food.applyPacket('inventory_content', bad); assert.equal(f.food.snapshot().inventoryUncertain, true)
  const fresh = mainPacket(f); f.food.applyPacket('inventory_content', fresh)
  assert.equal(f.food.snapshot().inventoryUncertain, false); assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.food.snapshot().lastResult.consumed, undefined); assert.equal(f.commits.length, 0)
})

test('actual life or self identity changes cannot join a placeholder inventory with the old eat operation', async t => {
  const f = setup(t), { pending } = await f.start(), rejected = assert.rejects(pending); ack(f)
  f.state.lifecycle.deathId++; f.state.runtimeEntityId = '42'
  f.food.applyPacket('inventory_content', mainPacket(f)); await rejected
  assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.food.snapshot().lastResult.consumed, undefined)
})
