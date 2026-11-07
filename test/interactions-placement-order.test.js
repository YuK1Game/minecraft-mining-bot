'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { deserialize } = require('node:v8')
const file = path.resolve(__dirname, 'interactions.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, emptyItem }\n', file)
const { fixture, emptyItem } = loaded.exports
const unpack = value => deserialize(Buffer.from(value, 'base64'))

function setup ({ name = 'minecraft:undyed_shulker_box', count = 1 } = {}) {
  const f = fixture({ timeoutMs: 80 })
  Object.assign(f.state, { profile: 'bot', realm: { id: 'realm' }, connectionId: 'one', startedAt: '2026-11-06T13:53:33.633Z', lifecycle: { deathId: 0 } })
  f.names.set(888, name); f.names.set(889, 'minecraft:gravel'); f.names.set(890, 'minecraft:blue_shulker_box')
  const source = { network_id: 888, count, metadata: 0, has_stack_id: true, stack_id: 92, block_runtime_id: 300, extra: { has_nbt: true, can_place_on: [], can_destroy: [], nbt: { version: 1, nbt: { type: 'compound', name: '', value: { BigWitness: { type: 'long', value: 123n } } } } } }
  f.raw.set(0, structuredClone(source))
  const slot = (value, index = 0) => { f.raw.set(index, structuredClone(value)); f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: index, item: value }) }
  const fullEmpty = () => {
    f.raw.set(0, emptyItem())
    f.interactions.applyPacket('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, index) => structuredClone(f.raw.get(index))) })
  }
  const pickup = () => slot({ ...emptyItem(), network_id: 889, count: 1, has_stack_id: true, stack_id: 222 })
  const block = (blockName = name) => { f.setBlock(f.target, blockName.replace(/^minecraft:/, ''), 444); f.interactions.applyPacket('update_block', {}) }
  return { ...f, source, slot, fullEmpty, pickup, block, start: () => f.interactions.placeBlock({ position: f.target, slot: 0 }) }
}

test('received full-main empty, later gravel pickup, then real box update preserves both actual observations', async () => {
  const f = setup(), pending = f.start()
  f.fullEmpty(); f.pickup()
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.block()
  const receipt = await pending, proof = receipt.placementObservation
  assert.equal(receipt.confirmedBy, 'server_block_and_inventory')
  assert.deepEqual(unpack(proof.sourceBefore), f.source)
  assert.equal(unpack(proof.sourceAfter).network_id, 0)
  assert.equal(unpack(proof.sourceAfter).count, 0)
  assert.equal(f.raw.get(0).network_id, 889, 'the current gravel is never rewritten to empty')
  assert.ok(Number.isSafeInteger(proof.sourceObservedAt)); assert.ok(Number.isSafeInteger(proof.blockObservedAt))
  assert.ok(proof.sourceObservedAt <= proof.blockObservedAt)
  const json = JSON.parse(JSON.stringify({ receipt, snapshot: f.interactions.snapshot() }))
  assert.equal(unpack(json.receipt.placementObservation.sourceBefore).extra.nbt.nbt.value.BigWitness.value, 123n)
  proof.sourceAfter = ''; proof.sourceObservedAt = 0
  assert.equal(unpack(f.interactions.snapshot().lastResult.placementObservation.sourceAfter).count, 0)
  assert.notEqual(f.interactions.snapshot().lastResult.placementObservation.sourceObservedAt, 0)
})

test('block-first then actual source empty still completes without waiting for another packet', async () => {
  const f = setup(), pending = f.start()
  f.block(); assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.slot(emptyItem())
  const proof = (await pending).placementObservation
  assert.equal(unpack(proof.sourceAfter).count, 0)
  assert.ok(proof.blockObservedAt <= proof.sourceObservedAt)
})

test('a witness never converts unknown, conflicting, cancelled or foreign observations into completion', async t => {
  for (const mode of ['never_empty', 'returned_source', 'moved_source', 'other_box', 'unknown_slot', 'unknown_inventory', 'uncertain_inventory', 'unknown_block', 'wrong_block', 'reject', 'cancel', 'life', 'connection', 'timeout', 'before_wire', 'before_wire_empty_stays', 'non_shulker', 'box_count_two']) await t.test(mode, async () => {
    const f = setup(mode === 'non_shulker' ? { name: 'minecraft:crafting_table' } : mode === 'box_count_two' ? { count: 2 } : {})
    let sent
    if (mode.startsWith('before_wire')) f.input.sendTransaction = (transaction, options) => { f.transactions.push(transaction); sent = options.onSent }
    const pending = f.start(), outcome = pending.then(receipt => ({ receipt }), error => ({ error }))
    if (mode !== 'never_empty') f.fullEmpty()
    if (mode === 'returned_source') f.slot(f.source)
    else if (mode === 'moved_source') f.slot(f.source, 5)
    else if (mode === 'other_box') f.slot({ ...structuredClone(f.source), network_id: 890, stack_id: 333 })
    else if (mode !== 'before_wire_empty_stays') f.pickup()
    if (mode === 'unknown_slot') { f.raw.set(0, null); f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: null }) }
    if (mode === 'unknown_inventory') { f.state.inventory.known = false; f.interactions.applyPacket('update_attributes', {}) }
    if (mode === 'uncertain_inventory') { f.state.inventory.uncertain = true; f.interactions.applyPacket('update_attributes', {}) }
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'connection') f.state.connectionId = 'different'
    if (mode === 'reject') f.interactions.applyPacket('item_stack_response', { responses: [{ request_id: f.transactions[0].legacy.legacy_request_id, status: 1 }] })
    if (mode === 'cancel') f.interactions.cancel('manual cancellation')
    if (mode.startsWith('before_wire')) sent()
    if (!['unknown_block', 'timeout'].includes(mode)) f.block(mode === 'wrong_block' ? 'minecraft:stone' : undefined)
    else if (mode === 'unknown_block') { f.blocks.set(`${f.target.x},${f.target.y},${f.target.z}`, { known: false }); f.interactions.applyPacket('update_block', {}) }
    const result = await outcome
    assert.ok(result.error, `${mode}: no completion may be inferred`)
    assert.equal(f.interactions.snapshot().lastResult.phase, 'failed')
    assert.equal(f.transactions.length, 1)
    f.block()
    assert.equal(f.interactions.snapshot().lastResult.phase, 'failed', 'a late block cannot resurrect cancelled work')
  })
})
