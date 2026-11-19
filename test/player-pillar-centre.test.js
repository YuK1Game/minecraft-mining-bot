'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { centreOnColumn } = require('../src/modes/pillar-centre')

const world = cells => (x, y, z) => cells.has(`${x},${y},${z}`) ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }

test('an off-centre body is walked to a free block beside and back', async () => {
  const floor = new Set(); for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) floor.add(`${x},63,${z}`)
  let at = { x: 0.62, y: 64, z: 0.5 }; const walks = []
  // A walk of a few centimetres does not move the Bot; a walk from another block does.
  const walk = async to => { walks.push(to); if (Math.hypot(to.x - at.x, to.z - at.z) > 0.4) at = { ...to } ; return true }
  assert.equal(await centreOnColumn({ column: { x: 0, z: 0 }, base: 64, feet: () => at, block: world(floor), walk }), true)
  assert.deepEqual(walks.map(w => [w.x, w.z]), [[1.5, 0.5], [0.5, 0.5]])
})

test('a centred body is left alone, and no free side is reported', async () => {
  const floor = new Set(['0,63,0'])
  let calls = 0; const walk = async () => { calls++; return true }
  assert.equal(await centreOnColumn({ column: { x: 0, z: 0 }, base: 64, feet: () => ({ x: 0.52, y: 64, z: 0.5 }), block: world(floor), walk }), true)
  assert.equal(await centreOnColumn({ column: { x: 0, z: 0 }, base: 64, feet: () => ({ x: 0.7, y: 64, z: 0.5 }), block: world(floor), walk }), false)
  assert.equal(calls, 0)
})
