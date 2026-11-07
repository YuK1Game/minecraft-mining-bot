'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { serialize, deserialize } = require('node:v8')

const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const packRaw = raw => serialize(raw).toString('base64')
function proofRaw (proof, field) {
  assert.equal(proof.rawEncoding, 'v8-base64')
  assert.equal(typeof proof[field], 'string')
  return deserialize(Buffer.from(proof[field], 'base64'))
}
function sourceModule (filename, source) {
  const loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(source, filename)
  return loaded.exports
}
function factory (name, environment) {
  const filename = require.resolve(`../src/${name}`)
  return process.env[environment] ? sourceModule(filename, fs.readFileSync(process.env[environment], 'utf8')) : require(filename)
}
function prefixFixture (name, exports) {
  const filename = require.resolve(`./${name}`)
  return sourceModule(filename, fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + `\nmodule.exports = ${exports}\n`)
}
const { createInteractions } = factory('interactions', 'PLACEMENT_INTERACTIONS_TEST_SOURCE')
const { createQuarryPortableStorage } = factory('quarry-portable-storage', 'PLACEMENT_PORTABLE_TEST_SOURCE')

test('real placement retains the actual consumed source observation when a pickup refills its slot before await resumes', async () => {
  const { fixture, emptyItem } = prefixFixture('interactions.test', '{ fixture, emptyItem }')
  const f = fixture()
  f.interactions = createInteractions({ client: { queue: (name, packet) => f.packets.push({ name, packet }) }, getState: () => f.state,
    world: { getBlock: (x, y, z) => f.blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] } }, crafting: f.crafting, getInput: () => f.input, timeoutMs: 1000 })
  Object.assign(f.state, { profile: 'bot', realm: { id: '42' }, connectionId: 'placement-scope', startedAt: '2026-11-07T00:00:00+09:00', lifecycle: { deathId: 2 } })
  f.names.set(777, 'minecraft:undyed_shulker_box')
  const source = copy(f.raw.get(0)), pending = f.interactions.placeBlock({ position: f.target, slot: 0 })
  f.setBlock(f.target, 'undyed_shulker_box', 20)
  f.interactions.applyPacket('update_block', { position: f.target })
  f.raw.set(0, emptyItem())
  f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: emptyItem() })
  const stone = { ...copy(source), network_id: 900, stack_id: 901, count: 1 }
  f.raw.set(0, stone)
  f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: stone })
  const receipt = await pending, proof = receipt.placementObservation
  assert.equal(receipt.phase, 'completed')
  assert.ok(proof, 'the successful lower layer must expose its actual observation, not ask the upper layer to infer it again')
  assert.deepEqual(proofRaw(proof, 'sourceBefore'), source)
  const consumed = proofRaw(proof, 'sourceAfter')
  assert.equal(consumed.network_id, 0); assert.equal(consumed.count, 0)
  assert.deepEqual(proof.targetBlock, { position: f.target, name: 'minecraft:undyed_shulker_box', runtimeId: 20 })
  assert.equal(proof.slot, 0); assert.equal(proof.wireSent, true); assert.equal(proof.transactionQueued, true)
  assert.equal(proof.requestId, receipt.requestId); assert.ok(Number.isInteger(proof.requestId) && proof.requestId < 0 && proof.requestId % 2 === 0)
  assert.equal(proof.scope.connectionId, f.state.connectionId); assert.equal(proof.scope.life, 2); assert.equal(proof.life, 2)
  assert.equal(f.raw.get(0).network_id, 900)
  proof.sourceBefore = packRaw({ ...proofRaw(proof, 'sourceBefore'), count: 99 })
  proof.sourceAfter = packRaw({ ...proofRaw(proof, 'sourceAfter'), count: 99 })
  proof.targetBlock.position.x = 99
  const retained = f.interactions.snapshot().lastResult.placementObservation
  assert.equal(proofRaw(retained, 'sourceBefore').count, 1); assert.equal(proofRaw(retained, 'sourceAfter').count, 0); assert.equal(retained.targetBlock.position.x, f.target.x)
  assert.equal(f.transactions.length, 1)
})

