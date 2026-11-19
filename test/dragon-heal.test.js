'use strict'
// The expedition's wait for health (src/modes/dragon-heal.js).
// Real Realm 2026-11-19 19:26-19:34 JST: health 17.03, hunger 16, raw meat 4 (kept for the furnace) and no cooked
// food: 「安全な場所で食事を取り、体力18以上への回復を待ちます。」 for ten minutes, and again after the stall reset.
const test = require('node:test')
const assert = require('node:assert/strict')
const { heal, unfed, WAIT } = require('../src/modes/dragon-heal')
const { keeping, RAW } = require('../src/modes/raw-meat-keep')

const FOOD = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken)$|^minecraft:bread$/
const RAW_MEAT = [{ slot: 2, name: 'minecraft:porkchop', count: 1 }, { slot: 3, name: 'minecraft:chicken', count: 1 }, { slot: 4, name: 'minecraft:mutton', count: 2 }]

// The eat preview as actions/food.js answers it, with the real rule for kept meat.
function scene ({ items = RAW_MEAT, hunger = 16, health = 17.03, dim = 'overworld', house = true, gate = false, recovery = null, threatened = false, damageAgo = 60000 } = {}) {
  const shared = { playerWanted: true, botMode: 'player', playerHouse: house ? { origin: { x: -4901, y: 76, z: -4993 } } : null, dragonOwnsWork: () => true, travelLastDamageAt: 1000000 - damageAgo }
  const calls = []
  const kept = item => RAW.test(item.name) && keeping(shared, { hunger, health })
  const preview = () => {
    const food = items.filter(item => FOOD.test(item.name) && item.count > 0)
    if (food.some(item => !kept(item))) return hunger === 20 ? { ready: false, code: 'HUNGER_FULL' } : { ready: true }
    return { ready: false, code: food.length ? 'FOOD_KEPT' : 'FOOD_NOT_IN_INVENTORY' }
  }
  const record = { nether: { gate }, recovery }
  const run = () => heal({
    ctx: { operations: { food: { preview, eat: async () => { calls.push('eat') }, snapshot: () => ({ hunger }) } } },
    record, dim, shared, now: () => 1000000,
    runtime: { inventory: () => ({ known: true, items }), travel: () => ({ retreatFromHostiles: async () => { calls.push('retreat') } }) },
    threatened: () => threatened,
    supplies: { acquire: async (name, count) => { calls.push(`acquire ${name} ${count}`); return { done: false, reason: '狩りで得た肉を確認して調理します。' } } },
    nether: async () => { calls.push('nether'); return { phase: 'working', reason: 'nether' } },
    recover: async () => { calls.push('recover'); return { done: false, reason: 'recover' } }
  })
  return { run, calls, record, shared }
}

test('as at 19:26 JST: only kept raw meat and hunger 16: the wait goes for food (hunt, cook at home) and does not stand', async () => {
  const f = scene()
  const out = await f.run()
  assert.deepEqual(f.calls, ['acquire food 1'])
  assert.notEqual(out.reason, WAIT)
})

test('the same pack with hunger 18 or more regenerates: the wait stands and eats nothing', async () => {
  for (const hunger of [18, 19]) {
    const f = scene({ hunger })
    assert.deepEqual(await f.run(), { phase: 'recovering', reason: WAIT })
    assert.deepEqual(f.calls, [])
  }
})

test('health 12 or less, or hunger under 10: the raw meat is not kept, and it is eaten here', async () => {
  for (const vitals of [{ health: 11.5 }, { hunger: 9 }]) {
    const f = scene(vitals)
    assert.equal((await f.run()).reason, WAIT)
    assert.deepEqual(f.calls, ['eat'])
  }
})

test('cooked food is eaten before anything else; an empty pack goes for food as before', async () => {
  const fed = scene({ items: [...RAW_MEAT, { slot: 7, name: 'minecraft:cooked_mutton', count: 1 }] })
  await fed.run()
  assert.deepEqual(fed.calls, ['eat'])
  const empty = scene({ items: [], hunger: 19 })
  await empty.run()
  assert.deepEqual(empty.calls, ['acquire food 1'])
})

test('the ways back to food are the same as for an empty pack: the Nether gate, the death recovery, then the home', async () => {
  const nether = scene({ dim: 'nether', gate: true })
  await nether.run()
  assert.deepEqual(nether.calls, ['nether'])
  assert.equal(nether.record.nether.returning, 'supplies')
  const died = scene({ recovery: { dimension: 'overworld' } })
  await died.run()
  assert.deepEqual(died.calls, ['recover'])
  const far = scene({ dim: 'nether' })
  assert.equal((await far.run()).reason, WAIT)
  assert.deepEqual(far.calls, [])
})

test('a hit with an enemy near still retreats first', async () => {
  const f = scene({ threatened: true, damageAgo: 2000 })
  const out = await f.run()
  assert.deepEqual(f.calls, ['retreat'])
  assert.match(out.reason, /退避/)
})

test('unfed: an unreceived hunger does not regenerate; food a meal refuses for another reason is waited for', () => {
  const inventory = { items: RAW_MEAT }
  assert.equal(unfed({ meal: { ready: false, code: 'FOOD_KEPT' }, inventory, hunger: null }), true)
  assert.equal(unfed({ meal: { ready: false, code: 'FOOD_KEPT' }, inventory, hunger: 17 }), true)
  assert.equal(unfed({ meal: { ready: false, code: 'FOOD_KEPT' }, inventory, hunger: 18 }), false)
  assert.equal(unfed({ meal: { ready: false, code: 'INVENTORY_UNKNOWN' }, inventory, hunger: 12 }), false)
  assert.equal(unfed({ meal: { ready: false, code: 'HUNGER_FULL' }, inventory, hunger: 20 }), false)
  assert.equal(unfed({ meal: { ready: true }, inventory: { items: [] }, hunger: 5 }), false)
  assert.equal(unfed({ meal: { ready: false, code: 'FOOD_NOT_IN_INVENTORY' }, inventory: { items: [] }, hunger: 20 }), true)
})
