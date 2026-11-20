'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLongTravel } = require('../src/travel/long-travel')

// Drive the real trip coordinator with received leg results. No game inputs,
// timers waiting for a server, or predicted positions are used as arrivals.
function trip ({ result, beforePass = () => {}, maxFailuresInRow = 6 }) {
  const state = { phase: 'spawned', health: 20, connectionId: 'first', lifecycle: { deathId: 0 }, position: { x: 0.5, y: 65.62, z: 0.5 } }
  const attempts = [], passes = []
  let clock = 0, pass = 0, last = { busy: false, phase: 'idle' }
  const travel = createLongTravel({
    getState: () => structuredClone(state),
    now: () => clock,
    sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)) },
    beforeLeg: async () => { beforePass(++pass, state); return null },
    record: async value => passes.push(value),
    stopWhenBlocked: true,
    maxFailuresInRow,
    chunkTravel: {
      async start ({ area }) {
        const code = result({ area, state, pass, attempts })
        attempts.push({ ...area, pass, code })
        if (code) last = { busy: false, phase: 'failed', error: { code } }
        else {
          state.position = { x: area.x1 * 16 + 8, y: 65.62, z: area.z1 * 16 + 8 }
          last = { busy: false, phase: 'arrived', serverConfirmed: true }
        }
      },
      status: () => last
    }
  })
  return { travel, state, attempts, passes }
}

async function finish (f) {
  f.travel.start({ destination: { x: 120, z: 0.5 } })
  for (let i = 0; i < 100 && f.travel.status().busy; i++) await new Promise(resolve => setImmediate(resolve))
  if (f.travel.status().busy) { await f.travel.cancel(); assert.fail('trip did not settle within its finite passes') }
  return f.travel.status()
}

test('chunk fallback reaches an available direction beyond the first three candidates', async () => {
  const f = trip({ result: ({ area, state }) => state.position.x === 0.5 && area.z1 < 1 ? 'CHUNK_TRAVEL_NO_ROUTE' : null })
  const status = await finish(f)
  assert.equal(status.phase, 'arrived', JSON.stringify(status))
  const firstSuccess = f.attempts.findIndex(attempt => attempt.code === null)
  assert.ok(firstSuccess >= 3, 'the usable direction is outside the first pass')
  const blocked = f.attempts.slice(0, firstSuccess)
  assert.equal(new Set(blocked.map(attempt => `${attempt.x1},${attempt.z1}`)).size, blocked.length, 'failed candidates do not starve an untried direction')
  assert.ok(f.passes.length >= 2)
  for (const pass of new Set(f.attempts.map(attempt => attempt.pass))) assert.ok(f.attempts.filter(attempt => attempt.pass === pass).length <= 3, 'per-pass work remains capped')
})

test('temporary ownership and planning interruptions do not discard a usable candidate', async () => {
  const interruptions = ['CHUNK_TRAVEL_BUSY', 'CHUNK_TRAVEL_CONTEXT_CHANGED', 'CHUNK_TRAVEL_DAMAGED']
  const f = trip({ result: ({ attempts }) => interruptions[attempts.length] ?? null })
  const status = await finish(f)
  assert.equal(status.phase, 'arrived', JSON.stringify(status))
  const initial = f.attempts.slice(0, 4).map(({ x1, z1 }) => `${x1},${z1}`)
  assert.equal(new Set(initial).size, 1, 'the untested direction is retried after control/context returns')
  assert.equal(f.passes.slice(0, 3).filter(pass => pass.moved).length, 0)
})

for (const change of ['connection', 'life']) test(`a ${change} change during beforeLeg invalidates the old snapshot and failed directions`, async () => {
  const f = trip({
    maxFailuresInRow: 2,
    beforePass: (pass, state) => { if (pass === 2) { if (change === 'connection') state.connectionId = 'second'; else state.lifecycle.deathId++ } },
    result: ({ pass, area, state }) => pass === 1 || state.position.x === 0.5 && (area.x1 !== 2 || area.z1 !== 0) ? 'CHUNK_TRAVEL_NO_ROUTE' : null
  })
  const status = await finish(f)
  assert.equal(status.phase, 'arrived', JSON.stringify(status))
  const first = f.attempts[0], afterScope = f.attempts.find(attempt => attempt.pass === 2)
  assert.deepEqual({ x: afterScope.x1, z: afterScope.z1 }, { x: first.x1, z: first.z1 }, 'failures from an old scope are not reused')
})

test('a received position change during beforeLeg is used before selecting another leg or announcing arrival', async () => {
  const f = trip({
    beforePass: (pass, state) => { if (pass === 2) state.position.x = 120 },
    result: ({ pass }) => pass === 1 ? 'CHUNK_TRAVEL_NO_ROUTE' : null
  })
  const status = await finish(f)
  assert.equal(status.phase, 'arrived')
  assert.equal(status.remaining, 0)
  assert.equal(f.attempts.length, 3, 'no chunk toward the pre-preparation position is started')
})