test('BigInt NBT placement evidence is JSON portable without losing raw type, value or immutability', async () => {
  const { fixture, emptyItem } = prefixFixture('interactions.test', '{ fixture, emptyItem }')
  const f = fixture()
  Object.assign(f.state, { profile: 'bot', realm: { id: '42' }, connectionId: 'placement-bigint', startedAt: '2026-11-07T00:00:00+09:00', lifecycle: { deathId: 2 } })
  f.interactions = createInteractions({ client: { queue: (name, packet) => f.packets.push({ name, packet }) }, getState: () => f.state,
    world: { getBlock: (x, y, z) => f.blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] } }, crafting: f.crafting, getInput: () => f.input, timeoutMs: 1000 })
  f.names.set(777, 'minecraft:undyed_shulker_box'); f.names.set(778, 'minecraft:diamond_pickaxe')
  const source = copy(f.raw.get(0)), long = (1n << 60n) + 7n
  source.extra = { has_nbt: true, can_place_on: [], can_destroy: [], nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: [] } }, TestLong: { type: 'long', value: long } } } } }
  const other = { ...copy(source), network_id: 778, stack_id: 93 }
  other.extra.nbt.nbt.value.TestLong.value = -long
  f.raw.set(0, copy(source)); f.raw.set(1, other)
  const pending = f.interactions.placeBlock({ position: f.target, slot: 0 })
  f.setBlock(f.target, 'undyed_shulker_box', 20); f.interactions.applyPacket('update_block', { position: f.target })
  f.raw.set(0, emptyItem()); f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: emptyItem() })
  const stone = { ...copy(source), network_id: 900, stack_id: 901 }
  f.raw.set(0, stone); f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: stone })
  const receipt = await pending, snapshot = f.interactions.snapshot()
  assert.equal(receipt.phase, 'completed')
  let json
  assert.doesNotThrow(() => { json = JSON.stringify({ receipt, snapshot }) }, 'HTTP-facing receipt and status snapshot must be valid JSON even with NBT long values')
  const restored = JSON.parse(json), decoded = proofRaw(restored.receipt.placementObservation, 'sourceBefore')
  assert.deepEqual(decoded, source)
  assert.equal(typeof decoded.extra.nbt.nbt.value.TestLong.value, 'bigint')
  assert.equal(decoded.extra.nbt.nbt.value.TestLong.value, long)
  assert.deepEqual(proofRaw(restored.receipt.placementObservation, 'sourceAfter'), emptyItem())
  assert.deepEqual(proofRaw(restored.snapshot.lastResult.placementObservation, 'sourceBefore'), source)
  decoded.count = 99; decoded.extra.nbt.nbt.value.TestLong.value = 0n
  receipt.placementObservation.sourceBefore = packRaw(decoded)
  assert.deepEqual(proofRaw(f.interactions.snapshot().lastResult.placementObservation, 'sourceBefore'), source)
  assert.equal(f.raw.get(1).extra.nbt.nbt.value.TestLong.value, -long, 'unrelated item observations remain untouched')
  assert.equal(f.transactions.length, 1)
})

function portableRace ({ mutate = null, sourceContents = null, actualContents = null } = {}) {
  const { fixture, item, airItem, carriedBox } = prefixFixture('quarry-portable-storage.test', '{ fixture, item, airItem, carriedBox }')
  const f = fixture('shulker')
  const emptyContents = Array.from({ length: 27 }, airItem)
  f.bag[0].count = 8
  f.bag[14] = carriedBox(sourceContents ?? emptyContents, 20)
  for (let slot = 1; slot <= 24; slot++) if (slot !== 14) f.bag[slot] = carriedBox(emptyContents, 2000 + slot)
  for (let slot = 25; slot < 36; slot++) f.bag[slot] = item(4, 64, 3000 + slot)
  assert.equal(f.items().length, 36)
  const receipts = [], packets = [], placements = [], opening = f.dependencies.chest.open
  f.dependencies.chest.open = async (...args) => {
    const position = args[0]
    if (!f.containers.has(key(position))) f.containers.set(key(position), copy(actualContents ?? sourceContents ?? emptyContents))
    return opening(...args)
  }
  const crafting = { ...f.crafting, snapshot: () => f.crafting.inventorySnapshot(), applyPacket: (name, packet) => { if (name === 'inventory_slot') f.bag[packet.slot] = copy(packet.item) } }
  const input = { stats: () => ({ running: false, target: null }), lookAt () {}, start () {}, stop () {}, sendTransaction: (transaction, options) => { placements.push(copy(transaction)); options?.onSent?.() } }
  const interactions = createInteractions({ client: { queue: (name, packet) => packets.push({ name, packet }) }, getState: f.getState, world: { getBlock: f.getBlock }, crafting, getInput: () => input, timeoutMs: 1000 })
  const ports = {
    snapshot: () => interactions.snapshot(),
    previewPlace: options => interactions.previewPlace(options),
    placeBlock: async options => {
      const source = copy(f.bag[options.slot]), pending = interactions.placeBlock(options)
      f.blocks.set(key(options.position), { known: true, name: 'minecraft:undyed_shulker_box', runtimeId: 2, boundingBox: 'block', extra: [] })
      interactions.applyPacket('update_block', { position: options.position })
      f.bag[options.slot] = airItem()
      interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: options.slot, item: airItem() })
      f.bag[options.slot] = item(4, 1, 70000)
      interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: options.slot, item: copy(f.bag[options.slot]) })
      const receipt = await pending
      receipts.push(copy(receipt))
      mutate?.({ f, receipt, source, slot: options.slot, position: options.position, item, airItem, carriedBox })
      return receipt
    }
  }
  const runner = createQuarryPortableStorage({ ...f.dependencies, interactions: ports })
  f.controller.ownsShulker = (...args) => runner.ownsShulker(...args)
  return { f, runner, placements, receipts, packets, run: checkpoint => runner.storeCarried({ ...copy(f.request), ...(checkpoint ? { checkpoint: copy(checkpoint) } : {}) }, { canPlace: () => true, onCheckpoint: async cp => f.checkpoints.push(copy(cp)) }) }
}

