'use strict'
// 2026-11-14 user decision (relay): logs may be cut only to prepare a long trip
// (about 10, from empty hands). Leaves stay off; nothing changes for the quarry.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createMining } = require('../src/mining')

function fixture (t, allowance) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-05T01:30:00.000Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, onGround: true }
  const blocks = new Map()
  const set = (p, name) => blocks.set(`${p.x},${p.y},${p.z}`, { position: { ...p }, known: true, name: `minecraft:${name}`, runtimeId: 5, boundingBox: 'block', properties: {}, extra: [] })
  set({ x: 0, y: 64, z: 0 }, 'stone')
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', runtimeId: 0, extra: [] } }
  const input = { lookAt () {}, start () {}, stop () {}, sendAction () {}, stats: () => ({ running: false }) }
  const mining = createMining({ getState: () => state, world, getInput: () => input, logAllowance: () => allowance })
  t.after(() => mining.stop('cleanup'))
  return { mining, set }
}
const reasons = preview => (preview.errors ?? []).map(String).join(' | ') + ' ' + String(preview.reason ?? '')

test('a log is refused without the long-trip allowance and passes the wood gate with it', t => {
  const off = fixture(t, false)
  off.set({ x: 1, y: 66, z: 0 }, 'oak_log')
  assert.match(reasons(off.mining.preview([{ x: 1, y: 66, z: 0 }])), /WOOD_HARVEST_DISABLED/)
  const on = fixture(t, true)
  on.set({ x: 1, y: 66, z: 0 }, 'oak_log')
  assert.doesNotMatch(reasons(on.mining.preview([{ x: 1, y: 66, z: 0 }])), /WOOD_HARVEST_DISABLED/)
})

test('leaves stay refused even with the allowance', t => {
  const f = fixture(t, true)
  f.set({ x: 1, y: 66, z: 0 }, 'oak_leaves')
  assert.match(reasons(f.mining.preview([{ x: 1, y: 66, z: 0 }])), /LEAF_HARVEST_DISABLED/)
})

test('the allowance is scoped: purpose, 30-minute expiry, never while quarry work runs; at most 10 logs', () => {
  const runtime = fs.readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(runtime, /a\.purpose === 'long_travel_prep' && Date\.now\(\) < a\.expiresAt && !quarryJob\?\.holdsWork\(\)/)
  assert.match(runtime, /Math\.max\(1, Math\.min\(10,/)
  const runner = fs.readFileSync(require.resolve('../src/runner'), 'utf8')
  assert.match(runner, /const allowed = !leafWork &&/)
})
