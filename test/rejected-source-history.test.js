'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { historicalSourceRejection } = require('../src/rejected-source-history')

function scene () {
  const scope = { profile: 'bot', realmId: '1', dimension: 'overworld', connectionId: 'socket', startedAt: '2026-11-06T13:53:33.633Z', runtimeEntityId: '10', life: 0 }
  const state = { phase: 'spawned', health: 20, ...scope, realm: { id: '1' }, lifecycle: { deathId: 0 } }
  const checkpoint = { kind: 'shulker', stage: 'depositing', operationId: 'job:storage:26', scope, stand: { x: -35, y: 48, z: -198 }, positions: [{ x: -33, y: 48, z: -198 }], placed: [{}], windowId: 68, initialContentsVerified: { windowEpoch: 91 }, intent: { type: 'deposit', name: 'minecraft:diorite', sourceSlot: 10, chestSlot: 5, count: 5, source: 'preserved-observed-source', destination: 'preserved-observed-destination' } }
  const recordedFailure = { type: 'carried_storage', operationId: checkpoint.operationId, status: 'blocked', at: '2026-11-06T15:57:03.301Z', result: { status: 'blocked', reason: 'サーバーがチェストへの移動を拒否しました。', checkpoint: structuredClone(checkpoint) } }
  const events = [
    { name: 'inventory_content', at: '2026-11-06T15:57:03.100Z' },
    { name: 'item_stack_response', at: '2026-11-06T15:57:03.933Z', position: { x: -34.5, y: 49.62, z: -197.5 }, requests: [{ id: -863, status: 'ok' }] },
    { name: 'item_stack_response', at: '2026-11-06T15:57:04.116Z', position: { x: -34.5, y: 49.62, z: -197.5 }, requests: [{ id: -865, status: 49 }] }
  ]
  return { checkpoint, recordedFailure, events, state }
}

test('one genuine historical source rejection correlates without granting transfer success or changing its before-data', () => {
  const input = scene(), before = structuredClone(input), result = historicalSourceRejection(input)
  assert.equal(result.ok, true)
  assert.equal(result.proof.requestId, -865)
  assert.equal(result.proof.protocolStatusCode, 49)
  assert.equal(result.proof.evidenceOrigin, 'historical_server_response_and_recorded_checkpoint')
  assert.equal(result.proof.sourceBefore, input.checkpoint.intent.source)
  assert.equal(result.proof.destinationBefore, input.checkpoint.intent.destination)
  assert.equal(Object.hasOwn(result.proof, 'notApplied'), false)
  assert.equal(Object.hasOwn(result.proof, 'serverConfirmed'), false)
  assert.deepEqual(input, before)
  result.proof.scope.life = 7
  assert.equal(input.checkpoint.scope.life, 0)
})

test('ambiguous responses, incomplete history, foreign scope and mismatched recorded failures remain unconfirmed', async t => {
  const cases = {
    'no observed rejection': f => { f.events.pop() },
    'duplicate response': f => { f.events.push(structuredClone(f.events.at(-1))) },
    'another rejected request': f => { const e = structuredClone(f.events.at(-1)); e.requests[0].id = -867; f.events.push(e) },
    'another status': f => { f.events.at(-1).requests[0].status = 50 },
    'string status': f => { f.events.at(-1).requests[0].status = '49' },
    'even request ID': f => { f.events.at(-1).requests[0].id = -864 },
    'request outside signed32': f => { f.events.at(-1).requests[0].id = -2147483649 },
    'outside recorded action window': f => { f.events.at(-1).at = '2026-11-06T15:58:04.116Z' },
    'history no longer covers the action': f => { f.events.shift() },
    'different actor position': f => { f.events.at(-1).position.x += 2 },
    'different connection': f => { f.state.connectionId = 'other' },
    'different life': f => { f.state.lifecycle.deathId = 1 },
    'different operation': f => { f.recordedFailure.operationId = 'other' },
    'different saved intent': f => { f.recordedFailure.result.checkpoint.intent.count = 6 },
    'timeout instead of server rejection': f => { f.recordedFailure.result.reason = 'timeout' },
    'dead bot': f => { f.state.health = 0 }
  }
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const f = scene(); change(f)
    assert.equal(historicalSourceRejection(f).ok, false)
  })
})

test('a unique status49 cannot borrow another failed or malformed response in the recorded operation window', async t => {
  for (const status of [50, 'failed', '49', null, undefined]) await t.test(String(status), () => {
    const f = scene(), other = structuredClone(f.events.at(-1))
    other.requests = [{ id: -867, status }]
    f.events.splice(f.events.length - 1, 0, other)
    assert.equal(historicalSourceRejection(f).ok, false)
  })
  for (const malformed of [null, {}, 'invalid']) await t.test(`malformed response ${JSON.stringify(malformed)}`, () => {
    const f = scene(); f.events.at(-1).requests.push(malformed)
    assert.equal(historicalSourceRejection(f).ok, false)
  })
  await t.test('a refusal with an invalid request ID is still ambiguity', () => {
    const f = scene(); f.events.at(-1).requests.push({ id: 123, status: 50 })
    assert.equal(historicalSourceRejection(f).ok, false)
  })
})

test('actual string-ok and numeric-zero success responses may coexist with the one source49 refusal', () => {
  const f = scene()
  f.events[1].requests.push({ id: -861, status: 0 }, { id: -859, status: 'ok' })
  const result = historicalSourceRejection(f)
  assert.equal(result.ok, true)
  assert.equal(result.proof.requestId, -865)
  assert.equal(result.proof.matchedResponseCount, 1)
})
