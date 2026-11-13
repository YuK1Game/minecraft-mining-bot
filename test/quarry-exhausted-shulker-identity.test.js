'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { selectCarriedStorage, carriedContainerIdentity, carriedContainerKey } = require('../src/quarry-inventory')

// Live 2026-11-13: after a reconnect every carried box got a new stack ID, so
// the stack-keyed "full" marks matched nothing and full boxes were placed,
// opened and recovered again one after another.
const contents = name => ({ has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: [{ Name: { type: 'string', value: name } }] } } } } } })
const box = (slot, stackId, extra) => ({ slot, name: 'minecraft:purple_shulker_box', count: 1, stackId, raw: { network_id: 900, metadata: 0, block_runtime_id: 77, count: 1, has_stack_id: true, stack_id: stackId, extra } })

test('a full box stays skipped after its stack ID changes on reconnect', () => {
  const fullBefore = box(2, 106, contents('minecraft:cobbled_deepslate'))
  const identity = carriedContainerIdentity(fullBefore)
  assert.match(identity, /^[0-9a-f]{64}$/)
  // The same box received again under a new connection.
  const fullAfter = box(2, 9001, contents('minecraft:cobbled_deepslate')), roomy = box(5, 9002, contents('minecraft:dirt'))
  assert.equal(carriedContainerIdentity(fullAfter), identity)
  const selected = selectCarriedStorage([fullAfter, roomy], { excludedShulkerKeys: [carriedContainerKey(fullBefore)], excludedShulkerIdentities: [identity], shulkerOnly: true })
  assert.equal(selected.sources[0].slot, 5)
  // Without the identity the stale stack key alone would pick the full box.
  assert.equal(selectCarriedStorage([fullAfter, roomy], { excludedShulkerKeys: [carriedContainerKey(fullBefore)], shulkerOnly: true }).sources[0].slot, 2)
})

test('boxes without received NBT have no identity and are never excluded by it', () => {
  const bare = box(3, 5, undefined)
  assert.equal(carriedContainerIdentity(bare), null)
  assert.equal(carriedContainerIdentity({ slot: 1, name: 'minecraft:purple_shulker_box', count: 1 }), null)
  assert.equal(selectCarriedStorage([bare], { excludedShulkerIdentities: ['0'.repeat(64)], shulkerOnly: true }).sources[0].slot, 3)
})
