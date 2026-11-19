'use strict'

// After a death the Bot respawns at the house bed with nothing. The sword,
// pickaxe, armour and food banked through the day lie in the base chests; they
// are taken out before any work leaves the house (live 2026-11-19 17:47-17:48
// JST: respawned empty-handed, walked out, and a witch by the door killed the
// Bot twice in a minute).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { restockable, kitMissing, essential } = require('../src/modes/player-base-kit')

const inv = rows => ({ known: true, items: rows.map(([slot, name, count]) => ({ slot, name: `minecraft:${name}`, count })) })
const slot = (index, name, count = 1) => ({ slot: index, known: true, name: `minecraft:${name}`, count })
const naked = { known: true, worn: [{ piece: 'helmet', name: null }, { piece: 'chestplate', name: null }, { piece: 'leggings', name: null }, { piece: 'boots', name: null }] }

test('the kit is missing only without a weapon or a pickaxe', () => {
  assert.equal(kitMissing(inv([])), true)
  assert.equal(kitMissing(inv([[0, 'wooden_sword', 1]])), true, 'no pickaxe')
  assert.equal(kitMissing(inv([[0, 'stone_pickaxe', 1]])), true, 'no weapon')
  assert.equal(kitMissing(inv([[0, 'stone_pickaxe', 1], [1, 'iron_axe', 1]])), false)
  assert.equal(kitMissing(inv([[0, 'stone_pickaxe', 1], [1, 'wooden_sword', 1]])), false, 'armour and food alone are no reason for a trip')
  assert.equal(kitMissing(null), false, 'unknown is not missing')
  assert.equal(kitMissing({ known: true, uncertain: true, items: [] }), false)
  assert.equal(essential('minecraft:stone_sword'), true)
  assert.equal(essential('minecraft:cooked_beef'), true)
  assert.equal(essential('minecraft:coal'), false)
})

test('from a chest: the best sword and pickaxe beyond those held, armour not worn, a shield, food', () => {
  const chest = [slot(0, 'wooden_sword'), slot(1, 'stone_sword'), slot(2, 'stone_pickaxe'), slot(3, 'iron_pickaxe'), slot(4, 'iron_helmet'), slot(5, 'leather_helmet'), slot(6, 'iron_boots'),
    slot(7, 'beef', 10), slot(8, 'cooked_beef', 10), slot(9, 'shield'), slot(10, 'tuff', 64), slot(11, 'coal', 30)]
  const wants = restockable(inv([]), naked, chest)
  const by = name => wants.filter(want => want.name === `minecraft:${name}`).reduce((sum, want) => sum + want.count, 0)
  assert.equal(by('stone_sword'), 1)
  assert.equal(by('wooden_sword'), 0)
  assert.equal(by('iron_pickaxe'), 1)
  assert.equal(by('stone_pickaxe'), 0)
  assert.equal(by('iron_helmet'), 1)
  assert.equal(by('leather_helmet'), 0)
  assert.equal(by('iron_boots'), 1)
  assert.equal(by('shield'), 1)
  assert.equal(by('cooked_beef'), 10, 'cooked food first')
  assert.equal(by('beef'), 6, 'up to 16 food')
  assert.equal(by('coal'), 16)
  assert.equal(by('tuff'), 0)
  assert.equal(new Set(wants.map(want => want.chestSlot)).size, wants.length, 'each chest slot once')
  // Held as good or better, worn, or with food held: not taken.
  const geared = inv([[0, 'iron_sword', 1], [1, 'diamond_pickaxe', 1], [2, 'bread', 3], [3, 'shield', 1], [4, 'coal', 16]])
  const worn = { known: true, worn: [{ piece: 'helmet', name: 'minecraft:iron_helmet' }, { piece: 'chestplate', name: null }, { piece: 'leggings', name: null }, { piece: 'boots', name: 'minecraft:leather_boots' }] }
  assert.deepEqual(restockable(geared, worn, chest), [])
  // With the worn slots not received, no armour is taken (it may be worn).
  assert.equal(restockable(inv([]), null, chest).some(want => /helmet|boots/.test(want.name)), false)
})

test('respawned empty-handed in the house: the sword, pickaxe, armour and food come out of the base chests first (live 2026-11-19 17:47 JST)', async () => {
  const gear = [[0, 'stone_sword', 1], [1, 'stone_pickaxe', 1], [2, 'iron_helmet', 1], [3, 'cooked_beef', 12], [4, 'cobblestone', 64]]
  const sim = createReturnSim({ feet: { x: 3.5, y: GROUND, z: 30.5 }, items: gear })
  const house = sim.buildHouse({ x: 0, y: GROUND, z: 0 })
  const o = house.origin
  const A = { x: o.x + 3, y: o.y + 1, z: o.z + 1 }, B = { x: o.x + 5, y: o.y + 1, z: o.z + 3 }
  // The banked gear lies in chest B; the chest on record (A) holds rubble only.
  sim.placeChest(A.x, A.y, A.z, { fill: 10 })
  gear.forEach((_, index) => { sim.storeOf(B)[index] = structuredClone(sim.bag[index]) })
  sim.shared.playerBase = A
  sim.worn = naked
  sim.die({ x: o.x + 3.5, y: o.y + 1, z: o.z + 3.5 })
  sim.agent.running = true
  const runtime = sim.mount()
  const armed = value => value === true || (sim.held('stone_sword') === 1 && sim.held('stone_pickaxe') === 1)
  assert.equal(await sim.run(runtime, { until: armed, ms: 300000 }), true, sim.log.join('\n'))
  assert.equal(sim.log.filter(line => /拠点のチェストから(?:ダイヤと資材|武器・道具・防具・食料)を取り出します/.test(line)).length >= 1, true, sim.log.join('\n'))
  assert.equal(sim.held('stone_sword'), 1)
  assert.equal(sim.held('stone_pickaxe'), 1)
  assert.equal(sim.held('iron_helmet'), 1)
  assert.equal(sim.held('cooked_beef'), 12)
  assert.equal(sim.held('cobblestone'), 0, 'rubble stays in the chest')
  assert.equal(sim.stored(B, 'stone_sword'), 0)
  // Once taken, the chests are no reason for another trip.
  await sim.sleep(60000)
  assert.equal(await runtime.base.tick(), null)
})
