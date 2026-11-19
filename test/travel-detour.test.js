'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTravelDetour, standpoints } = require('../src/travel/travel-detour')
const { createLongTravel } = require('../src/travel/long-travel')

const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
const block = name => ({ known: true, name: 'minecraft:' + name, boundingBox: 'block' })
// The door step of 2026-11-19 07:05 JST: two cobblestones at y=76, four blocks of air to the south,
// ground at the same height from six cells south, lower ground under the gap.
const step = (x, y, z) => y === 76 && z === 0 && (x === 0 || x === 1) ? block('cobblestone') : y === 76 && z >= 6 ? block('grass_block') : y <= 71 ? block('stone') : air

function setup ({ getBlock = step, covered = false, build = null, climb = null } = {}) {
  const state = { feet: { x: 1.5, y: 77, z: 0.5 }, covered, clock: 0, logs: [], builds: [], climbs: 0 }
  const detour = createTravelDetour({
    getFeet: () => state.feet, getBlock, covered: () => state.covered, now: () => state.clock, log: text => state.logs.push(text),
    climb: climb ?? (async () => { state.climbs++; state.covered = false; state.feet = { ...state.feet, y: state.feet.y + 40 } }),
    build: build ?? (async (target, { done }) => { state.builds.push(target); assert.equal(done(target), true); state.feet = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }; return { ok: true } })
  })
  return { state, detour }
}

test('standpoints are received cells to stand on toward the destination, same height first', () => {
  const spots = standpoints(step, { x: 1.5, y: 77, z: 0.5 }, { x: 1, z: 200 })
  assert.ok(spots.length > 0)
  assert.deepEqual({ y: spots[0].y, x: spots[0].x }, { y: 77, x: 1 })
  assert.ok(spots[0].z >= 6 && spots[0].z <= 12)
  const unknown = standpoints(() => ({ known: false }), { x: 1.5, y: 77, z: 0.5 }, { x: 1, z: 200 })
  assert.deepEqual(unknown, [], 'unreceived cells are no standpoint')
})

test('no walk on: the build route goes to a standpoint toward the destination', async () => {
  const { state, detour } = setup()
  const went = await detour({ x: 1, z: 200 })
  assert.deepEqual(went, { ok: true, code: 'DETOUR_BUILT' })
  assert.equal(state.builds.length, 1)
  assert.match(state.logs[0], /掘る・積む道で/)
})

test('under natural ground the way up comes first', async () => {
  const { state, detour } = setup({ covered: true })
  assert.deepEqual(await detour({ x: 1, z: 200 }), { ok: true, code: 'DETOUR_CLIMBED' })
  assert.equal(state.climbs, 1)
  assert.equal(state.builds.length, 0)
})

test('a detour that did not move the feet rests on that cell for a minute, and three standpoints are the most', async () => {
  let asked = 0
  const { state, detour } = setup({ build: async () => { asked++; return { ok: false, code: 'NO_BUILD_ROUTE' } } })
  assert.deepEqual(await detour({ x: 1, z: 200 }), { ok: false, code: 'NO_BUILD_ROUTE' })
  assert.equal(asked, 3)
  assert.equal((await detour({ x: 1, z: 200 })).code, 'DETOUR_RESTING')
  assert.equal(asked, 3)
  state.clock = 61000
  await detour({ x: 1, z: 200 })
  assert.equal(asked, 6)
})

test('the long trip asks for the detour when neither a point nor a chunk leg moved it, and the pass then counts as moved', async () => {
  const state = { phase: 'spawned', health: 20, position: { x: 0.5, y: 65.62, z: 0.5 } }
  const logs = []
  let detours = 0
  const travel = createLongTravel({
    getState: () => state, log: text => logs.push(text), save: async () => {}, pollMs: 1, stopWhenBlocked: true, maxFailuresInRow: 2,
    chunkTravel: { start: async () => {}, status: () => ({ busy: false, phase: 'failed', error: { code: 'CHUNK_TRAVEL_NO_ROUTE' } }), cancel: async () => {} },
    findPoint: async () => null, walkTo: async () => ({ ok: false }),
    detour: async destination => { detours++; state.position = { ...state.position, x: state.position.x + 12 }; return { ok: true, code: 'DETOUR_BUILT' } }
  })
  travel.start({ destination: { x: 60, z: 0 } })
  const until = Date.now() + 5000
  while (travel.status().busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(travel.status().phase, 'arrived')
  assert.ok(detours >= 3)
  assert.equal(logs.some(text => /どの方向にも進めません/.test(text)), false)
})

// Live 2026-11-19 14:53-15:03 JST: on a dry dirt cell with water in the columns west and north (isInWater true), the
// dig-and-stack route was planned about 60 times; every step ended with ASCENT_POSITION_UNCONFIRMED or a refused step-down.
test('in water the detour leaves the water first and digs or stacks nothing from there', async () => {
  const state = { feet: { x: 1.5, y: 77, z: 0.5 }, wet: true, logs: [], builds: 0, clock: 0 }
  const make = dry => createTravelDetour({ getFeet: () => state.feet, getBlock: step, wet: () => state.wet, dry, now: () => state.clock, log: text => state.logs.push(text), build: async () => { state.builds++; return { ok: true } } })
  const out = await make(async () => { state.wet = false; return { ok: true } })({ x: 1, z: 200 })
  assert.deepEqual(out, { ok: true, code: 'DETOUR_DRIED' })
  assert.equal(state.builds, 0)
  state.wet = true
  const stuck = await make(async () => ({ ok: false, reason: 'NO_LEDGE' }))({ x: 1, z: 200 })
  assert.deepEqual(stuck, { ok: false, code: 'DETOUR_WET:NO_LEDGE' })
  assert.equal(state.builds, 0)
})
