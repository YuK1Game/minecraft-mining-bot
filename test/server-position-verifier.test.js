'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServerPositionVerifier } = require('../src/server-position-verifier')

const feet = { x: -48.5, y: -1, z: 36.5 }
function fixture (options = {}) {
  let clock = 1000; let reads = 0; let serial = 0
  const state = { profile: 'position-test', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', dimension: 'overworld', runtimeEntityId: '41', playerName: 'Bot', lifecycle: { deathId: 2 }, phase: 'spawned', health: 20, gameMode: 'survival', rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'client_prediction' }
  const sent = []
  const verifier = createServerPositionVerifier({ client: { queue: (name, packet) => sent.push({ name, packet: structuredClone(packet) }) }, getState: () => { reads++; return state }, now: () => clock, timeoutMs: 100, randomUUID: () => `12345678-1234-4321-8765-${String(++serial).padStart(12, '0')}`, ...options })
  // The confirming reply of the inverted selector: no target matched.
  const output = (patch = {}) => ({ origin: structuredClone(sent.at(-1).packet.origin), output_type: 'all_output', success_count: 0, output: [{ message_id: 'commands.generic.noTargetMatch', success: false, parameters: [] }], has_data: false, ...patch })
  const found = (patch = {}) => output({ success_count: 1, output: [{ message_id: 'commands.testfor.success', success: true, parameters: ['Bot'] }], ...patch })
  return { verifier, state, sent, output, found, reads: () => reads, advance: ms => { clock += ms } }
}

test('the pinned command_output schema uses origin, success_count and output message containers', () => {
  const protocol = require('../node_modules/minecraft-data/minecraft-data/data/bedrock/1.26.60/protocol.json')
  assert.deepEqual(protocol.types.packet_command_output[1].map(f => f.name), ['origin', 'output_type', 'success_count', 'output', 'has_data', 'data'])
  const messages = protocol.types.packet_command_output[1].find(f => f.name === 'output')
  assert.deepEqual(messages.type[1].type[1].map(f => f.name), ['message_id', 'success', 'parameters'])
})

test('only the requested inverted testfor volume and its matching no-target reply supply a position receipt', async () => {
  const f = fixture(); const before = structuredClone(f.state)
  const pending = f.verifier.confirm(feet, { operationId: 'pillar:step:1' })
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].name, 'command_request')
  assert.equal(f.sent[0].packet.command, '/testfor @s[x=-48.5,y=-1,z=36.5,rm=0.12]')
  assert.equal(f.sent[0].packet.origin.request_id, '', 'use the known Realm command envelope; the UUID identifies the request')
  assert.equal(f.verifier.snapshot().lastResult, null, 'sending supplies no position evidence')
  f.advance(20)
  assert.equal(f.verifier.applyPacket('command_output', f.output()), true)
  const receipt = await pending
  assert.equal(receipt.serverConfirmed, true)
  assert.equal(receipt.kind, 'server_position_volume')
  assert.deepEqual(receipt.feet, feet)
  assert.equal(receipt.radius, 0.12)
  assert.equal(receipt.receivedAt, 1020)
  assert.deepEqual(JSON.parse(receipt.scope), ['position-test', '1', 'c1', 't1', 'overworld', '41', 2])
  assert.deepEqual(f.state, before, 'the received raw pose is never rewritten')
})

test('a real ProtoDef li64 command origin is accepted without coercing malformed values', async () => {
  const f = fixture(), pending = f.verifier.confirm(feet)
  const packet = f.output()
  packet.origin.player_entity_id = require('protodef/src/datatypes/numeric').li64[0](Buffer.alloc(8), 0).value
  assert.equal(packet.origin.player_entity_id.constructor.name, 'SignedBigInt')
  f.verifier.applyPacket('command_output', packet)
  assert.equal((await pending).serverConfirmed, true)
  const invalid = fixture(), bad = invalid.verifier.confirm(feet), malformed = invalid.output()
  malformed.origin.player_entity_id = [0, 2147483648]
  invalid.verifier.applyPacket('command_output', malformed)
  assert.equal((await bad).serverConfirmed, false)
})

