'use strict'

// The home kit's food, one lap (user's instructions 2026-11-20): the reserve chest is one cooked food short, and
// the Bot finds that out at the chest, leaves, hunts, cooks at home, stores, keeps its own eight and goes on to the
// next goal. The real expedition runtime runs the lap (helpers/food-lap-world.js says what is stood in for).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createFoodLap, COOKED } = require('./helpers/food-lap-world')

const FOOD_IN = transfer => transfer[0] === 'in' && COOKED.test(transfer[1])

test('lap: chest 7 and hand 8 -> the shortage is read at the chest, meat is hunted and cooked, chest 8, hand 8, next goal diamond', async t => {
  const w = await createFoodLap(t)
  assert.equal(w.objective().id, 'home_reserve')
  // 1. The chest is opened and its 54 slots say 7; the food is what is fetched now; the Bot leaves the base.
  await w.look(); await w.look(); await w.look(); await w.look()
  assert.equal(w.shared.dragonReserveSeen.counts.food, 7, 'read from the chest, as received')
  const gather = w.record().early.gather
  assert.deepEqual({ name: gather.name, count: gather.count }, { name: 'food', count: 9 }, 'one for the chest over the eight it keeps')
  assert.deepEqual(w.transfers, [], 'nothing is moved while the hand has only its own eight')
  // 2-4. Runs until the reserve finishes and the planned diamond work becomes the next objective.
  const looks = await w.lap()
  assert.notEqual(looks, -1, 'the lap ends: ' + w.trace.join(' / '))
  // 2. Meat came into the hand and was cooked at the home furnace.
  assert.equal(w.hunts, 1)
  assert.equal(w.cooks.length, 1)
  assert.deepEqual(w.cooks[0], ['minecraft:beef', 1, 'minecraft:coal'], 'only what the kit is short of is cooked')
  // 3. The same chest read again: 8. The hand keeps 8. One transfer of one item, nothing twice, nothing taken out.
  assert.equal(w.chestCount(COOKED), 8)
  assert.equal(w.cooked(), 8)
  assert.deepEqual(w.transfers, [['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.shared.dragonReserveSeen.counts.food, 8, 'the last read of the chest')
  // 4. The kit is banked and the expedition retains the planned diamond objective.
  assert.equal(w.record().early.reserveReady, true)
  assert.equal(w.record().early.gather, undefined)
  assert.equal(w.objective().id, 'diamond')
  assert.equal(w.objective().legacy, false)
  assert.equal(w.rt.owns(), true)
  assert.equal(w.said(/^遠征: 目的 .*進んでいません/).length, 0, 'no stall was counted on the way')
})

test('lap: a meal on the way is made up for; the chest still gets its one and the hand ends with eight or more', async t => {
  const w = await createFoodLap(t, { animals: [{ at: { x: 30, z: 40 }, drops: 1 }, { at: { x: -40, z: 30 }, drops: 2 }] })
  let ate = false
  const looks = await w.lap({ each: () => { if (!ate && w.hunts === 1) { ate = true; w.eat(1) } } })
  assert.notEqual(looks, -1, 'the lap ends: ' + w.trace.join(' / '))
  assert.equal(ate, true)
  assert.equal(w.chestCount(COOKED), 8)
  assert.ok(w.cooked() >= 8, 'hand ' + w.cooked())
  assert.deepEqual(w.transfers.filter(FOOD_IN), [['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.record().early.reserveReady, true)
  assert.equal(w.objective().id, 'diamond')
})

test('lap: a reserve chest full of stone, with food of another kind: one stack of stone comes out, then the one food goes in', async t => {
  const w = await createFoodLap(t, { rubble: true, chestFoodName: 'cooked_mutton' })
  const looks = await w.lap()
  assert.notEqual(looks, -1, 'the lap ends: ' + w.trace.join(' / '))
  assert.deepEqual(w.transfers, [['out', 'minecraft:cobblestone', 12], ['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.chestCount(COOKED), 8)
  assert.equal(w.cooked(), 8)
  assert.equal(w.objective().id, 'diamond')
})

test('lap: a reload of the behaviour code in the middle goes on with the same goal and stores nothing twice', async t => {
  const w = await createFoodLap(t)
  // Up to the cooked meat in hand, before the walk to the chest.
  let reloaded = false
  const looks = await w.lap({ each: () => {
    if (reloaded) { w.after ??= w.shared.dragonGoal?.id; return }
    if (w.cooked() < 9) return
    reloaded = true
    w.before = w.shared.dragonGoal?.id
    w.rt.cancel()
    w.boot(w.shared)
  } })
  assert.equal(reloaded, true)
  assert.notEqual(looks, -1, 'the lap ends: ' + w.trace.join(' / '))
  assert.equal(w.before, 'early.home_reserve#1')
  assert.equal(w.after, w.before, 'the same goal went on after the reload')
  assert.equal(w.hunts, 1, 'the hunt is not done again')
  assert.equal(w.cooks.length, 1, 'the cook is not done again')
  assert.deepEqual(w.transfers, [['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.chestCount(COOKED), 8)
  assert.equal(w.cooked(), 8)
  assert.equal(w.objective().id, 'diamond')
})

test('lap: food already cooked in the furnace finishes the reserve without another hunt or fuel acquisition', async t => {
  const w = await createFoodLap(t, { fuel: 0, animals: [] })
  Object.assign(w.furnace[2], { name: 'minecraft:cooked_beef', count: 1 })
  assert.notEqual(await w.lap(), -1, w.trace.join(' / '))
  assert.equal(w.hunts, 0)
  assert.equal(w.cooks.length, 0)
  assert.equal(w.chestCount(COOKED), 8)
  assert.equal(w.cooked(), 8)
  assert.deepEqual(w.transfers, [['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.objective().id, 'diamond')
})

test('lap: raw meat and fuel left in the furnace finish the reserve with neither held', async t => {
  const w = await createFoodLap(t, { fuel: 0, animals: [] })
  Object.assign(w.furnace[0], { name: 'minecraft:beef', count: 1 })
  Object.assign(w.furnace[1], { name: 'minecraft:coal', count: 1 })
  assert.notEqual(await w.lap(), -1, w.trace.join(' / '))
  assert.equal(w.hunts, 0)
  assert.equal(w.cooks.length, 1)
  assert.equal(w.chestCount(COOKED), 8)
  assert.equal(w.cooked(), 8)
  assert.deepEqual(w.transfers, [['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.objective().id, 'diamond')
})

test('lap: with no animal anywhere the lap does not end as done; the goal is warned about and decided again without freezing in a hold', async t => {
  const w = await createFoodLap(t, { animals: [] })
  const looks = await w.lap({ limit: 1500, each: () => { w.at += 2000 } })
  assert.equal(looks, -1, 'never given back as done')
  assert.equal(w.record().early.reserveReady, undefined)
  assert.equal(w.chestCount(COOKED), 7)
  assert.deepEqual(w.transfers, [])
  assert.ok(w.said(/^遠征: 目的 .*進んでいません/).length >= 1)
  assert.ok((w.shared.dragonGoal?.decisions ?? 0) >= 3, 'decisions: ' + JSON.stringify(w.shared.dragonGoal))
  assert.equal(w.shared.dragonGoal?.hold ?? null, null)
})

// Live 2026-11-20 02:21-02:32 JST: when the only pickaxe breaks while away from the mine,
// the expedition hands the player back to the starter jobs; once a pickaxe is crafted again,
// the same goal resumes to completion.
test('lap: a pickaxe broken on the way gives the player to the starter jobs; with a pickaxe again the same goal goes on to the end', async t => {
  const w = await createFoodLap(t)
  let broke = false, brokenPick = null
  const first = await w.lap({ each: () => {
    if (!broke && w.hunts === 1) {
      broke = true
      const idx = w.raw.inventory.items.findIndex(i => i.name === 'minecraft:iron_pickaxe')
      if (idx >= 0) brokenPick = w.raw.inventory.items.splice(idx, 1)[0]
    }
  } })
  assert.equal(broke, true)
  assert.notEqual(first, -1, 'the player is given back, not kept under a step that does nothing: ' + w.trace.join(' / '))
  assert.equal(w.objective().id, 'wood')
  assert.equal(w.rt.owns(), false, 'the starter jobs have the player')
  assert.equal(w.record().early.reserveReady, undefined, 'not counted as done')
  const goal = w.shared.dragonGoal?.id
  assert.equal(goal, 'early.home_reserve#1')
  // The starter jobs made a pickaxe.
  if (brokenPick) w.raw.inventory.items.push(brokenPick)
  assert.equal(w.rt.owns(), true)
  const looks = await w.lap()
  assert.notEqual(looks, -1, 'the lap ends: ' + w.trace.join(' / '))
  assert.equal(w.shared.dragonGoal?.id.startsWith('early.home_reserve#'), true)
  assert.equal(w.hunts, 1, 'the hunt is not done again')
  assert.deepEqual(w.transfers.filter(FOOD_IN), [['in', 'minecraft:cooked_beef', 1]])
  assert.equal(w.chestCount(COOKED), 8)
  assert.ok(w.cooked() >= 8)
  assert.equal(w.record().early.reserveReady, true)
  assert.equal(w.objective().id, 'diamond')
})
