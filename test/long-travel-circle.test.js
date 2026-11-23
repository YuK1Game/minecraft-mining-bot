'use strict'

// A long trip whose walks go round asks for its own way on (src/travel/trip-circle.js).
// Real Realm 2026-11-23 14:48:17-14:50:43 JST, the trip back to the mine at (9808, 10178) from 50 m east of it
// (.local/long-travel/legs.jsonl on the PC): 126 passes, one second each, all `via point, moved true`:
//   (9857,68,10165) > (9858,69,10163), 50 m > 52 m left, 63 times
//   (9858,69,10163) > (9857,68,10165), 52 m > 50 m left, 63 times
// No line of the detour (「掘る・積む道」), 「停止: 同じ場所から先へ進めていません」 every twelve passes, the trip
// started again from the same feet each time, and from 14:50:45 the Bot stood there (goal early.home_reserve#4
// held at 15:20:33).
// Real: createLongTravel (the pass loop, the stuck guard, the detour call) and the trip circle.
// Stand-ins: the relay-point search answers as the legs were recorded, the walk moves the feet to the point, the
// chunk leg has no route, and the detour moves the feet nine blocks toward the destination.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLongTravel } = require('../src/travel/long-travel')
const { createTripCircle } = require('../src/travel/trip-circle')

const MINE = { x: 9808, z: 10178 }
const A = { x: 9856.5, y: 68, z: 10164.6 }, B = { x: 9857.6, y: 69, z: 10162.9 }
const column = p => `${Math.floor(p.x)},${Math.floor(p.z)}`
const left = p => Math.hypot(MINE.x - p.x, MINE.z - p.z)
const toward = (p, metres) => { const d = left(p), k = Math.min(1, metres / d); return { x: p.x + (MINE.x - p.x) * k, y: p.y, z: p.z + (MINE.z - p.z) * k } }

// The plateau of 14:48: from A the only relay point is B and from B it is A. Anywhere else the walk leads on.
function plateau ({ detour, back = false } = {}) {
  const state = { phase: 'spawned', health: 19.8, position: { x: A.x, y: A.y + 1.62, z: A.z } }
  const feet = () => ({ x: state.position.x, y: state.position.y - 1.62, z: state.position.z })
  const stand = p => { state.position = { x: p.x, y: p.y + 1.62, z: p.z } }
  const w = { state, feet, logs: [], walks: [], detours: [], chunks: 0 }
  w.travel = createLongTravel({
    getState: () => state, log: text => w.logs.push(text), save: async () => {}, pollMs: 1, stopWhenBlocked: true,
    sleep: () => new Promise(resolve => setImmediate(resolve)),
    chunkTravel: { start: async () => { w.chunks++ }, status: () => ({ busy: false, phase: 'failed', error: { code: 'CHUNK_TRAVEL_NO_ROUTE' } }), cancel: async () => {} },
    findPoint: async at => column(at) === column(A) ? B : column(at) === column(B) ? A : back ? A : toward(at, 10),
    walkTo: async point => { w.walks.push(`${column(feet())}>${column(point)}`); stand(point); return { ok: true } },
    detour: detour === null ? null : async () => { w.detours.push(column(feet())); return detour ? detour(w, stand) : (stand(toward(feet(), 9)), { ok: true, code: 'DETOUR_BUILT' }) }
  })
  w.run = async () => {
    w.travel.start({ destination: MINE })
    const until = Date.now() + 8000
    while (w.travel.status().busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2))
    return w.travel.status()
  }
  return w
}

test('the two columns of 14:48 JST: the third return asks for the detour, and the trip arrives', async () => {
  const w = plateau()
  const ended = await w.run()
  assert.equal(ended.phase, 'arrived', w.logs.slice(-4).join(' / '))
  assert.equal(w.detours.length, 1, 'one detour leaves the plateau')
  const round = w.walks.findIndex((_, i) => w.walks.slice(0, i + 1).filter(leg => leg.endsWith('>' + column(B))).length === 3)
  assert.equal(round, 4, 'A>B, B>A, A>B, B>A, A>B: the fifth walk ends in the same column for the third time')
  assert.equal(w.chunks, 0, 'a walk that went round goes straight to the detour, not to one more walked leg')
  assert.ok(w.logs.some(text => /歩きが同じ場所 \(9857, 10162\) へ 3 回戻りました。歩く道では近づけないため、ほかの道を試します（残り 5\dm）/.test(text)), w.logs.join('\n'))
  assert.equal(w.logs.some(text => /同じ場所から先へ進めていません/.test(text)), false)
})

test('a detour that leaves no way on ends the trip with the reason after a few passes, not after rounds of walking', async () => {
  const w = plateau({ detour: () => ({ ok: false, code: 'NO_BUILD_ROUTE' }) })
  const ended = await w.run()
  assert.equal(ended.phase, 'stopped')
  assert.equal(ended.reason, 'LONG_TRAVEL_NO_PROGRESS')
  assert.equal(w.walks.length, 10, 'four walks to the first round, then six rounds')
  assert.equal(w.detours.length, 5, 'asked after every round but the last')
})

test('walks that come back to the same column after every detour end the trip: six rounds no nearer', async () => {
  const w = plateau({ back: true })
  const ended = await w.run()
  assert.equal(ended.phase, 'stopped')
  assert.equal(ended.reason, 'LONG_TRAVEL_NO_PROGRESS')
  assert.equal(w.detours.length, 5, 'the sixth round ends the trip before another detour')
})

test('without a detour (a trip outside play) the round is a failed pass like any other', async () => {
  const w = plateau({ detour: null })
  const ended = await w.run()
  assert.equal(ended.phase, 'stopped')
  assert.ok(['LONG_TRAVEL_BLOCKED', 'LONG_TRAVEL_NO_PROGRESS'].includes(ended.reason), ended.reason)
})

test('a column is a round at its third walk; passing it twice is not, and only the last columns are kept', () => {
  const circle = createTripCircle({ keep: 3 })
  assert.equal(circle.round(circle.arrived({ x: 1.2, z: 1.9 })), false)
  assert.equal(circle.round(circle.arrived({ x: 1.8, z: 1.1 })), false, 'the second time in the column')
  assert.equal(circle.round(circle.arrived({ x: 1.5, z: 1.5 })), true)
  for (const x of [10, 11, 12]) circle.arrived({ x, z: 0 })
  assert.equal(circle.arrived({ x: 1.5, z: 1.5 }), 1, 'a column passed long ago is forgotten')
  // Six rounds without coming eight metres nearer; nearer starts the count again.
  const far = createTripCircle()
  assert.deepEqual([50, 52, 50, 52, 50].map(m => far.spent(m)), [false, false, false, false, false])
  assert.equal(far.spent(41), false, 'nine metres nearer')
  assert.deepEqual([41, 40, 41, 40].map(m => far.spent(m)), [false, false, false, false])
  assert.equal(far.spent(41), true)
})