test('unknown UUIDs, predictions, movement hints and chunk packets cannot satisfy the request', async () => {
  const f = fixture(); const pending = f.verifier.confirm(feet)
  const reads = f.reads()
  for (const name of ['level_chunk', 'move_entity_delta', 'server_post_move', 'player_auth_input']) assert.equal(f.verifier.applyPacket(name, { position: feet }), false)
  const other = f.output(); other.origin.uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  assert.equal(f.verifier.applyPacket('command_output', other), false)
  assert.equal(f.reads(), reads)
  assert.equal(f.verifier.snapshot().pending, true)
  f.verifier.cancel('fixture cleanup')
  assert.equal((await pending).serverConfirmed, false)
})

test('a match of the inverted selector (the player is elsewhere) is a negative result, not a position or a command retry', async () => {
  const f = fixture(); const pending = f.verifier.confirm(feet)
  f.verifier.applyPacket('command_output', f.found())
  const result = await pending
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.reason, 'POSITION_NOT_FOUND')
  assert.equal(f.sent.length, 1)
  assert.equal(f.verifier.snapshot().pending, false)
})

test('ambiguous and malformed no-target replies never count as a position', async () => {
  const variants = [
    p => { p.success_count = 2 },
    p => { p.output[0].success = true },
    p => { p.output[0].message_id = 'commands.give.success' },
    p => { p.output[0].message_id = 'commands.generic.syntax' },
    p => { p.output[0].parameters = [42] },
    p => { p.output.push(p.output[0]) },
    p => { p.output_messages = p.output; delete p.output },
    p => { delete p.origin.request_id },
    p => { p.origin.type = 'command_block' },
    p => { p.origin.player_entity_id = 'not an int64' },
    p => { delete p.has_data },
    p => { p.has_data = true; p.data = {} }
  ]
  for (const corrupt of variants) {
    const f = fixture(); const pending = f.verifier.confirm(feet)
    const packet = f.output(); corrupt(packet)
    f.verifier.applyPacket('command_output', packet)
    const result = await pending
    assert.equal(result.serverConfirmed, false)
    assert.ok(['POSITION_OUTPUT_UNCONFIRMED', 'POSITION_COMMAND_REJECTED'].includes(result.reason), result.reason)
  }
})

test('a namespaced no-target key is accepted but an explicit permission refusal is not', async () => {
  const f = fixture()
  let pending = f.verifier.confirm(feet)
  f.verifier.applyPacket('command_output', f.output({ output: [{ message_id: '%commands.generic.noTargetMatch', success: false, parameters: [] }] }))
  assert.equal((await pending).serverConfirmed, true)
  pending = f.verifier.confirm(feet)
  f.verifier.applyPacket('command_output', f.output({ success_count: 0, output: [{ message_id: 'commands.generic.permission', success: false, parameters: [] }] }))
  assert.equal((await pending).reason, 'POSITION_COMMAND_REJECTED')
})

test('a changed connection, dimension, identity, realm or life rejects a matching UUID', async () => {
  const changes = [s => { s.connectionId = 'c2' }, s => { s.dimension = 'nether' }, s => { s.runtimeEntityId = '42' }, s => { s.realm.id = '2' }, s => { s.lifecycle.deathId++ }, s => { s.health = 0 }, s => { s.spawnPending = true }]
  for (const change of changes) {
    const f = fixture(); const pending = f.verifier.confirm(feet)
    change(f.state)
    f.verifier.applyPacket('command_output', f.output())
    const result = await pending
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.reason, 'POSITION_SCOPE_CHANGED')
  }
})

