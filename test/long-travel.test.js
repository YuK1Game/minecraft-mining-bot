'use strict'
// Long-distance travel, stage 1 (2026-11-14): repeated chunk-travel legs toward
// a far destination, turning aside when a leg cannot be walked, pausing after
// damage, saving progress and stopping with a reason when blocked.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLongTravel } = require('../src/long-travel')

function fixture ({ blocked = () => false, damagedOnce = false } = {}) {
  const state = { phase: 'spawned', health: 20, position: { x: 0.5, y: 65.62, z: 0.5 } }
  const legs = [], saves = []
  let busy = false, last = null, damaged = !damagedOnce
  const chunkTravel = {
    async start ({ area }) {
      legs.push(area)
      if (!damaged) { damaged = true; last = { phase: 'failed', busy: false, error: { code: 'CHUNK_TRAVEL_DAMAGED' } }; return last }
      if (blocked(area)) { last = { phase: 'failed', busy: false, error: { code: 'CHUNK_TRAVEL_NO_ROUTE', message: 'no route' } }; return last }
      busy = true
      // Walk to the middle of the requested chunk (the received position).
      state.position = { x: area.x1 * 16 + 8, y: 65.62, z: area.z1 * 16 + 8 }
      busy = false; last = { phase: 'arrived', serverConfirmed: true, busy: false }
      return last
    },
    status: () => last ?? { phase: 'idle', busy },
    cancel: async () => {}
  }
  const logs = []
  const travel = createLongTravel({ getState: () => state, chunkTravel, save: async doc => saves.push(doc), log: m => logs.push(m), sleep: () => new Promise(r => setImmediate(r)), damagePauseMs: 0, pollMs: 1 })
  return { state, legs, saves, logs, travel }
}
async function finish (f, ms = 5000) {
  const until = Date.now() + ms
  while (f.travel.status().busy && Date.now() < until) await new Promise(r => setTimeout(r, 2))
  return f.travel.status()
}

test('walks leg by leg toward a far destination and arrives', async () => {
  const f = fixture()
  f.travel.start({ destination: { x: 300, z: -300 } })
  const s = await finish(f)
  assert.equal(s.phase, 'arrived', JSON.stringify(s))
  assert.ok(s.legs >= 8 && s.legs <= 20, `legs ${s.legs}`)
  assert.ok(f.saves.length >= s.legs, 'progress is saved after every leg')
  assert.ok(f.logs.some(m => /目的地に着きました/.test(m)))
})

test('a blocked direction is passed by turning aside', async () => {
  // Everything straight east (z chunk 0) is blocked; legs must leave that row.
  const f = fixture({ blocked: area => area.z1 === 0 && area.x1 > 0 })
  f.travel.start({ destination: { x: 200, z: 0 } })
  const s = await finish(f)
  assert.equal(s.phase, 'arrived', JSON.stringify(s))
  assert.ok(f.legs.some(a => a.z1 !== 0))
})

test('when no direction can be walked it stops with the reason', async () => {
  const f = fixture({ blocked: () => true })
  f.travel.start({ destination: { x: 500, z: 500 } })
  const s = await finish(f)
  assert.equal(s.phase, 'stopped'); assert.equal(s.reason, 'LONG_TRAVEL_BLOCKED')
  assert.ok(f.logs.some(m => /停止/.test(m) && /CHUNK_TRAVEL_NO_ROUTE/.test(m)))
})

test('damage ends a leg and the trip continues after a pause', async () => {
  const f = fixture({ damagedOnce: true })
  f.travel.start({ destination: { x: 100, z: 0 } })
  const s = await finish(f)
  assert.equal(s.phase, 'arrived', JSON.stringify(s))
  assert.ok(f.logs.some(m => /被弾/.test(m)))
})

test('a saved trip continues its leg count', async () => {
  const f = fixture()
  f.travel.start({ destination: { x: 100, z: 0 }, resume: { legs: 7, startedAt: '2026-11-14T00:00:00Z' } })
  const s = await finish(f)
  assert.ok(s.legs > 7)
})
