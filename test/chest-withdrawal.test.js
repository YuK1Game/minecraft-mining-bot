'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const file = path.resolve(__dirname, 'chest.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, air }\n', file)
const { fixture, item, air } = loaded.exports

function setup (t, { name = 'minecraft:bread', count = 64, targetCount = 0, blockName = 'minecraft:undyed_shulker_box', timeoutMs = 2000 } = {}) {
  const f = fixture({ actualCrafting: true, wireDecode: true, blockName, timeoutMs })
  f.observe('item_registry', { itemstates: [{ runtime_id: 401, name: 'minecraft:diamond' }, { runtime_id: 402, name: 'minecraft:dirt' }, { runtime_id: 410, name }] })
  const source = item(410, count, 810)
  if (name.endsWith('_pickaxe')) source.extra = { ...source.extra, has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 29 }, display: { type: 'compound', value: { Name: { type: 'string', value: 'received tool' } } } } } } }
  f.chestSlot(3, source)
  f.main(14, targetCount ? { ...structuredClone(source), count: targetCount, stack_id: 811 } : air())
  t.after(() => f.chest.cancel('fixture cleanup'))
  const options = { chestSlot: 3, count: name.endsWith('_pickaxe') ? 1 : 5, targetSlot: 14, expectedName: name }
  const start = extra => { const pending = f.chest.withdrawItem({ ...options, ...extra }); void pending.catch(() => {}); return pending }
  const ack = ({ id = -501, playerCount = targetCount + options.count, chestCount = count - options.count, playerId = 901, chestId = chestCount ? 902 : 0, type = blockName.includes('shulker') ? 'shulker' : 'container', status = 'ok' } = {}) => {
    const slot = (index, n, netId) => ({ slot: index, hotbar_slot: index, count: n, item_stack_id: netId, custom_name: '', filtered_custom_name: '', durability_correction: 0 })
    f.observe('item_stack_response', f.codec('item_stack_response', { responses: [{ status, request_id: id, ...(status === 'ok' ? { containers: [{ slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: null }, slots: [slot(14, playerCount, playerId)] }, { slot_type: { container_id: type, dynamic_container_id: null }, slots: [slot(3, chestCount, chestId)] }] } : {}) }] }))
  }
  const player = (n = targetCount + options.count, id = 901) => f.main(14, n ? { ...structuredClone(source), count: n, stack_id: id } : air())
  const container = (n = count - options.count, id = 902) => f.chestSlot(3, n ? { ...structuredClone(source), count: n, stack_id: id } : air())
  return { ...f, source, options, start, ack, player, container }
}

test('a schema-valid normal take preserves a received tool NBT and waits for both actual slots plus the matching ACK', async t => {
  const f = setup(t, { name: 'minecraft:diamond_pickaxe', count: 1 })
  const pending = f.start()
  const wire = f.codec('item_stack_request', f.packets.at(-1).params).requests[0].actions[0]
  assert.deepEqual([wire.type_id, wire.legacy_type_id, wire.count, wire.source.slot_type.container_id, wire.source.slot, wire.source.stack_id, wire.destination.slot_type.container_id, wire.destination.slot, wire.destination.stack_id], ['take', 0, 1, 'shulker', 3, 810, 'hotbar_and_inventory', 14, 0])
  f.ack(); assert.equal(f.chest.snapshot().busy, true)
  assert.equal(f.crafting.rawItem(14).count, 0, 'ACK does not synthesize a received tool')
  f.player(); assert.equal(f.chest.snapshot().busy, true)
  f.container()
  const receipt = await pending
  assert.equal(receipt.operation, 'withdraw_item')
  assert.equal(receipt.serverConfirmed, true)
  assert.deepEqual([receipt.before.playerCount, receipt.after.playerCount, receipt.before.chestCount, receipt.after.chestCount], [0, 1, 1, 0])
  assert.deepEqual(f.crafting.rawItem(14).extra, f.source.extra)
  assert.equal(f.reconciliations.length, 0)
})

test('bread, dirt and arrows can be withdrawn into a matching partial stack with exact two-sided deltas', async t => {
  for (const name of ['minecraft:bread', 'minecraft:dirt', 'minecraft:arrow']) await t.test(name, async t => {
    const f = setup(t, { name, count: 64, targetCount: 59, blockName: 'minecraft:chest' })
    const pending = f.start()
    f.container(); f.player(); assert.equal(f.chest.snapshot().busy, true, 'fresh slots without acceptance are insufficient')
    f.ack()
    const receipt = await pending
    assert.equal(receipt.after.playerCount, 64); assert.equal(receipt.after.chestCount, 59)
    assert.equal(receipt.inventoryEvidence, 'received_slot_descriptor')
    assert.equal(receipt.containerEvidence, 'received_slot_descriptor')
  })
})

test('automatic destination selection respects actual item stack limits and never merges tools', async t => {
  const f = setup(t, { name: 'minecraft:diamond_pickaxe', count: 1, targetCount: 1 })
  const pending = f.start({ targetSlot: undefined })
  const action = f.packets.at(-1).params.requests[0].actions[0]
  assert.equal(action.destination.slot, 0)
  assert.equal(action.destination.stack_id, 0)
  assert.equal(f.crafting.rawItem(14).count, 1)
  f.chest.cancel('test ended before a real transfer')
  await assert.rejects(pending)
})

