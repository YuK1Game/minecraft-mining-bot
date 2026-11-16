'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createScaffoldPorts } = require('../src/modes/player-scaffold-ports')

// Flat ground at y=63 (feet stand at y=64). The fake movement arrives at once.
function scene ({ busy = 0, error = '前の操作の終了処理を待ってください。' } = {}) {
  const feet = { x: 0.5, y: 64, z: 0.5 }, starts = []
  let clock = 0, refusals = busy
  const getBlock = (x, y, z) => ({ known: true, name: y <= 63 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: y <= 63 ? 'block' : 'empty' })
  const operations = {
    movement: { start: (target, options) => { if (refusals-- > 0) throw new Error(error); if (Math.hypot(target.x - feet.x, target.z - feet.z) > options.maxDistance) throw new Error('Target lies outside the bounded search area'); starts.push({ ...target }); Object.assign(feet, target) } },
    mining: { preview: () => ({ ready: true }), start: () => {} }
  }
  const ports = createScaffoldPorts({ operations, getBlock, getFeet: () => ({ ...feet }), getInventory: () => ({ known: true, items: [] }), getMotion: () => ({ phase: 'idle' }), pillarStep: async () => ({}), sleep: async ms => { clock += ms }, now: () => clock })
  return { ports, feet, starts }
}

test('a start refused because the previous operation is still ending is tried again', async () => {
  const f = scene({ busy: 3 })
  assert.equal(await f.ports.walk({ x: 3.5, y: 64, z: 0.5 }), true)
  assert.equal(f.starts.length, 1)
  const other = scene({ busy: 1, error: 'No safe route found' })
  assert.equal(await other.ports.walk({ x: 3.5, y: 64, z: 0.5 }), false)
  assert.equal(other.ports.why(), 'No safe route found')
  assert.equal(other.starts.length, 0)
})

test('a tree farther than one walk is approached in hops over received ground', async () => {
  const f = scene()
  assert.equal(await f.ports.walk({ x: 40.5, y: 64, z: 0.5 }), false, 'one walk does not reach 40 blocks')
  assert.equal(await f.ports.approach({ x: 40.5, y: 64, z: 0.5 }), true)
  assert.ok(Math.hypot(40.5 - f.feet.x, 0.5 - f.feet.z) <= 12)
  assert.ok(f.starts.length >= 3 && f.starts.every(target => target.y === 64))
})

test('a walk refused while hanging above the floor lands first and is planned again', async () => {
  const settles = []
  const feet = { x: 0.5, y: 64.02, z: 0.5 }, starts = []
  let clock = 0, hanging = true
  const operations = {
    movement: {
      start: target => { if (hanging) { const error = new Error('Wait for a supported landing before planning'); error.code = 'NO_ROUTE'; throw error } starts.push({ ...target }); Object.assign(feet, target) },
      settle: options => { settles.push(options); hanging = false; feet.y = 64 }
    }
  }
  const ports = createScaffoldPorts({ operations, getBlock: (x, y) => ({ known: true, name: y <= 63 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 63 ? 'block' : 'empty' }), getFeet: () => ({ ...feet }), getInventory: () => ({ known: true, items: [] }), getMotion: () => ({ phase: 'idle' }), pillarStep: async () => ({}), sleep: async ms => { clock += ms }, now: () => clock })
  assert.equal(await ports.walk({ x: 2.5, y: 64, z: 0.5 }), true)
  assert.equal(settles.length, 1)
  assert.deepEqual(settles[0], { maxTicks: 40, maxDrop: 1, maxHorizontal: 1 })
  assert.equal(starts.length, 1)
  // Any other refusal does not settle.
  const other = scene({ busy: 1, error: 'No safe route found' })
  assert.equal(await other.ports.walk({ x: 3.5, y: 64, z: 0.5 }), false)
})
