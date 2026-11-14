'use strict'
// Coordinator 2026-11-14: measure the trip (one record per pass with times,
// received positions and distance left) and where the time goes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLongTravel } = require('../src/long-travel')

test('every pass is recorded and its time is split by category', async () => {
  const state = { phase: 'spawned', health: 20, position: { x: 0, y: 65.62, z: 0 } }
  const records = []
  let walks = 0
  const lt = createLongTravel({
    getState: () => state,
    chunkTravel: { start: async () => {}, status: () => ({ busy: false, phase: 'failed', error: { code: 'CHUNK_TRAVEL_NO_ROUTE' } }) },
    findPoint: async () => ({ x: state.position.x + 10, y: 64, z: 0 }),
    walkTo: async p => { walks++; await new Promise(r => setTimeout(r, 5)); state.position = { x: p.x, y: 65.62, z: 0 }; return { ok: true } },
    record: async e => { records.push(e) },
    log: () => {}, save: async () => {}, pollMs: 2, arriveM: 20
  })
  lt.start({ destination: { x: 60, z: 0 } })
  const until = Date.now() + 3000
  while (Date.now() < until && lt.status().phase !== 'arrived') await new Promise(r => setTimeout(r, 5))
  assert.equal(lt.status().phase, 'arrived')
  assert.ok(records.length >= 3)
  const r0 = records[0]
  assert.equal(r0.via, 'point'); assert.equal(r0.moved, true)
  assert.ok(r0.remainingAfter < r0.remainingBefore, 'the distance left shrinks')
  assert.ok(Date.parse(r0.end) >= Date.parse(r0.start))
  const timing = lt.status().timing
  assert.ok(timing.walk > 0 && timing.plan >= 0, JSON.stringify(timing))
})