test('lifecycle packets cancel an outstanding witness immediately', async () => {
  for (const [name, packet] of [['disconnect', {}], ['respawn', {}], ['change_dimension', {}], ['entity_event', { runtime_entity_id: 41n, event_id: 'death_animation' }], ['set_health', { health: 0 }]]) {
    const f = fixture(); const pending = f.verifier.confirm(feet)
    f.verifier.applyPacket(name, packet)
    assert.equal((await pending).reason, 'POSITION_SCOPE_CHANGED')
    assert.equal(f.verifier.applyPacket('command_output', f.output()), false)
  }
})

test('cancellation, real timeout and late replies remain negative', async () => {
  const f = fixture({ timeoutMs: 25 }); const abort = new AbortController()
  let pending = f.verifier.confirm(feet, { signal: abort.signal })
  abort.abort(new Error('stop'))
  assert.equal((await pending).reason, 'POSITION_CANCELLED')
  assert.equal(f.verifier.applyPacket('command_output', f.output()), false)
  pending = f.verifier.confirm(feet)
  assert.equal((await pending).reason, 'POSITION_TIMEOUT')
  pending = f.verifier.confirm(feet)
  f.advance(26)
  f.verifier.applyPacket('command_output', f.output())
  assert.equal((await pending).reason, 'POSITION_TIMEOUT')
})

test('outstanding calls do not overlap, and old UUIDs are neither accepted nor reused', async () => {
  const f = fixture()
  let first = f.verifier.confirm(feet)
  assert.equal((await f.verifier.confirm({ ...feet, y: 0 })).reason, 'POSITION_VERIFIER_BUSY')
  const old = f.output()
  f.verifier.cancel(); await first
  first = f.verifier.confirm({ ...feet, y: 0 })
  assert.equal(f.verifier.applyPacket('command_output', old), false)
  f.verifier.applyPacket('command_output', f.output())
  assert.equal((await first).serverConfirmed, true)
  const repeated = fixture({ randomUUID: () => '12345678-1234-4321-8765-000000000001' })
  const pending = repeated.verifier.confirm(feet)
  repeated.verifier.cancel(); await pending
  assert.equal((await repeated.verifier.confirm(feet)).reason, 'POSITION_REQUEST_ID_REUSED')
  assert.equal(repeated.sent.length, 1)
})

test('non-centred, fractional-Y, injected or unavailable-state requests do not queue any command', async () => {
  const f = fixture()
  for (const p of [{ ...feet, x: -49 }, { ...feet, y: 0.5 }, { ...feet, z: Infinity }, { ...feet, x: '0,y=1]' }, { ...feet, y: NaN }]) assert.equal((await f.verifier.confirm(p)).reason, 'POSITION_INVALID_REQUEST')
  assert.equal(f.sent.length, 0)
  delete f.state.lifecycle
  assert.equal((await f.verifier.confirm(feet)).reason, 'POSITION_STATE_UNAVAILABLE')
  assert.equal(f.sent.length, 0)
})

test('a wider check accepts an off-centre pose with a bounded radius and still needs the matching server output', async () => {
  const f = fixture(); const before = structuredClone(f.state)
  const pending = f.verifier.confirm({ x: -28.8312, y: 36.004, z: 0.9631 }, { radius: 1.5, operationId: 'quarry:pose' })
  assert.equal(f.sent.at(-1).packet.command, '/testfor @s[x=-28.83,y=36,z=0.96,rm=1.5]')
  f.advance(20)
  assert.equal(f.verifier.applyPacket('command_output', f.output()), true)
  const receipt = await pending
  assert.equal(receipt.serverConfirmed, true); assert.equal(receipt.radius, 1.5)
  assert.deepEqual(f.state, before, 'the received raw pose is never rewritten')
  for (const radius of [0.05, 2, Number.NaN]) assert.equal((await f.verifier.confirm({ x: 1, y: 2, z: 3 }, { radius })).reason, 'POSITION_INVALID_REQUEST')
  assert.equal((await f.verifier.confirm({ x: 1.3, y: 2, z: 3 })).reason, 'POSITION_INVALID_REQUEST', 'the exact check still needs a block centre')
})