test('a full 36-slot inventory can place, receive stone in the freed slot, deposit to make recovery room, and recover the same exact contents', async () => {
  const h = portableRace(), result = await h.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.recovered, true)
  assert.equal(h.placements.length, 1)
  assert.equal(h.f.events.filter(event => event.type === 'deposit').length, 1)
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
  assert.equal(h.f.items().filter(item => /shulker_box$/.test(item.name)).length, 24)
  assert.equal(h.f.items().length, 36, 'normal deposit creates exactly the slot needed for recovering the box')
  assert.equal(result.deposited.reduce((sum, entry) => sum + entry.count, 0), 8)
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  assert.equal(proofRaw(h.receipts[0].placementObservation, 'sourceAfter').count, 0)
  assert.deepEqual(proofRaw(result.checkpoint.placed[0].placementObservation, 'sourceBefore'), proofRaw(h.receipts[0].placementObservation, 'sourceBefore'), 'persisted proof is encoded once and retains the received descriptor')
  assert.ok(result.checkpoint.initialContentsVerified, 'the fresh opened contents agree with the known placed source before transfer')
})

test('current source-slot reuse cannot hide moved sources, lost boxes, changed contents or mismatched placement evidence', async t => {
  const changes = {
    'source still exists in another slot': ({ f, source }) => { f.bag[25] = copy(source) },
    'a different old box disappears': ({ f, airItem }) => { f.bag[5] = airItem() },
    'source moved and another box lost leaves the same total box count': ({ f, source, airItem }) => { f.bag[25] = copy(source); f.bag[5] = airItem() },
    'a retained box NBT changed without changing its ID': ({ f }) => { f.bag[5].extra.nbt.nbt.value.CustomName = { type: 'string', value: 'different contents or identity' } },
    'the target block changed': ({ f, position }) => { f.blocks.set(key(position), { known: true, name: 'minecraft:stone', runtimeId: 4, boundingBox: 'block', extra: [] }) },
    'target geometry is unknown': ({ f, position }) => { f.blocks.set(key(position), { known: false }) },
    'current main inventory is unknown': ({ f }) => { f.state.inventory.known = false },
    'connection changed': ({ f }) => { f.state.connectionId = 'another-connection' },
    'dimension changed': ({ f }) => { f.state.dimension = 'nether' },
    'life changed': ({ f }) => { f.state.lifecycle.deathId++ },
    'receipt was not completed': ({ receipt }) => { receipt.phase = 'failed' },
    'receipt is not server block and inventory': ({ receipt }) => { receipt.confirmedBy = 'sent_only' },
    'observation is absent': ({ receipt }) => { delete receipt.placementObservation },
    'observation targets another coordinate': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.targetBlock.position.x++ },
    'observation source identity changed': ({ receipt }) => { if (receipt.placementObservation) { const raw = proofRaw(receipt.placementObservation, 'sourceBefore'); raw.stack_id++; receipt.placementObservation.sourceBefore = packRaw(raw) } },
    'observation does not prove an actual empty source': ({ receipt, item }) => { if (receipt.placementObservation) receipt.placementObservation.sourceAfter = packRaw(item(4, 1, 70000)) },
    'observation source payload is not v8': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.sourceBefore = 'not-a-v8-descriptor' },
    'observation source-after payload is empty': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.sourceAfter = '' },
    'observation source payload is an unsupported raw object': ({ receipt, source }) => { if (receipt.placementObservation) receipt.placementObservation.sourceBefore = copy(source) },
    'observation has an unsupported encoding': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.rawEncoding = 'json' },
    'observation has no encoding declaration': ({ receipt }) => { if (receipt.placementObservation) delete receipt.placementObservation.rawEncoding },
    'observation belongs to another request': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.requestId -= 2 },
    'observation was not queued': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.transactionQueued = false },
    'observation was not sent': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.wireSent = false },
    'observation has another scope': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.scope.connectionId = 'another-connection' },
    'observation has another life': ({ receipt }) => { if (receipt.placementObservation) receipt.placementObservation.life++ }
  }
  for (const [label, mutate] of Object.entries(changes)) await t.test(label, async () => {
    const h = portableRace({ mutate }), result = await h.run()
    assert.equal(result.status, 'blocked', label)
    assert.equal(result.recovered, false, label)
    assert.equal(h.placements.length, 1)
    assert.equal(h.f.events.filter(event => ['deposit', 'mine'].includes(event.type)).length, 0, 'unconfirmed placement never transfers or breaks')
    assert.equal(result.checkpoint.stage, 'placing')
    assert.equal(result.checkpoint.intent.type, 'place')
  })
})

