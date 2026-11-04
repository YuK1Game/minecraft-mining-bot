'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createState } = require('../src/state')

test('tracks only received own-entity breath metadata and preserves partial updates', () => {
  let time = '2026-10-31T00:00:00.000Z'
  const s = createState('test', () => time)
  s.applyPacket('start_game', { runtime_entity_id: 1n })
  const packet = (id, metadata) => s.applyPacket('set_entity_data', { runtime_entity_id: id, metadata })
  packet(2n, [{ key: 'air', type: 'short', value: 300 }])
  assert.equal(s.snapshot().breath.current, null)
  packet(1n, [{ key: 'air', type: 'short', value: 300 }, { key: 'max_airdata_max_air', type: 'short', value: 300 }])
  time = '2026-10-31T00:00:01.000Z'
  packet(1n, [{ key: 'air', type: 'short', value: 280 }])
  assert.deepEqual(s.snapshot().breath, { current: 280, maximum: 300, currentUpdatedAt: time, maximumUpdatedAt: '2026-10-31T00:00:00.000Z' })
  packet(1n, [{ key: 'air', type: 'int', value: 1 }, { key: 'air', type: 'short', value: NaN }, { key: 'max_airdata_max_air', type: 'short', value: -1 }])
  assert.equal(s.snapshot().breath.current, 280)
  assert.equal(s.snapshot().breath.maximum, 300)
  packet(1n, [{ key: 'air', type: 'short', value: -1 }])
  assert.equal(s.snapshot().breath.current, -1)
})

test('clears old breath on a new world, dimension change, and own respawn', () => {
  const s = createState('test')
  const set = () => s.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'air', type: 'short', value: 100 }] })
  s.applyPacket('start_game', { runtime_entity_id: 1n }); set()
  s.applyPacket('respawn', { runtime_entity_id: 2n, state: 1 })
  assert.equal(s.snapshot().breath.current, 100)
  s.applyPacket('respawn', { runtime_entity_id: 1n, state: 1 })
  assert.equal(s.snapshot().breath.current, null)
  set(); s.applyPacket('change_dimension', { dimension: 0 })
  assert.equal(s.snapshot().breath.current, null)
  set(); s.applyPacket('start_game', { runtime_entity_id: 1n })
  assert.equal(s.snapshot().breath.current, null)
})
