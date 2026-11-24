'use strict'
// A food source the hunt cannot walk to is walked to once, then left alone
// (src/modes/dragon-food-reach.js, the food step in dragon-early-food.js).
// Live 2026-11-18 21:37-21:48 JST: seven minutes at one spot showing
// 「狩りで得た肉を確認して調理します。」 with nothing logged, then five search
// trips in 16 s, each cancelled after 0.5 s because a food source was "in view".
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { foodReach, MISSES, REST_MS } = require('../src/modes/dragon-food-reach')
const { provisionFood } = require('../src/modes/dragon-early-food')

const COW = { runtimeId: '1463', name: 'minecraft:cow', kind: 'prey', position: { x: 12.5, y: 48, z: -20.5 } }
const NO_RELAY = '既知の安全な陸上中継を作れないため、別の食料源を待ちます。'
const miss = (target = COW) => ({ ok: true, target, steps: 0, hits: 0, foodGained: 0, reason: NO_RELAY })

// The food step with no food, 40 m from the house. The hunt sees `target` and answers `hunt()`.
function scene ({ target = COW, hunt = () => miss(target) } = {}) {
  let clock = 1000000
  const f = { trips: [], logs: [], hunts: 0, untils: [], tick: ms => { clock += ms } }
  f.ctx = {
    shared: { playerHouse: { origin: { x: 0, y: 64, z: 0 }, done: true } }, memory: {}, now: () => clock, log: line => f.logs.push(line), cancelled: () => false, signal: new AbortController().signal,
    runtime: { inventory: () => ({ known: true, items: [{ name: 'minecraft:stone_sword', count: 1, slot: 0 }] }), raw: () => ({ dimension: 'overworld' }), combatOwns: () => false },
    getFeet: () => ({ x: 40.5, y: 64, z: 0.5 }), getBlock: () => ({ known: false }),
    operations: { foraging: { preview: () => ({ ready: true, kind: 'prey', target, distance: 38 }), stop () {}, execute: async () => { f.hunts++; return hunt() } }, quarry: { travelStatus: () => ({ busy: false }) }, perception: { entities: () => [] } },
    travelTo: async (input, options) => { f.trips.push(input.destination); if (options.until) f.untils.push(options.until()) }
  }
  f.steps = async count => { let last = null; for (let i = 0; i < count; i++) { last = await provisionFood(f.ctx, 32); f.tick(2000) } return last }
  return f
}

test('misses are counted per source; a hunt that walked or hit is not a miss; the rest ends', () => {
  let clock = 0
  const shared = {}, now = () => clock
  const reach = () => foodReach(shared, { now })
  assert.equal(reach().note(miss()), null)
  assert.equal(reach().given(COW.runtimeId), false)
  assert.equal(reach().note({ ...miss(), steps: 2 }), null, 'it walked: the count starts again')
  assert.equal(reach().note(miss()), null)
  assert.ok(reach().note(miss()), `given up at ${MISSES} misses in a row`)
  assert.equal(reach().given(COW.runtimeId), true)
  assert.equal(reach().given('7'), false, 'another source is untouched')
  assert.deepEqual(reach().trip(COW, { x: 40.5, y: 64, z: 0.5 }), { x: 12, z: -21 })
  assert.equal(reach().trip(COW, { x: 13, y: 64, z: -20 }), null, 'already beside it')
  reach().walked(COW.runtimeId)
  assert.equal(reach().given(COW.runtimeId), false, 'tried again from the new place')
  reach().note(miss()); reach().note(miss())
  assert.equal(reach().trip(COW, { x: 40.5, y: 64, z: 0.5 }), null, 'walked to once only')
  assert.equal(reach().given(COW.runtimeId), true)
  clock += REST_MS
  assert.equal(reach().given(COW.runtimeId), false, 'looked at again after the rest')
})

test('a source the hunt cannot walk to: two hunts, one trip beside it, two more hunts, then the search goes elsewhere', async () => {
  const f = scene()
  await f.steps(2)
  assert.equal(f.hunts, 2)
  assert.deepEqual(f.trips, [])
  assert.equal(f.logs.filter(line => /食料源 cow へ歩いて近づけません（既知の安全な陸上中継/.test(line)).length, 1, f.logs.join('\n'))
  const beside = await f.steps(1)
  assert.deepEqual(f.trips, [{ x: 12, z: -21 }], 'the long trip to the source')
  assert.equal(beside.reason, '食料源のそばから狩りをやり直します。')
  await f.steps(2)
  assert.equal(f.hunts, 4, 'hunted again from there')
  await f.steps(3)
  assert.equal(f.hunts, 4, 'no more hunts at this source')
  assert.equal(f.trips.length, 4, 'three search trips, none to the source again')
  assert.ok(f.trips.slice(1).every(at => at.x !== 12 || at.z !== -21), JSON.stringify(f.trips))
  assert.deepEqual(f.untils, [false, false, false], 'the given-up source does not end the search trip')
})

test('a hunt that gains food or lands a hit keeps hunting, with no trip', async () => {
  let n = 0
  const f = scene({ hunt: () => ++n % 2 ? miss() : { ...miss(), hits: 1 } })
  await f.steps(12)
  assert.equal(f.hunts, 12)
  assert.deepEqual(f.trips, [])
})

// Live 2026-11-19 02:15-02:27 JST: a pig in a one-deep ditch under vines; every hunt walked, none hit.
test('hunts that walk without a hit give the source up after three in a row, without a trip', async () => {
  const { CHASES } = require('../src/modes/dragon-food-reach')
  let clock = 0
  const shared = {}, now = () => clock, reach = () => foodReach(shared, { now }), chase = { ...miss(), steps: 5 }
  for (let i = 1; i < CHASES; i++) assert.equal(reach().note(chase), null)
  assert.equal(reach().note({ ...chase, hits: 1 }), null, 'a hit starts the count again')
  for (let i = 1; i < CHASES; i++) assert.equal(reach().note(chase), null)
  assert.equal(reach().note(chase)?.chased, true)
  assert.equal(reach().given(COW.runtimeId), true)
  assert.equal(reach().trip(COW, { x: 40.5, y: 64, z: 0.5 }), null, 'no trip: the bot is beside it')
  clock += REST_MS
  assert.equal(reach().given(COW.runtimeId), false)

  const f = scene({ hunt: () => ({ ...miss(), steps: 4 }) })
  await f.steps(CHASES + 2)
  assert.equal(f.hunts, CHASES, 'not hunted again after the give-up')
  assert.ok(f.logs.some(line => line.includes('歩いても当てられない')))
})

test('a source that already missed once does not cancel a search trip when its short foraging cooldown expires', async () => {
  let cooldown = false
  const f = scene({ hunt: () => { cooldown = true; return miss(COW) } })
  f.ctx.operations.foraging.preview = () => cooldown
    ? { ready: false, code: 'NO_KNOWN_FOOD_SOURCE' }
    : { ready: true, kind: 'prey', target: COW, distance: 38 }
  f.ctx.travelTo = async (input, options) => {
    f.trips.push(input.destination)
    // Simulate foraging's 15 s cooldown expiring mid-trip.
    cooldown = false
    if (options.until) f.untils.push(options.until())
  }
  await f.steps(2)
  assert.equal(f.hunts, 1)
  assert.equal(f.trips.length, 1)
  assert.deepEqual(f.untils, [false], 'a previously missed source must not abort an ongoing search trip')
})