test('known source contents must agree with the freshly opened placed box before the first transfer', async () => {
  const { item, airItem } = prefixFixture('quarry-portable-storage.test', '{ item, airItem }')
  const sourceContents = Array.from({ length: 27 }, airItem)
  sourceContents[3] = item(3, 1, 8100)
  const h = portableRace({ sourceContents, actualContents: Array.from({ length: 27 }, airItem) }), result = await h.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.recovered, false)
  assert.equal(h.placements.length, 1)
  assert.equal(h.f.events.filter(event => ['deposit', 'mine'].includes(event.type)).length, 0)
  assert.ok(result.checkpoint.initialContents)
  assert.notEqual(result.checkpoint.initialContentsVerified, true)
})

test('a known filled source resumes a confirmed transfer without replaying placement or demanding the original contents again', async () => {
  const { item, airItem } = prefixFixture('quarry-portable-storage.test', '{ item, airItem }')
  const sourceContents = Array.from({ length: 27 }, airItem)
  sourceContents[3] = item(3, 1, 8200)
  const h = portableRace({ sourceContents }), interrupted = new AbortController()
  let checkpoint
  const first = await h.runner.storeCarried(copy(h.f.request), { signal: interrupted.signal, canPlace: () => true, onCheckpoint: async cp => {
    if (!checkpoint && cp.stage === 'depositing' && cp.intent == null && cp.deposited.reduce((sum, entry) => sum + entry.count, 0) === 8) { checkpoint = copy(cp); interrupted.abort() }
  } })
  assert.equal(first.status, 'blocked')
  assert.ok(checkpoint?.initialContentsVerified)
  assert.equal(checkpoint.plan[0].transferred, 8)
  assert.doesNotThrow(() => JSON.stringify(checkpoint), 'persisted evidence contains encoded raw descriptors')
  const result = await h.run(checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.recovered, true)
  assert.equal(result.deposited.reduce((sum, entry) => sum + entry.count, 0), 8)
  assert.equal(h.placements.length, 1)
  assert.equal(h.f.events.filter(event => event.type === 'deposit').length, 1)
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
  assert.equal(h.f.items().filter(entry => /shulker_box$/.test(entry.name)).length, 24)
})

test('an old placing checkpoint without the completed observation remains unconfirmed and is never placed twice', async () => {
  const h = portableRace({ mutate: ({ receipt }) => { delete receipt.placementObservation } })
  const first = await h.run()
  assert.equal(first.status, 'blocked')
  const checkpoint = copy(first.checkpoint)
  delete checkpoint.intent.boxesBefore
  const beforeEvents = h.f.events.length, second = await h.run(checkpoint)
  assert.equal(second.status, 'blocked')
  assert.equal(second.recovered, false)
  assert.equal(h.placements.length, 1)
  assert.deepEqual(second.checkpoint.intent, checkpoint.intent)
  assert.equal(h.f.events.slice(beforeEvents).filter(event => ['place', 'deposit', 'mine'].includes(event.type)).length, 0)
})
