'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryV22ChestWork } = require('../src/quarry-v22-chest-work')
const file = path.resolve(__dirname, 'quarry-v22-chest-work.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, raw, empty, names }\n', file)
const { fixture, raw, empty, names } = loaded.exports
const copy = value => structuredClone(value)
const root = raw => raw.extra.nbt.nbt.value
const request = f => ({ jobId: 'q', operationId: 'start', position: f.pos })
const worker = f => createQuarryV22ChestWork({ ...f.ports, sleep: async () => {} })

async function pausedPrefix (index = 11, { absentDamage = false } = {}) {
  const f = fixture(), events = []
  for (const item of f.base.filter(item => item.network_id)) {
    const name = names.get(item.network_id), value = {}
    item.block_runtime_id = 0
    if (/sword$|bow$|diamond_(helmet|chestplate|leggings|boots)$/.test(name)) {
      if (!absentDamage) value.Damage = { type: 'int', value: 10 }
      value.ench = { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: name === 'minecraft:bow' ? 22 : 9 }, lvl: { type: 'short', value: 1 } }] } }
    }
    if (item.contents) value.Items = { type: 'list', value: { type: 'compound', value: item.contents.map((row, slot) => ({ Slot: { type: 'byte', value: slot }, Name: { type: 'string', value: row.name }, Count: { type: 'byte', value: row.count } })) } }
    item.extra = { has_nbt: 'true', nbt: { version: 1, nbt: { type: 'compound', name: '', value } }, can_place_on: [], can_destroy: [] }
  }
  const stopped = await worker(f).withdrawAll(request(f), { onCheckpoint: async cp => {
    if (cp.index === index && cp.intent?.index === index) throw Object.assign(new Error('stop before the next wire'), { code: 'PERSISTENCE_FAILED' })
  } })
  assert.equal(stopped.reason, 'PERSISTENCE_FAILED')
  assert.equal(stopped.checkpoint.index, index)
  assert.equal(stopped.checkpoint.intent.index, index)
  assert.equal(f.transfers.length, index)
  const checkpoint = stopped.checkpoint, original = copy(checkpoint)
  const withdraw = f.ports.withdraw
  f.ports.withdraw = async args => { events.push('wire'); return withdraw(args) }
  const run = (extra = {}, onCheckpoint = async cp => { if (cp.prefixUseObservations?.length) events.push('audit') }) => worker(f).withdrawAll({ ...request(f), checkpoint: copy(checkpoint), ...extra }, { onCheckpoint })
  return Object.assign(f, { checkpoint, original, events, run })
}

function useReceivedKit (f) {
  ;[f.bag[0], f.bag[2]] = [f.bag[2], f.bag[0]]
  f.bag[0].count = 63
  root(f.bag[2]).Damage = { type: 'int', value: 12 }
  root(f.bag[1]).Damage = { type: 'int', value: 11 }
  f.bag[35] = f.bag[1]; f.bag[1] = empty()
  for (let slot = 0; slot < 4; slot++) {
    f.armor[slot] = f.bag[slot + 4]; f.bag[slot + 4] = empty()
    root(f.armor[slot]).Damage = { type: 'int', value: 13 + slot }
  }
}

function assertOriginalPrefix (f, cp) {
  assert.deepEqual(cp.plan, f.original.plan)
  assert.deepEqual(cp.identities, f.original.identities)
  assert.deepEqual(cp.receipts.slice(0, f.original.index), f.original.receipts)
}

test('explicit prefix use completes the remaining kit after bread/sword permutation, bread consumption and actual worn armor damage', async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.index, 34)
  assert.equal(f.transfers.length, 34, 'each original stack is withdrawn exactly once')
  assert.equal(f.bag.find(item => names.get(item.network_id) === 'minecraft:bread').count, 63)
  assert.deepEqual(f.armor.map(item => root(item).Damage.value), [13, 14, 15, 16])
  assertOriginalPrefix(f, result.checkpoint)
  assert.ok(Array.isArray(result.checkpoint.prefixUseObservations) && result.checkpoint.prefixUseObservations.length > 0)
  assert.ok(f.events.indexOf('audit') >= 0 && f.events.indexOf('audit') < f.events.indexOf('wire'), 'the observation is durable before continuing')
})

test('a confirmed prefix without a pending intent also permits the same explicit observed use', async () => {
  const f = await pausedPrefix(); f.checkpoint.intent = null; useReceivedKit(f)
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'completed', result.reason); assert.equal(f.transfers.length, 34)
  assertOriginalPrefix(f, result.checkpoint)
})

test('fresh received equipment with no Damage tag may acquire typed integer wear while preserving all other NBT', async () => {
  const f = await pausedPrefix(11, { absentDamage: true }); useReceivedKit(f)
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'completed', result.reason); assert.equal(f.transfers.length, 34)
  assertOriginalPrefix(f, result.checkpoint)
})

for (const flag of [undefined, false, 'true']) test(`prefix use is not enabled by ${String(flag)}`, async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  const result = await f.run(flag === undefined ? {} : { allowReceivedPrefixUse: flag })
  assert.equal(result.status, 'blocked'); assert.equal(f.transfers.length, 11)
  assertOriginalPrefix(f, result.checkpoint)
})

