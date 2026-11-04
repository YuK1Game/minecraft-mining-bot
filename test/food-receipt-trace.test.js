'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const fixtureFile = path.resolve(__dirname, '../test/food.test.js'), loaded = new Module(fixtureFile, module)
loaded.filename = fixtureFile; loaded.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
loaded._compile(fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture,item,air,createSerializer,createDeserializer}\n', fixtureFile)
const { fixture, item, air, createSerializer, createDeserializer } = loaded.exports
const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
const wire = (name, params) => parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
function trace (f) { const s = f.food.snapshot(); return s.receiptTrace ?? s.lastResult?.receiptTrace }
function releaseReceipt (f, subtype = 'consume') {
  const raw = f.crafting.rawItem(0)
  return wire('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0, legacy_transactions: null }, transaction_type: 'item_release', actions: [{ source_type: 'container', window_id: 0, flags: null, slot: 0, old_item: raw, new_item: air() }], transaction_data: { action_type: subtype, hotbar_slot: 0, held_item: raw, head_pos: f.state.position, hand: 'main_hand' } } })
}

test('actual received consume transaction keeps subtype and full selected descriptor digests without becoming an ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture({ count: 1 }); f.observeHunger(16); const { pending } = await f.start(); const rejected = assert.rejects(pending)
  f.advanceHold(t); f.food.applyPacket('inventory_transaction', releaseReceipt(f))
  f.observeSlot(wire('inventory_slot', { window_id: 'inventory', slot: 0, item: air(), container: null, storage_item: null }).item)
  const row = trace(f).events.find(row => row.name === 'inventory_transaction')
  assert.equal(row.direction, 'server_received'); assert.equal(row.transaction.type, 'item_release'); assert.equal(row.transaction.data.actionType, 'consume')
  assert.equal(row.transaction.actions[0].old.count, 1); assert.equal(row.transaction.actions[0].old.stackId, 81); assert.equal(row.transaction.actions[0].new.id, 0); assert.equal(row.transaction.actions[0].new.count, 0)
  assert.match(row.transaction.actions[0].old.rawHash, /^[a-f0-9]{16}$/); assert.equal(row.transaction.data.held.count, 1)
  assert.equal(row.after.flags.completedAck, false); assert.equal(row.after.flags.hungerIncreased, false)
  assert.equal(f.food.snapshot().busy, true, 'diagnostic consume subtype cannot bypass the existing completion guards')
  t.mock.timers.tick(12000); await rejected
  assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.uncertainties.length, 1)
  const preserved = f.uncertainties[0].receiptTrace
  assert.equal(preserved.requestId, -202); assert.ok(preserved.events.some(e => e.name === 'inventory_transaction'))
  assert.ok(trace(f).events.some(e => e.name === 'failed')); assert.equal(f.commits.length, 0)
})

test('successful early actual receipts retain exact order and flags in lastResult without a second use', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture({ count: 1 }); f.observeHunger(16); const { pending } = await f.start()
  f.observeHunger(18); f.observeHunger(16); f.observeSlot(air()); const result = await pending
  assert.equal(result.serverConfirmed, true); assert.equal(f.transactions.length, 1)
  const events = trace(f).events
  assert.deepEqual(events.filter(e => e.direction === 'server_received').map(e => e.name), ['update_attributes', 'update_attributes', 'inventory_slot'])
  const row = events.find(e => e.name === 'inventory_slot'); assert.equal(row.after.flags.observedConsumption, true); assert.equal(row.after.flags.hungerIncreased, true)
  assert.equal(f.food.snapshot().receiptTrace, null, 'completed status exposes one retained trace instead of a duplicate payload')
  assert.equal(f.food.snapshot().lastResult.receiptTrace.requestId, -202); assert.equal(f.uncertainties.length, 0)
})

test('trace remains32events/8KiB bounded and exposes only digests instead of raw NBT', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture({ count: 2 }); f.bag.get(0).extra.nbt = { diagnostic_private_fixture: 'DO_NOT_EXPOSE_THIS_NBT'.repeat(1024) }
  f.observeHunger(16); const { pending } = await f.start(); const rejected = assert.rejects(pending)
  for (let i = 0; i < 100; i++) f.observeHunger(16)
  const current = trace(f), text = JSON.stringify(current)
  assert.ok(current.events.length <= 32); assert.ok(Buffer.byteLength(text, 'utf8') <= 8192); assert.ok(current.droppedEvents > 0)
  assert.equal(text.includes('DO_NOT_EXPOSE_THIS_NBT'), false)
  f.food.cancel('fixture cleanup'); await rejected
  assert.ok(Buffer.byteLength(JSON.stringify(trace(f)), 'utf8') <= 8192)
})

test('cancelled life change is diagnostic-only and late acknowledgement cannot resurrect old consumption', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture({ count: 1 }); f.observeHunger(16); const { pending } = await f.start(); const rejected = assert.rejects(pending)
  f.state.lifecycle.deathId++
  f.food.applyPacket('completed_using_item', wire('completed_using_item', { used_item_id: 300, use_method: 'eat' })); await rejected
  const row = trace(f).events.find(e => e.name === 'completed_using_item')
  assert.equal(row.scopeMatches, false); assert.equal(row.life, 2); assert.equal(row.after.flags.completedAck, false)
  f.observeSlot(air()); assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.commits.length, 0)
})

test('unmatched actual use ID is retained honestly and never becomes completion evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture({ count: 1 }); const { pending } = await f.start(); const rejected = assert.rejects(pending)
  f.food.applyPacket('completed_using_item', wire('completed_using_item', { used_item_id: 301, use_method: 'eat' })); f.observeSlot(air())
  const row = trace(f).events.find(e => e.name === 'completed_using_item')
  assert.equal(row.usedItemId, 301); assert.equal(row.after.flags.completedAck, false); assert.equal(f.food.snapshot().busy, true)
  f.food.cancel('fixture cleanup'); await rejected
})

test('fresh actual full inventory still restores only authority without inventing hunger/use acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture({ count: 1 }); const { pending } = await f.start(); const rejected = assert.rejects(pending)
  f.bag.set(0, air()); f.food.applyPacket('inventory_content', { window_id: 'inventory', input: [...f.bag.values()] })
  t.mock.timers.tick(12000); await rejected
  assert.equal(f.uncertainties.length, 0); assert.equal(f.food.snapshot().lastResult.phase, 'failed'); assert.equal(f.food.snapshot().inventoryUncertain, false)
  const row = trace(f).events.find(e => e.name === 'inventory_content'); assert.equal(row.rawMatches, true); assert.equal(row.after.flags.completedAck, false)
  assert.equal(typeof f.food.restoreHunger, 'function', 'already-active hunger restoration API remains present')
})
