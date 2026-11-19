'use strict'

// The things of the house a job needs, read from the received blocks (src/modes/house/house-facilities.js), and what
// the house's record means (src/modes/house/house-repair.js).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { facility, repairSteps, NAMES } = require('../src/modes/house/house-facilities')
const { houseDuty, focusOf, needHouse } = require('../src/modes/house/house-repair')
const { houseDoc, loadHouseSync } = require('../src/modes/house/house-build')
const { chestOf, bedOf } = require('../src/modes/house/house-spawn')
const { createHouseWorld, ORIGIN } = require('./helpers/house-world')

const ids = steps => steps.map(step => step.id).sort()

test('in a whole house every thing stands, at the blueprint\'s place', () => {
  const w = createHouseWorld()
  for (const name of NAMES) assert.equal(facility(w.getBlock, ORIGIN, name).state, 'standing', name)
  assert.deepEqual(facility(w.getBlock, ORIGIN, 'chest').at, chestOf(ORIGIN))
  assert.deepEqual(facility(w.getBlock, ORIGIN, 'bed').at, bedOf(ORIGIN))
  assert.equal(facility(w.getBlock, ORIGIN, 'chest').alternative, false)
})

test('a hole in the wall or the roof breaks none of the things', () => {
  const w = createHouseWorld()
  w.take('oak_planks', 'oak_slab', 'glass', 'torch')
  for (const name of NAMES) assert.equal(facility(w.getBlock, ORIGIN, name).state, 'standing', name)
})

test('the bed gone is broken: its step, the floor under it when that is gone too, and the table it is made at', () => {
  const w = createHouseWorld()
  w.take('white_bed')
  const bed = facility(w.getBlock, ORIGIN, 'bed')
  assert.equal(bed.state, 'broken')
  assert.deepEqual(ids(bed.missing), ['p_173'])
  assert.deepEqual(repairSteps(w.getBlock, ORIGIN, 'bed').sort(), ['p_173'])
  const under = w.steps.find(step => step.phase === 'foundation' && step.position.x === ORIGIN.x + 1 && step.position.z === ORIGIN.z + 2)
  w.take(under.id, 'crafting_table')
  assert.deepEqual(repairSteps(w.getBlock, ORIGIN, 'bed').sort(), ['p_173', 'p_178', under.id].sort())
  assert.deepEqual(repairSteps(w.getBlock, ORIGIN, 'furnace'), [], 'a thing that stands needs no step')
})

test('one of two is enough: the other large chest, the other furnace; the one used before comes first', () => {
  const w = createHouseWorld()
  const [a1, a2, b1] = w.pick('chest')
  w.take(a2.id)
  const chest = facility(w.getBlock, ORIGIN, 'chest')
  assert.equal(chest.state, 'standing')
  assert.deepEqual(chest.at, b1.position, 'half of chest A is 27 slots: chest B')
  assert.equal(chest.alternative, true)
  w.mend()
  assert.deepEqual(facility(w.getBlock, ORIGIN, 'chest', { prefer: b1.position }).at, b1.position)
  assert.deepEqual(facility(w.getBlock, ORIGIN, 'chest', { spent: at => at.x === a1.position.x && at.z === a1.position.z }).at, b1.position)
  assert.equal(facility(w.getBlock, ORIGIN, 'chest', { spent: () => true }).state, 'spent', 'standing, and every use of it failed')
  const [f1, f2] = w.pick('furnace')
  w.take(f1.id)
  assert.deepEqual(facility(w.getBlock, ORIGIN, 'furnace').at, f2.position)
  w.take(f2.id)
  assert.equal(facility(w.getBlock, ORIGIN, 'furnace').state, 'broken')
  assert.equal(facility(w.getBlock, ORIGIN, 'furnace').missing.length, 1, 'one furnace is what the repair puts back')
})

test('both large chests damaged: broken, and the repair is the pair nearest to whole', () => {
  const w = createHouseWorld()
  const [a1, a2, b1] = w.pick('chest')
  w.take(a1.id, a2.id, b1.id)
  const chest = facility(w.getBlock, ORIGIN, 'chest')
  assert.equal(chest.state, 'broken')
  assert.deepEqual(ids(chest.missing), [b1.id])
})

test('unreceived cells are never broken and never standing', () => {
  const w = createHouseWorld()
  w.take('white_bed'); w.hide('white_bed')
  assert.equal(facility(w.getBlock, ORIGIN, 'bed').state, 'unknown')
  w.away = true
  for (const name of NAMES) assert.equal(facility(w.getBlock, ORIGIN, name).state, 'unknown', name)
  assert.deepEqual(repairSteps(w.getBlock, ORIGIN, 'bed'), [])
  // One chest pair unreceived and the other received broken: still unknown, the unreceived one may stand.
  w.away = false; w.show(); w.mend()
  const [a1, , b1] = w.pick('chest')
  w.take(a1.id); w.hide(b1.id)
  assert.equal(facility(w.getBlock, ORIGIN, 'chest').state, 'unknown')
})

