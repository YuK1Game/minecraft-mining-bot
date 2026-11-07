'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { historicalEmptyPlacement } = require('../src/placement-source-history')
function scene () {
  const scope = { profile: 'bot', realmId: '1', dimension: 'overworld', connectionId: 'socket', startedAt: '2026-11-06T13:53:33.633Z', runtimeEntityId: '10', life: 0 }
  const checkpoint = { version: 1, jobId: 'job', operationId: 'job:storage:73', kind: 'shulker', stage: 'placing', scope, stand: { x: -43, y: 40, z: -196 }, positions: [{ x: -41, y: 40, z: -196 }], placed: [], deposited: [], plan: [{ transferred: 0 }], initialContents: 'immutable27', intent: { type: 'place', position: { x: -41, y: 40, z: -196 }, slot: 3, source: 'immutableRaw' } }
  const recordedFailure = { type: 'carried_storage', operationId: checkpoint.operationId, status: 'blocked', at: '2026-11-06T16:52:16.214Z', result: { status: 'blocked', reason: 'サーバーから設置・使用の完了を確認できませんでした。', checkpoint: structuredClone(checkpoint) } }
  const events = [{ name: 'inventory_content', at: '2026-11-06T16:52:16.100Z' }, { name: 'inventory_content', windowId: 'inventory', at: '2026-11-06T16:52:16.542Z', position: { x: -42.5, y: 41.62, z: -195.5 }, items: Array.from({ length: 36 }, (_, slot) => ({ slot, id: slot > 10 ? 205 : 1, count: 1 })).filter(i => i.slot !== 3) }, { name: 'inventory_transaction', at: '2026-11-06T16:52:16.561Z', actions: [{ slot: 3, oldCount: 0, newCount: 1, itemId: 13 }] }]
  return { checkpoint, recordedFailure, events, state: { phase: 'spawned', health: 20, ...scope, realm: { id: '1' }, lifecycle: { deathId: 0 } } }
}
test('received empty slot survives a later pickup without granting placement or storage success', () => {
  const f = scene(), before = structuredClone(f), result = historicalEmptyPlacement(f)
  assert.equal(result.ok, true)
  assert.equal(result.proof.observedAt, Date.parse(f.events[1].at))
  assert.equal(result.proof.requestOutcome, 'unacknowledged')
  assert.equal(result.proof.receivedMain.length, 35)
  assert.equal(Object.hasOwn(result.proof, 'serverConfirmed'), false)
  assert.equal(Object.hasOwn(result.proof, 'placementConfirmed'), false)
  assert.deepEqual(f, before)
  result.proof.scope.life = 99
  assert.equal(f.checkpoint.scope.life, 0)
})
test('incomplete, foreign and contradictory history cannot become placement evidence', async t => {
  const cases = {
    'missing full main': f => { f.events.splice(1, 1) },
    'only source replacement': f => { f.events[1].items.push({ slot: 3, id: 13, count: 1 }) },
    'partial main': f => { f.events[1].items.pop() },
    'duplicate slot': f => { f.events[1].items[1].slot = 0 },
    'invalid item': f => { f.events[1].items[1].id = 0 },
    'invalid count': f => { f.events[1].items[1].count = 0 },
    'different window': f => { f.events[1].windowId = 'armor' },
    'before operation': f => { f.events[1].at = '2026-11-06T16:52:16.001Z' },
    'after timeout': f => { f.events[1].at = '2026-11-06T16:52:24.215Z' },
    'truncated history': f => { f.events.shift() },
    'different observed position': f => { f.events[1].position.x += 1 },
    'unknown observed position': f => { delete f.events[1].position },
    'different connection': f => { f.state.connectionId = 'other' },
    'different life': f => { f.state.lifecycle.deathId = 1 },
    'dead': f => { f.state.health = 0 },
    'different operation': f => { f.recordedFailure.operationId = 'other' },
    'changed checkpoint': f => { f.recordedFailure.result.checkpoint.intent.source = 'different' },
    'another failure': f => { f.recordedFailure.result.reason = 'notSent' },
    'unsent': f => { f.checkpoint.intent.notSent = true },
    'unknown initial contents': f => { delete f.checkpoint.initialContents },
    'nonhotbar source': f => { f.checkpoint.intent.slot = 12 },
    'actual refusal': f => { f.events.push({ name: 'item_stack_response', at: f.events[1].at, requests: [{ id: -322, status: 49 }] }) },
    'unknown response': f => { f.events.push({ name: 'item_stack_response', at: f.events[1].at, requests: [{}] }) }
  }
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => { const f = scene(); change(f); assert.equal(historicalEmptyPlacement(f).ok, false) })
})
