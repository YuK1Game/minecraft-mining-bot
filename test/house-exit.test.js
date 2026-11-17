'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { leaveHouse, inside } = require('../src/modes/house/house-exit')
const { doorOf } = require('../src/modes/house/house-door')

const origin = { x: -4901, y: 76, z: -4994 }

// Floor at origin.y, walls around a 7x7 footprint with the blueprint's door gap.
function world () {
  const door = doorOf(origin)
  return (x, y, z) => {
    if (y < origin.y + 1) return { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' }
    if (door && x === door.x && z === door.z && (y === door.y || y === door.y + 1)) return { known: true, name: 'minecraft:wooden_door', boundingBox: 'block', properties: { open_bit: true } }
    const wall = (x === origin.x || x === origin.x + 6 || z === origin.z || z === origin.z + 6) && x >= origin.x && x <= origin.x + 6 && z >= origin.z && z <= origin.z + 6
    if (wall && y <= origin.y + 3) return { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
}

test('inside the house, a long trip first walks out through the door (live 2026-11-17 21:52 JST)', async () => {
  let feet = { x: origin.x + 1.5, y: origin.y + 2, z: origin.z + 4.5 }
  const walks = [], logs = []
  let opened = 0
  const out = await leaveHouse({ house: { origin }, getFeet: () => feet, getBlock: world(), walk: async target => { walks.push(target); feet = { ...target } ; return true }, door: async () => { opened++; return true }, log: line => logs.push(line) })
  assert.equal(out, true)
  assert.equal(opened, 1)
  assert.equal(walks.length, 2)
  assert.equal(inside(origin, walks[0]), true, 'first the stand inside the door')
  assert.equal(inside(origin, walks[1]), false, 'then the stand outside it')
  assert.ok(logs.some(line => /外へ出ました/.test(line)))
})

test('outside the house, or with no house, nothing is walked', async () => {
  const walk = async () => assert.fail('no walk')
  assert.equal(await leaveHouse({ house: { origin }, getFeet: () => ({ x: origin.x + 3.5, y: origin.y + 1, z: origin.z + 12 }), getBlock: world(), walk }), false)
  assert.equal(await leaveHouse({ house: null, getFeet: () => ({ x: 0, y: 0, z: 0 }), getBlock: world(), walk }), false)
})
