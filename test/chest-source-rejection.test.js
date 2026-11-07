'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { deserialize } = require('node:v8')
const file = path.resolve(__dirname, 'chest.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, air, target }\n', file)
const { fixture, item, air, target } = loaded.exports
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const response = (f, status = 49, id = -501, options) => f.observe('item_stack_response', { responses: [{ status, request_id: id }] }, options)
const rejected = promise => promise.then(() => { throw new Error('rejected transfer unexpectedly completed') }, error => error)

test('only the matching live source-slot rejection records immutable JSON-safe exact request evidence', async () => {
  const f = fixture()
  const source = item(401, 5, 88)
  source.extra = { has_nbt: true, can_place_on: [], can_destroy: [], nbt: { version: 1, nbt: { type: 'compound', name: '', value: { LongProof: { type: 'long', value: 123n } } } } }
  f.main(14, source)
  const pending = rejected(f.chest.depositItem({ sourceSlot: 14, chestSlot: 0, count: 5, expectedName: 'minecraft:diamond' }))
  // The received source grows and gets a new ID before the rejected response.
  // The proof must retain the sent descriptor, never the latest replacement.
  f.main(14, { ...structuredClone(source), count: 10, stack_id: 99 })
  response(f)
  const error = await pending, proof = error.details?.rejectionProof
  assert.ok(proof, 'an actual status49 must survive cancellation as rejection evidence')
  assert.equal(proof.kind, 'chest_source_slot_rejection')
  assert.equal(proof.version, 1)
  assert.equal(proof.origin, 'matching_live_server_response')
  assert.equal(proof.status, 49); assert.equal(proof.protocolStatusCode, 49)
  assert.equal(proof.requestId, -501); assert.equal(proof.operation, 'deposit_item')
  assert.equal(proof.sourceSlot, 14); assert.equal(proof.playerSlot, 14); assert.equal(proof.chestSlot, 0)
  assert.equal(proof.count, 5); assert.equal(proof.item, 'minecraft:diamond')
  assert.equal(proof.windowId, 5); assert.ok(Number.isSafeInteger(proof.windowEpoch))
  assert.deepEqual(proof.position, target); assert.equal(proof.scope.life, 0)
  assert.equal(proof.scope.connectionId, f.state.connectionId)
  assert.equal(proof.wireSent, true); assert.equal(proof.serverRejected, true)
  assert.ok(Number.isSafeInteger(proof.observedAt))
  assert.equal(proof.rawEncoding, 'v8-base64')
  assert.deepEqual(unpack(proof.sourceBefore), source)
  assert.deepEqual(unpack(proof.destinationBefore), air())
  const json = JSON.parse(JSON.stringify({ errorDetails: error.details, snapshot: f.chest.snapshot() }))
  assert.equal(unpack(json.errorDetails.rejectionProof.sourceBefore).extra.nbt.nbt.value.LongProof.value, 123n)
  assert.deepEqual(json.snapshot.lastResult.rejectionProof, proof)
  assert.equal(json.snapshot.lastResult.serverConfirmed, false)
  assert.equal(json.snapshot.busy, false)
  assert.equal(f.reconciliations.length, 0)
  assert.equal(f.uncertain.length, 0, 'explicit rejection retains the existing cancel semantics')
  proof.count = 99; proof.scope.life = 99; proof.sourceBefore = ''
  assert.equal(f.chest.snapshot().lastResult.rejectionProof.count, 5)
  assert.equal(f.chest.snapshot().lastResult.rejectionProof.scope.life, 0)
  assert.deepEqual(unpack(f.chest.snapshot().lastResult.rejectionProof.sourceBefore), source)
  response(f)
  assert.equal(f.packets.filter(packet => packet.name === 'item_stack_request').length, 1)
})

test('a rejected withdrawal binds source to the real chest slot and destination to the real player slot', async () => {
  const f = fixture({ blockName: 'minecraft:undyed_shulker_box' })
  const source = item(401, 7, 810); f.chestSlot(3, source)
  const pending = rejected(f.chest.withdrawItem({ chestSlot: 3, targetSlot: 15, count: 2, expectedName: 'minecraft:diamond' }))
  response(f)
  const proof = (await pending).details?.rejectionProof
  assert.ok(proof)
  assert.equal(proof.operation, 'withdraw_item')
  assert.equal(proof.sourceSlot, 3); assert.equal(proof.playerSlot, 15); assert.equal(proof.chestSlot, 3)
  assert.deepEqual(unpack(proof.sourceBefore), source)
  assert.deepEqual(unpack(proof.destinationBefore), air())
  assert.equal(f.crafting.rawItem(15).count, 0); assert.equal(f.chest.rawItem(3).count, 7)
  assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
})

test('the actual 1.26.60 packet codec preserves numeric source-slot rejection49 for the matching request', async () => {
  const f = fixture({ actualCrafting: true, wireDecode: true })
  const pending = rejected(f.chest.depositItem({ sourceSlot: 14, chestSlot: 0, count: 1, expectedName: 'minecraft:diamond' }))
  f.ack(-501, 49)
  const error = await pending
  assert.equal(error.details?.rejectionProof.status, 49)
  assert.equal(error.details?.rejectionProof.requestId, -501)
  assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
  assert.equal(f.reconciliations.length, 0)
})

test('other status codes, wrong/replayed requests and changed authority never create source49 proof', async t => {
  for (const mode of ['status1', 'status48', 'status50', 'status_string', 'wrong_request', 'replay', 'life', 'connection', 'window', 'cancel', 'timeout', 'not_sent', 'accepted_then_rejected']) await t.test(mode, async () => {
    const f = fixture({ timeoutMs: 50 })
    if (mode === 'not_sent') {
      const queue = f.client.queue
      f.client.queue = (name, packet) => { queue(name, packet); if (name === 'item_stack_request') response(f) }
    }
    const pending = rejected(f.chest.depositItem({ sourceSlot: 14, chestSlot: 0, count: 1, expectedName: 'minecraft:diamond' }))
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'connection') f.state.connectionId = 'different'
    if (mode === 'window') f.openedPacket(target, 6)
    if (mode === 'cancel') { f.chest.cancel('user cancellation'); response(f) }
    else if (mode === 'accepted_then_rejected') { f.ack(); response(f) }
    else if (mode === 'wrong_request') { response(f, 49, -503); assert.equal(f.chest.snapshot().busy, true); f.chest.cancel('wrong response ignored') }
    else if (mode === 'replay') { response(f, 49, -501, { replaying: true }); assert.equal(f.chest.snapshot().busy, true); f.chest.cancel('replayed response ignored') }
    else if (mode.startsWith('status')) response(f, mode === 'status_string' ? '49' : Number(mode.slice(6)))
    else if (!['timeout', 'not_sent'].includes(mode)) response(f)
    const error = await pending
    assert.equal(error.details?.rejectionProof, undefined)
    assert.equal(f.chest.snapshot().lastResult.rejectionProof, undefined)
    assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
    assert.equal(f.reconciliations.length, 0)
    assert.equal(f.packets.filter(packet => packet.name === 'item_stack_request').length, 1)
  })
})