test('the entrance: the floor through the doorway; a missing door is still a way in, a block in the doorway is not', () => {
  const w = createHouseWorld()
  w.take('oak_door')
  assert.equal(facility(w.getBlock, ORIGIN, 'entrance').state, 'standing')
  // The blast of 2026-11-19 01:34 JST: the door and the floor behind it.
  w.set(ORIGIN.x + 3, ORIGIN.y, ORIGIN.z + 5, null)
  const entrance = facility(w.getBlock, ORIGIN, 'entrance')
  assert.equal(entrance.state, 'broken')
  assert.deepEqual(ids(entrance.missing), ['p_039'])
  w.mend()
  w.set(ORIGIN.x + 3, ORIGIN.y + 1, ORIGIN.z + 6, 'cobblestone')
  assert.equal(facility(w.getBlock, ORIGIN, 'entrance').state, 'broken')
})

test('who works on the house: the build, a running repair, nobody while it is whole or the repair is held', () => {
  assert.equal(houseDuty(null), 'build')
  assert.equal(houseDuty({ origin: ORIGIN, done: false }), 'build')
  assert.equal(houseDuty({ origin: ORIGIN, done: true }), null)
  assert.equal(houseDuty({ origin: ORIGIN, done: false, repair: { state: 'running', since: 0 } }), 'repair')
  assert.equal(houseDuty({ origin: ORIGIN, done: false, repair: { state: 'held', since: 0, until: 9 } }), null)
  assert.equal(focusOf({ origin: ORIGIN, done: false, repair: { state: 'running', since: 0 } }), null)
  assert.deepEqual([...focusOf({ origin: ORIGIN, done: false, repair: { state: 'running', since: 0, focus: ['p_173'] } })], ['p_173'])
  assert.equal(focusOf({ origin: ORIGIN, done: false, repair: { state: 'held', since: 0, until: 9, focus: ['p_173'] } }), null)
})

test('a job that needs a broken thing: the observation is written, that thing\'s repair runs, and a tried one is not asked for again', () => {
  const w = createHouseWorld()
  const shared = { playerHouse: { origin: ORIGIN, done: true, spawn: true } }
  assert.equal(needHouse(shared, w.getBlock, 'bed', { now: 1000 }).state, 'standing')
  assert.equal(shared.playerHouse.done, true, 'nothing written for a thing that stands')
  w.take('white_bed')
  w.away = true
  assert.equal(needHouse(shared, w.getBlock, 'bed', { now: 1000 }).state, 'unknown')
  assert.equal(shared.playerHouse.done, true, 'nothing written for unreceived cells')
  w.away = false
  const logs = []
  assert.equal(needHouse(shared, w.getBlock, 'bed', { now: 2000, log: line => logs.push(line) }).state, 'repair')
  assert.deepEqual(shared.playerHouse, { origin: ORIGIN, done: false, spawn: true, built: true, repair: { state: 'running', since: 2000, need: 'bed', focus: ['p_173'] } })
  assert.match(logs[0], /家のベッドが壊れているため、そこだけ先に直します（1 手）/)
  // Another thing while this one is being put back: one at a time.
  w.take('furnace')
  assert.equal(needHouse(shared, w.getBlock, 'furnace', { now: 3000 }).state, 'repair')
  assert.equal(shared.playerHouse.repair.need, 'bed')
  // Held after its time: the bed is not asked for again; another thing is, once.
  shared.playerHouse = { ...shared.playerHouse, repair: { state: 'held', since: 2000, heldAt: 9000, until: 99000, need: 'bed', focus: ['p_173'], tried: { bed: 9000 }, basis: { missing: 3, short: null, seen: true } } }
  const held = needHouse(shared, w.getBlock, 'bed', { now: 10000 })
  assert.equal(held.state, 'held'); assert.equal(held.until, 99000)
  assert.equal(shared.playerHouse.repair.state, 'held')
  assert.equal(needHouse(shared, w.getBlock, 'furnace', { now: 11000 }).state, 'repair')
  assert.deepEqual(shared.playerHouse.repair, { state: 'running', since: 11000, need: 'furnace', focus: ['p_179'], tried: { bed: 9000 } })
})

test('the record on disk: a file of before is read as it was, a repair is kept, a broken shape is dropped', () => {
  const read = doc => loadHouseSync('x', { io: { readFileSync: () => JSON.stringify(doc) } })
  assert.deepEqual(read({ version: 1, origin: ORIGIN, done: true, spawn: true }), { origin: { ...ORIGIN }, done: true, spawn: true })
  const held = { origin: { ...ORIGIN }, done: false, spawn: true, built: true, left: { glass: 2 }, repair: { state: 'held', since: 5, need: 'bed', focus: ['p_173'], tried: { bed: 9 }, heldAt: 9, until: 99, basis: { missing: 3, short: { logs: 0, wool: 3 }, seen: true } } }
  assert.deepEqual(read(houseDoc(held, 0)), held)
  const running = { origin: { ...ORIGIN }, done: false, spawn: false, built: true, repair: { state: 'running', since: 7 } }
  assert.deepEqual(read(houseDoc(running, 0)), running)
  assert.equal(read({ version: 1, origin: ORIGIN, done: false, repair: { state: 'held', since: 5 } }).repair, undefined, 'a hold without its time is not a hold')
  assert.equal(read({ version: 1, origin: ORIGIN, done: false, repair: { state: 'done' } }).repair, undefined)
  assert.equal(houseDoc({ origin: ORIGIN, done: true, spawn: true, repair: null }, 0).repair, undefined)
})
