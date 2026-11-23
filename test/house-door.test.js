'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { openDoor, doorOf, doorStands } = require('../src/modes/house/house-door')

const origin = { x: 0, y: 64, z: 0 }
function scene ({ open = false, opens = true } = {}) {
  const door = doorOf(origin)
  const state = { open }
  const getBlock = (x, y, z) => {
    if (x === door.x && z === door.z && (y === door.y || y === door.y + 1)) return { known: true, name: 'minecraft:wooden_door', boundingBox: 'block', properties: { open_bit: state.open } }
    if (y < door.y) return { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' }
    if (z === door.z && y <= door.y + 2 && x >= door.x - 3 && x <= door.x + 3) return { known: true, name: 'minecraft:oak_planks', boundingBox: 'block' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
  let clock = 0
  const uses = [], walks = []
  const run = feet => openDoor({ origin, getBlock, getFeet: () => feet, walk: async target => { walks.push(target); return true }, useDoor: async at => { uses.push(at); if (opens) state.open = !state.open }, now: () => clock, sleep: async ms => { clock += ms } })
  return { door, state, getBlock, run, uses, walks }
}

test('a closed door is opened by one use and counts on the received open_bit', async () => {
  const f = scene()
  assert.equal(doorStands(f.getBlock, f.door).length, 2)
  assert.equal(await f.run({ x: f.door.x + 0.5, y: f.door.y, z: f.door.z + 1.5 }), true)
  assert.equal(f.uses.length, 1)
  assert.equal(f.state.open, true)
  assert.equal(f.walks.length, 0)
})

test('an open door is left alone; a door that does not open is reported', async () => {
  const open = scene({ open: true })
  assert.equal(await open.run({ x: 0, y: 64, z: 20 }), true)
  assert.equal(open.uses.length, 0)
  const stuck = scene({ opens: false })
  assert.equal(await stuck.run({ x: stuck.door.x + 0.5, y: stuck.door.y, z: stuck.door.z + 6.5 }), false)
  assert.equal(stuck.walks.length, 1)
  assert.equal(stuck.uses.length, 2)
})

test('a door the walk to its stand opened is not clicked again (a second click would close it)', async () => {
  const f = scene()
  let clock = 0
  const uses = []
  const ok = await openDoor({ origin, getBlock: f.getBlock, getFeet: () => ({ x: f.door.x + 0.5, y: f.door.y, z: f.door.z + 6.5 }), walk: async () => { f.state.open = true; return true }, useDoor: async at => { uses.push(at); f.state.open = !f.state.open }, now: () => clock, sleep: async ms => { clock += ms } })
  assert.equal(ok, true)
  assert.deepEqual(uses, [])
  assert.equal(f.state.open, true)
})
