'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFailureMemo } = require('../src/survival/tunnel-failure-memo')
const { createTunneling } = require('../src/survival/tunneling')

test('a remembered failure is returned until it expires; no key means no reuse', () => {
  let time = 0
  const memo = createFailureMemo({ ttlMs: 1000, limit: 2, now: () => time })
  memo.set('a', { message: 'none' })
  assert.deepEqual(memo.get('a'), { message: 'none' })
  assert.equal(memo.get('b'), null)
  memo.set(null, { message: 'ignored' })
  assert.equal(memo.get(null), null)
  time = 1001
  assert.equal(memo.get('a'), null)
  memo.set('a', 1); memo.set('b', 2); memo.set('c', 3)
  assert.equal(memo.get('a'), null)
  assert.equal(memo.get('c'), 3)
})

function scene () {
  // Within 8 blocks below: a deeper ore gets a partial descent route instead (tunneling.js DEEP).
  const target = { x: -8, y: -6, z: -12 }
  const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, extra: [] })
  const shell = (x, y, z) => Math.max(Math.abs(x - target.x), Math.abs(y - target.y), Math.abs(z - target.z))
  const counts = { reads: 0 }
  let revision = 1, open = false
  const world = {
    revision: () => revision,
    getBlock: (x, y, z) => { counts.reads++; return shell(x, y, z) === 0 ? block('diamond_ore') : shell(x, y, z) <= 2 && !open ? block('lava') : y >= 0 && y <= 1 && x === 0 && z === 0 ? block('air') : block('stone') }
  }
  const tool = { name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: true, durabilityUsed: 0 }
  const state = { phase: 'spawned', position: { x: 0.5, y: 1.62, z: 0.5 }, positionSource: 'start_game', gameMode: 'survival', health: 20, dimension: 'overworld', selectedSlot: 0, rawSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: tool, startedAt: 's', connectionId: 'c', inventory: { known: true, items: [tool] }, hostiles: [] }
  const noop = () => {}
  const tunneling = createTunneling({ getState: () => structuredClone(state), world, excavation: { execute: noop, preview: noop, stop: noop }, movement: { preview: noop, start: noop, stop: noop }, getMovement: () => ({}), mining: { preview: noop }, getPreservedFloors: () => [] })
  return { tunneling, counts, decision: { type: 'tunnel', target, resource: 'diamond' }, change: () => { revision++; open = true } }
}

test('a tunnel search with no route is not repeated until the received terrain changes', () => {
  const s = scene()
  const first = s.tunneling.preview(s.decision, {})
  assert.equal(first.code, 'NO_SAFE_ROUTE')
  const reads = s.counts.reads
  const second = s.tunneling.preview(s.decision, {})
  assert.equal(second.code, 'NO_SAFE_ROUTE')
  assert.equal(second.reason, first.reason)
  assert.ok(s.counts.reads - reads < 50, `second search read ${s.counts.reads - reads} blocks`)
  s.change()
  assert.equal(s.tunneling.preview(s.decision, {}).ready, true)
})