test('a whole 64-item dirt stack empties exactly one container slot without changing the other contents', async t => {
  const f = setup(t, { name: 'minecraft:dirt', count: 64 })
  f.options.count = 64
  const other = item(402, 64, 999)
  f.chestSlot(4, other)
  const receivedOther = f.chest.rawItem(4)
  const pending = f.start()
  f.ack(); f.container(); f.player()
  const receipt = await pending
  assert.deepEqual([receipt.before.chestCount, receipt.after.chestCount, receipt.after.playerCount], [64, 0, 64])
  assert.equal(f.chest.rawItem(3).count, 0)
  assert.deepEqual(f.chest.rawItem(4), receivedOther)
})

test('full, incompatible, unknown and invalid requests send no take and preserve the source box', t => {
  for (const mode of ['full', 'unknown_item', 'wrong_name', 'wrong_source_slot', 'oversize', 'unknown_contents']) {
    const f = setup(t, { name: mode === 'unknown_item' ? 'custom:unrecognized_item' : 'minecraft:bread', targetCount: mode === 'full' ? 64 : 0 })
    const before = structuredClone(f.chest.rawItem(3))
    if (mode === 'unknown_contents') f.observe('container_close', { window_id: 5 })
    assert.throws(() => f.chest.withdrawItem({ ...f.options, ...(mode === 'wrong_name' ? { expectedName: 'minecraft:dirt' } : {}), ...(mode === 'wrong_source_slot' ? { chestSlot: 27 } : {}), ...(mode === 'oversize' ? { count: 65 } : {}) }))
    assert.equal(f.packets.filter(p => p.name === 'item_stack_request').length, 0, mode)
    if (mode !== 'unknown_contents') assert.deepEqual(f.chest.rawItem(3), before)
  }
})

test('wrong ACK request, missing fresh side and replayed slot descriptors cannot confirm or invent a withdrawal', async t => {
  for (const mode of ['wrong_ack', 'no_player', 'no_chest', 'replayed_player', 'replayed_chest']) await t.test(mode, async t => {
    const f = setup(t), pending = f.start()
    f.ack(mode === 'wrong_ack' ? { id: -503 } : {})
    if (mode !== 'no_player') f.main(14, { ...f.source, count: 5, stack_id: 901 }, { replaying: mode === 'replayed_player' })
    if (mode !== 'no_chest') f.chestSlot(3, { ...f.source, count: 59, stack_id: 902 }, { replaying: mode === 'replayed_chest' })
    assert.equal(f.chest.snapshot().busy, true)
    f.chest.cancel('not enough actual receipt evidence'); await assert.rejects(pending)
    assert.equal(f.reconciliations.length, 0)
    assert.equal(f.uncertain.length, 1)
  })
})

test('wrong counts, changed metadata, changed NBT and ACK net IDs fail closed', async t => {
  for (const mode of ['player_count', 'chest_count', 'metadata', 'nbt', 'player_id', 'chest_id']) await t.test(mode, async t => {
    const f = setup(t), pending = f.start(), stopped = assert.rejects(pending)
    f.ack()
    const received = { ...structuredClone(f.source), count: mode === 'player_count' ? 6 : 5, stack_id: mode === 'player_id' ? 999 : 901 }
    if (mode === 'metadata') received.metadata = 1
    if (mode === 'nbt') received.extra = { ...received.extra, has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 1 } } } } }
    f.main(14, received)
    f.container(mode === 'chest_count' ? 58 : 59, mode === 'chest_id' ? 998 : 902)
    await stopped
    assert.equal(f.uncertain.length, 1)
    assert.equal(f.chest.snapshot().lastResult.operation, 'withdraw_item')
  })
})

test('life, connection, window changes, server rejection and abort cannot credit old receipts or send twice', async t => {
  for (const mode of ['life', 'connection', 'window', 'reject', 'abort']) await t.test(mode, async t => {
    const f = setup(t), controller = new AbortController(), pending = f.start({ signal: controller.signal }), stopped = assert.rejects(pending)
    if (mode === 'life') { f.state.lifecycle.deathId++; f.observe('update_attributes', { runtime_entity_id: 13639n, attributes: [] }) }
    if (mode === 'connection') { f.state.connectionId = 'other'; f.observe('update_attributes', { runtime_entity_id: 13639n, attributes: [] }) }
    if (mode === 'window') f.observe('container_close', { window_id: 5 })
    if (mode === 'reject') f.ack({ status: 'error' })
    if (mode === 'abort') controller.abort(new Error('test abort'))
    await stopped
    f.ack(); f.player(); f.container()
    assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
    assert.equal(f.packets.filter(p => p.name === 'item_stack_request').length, 1)
    assert.equal(f.reconciliations.length, 0)
  })
})

test('an already aborted request sends nothing and a receipt timeout leaves inventory uncertain', async t => {
  const f = setup(t, { timeoutMs: 50 }), controller = new AbortController()
  controller.abort()
  assert.throws(() => f.chest.withdrawItem({ ...f.options, signal: controller.signal }))
  assert.equal(f.packets.length, 0)
  await assert.rejects(f.start(), /実際の完了/)
  assert.equal(f.chest.snapshot().inventoryUncertain, true)
  assert.equal(f.crafting.rawItem(14).count, 0)
})
