'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { explore } = require('../src/modes/dragon-supply-gather')
const { MISSES, ROAM_M } = require('../src/modes/supply-roam')

// Solid rock everywhere except the Bot's own cell: no place to walk to in any heading.
function tunnel ({ dimension = 'overworld' } = {}) {
  const trips = [], lines = [], approaches = []
  const memory = { early: {} }
  const ctx = {
    memory, shared: {}, log: line => lines.push(line), cancelled: () => false,
    runtime: { raw: () => ({ dimension }) },
    getFeet: () => ({ x: -4839.5, y: 47, z: -4986.5 }),
    getBlock: (x, y, z) => ({ known: true, name: x === -4840 && z === -4987 && (y === 47 || y === 48) ? 'minecraft:air' : 'minecraft:stone', boundingBox: 'block' }),
    hands: { approach: async target => { approaches.push(target); return false } },
    travelTo: async (input, options) => { trips.push({ input, until: options.until() }); return true }
  }
  return { ctx, trips, lines, approaches, memory }
}

test('a search with nowhere to walk leaves by the long trip after a full turn of headings', async () => {
  const h = tunnel()
  for (let i = 0; i < MISSES - 1; i++) await explore(h.ctx, 'log')
  assert.equal(h.trips.length, 0)
  await explore(h.ctx, 'log')
  assert.equal(h.trips.length, 1)
  const to = h.trips[0].input.destination
  assert.equal(Math.abs(to.x - -4840) + Math.abs(to.z - -4987), ROAM_M)
  assert.equal(h.trips[0].until, false)
  assert.equal(h.lines.filter(line => /log を探して歩ける場所がまわりにないため、長距離移動で場所を変えます/.test(line)).length, 1)
  // The count starts again, and the line is not repeated within a minute.
  for (let i = 0; i < MISSES; i++) await explore(h.ctx, 'log')
  assert.equal(h.trips.length, 2)
  assert.equal(h.lines.length, 1)
  assert.notDeepEqual(h.trips[1].input.destination, to)
})

test('a step that walked starts the count again; outside the overworld no trip is asked for', async () => {
  const h = tunnel()
  for (let i = 0; i < MISSES - 1; i++) await explore(h.ctx, 'log')
  h.ctx.getBlock = (x, y, z) => ({ known: true, name: y <= 46 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 46 ? 'block' : 'empty' })
  h.ctx.hands.approach = async () => true
  await explore(h.ctx, 'log')
  assert.equal(h.memory.early.supplySearch['log:miss'], 0)
  assert.equal(h.trips.length, 0)
  const nether = tunnel({ dimension: 'nether' })
  for (let i = 0; i < MISSES * 2; i++) await explore(nether.ctx, 'soul_sand')
  assert.equal(nether.trips.length, 0)
})

test('walking in an area without logs eventually searches further and expands from the same centre', async () => {
  const h = tunnel()
  h.ctx.getBlock = (x, y, z) => ({ known: true, name: y <= 46 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 46 ? 'block' : 'empty' })
  h.memory.early.supplySearch = { 'log:roam': 73 }
  let feet = h.ctx.getFeet()
  h.ctx.getFeet = () => feet
  h.ctx.hands.approach = async target => { feet = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }; return true }
  for (let i = 0; i < 7; i++) await explore(h.ctx, 'log')
  assert.equal(h.trips.length, 0)
  const centre = { x: Math.floor(feet.x), z: Math.floor(feet.z) }
  await explore(h.ctx, 'log')
  for (let i = 0; i < 4 * 8; i++) await explore(h.ctx, 'log')
  const destinations = h.trips.map(trip => trip.input.destination)
  assert.deepEqual(destinations, [
    { x: centre.x + ROAM_M, z: centre.z }, { x: centre.x, z: centre.z + ROAM_M },
    { x: centre.x - ROAM_M, z: centre.z }, { x: centre.x, z: centre.z - ROAM_M },
    { x: centre.x + 2 * ROAM_M, z: centre.z }
  ])
})

test('an early long-trip arrival is followed by a short walk into the selected area', async () => {
  const h = tunnel()
  let feet = h.ctx.getFeet()
  h.ctx.getFeet = () => feet
  h.ctx.travelTo = async ({ destination }) => {
    feet = { x: destination.x - 19.5, y: feet.y, z: destination.z + 0.5 }
    return { phase: 'arrived', ended: 'finished' }
  }
  for (let i = 0; i < MISSES; i++) await explore(h.ctx, 'log')

  const search = h.memory.early.supplySearch
  assert.deepEqual(search['log:roamTarget'], { x: -4840 + ROAM_M, z: -4987 })
  // The regular next heading follows the Z axis instead of returning to the selected area.
  search.log = 7
  h.ctx.getBlock = (x, y, z) => ({ known: true, name: y <= 46 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 46 ? 'block' : 'empty' })
  h.ctx.hands.approach = async ({ x, y, z }) => { feet = { x: x + 0.5, y, z: z + 0.5 }; return true }
  await explore(h.ctx, 'log')
  assert.equal(feet.x, search['log:roamTarget'].x - 7.5)
  assert.equal(feet.z, search['log:roamTarget'].z + 0.5)
  await explore(h.ctx, 'log')
  assert.equal(search['log:roamTarget'], undefined)
})
