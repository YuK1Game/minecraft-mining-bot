'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createPlainsLocator } = require('../src/locate-plains')

const encoder = createSerializer('1.26.60'), decoder = createDeserializer('1.26.60')
const wire = (name, params) => decoder.parsePacketBuffer(encoder.createPacketBuffer({ name, params })).data.params
function fixture (options = {}) {
  const sent = [], state = { phase: 'spawned', profile: 'test', realm: { id: '1' }, connectionId: '1', startedAt: '2026-11-06', dimension: 'overworld', runtimeEntityId: '1', health: 20, lifecycle: { deathId: 0 } }
  const service = createPlainsLocator({ client: { queue: (name, params) => sent.push(wire(name, params)) }, getState: () => state, ...options })
  const receipt = () => wire('command_output', { origin: sent.at(-1).origin, output_type: 'alloutput', success_count: 1, has_data: false, output: [{ success: true, message_id: 'commands.locate.biome.success', parameters: ['minecraft:plains', '260', '68', '-254', '870'] }] })
  return { service, sent, state, receipt }
}

test('only the matching live 1.26.60 output supplies a plains location', async () => {
  const f = fixture(), locating = f.service.locate(), receipt = f.receipt()
  assert.equal(f.sent[0].command, '/locate biome minecraft:plains')
  assert.equal((await f.service.locate()).reason, 'LOCATE_BUSY')
  const foreign = structuredClone(receipt)
  foreign.origin.uuid = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  f.service.applyPacket('command_output', foreign)
  f.service.applyPacket('command_output', receipt, { replaying: true })
  assert.equal(f.service.snapshot().pending, true)
  f.service.applyPacket('command_output', receipt)
  const result = await locating
  assert.equal(result.requestId, f.sent[0].origin.uuid)
  assert.equal(result.serverConfirmed, true)
  assert.deepEqual(result.position, { x: 260, y: 68, z: -254 })
  assert.deepEqual(result.serverOutput.output, receipt.output)
  const next = f.service.locate()
  f.service.applyPacket('command_output', receipt)
  assert.equal(f.service.snapshot().pending, true)
  f.service.cancel()
  assert.equal((await next).reason, 'LOCATE_INTERRUPTED')
})

test('require a known overworld life and refuse late, invalid and reused receipts', async () => {
  const f = fixture({ randomUUID: () => 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' })
  f.state.dimension = 'nether'
  assert.equal((await f.service.locate()).reason, 'LOCATE_STATE_UNAVAILABLE')
  f.state.dimension = 'overworld'
  const pending = f.service.locate(), packet = f.receipt()
  f.state.lifecycle.deathId++
  f.service.applyPacket('command_output', packet)
  assert.equal((await pending).reason, 'LOCATE_SCOPE_CHANGED')
  assert.equal((await f.service.locate()).reason, 'LOCATE_INVALID_REQUEST_ID')
  let time = 100
  const timed = fixture({ now: () => time })
  const late = timed.service.locate()
  time += 21000
  timed.service.applyPacket('command_output', timed.receipt())
  assert.equal((await late).reason, 'LOCATE_TIMEOUT')
})

test('reject failure, other biome, invalid schema and invalid coordinates while retaining server output', async () => {
  for (const corrupt of [
    p => { p.success_count = 0 },
    p => { p.output[0].message_id = 'commands.locate.structure.success' },
    p => { p.output[0].parameters[0] = 'desert' },
    p => { p.output[0].parameters[1] = '30X' },
    p => { p.output[0].parameters[2] = '322' },
    p => { p.output[0].parameters.pop() }
  ]) {
    const f = fixture(), pending = f.service.locate(), reply = f.receipt()
    corrupt(reply)
    f.service.applyPacket('command_output', reply)
    const result = await pending
    assert.equal(result.reason, 'LOCATE_OUTPUT_UNCONFIRMED')
    assert.equal(result.position, undefined)
    assert.deepEqual(result.serverOutput.output, reply.output)
  }
})