for (const mode of ['missing', 'metadata', 'blockRuntime', 'network', 'enchant', 'rename', 'repair', 'damageFloat', 'damageType', 'breadZero', 'breadIncreased', 'breadNbt', 'supplyNbt']) test(`${mode} cannot be accepted as harmless received-prefix use`, async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  if (mode === 'missing') f.bag[2] = empty()
  if (mode === 'metadata') f.bag[2].metadata++
  if (mode === 'blockRuntime') f.bag[2].block_runtime_id++
  if (mode === 'network') f.bag[2].network_id = raw('minecraft:stone_sword').network_id
  if (mode === 'enchant') root(f.bag[2]).ench.value.value[0].lvl.value++
  if (mode === 'rename') root(f.bag[2]).display = { type: 'compound', value: { Name: { type: 'string', value: 'different sword' } } }
  if (mode === 'repair') root(f.armor[0]).Damage.value = 9
  if (mode === 'damageFloat') root(f.armor[0]).Damage.value = 13.5
  if (mode === 'damageType') root(f.armor[0]).Damage.type = 'float'
  if (mode === 'breadZero') f.bag[0] = empty()
  if (mode === 'breadIncreased') f.bag[0].count = 65
  if (mode === 'breadNbt') root(f.bag[0]).CustomName = { type: 'string', value: 'different bread' }
  if (mode === 'supplyNbt') root(f.bag[10]).Items.value.value[0].Count.value--
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'blocked', mode); assert.equal(f.transfers.length, 11, mode)
  assertOriginalPrefix(f, result.checkpoint)
})

for (const mode of ['mainUnknown', 'mainSlotUnknown', 'armorUnknown', 'rawArmorMissing', 'rawArmorNbtUnknown']) test(`${mode} cannot be replaced with ACK-derived or cached prefix proof`, async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  const getView = f.ports.getView, getRawEquipment = f.ports.getRawEquipment
  if (mode === 'mainUnknown') f.state.inventory.known = false
  if (mode === 'mainSlotUnknown') f.ports.getView = () => { const view = getView(); view.slots[35].known = false; return view }
  if (mode === 'armorUnknown') f.ports.getView = () => { const view = getView(); view.armor.known = false; view.armor.slots[0].known = false; return view }
  if (mode === 'rawArmorMissing') f.ports.getRawEquipment = (kind, slot) => kind === 'armor' && slot === 0 ? null : getRawEquipment(kind, slot)
  if (mode === 'rawArmorNbtUnknown') delete f.armor[0].extra.nbt
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'blocked', mode); assert.equal(f.transfers.length, 11, mode)
})

test('one actual cargo stack cannot satisfy two identical confirmed receipt anchors', async () => {
  const f = await pausedPrefix(14)
  f.bag[13] = empty()
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'blocked'); assert.equal(f.transfers.length, 14)
  assertOriginalPrefix(f, result.checkpoint)
})

for (const mode of ['receipt', 'missingIdentity']) test(`${mode} cannot authorize prefix use without its original confirmed anchor`, async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  if (mode === 'receipt') f.checkpoint.receipts[0].count++
  if (mode === 'missingIdentity') delete f.checkpoint.identities[0]
  const result = await f.run({ allowReceivedPrefixUse: true })
  assert.equal(result.status, 'blocked'); assert.equal(f.transfers.length, 11)
})

test('failed durable prefix-use observation prevents the first remaining transfer', async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  const result = await f.run({ allowReceivedPrefixUse: true }, async cp => {
    if (cp.prefixUseObservations?.length) throw Object.assign(new Error('audit storage unavailable'), { code: 'PERSISTENCE_FAILED' })
  })
  assert.equal(result.reason, 'PERSISTENCE_FAILED'); assert.equal(f.transfers.length, 11)
  assertOriginalPrefix(f, result.checkpoint)
})

test('received prefix changed while saving its audit is rechecked before another wire', async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  let changed = false
  const result = await f.run({ allowReceivedPrefixUse: true }, async cp => {
    if (!changed && cp.prefixUseObservations?.length) { changed = true; f.bag[0] = empty() }
  })
  assert.equal(changed, true)
  assert.equal(result.status, 'blocked'); assert.equal(f.transfers.length, 11)
  assertOriginalPrefix(f, result.checkpoint)
})

test('wear cannot decrease below a previously durable observation even when still above the original receipt', async () => {
  const f = await pausedPrefix(); useReceivedKit(f)
  let observed = false
  const stopped = await f.run({ allowReceivedPrefixUse: true }, async cp => {
    if (cp.prefixUseObservations?.length) observed = true
    if (observed && cp.intent == null) throw Object.assign(new Error('pause before another intent'), { code: 'PERSISTENCE_FAILED' })
  })
  assert.equal(observed, true); assert.equal(stopped.reason, 'PERSISTENCE_FAILED'); assert.equal(f.transfers.length, 11)
  root(f.bag[2]).Damage.value = 11
  const result = await worker(f).withdrawAll({ ...request(f), checkpoint: copy(stopped.checkpoint), allowReceivedPrefixUse: true }, f.options)
  assert.equal(result.status, 'blocked'); assert.equal(f.transfers.length, 11)
})
