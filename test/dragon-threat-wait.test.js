'use strict'
// A step of the expedition does not wait without end for an enemy nobody fights
// (src/modes/dragon-threat-wait.js, the food step in dragon-early-food.js).
// Live 2026-11-18 21:16-21:19 JST: 「敵への対処・回避を食料探しより優先してください。」
// every two seconds under the overhang west of the house, no food, nothing moved.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { threatWait, WAIT_MS, GAP_MS } = require('../src/modes/dragon-threat-wait')
const { provisionFood } = require('../src/modes/dragon-early-food')

const THREAT = { ready: false, code: 'NEARBY_THREAT', recommendation: 'avoid', errors: ['敵への対処・回避を食料探しより優先してください。'] }

// The food step with no food and no raw meat, 40 m from the house; `plan` is what the hunt's own check answers.
function scene ({ plan = () => THREAT } = {}) {
  let clock = 1000000
  const f = { trips: [], logs: [], fighting: false, plan, tick: ms => { clock += ms } }
  f.ctx = {
    shared: { playerHouse: { origin: { x: 0, y: 64, z: 0 }, done: true } }, memory: {}, now: () => clock, log: line => f.logs.push(line), cancelled: () => false, signal: new AbortController().signal,
    runtime: { inventory: () => ({ known: true, items: [{ name: 'minecraft:stone_sword', count: 1, slot: 0 }] }), raw: () => ({ dimension: 'overworld' }), combatOwns: () => f.fighting },
    getFeet: () => ({ x: 40.5, y: 64, z: 0.5 }), getBlock: () => ({ known: false }),
    operations: { foraging: { preview: () => f.plan(), stop () {}, execute: async () => assert.fail('no hunt while the check refuses') }, quarry: { travelStatus: () => ({ busy: false }) }, perception: { entities: () => [] } },
    travelTo: async input => { f.trips.push(input.destination) }
  }
  // One step every two seconds, as the expedition's timer.
  f.steps = async count => { let last = null; for (let i = 0; i < count; i++) { last = await provisionFood(f.ctx, 32); f.tick(2000) } return last }
  return f
}

test('the wait is over after its time; a pause in the refusals or a fight starts it again', () => {
  let clock = 0
  const shared = {}, now = () => clock
  assert.equal(threatWait(shared, 'food', { now }), true)
  clock = WAIT_MS - 1
  shared.dragonThreatWait.seen = clock - 2000
  assert.equal(threatWait(shared, 'food', { now }), true)
  clock = WAIT_MS
  assert.equal(threatWait(shared, 'food', { now }), false, 'waited long enough')
  clock += 2000
  assert.equal(threatWait(shared, 'food', { now, fighting: true }), true, 'combat has the controls: the fight is the answer')
  clock += WAIT_MS - 2000
  shared.dragonThreatWait.seen = clock - 2000
  assert.equal(threatWait(shared, 'food', { now }), true, 'counted from the end of the fight')
  clock += GAP_MS + 1
  assert.equal(threatWait(shared, 'food', { now }), true, 'no refusal for a while: a new wait')
  assert.equal(threatWait(shared, 'other', { now }), true, 'another reason: its own wait')
})

test('an enemy nobody fights: the food step waits twenty seconds, then looks for food somewhere else', async () => {
  const f = scene()
  const waiting = await f.steps(10)
  assert.equal(waiting.reason, THREAT.errors[0])
  assert.deepEqual(f.trips, [], 'still waiting at 18 s')
  await f.steps(1)
  assert.equal(f.trips.length, 1, 'the search trip starts at 20 s')
  assert.ok(Math.hypot(f.trips[0].x, f.trips[0].z) >= 90, JSON.stringify(f.trips[0]))
  assert.equal(f.logs.filter(line => /近くの敵が 20 秒たっても離れず、戦闘にもならないため、食料を探す場所を変えます/.test(line)).length, 1, f.logs.join('\n'))
})

test('while combat has the controls the step waits; the time is counted after the fight', async () => {
  const f = scene()
  f.fighting = true
  await f.steps(30)
  assert.deepEqual(f.trips, [], 'a minute of fighting: no trip')
  f.fighting = false
  await f.steps(9)
  assert.deepEqual(f.trips, [], '18 s after the last step of the fight')
  await f.steps(1)
  assert.equal(f.trips.length, 1)
})

test('a refusal that is not about an enemy is waited for as before', async () => {
  const f = scene({ plan: () => ({ ready: false, code: 'INVENTORY_UNKNOWN', errors: ['実際の持ち物の観測が必要です。'] }) })
  const last = await f.steps(30)
  assert.equal(last.reason, '実際の持ち物の観測が必要です。')
  assert.deepEqual(f.trips, [])
})

test('the enemy leaves before the time is up: no trip, and the hunt check is used again', async () => {
  let threat = true
  const f = scene({ plan: () => threat ? THREAT : { ready: false, code: 'NO_KNOWN_FOOD_SOURCE', errors: ['観測済みの対応食料か、保護されていない牛・豚・羊が必要です。'] } })
  await f.steps(5)
  assert.deepEqual(f.trips, [])
  threat = false
  await f.steps(1)
  assert.equal(f.trips.length, 1, 'nothing to hunt here: the ordinary search trip')
  assert.equal(f.logs.filter(line => /近くの敵/.test(line)).length, 0)
})
