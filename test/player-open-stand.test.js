'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOpenStand } = require('../src/modes/open-stand')

// The received blocks around the home furnace, live 2026-11-18 23:26 JST (house origin (-4901, 76, -4993)).
function house () {
  const cells = new Map()
  const set = (x, y, z, name) => cells.set(`${x},${y},${z}`, name)
  for (let x = -4901; x <= -4895; x++) for (let z = -4993; z <= -4985; z++) set(x, 76, z, 'cobblestone')
  for (let x = -4901; x <= -4895; x++) for (const y of [77, 78]) { set(x, y, -4987, 'oak_planks'); set(x, y, -4993, 'oak_planks') }
  for (let z = -4993; z <= -4987; z++) for (const y of [77, 78]) { set(-4901, y, z, 'oak_planks'); set(-4895, y, z, 'oak_planks') }
  set(-4898, 77, -4987, 'wooden_door'); set(-4898, 78, -4987, 'wooden_door') // the open door
  set(-4900, 77, -4989, 'furnace'); set(-4900, 77, -4988, 'furnace'); set(-4900, 77, -4990, 'crafting_table')
  return (x, y, z) => { const name = cells.get(`${x},${y},${z}`) ?? 'air'; return { known: true, name: `minecraft:${name}`, boundingBox: name === 'air' || name === 'wooden_door' ? 'empty' : 'block' } }
}

test('outside the door the home furnace cannot be opened; the stand chosen is inside, and the walk there ends the search', async () => {
  const getBlock = house(), furnace = { x: -4900, y: 77, z: -4989 }
  const body = { x: -4897.5, y: 77, z: -4985.5 }, walks = []
  const stand = createOpenStand({ getBlock, getFeet: () => ({ ...body }), walk: async to => { walks.push(to); Object.assign(body, to) } })
  assert.equal(stand.here(furnace), false, 'the wall beside the door is in the way')
  const found = stand.stands(furnace)
  assert.ok(found.length > 0)
  assert.ok(found.every(at => at.z > -4993 && at.z < -4987 && at.x > -4901 && at.x < -4895), 'every stand is inside the walls')
  assert.equal(await stand.go(furnace), true)
  assert.equal(walks.length, 1)
  assert.equal(stand.here(furnace), true)
})

test('with no walk that gets inside, the answer is false after the bounded tries', async () => {
  const getBlock = house(), furnace = { x: -4900, y: 77, z: -4989 }
  let walks = 0
  const stand = createOpenStand({ getBlock, getFeet: () => ({ x: -4897.5, y: 77, z: -4985.5 }), walk: async () => { walks++ } })
  assert.equal(await stand.go(furnace), false)
  assert.ok(walks >= 1 && walks <= 4)
})
