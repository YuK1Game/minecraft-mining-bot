'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createSelfResistance, createSelfSlowFalling, createSelfEffectEvents } = require('../src/self-resistance')

function fixture () {
  let time = 1000
  const state = { phase: 'spawned', profile: 'test', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-06T01:00:00Z', dimension: 'overworld', runtimeEntityId: '41', position: { x: 0, y: 64, z: 0 }, health: 5.5, lifecycle: { phase: 'alive', deathId: 1 } }
  const observer = createSelfResistance({ getState: () => state, now: () => time })
  const packet = { runtime_entity_id: 41n, event_id: 'add', effect_id: 11, amplifier: 4, particles: false, duration: 2400, tick: 9007199254740995n, ambient: false }
  return { observer, state, packet, advance: ms => { time += ms } }
}

test('real Bedrock resistance add/update/remove packets confirm only the own current effect receipt', () => {
  const f = fixture(), encode = createSerializer('1.26.60'), decode = createDeserializer('1.26.60')
  const receive = changes => f.observer.observe(decode.parsePacketBuffer(encode.createPacketBuffer({ name: 'mob_effect', params: { ...f.packet, ...changes } })).data.params)
  assert.equal(f.observer.snapshot().active, null)
  assert.equal(receive({}), true)
  let status = f.observer.snapshot()
  assert.equal(status.active, true); assert.equal(status.serverConfirmed, true)
  assert.equal(status.amplifier, 4); assert.equal(status.durationTicks, 2400); assert.equal(status.tick, String(f.packet.tick))
  f.advance(10000); assert.equal(f.observer.snapshot().remainingMsEstimate, 110000)
  receive({ event_id: 'update', amplifier: 2, duration: 100, tick: f.packet.tick + 1n })
  status = f.observer.snapshot(); assert.equal(status.event, 'update'); assert.equal(status.sequence, 2); assert.equal(status.amplifier, 2)
  receive({ event_id: 'remove', duration: 0, tick: f.packet.tick + 2n })
  assert.equal(f.observer.snapshot().active, false)
  receive({}); assert.equal(f.observer.snapshot().active, false, 'older tick cannot restore a removed effect')
})

test('replayed, foreign, expired and wrong-life observations never confirm active protection', () => {
  const f = fixture()
  f.observer.observe(f.packet, { replaying: true }); f.observer.observe({ ...f.packet, runtime_entity_id: 4n }); f.observer.observe({ ...f.packet, effect_id: 19 })
  assert.equal(f.observer.snapshot().active, null)
  f.observer.observe(f.packet); f.state.lifecycle.deathId++
  assert.equal(f.observer.snapshot().serverConfirmed, false)
  f.observer.observe(f.packet); f.state.connectionId = 'new'; assert.equal(f.observer.snapshot().active, null)
  f.observer.observe(f.packet); f.advance(120000); assert.equal(f.observer.snapshot().reason, 'RECEIPT_EXPIRED')
  assert.equal(f.observer.snapshot().active, null)
  f.observer.clear(); assert.equal(f.observer.snapshot().reason, 'NO_CURRENT_RECEIPT')
})

test('an own remove always revokes protection, including an unspecified zero tick after a numbered update', () => {
  const f = fixture(), tick = f.packet.tick
  f.observer.observe(f.packet)
  assert.equal(f.observer.observe({ ...f.packet, event_id: 'remove', duration: 0, tick: 0n }), true)
  assert.equal(f.observer.snapshot().active, false)
  assert.equal(f.observer.observe({ ...f.packet, tick: tick - 1n }), false, 'retain the last ordered tick across an unnumbered remove')
  assert.equal(f.observer.snapshot().active, false)
  assert.equal(f.observer.observe({ ...f.packet, event_id: 'update', tick: 0n }), true, 'fresh unnumbered packets use receive order')
  assert.equal(f.observer.snapshot().active, true)
  assert.equal(f.observer.observe({ ...f.packet, event_id: 'remove', duration: 0, tick: tick - 1n }), true)
  assert.equal(f.observer.snapshot().active, false)
})

test('self effect diagnostics preserve actual numeric wire IDs and keep the world and life scopes separate', () => {
  const f = fixture()
  let time = 1000
  const slow = createSelfSlowFalling({ getState: () => f.state, now: () => time })
  const journal = createSelfEffectEvents({ getState: () => f.state, now: () => time })
  const encode = createSerializer('1.26.60'), decode = createDeserializer('1.26.60')
  const send = (changes, options) => {
    const params = { ...f.packet, effect_id: 27, amplifier: 1, duration: 12000, ...changes }
    const packet = decode.parsePacketBuffer(encode.createPacketBuffer({ name: 'mob_effect', params })).data.params
    journal.observe(packet, options); slow.observe(packet, options)
  }
  send({ runtime_entity_id: 42n }); send({}, { replaying: true }); assert.equal(journal.snapshot().events.length, 0)
  send({ effect_id: 28 }); assert.equal(slow.snapshot().active, null)
  time += 500; send({ event_id: 'update' })
  const result = journal.snapshot()
  assert.deepEqual(result.events.map(e => e.effectId), [28, 27]); assert.equal(result.events[1].receivedAt, 1500)
  assert.equal(result.events[1].amplifier, 1); assert.equal(result.events[1].durationTicks, 12000); assert.equal(result.events[1].event, 'update')
  f.state.lifecycle.deathId++; assert.deepEqual(journal.snapshot().events, [])
  for (let i = 0; i < 20; i++) send({ effect_id: 11 })
  assert.equal(journal.snapshot().events.length, 16); assert.ok(journal.snapshot().events.every(e => e.effectId === 11))
  journal.clear(); assert.deepEqual(journal.snapshot().events, [])
})

test('1.26.60 Realm slow_falling receipt uses wire ID 27 and never grants protection from ID 28', () => {
  const f = fixture(); let time = 1793934444267
  const slow = createSelfSlowFalling({ getState: () => f.state, now: () => time })
  const actual = { ...f.packet, effect_id: 27, event_id: 'update', amplifier: 1, duration: 12000, tick: 9247927n }
  assert.equal(slow.observe({ ...actual, effect_id: 28 }), false)
  assert.equal(slow.observe({ ...actual, runtime_entity_id: 42n }), false)
  assert.equal(slow.observe(actual, { replaying: true }), false)
  assert.equal(slow.snapshot().active, null)
  assert.equal(slow.observe(actual), true)
  const seen = slow.snapshot()
  assert.equal(seen.effectId, 27); assert.equal(seen.amplifier, 1); assert.equal(seen.durationTicks, 12000); assert.equal(seen.active, true)
  assert.equal(seen.tick, '9247927'); assert.equal(seen.receivedAt, time); assert.equal(seen.remainingMsEstimate, 600000)
  time += 600000; assert.equal(slow.snapshot().active, null)
  slow.observe({ ...actual, event_id: 'add', tick: 9248000n }); assert.equal(slow.snapshot().active, true)
  slow.observe({ ...actual, event_id: 'remove', duration: 0, tick: 0n }); assert.equal(slow.snapshot().active, false)
  f.state.lifecycle.deathId++; assert.equal(slow.snapshot().active, null)
})
