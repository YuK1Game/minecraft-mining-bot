'use strict'

// What the reserve chest holds, as the goal's value counts it (src/modes/dragon-reserve-seen.js), through the real
// expedition runtime (helpers/food-lap-world.js says what is stood in for) and the real chest ports of a second
// opener of the same chest (return/container-ports.js, as the return to the base uses them).
//
// Real Realm 2026-11-20 21:35-23:42 JST: after two deaths the return took the pickaxe and the armour out of the
// reserve chest; the goal went on counting them in the chest, and seven iron ingots and a second helmet made
// afterwards were no result (決め直し 3/3, the goal held with a trip home 28 m short of the house).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createFoodLap } = require('./helpers/food-lap-world')
const { createContainerPorts } = require('../src/modes/return/container-ports')
const { measure } = require('../src/modes/dragon-goal-measure')
const { count, home } = require('../src/modes/dragon-supply-kit')
const { noteReserve, reserveCounts } = require('../src/modes/dragon-reserve-seen')

const TAKEN = ['minecraft:iron_pickaxe', 'minecraft:iron_helmet', 'minecraft:iron_chestplate', 'minecraft:iron_leggings']
const ARMOUR = TAKEN.slice(1)
const names = home.map(([name]) => name)
const inChest = w => Object.fromEntries(names.map(name => [name, count(name, w.slots)]))

test('after a death the return takes the kit out of the reserve chest: the goal counts it once, where it is now', async t => {
  const w = await createFoodLap(t)
  await w.look(); await w.look(); await w.look(); await w.look()
  assert.equal(w.shared.dragonReserveSeen.counts.iron_helmet, 1, 'the expedition has read the chest')
  assert.equal(w.shared.dragonGoal.key, 'early.home_reserve')
  // A death: nothing in hand, nothing worn, a new life.
  w.life = 'a/1'
  w.raw.inventory = { known: true, items: [] }
  // The return (the ordinary work's ports, the same memory of received chests) takes the pickaxe and the armour out.
  const crew = createContainerPorts({ operations: w.operations, getInventory: () => w.raw.inventory, memory: w.shared.playerChestMemory })
  const pick = slots => slots.filter(slot => TAKEN.includes(slot.name)).map(slot => ({ chestSlot: slot.slot, name: slot.name, count: 1 }))
  const taken = await crew.withdraw(w.chest, pick)
  assert.equal(taken.progress.confirmedTransferred, 4, taken.code)
  // The armour is put on: out of the hand, onto the body.
  w.worn = ARMOUR.map(name => ({ name, count: 1 }))
  w.raw.inventory = { known: true, items: w.raw.inventory.items.filter(item => !ARMOUR.includes(item.name)) }
  assert.equal(count('iron_helmet', w.slots), 0, 'the helmet is not in the chest')
  // What the first look of the new life measures: before anything of this step has opened the chest again.
  const now = { key: 'early.home_reserve', items: w.raw.inventory.items.map(item => ({ ...item })), worn: w.worn, record: w.record() }
  const once = measure({ ...now, reserve: inChest(w) }).value
  const twice = measure({ ...now, reserve: w.shared.dragonReserveSeen.counts }).value
  assert.ok(twice > once + 10, `the copy of the chest the expedition took counts the kit twice (${twice} against ${once})`)
  assert.deepEqual(reserveCounts(w.shared), inChest(w), 'read from the last opener, whoever it was')
  assert.equal(await w.look(), true, 'the expedition has the player again')
  assert.equal(w.shared.dragonGoal.best, once, 'what later gains have to beat is the kit counted once')
})

test('the counts: the later record of the house\'s pair, the copy while nothing was remembered, null before the first read', () => {
  const slots = n => [{ slot: 0, known: true, name: 'minecraft:iron_helmet', count: n }, { slot: 1, known: true, name: 'minecraft:cooked_beef', count: 5 }]
  const shared = {}
  assert.equal(reserveCounts(shared), null)
  // A copy of the form before this module (no place, no names): as it is.
  shared.dragonReserveSeen = { counts: { iron_helmet: 1 } }
  assert.deepEqual(reserveCounts(shared), { iron_helmet: 1 })
  const at = { x: 3, y: 65, z: 1 }
  assert.deepEqual(noteReserve(shared, at, ['iron_helmet', 'food'], slots(2)).counts, { iron_helmet: 2, food: 5 })
  assert.deepEqual(reserveCounts(shared), { iron_helmet: 2, food: 5 }, 'no memory of received chests: the copy')
  shared.playerChestMemory = { seen: new Map(), at: new Map() }
  assert.deepEqual(reserveCounts(shared), { iron_helmet: 2, food: 5 }, 'this chest not in the memory: the copy')
  shared.playerChestMemory.seen.set('3,65,1', slots(1)); shared.playerChestMemory.at.set('3,65,1', 100)
  assert.deepEqual(reserveCounts(shared), { iron_helmet: 1, food: 5 })
  // The other half of the house's large chest was opened later (the house's origin makes (3,65,1) and (4,65,1) one chest).
  shared.playerHouse = { origin: { x: 0, y: 64, z: 0 } }
  shared.playerChestMemory.seen.set('4,65,1', slots(0)); shared.playerChestMemory.at.set('4,65,1', 200)
  assert.deepEqual(reserveCounts(shared), { iron_helmet: 0, food: 5 })
  shared.playerChestMemory.at.set('3,65,1', 300)
  assert.deepEqual(reserveCounts(shared), { iron_helmet: 1, food: 5 })
})
