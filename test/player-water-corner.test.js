'use strict'
// Live 2026-11-19 09:22-09:25 JST: afloat against a bank two blocks above the
// surface, the ledges along the same bank to the side; every straight exit
// tape ended 「Water exit tape did not stand on the ledge within its tick
// bound」, 37 times in 72 s.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/movement/physics')
const { planWaterExit, createWaterExitStepper } = require('../src/movement/water-exit')
const { ledges } = require('../src/movement/water-ledges')
const { sides, aim } = require('../src/movement/water-corner')
const pond = require('./helpers/bank-pond')

const afloat = (physics, feet) => Object.assign(physics.fromServer({ position: { x: feet.x, y: feet.y + 1.62, z: feet.z }, gameMode: 'survival' }), { isInWater: true, onGround: false, velocity: { x: 0, y: 0, z: 0 } })

test('the ledges along the bank are reached around the corner, from every depth of the bob', () => {
  const physics = createPhysics({ world: { getBlock: pond.getBlock }, allowWater: true })
  for (const y of [62.1, 62.65, 62.78]) {
    const feet = { ...pond.FEET, y }
    const found = ledges(pond.getBlock, feet).slice(0, 2)
    assert.deepEqual(found.map(l => [Math.floor(l.x), l.y, Math.floor(l.z)]).sort((a, b) => b[2] - a[2]), [[-4811, 63, -5011], [-4811, 63, -5016]])
    for (const ledge of found) {
      const route = planWaterExit({ physics, initial: afloat(physics, feet), target: ledge })
      assert.equal(route.ready, true, `${y} ${ledge.z}: ${route.reason}`)
      assert.ok(route.waterExit.via, 'the straight heading does not stand on this ledge')
      const end = route.exitFrames.at(-1).state
      assert.equal(end.onGround, true)
      assert.equal(end.isInWater, false)
      assert.deepEqual([Math.floor(end.position.x), end.position.y, Math.floor(end.position.z)], [Math.floor(ledge.x), 63, Math.floor(ledge.z)])
    }
  }
})

test('the stepper sends the same tape and stands on the ledge in prediction', () => {
  const physics = createPhysics({ world: { getBlock: pond.getBlock }, allowWater: true })
  const initial = afloat(physics, pond.FEET)
  const route = planWaterExit({ physics, initial, target: { x: -4810.5, y: 63, z: -5010.5 } })
  const stepper = createWaterExitStepper({ route, initial, physics })
  let frame = null
  for (let i = 0; i < route.exitFrames.length; i++) {
    frame = stepper.next()
    assert.deepEqual(frame.predictedState.position, route.exitFrames[i].state.position)
  }
  assert.equal(frame.phase, 'awaiting_server_confirmation')
  // A server correction re-seeds the prediction; the rule has no memory and goes on.
  const again = createWaterExitStepper({ route, initial, physics })
  for (let i = 0; i < 10; i++) again.next()
  assert.equal(again.resumeReplay(afloat(physics, { x: -4809.5, y: 62.4, z: -5012.2 })).accepted, true)
  let phase = 'moving'
  for (let i = 0; i < 250 && phase === 'moving'; i++) phase = again.next().phase
  assert.equal(phase, 'awaiting_server_confirmation')
})

test('a straight exit keeps its fixed heading', () => {
  const physics = createPhysics({ world: { getBlock: pond.getBlock }, allowWater: true })
  const feet = { x: -4809.5, y: 62.6, z: -5010.5 }
  const route = planWaterExit({ physics, initial: afloat(physics, feet), target: { x: -4810.5, y: 63, z: -5010.5 } })
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.waterExit.via, undefined)
})

test('side cells are received water beside the ledge only; the aim turns to the ledge on its line', () => {
  const physics = createPhysics({ world: { getBlock: pond.getBlock }, allowWater: true })
  const found = sides(physics, { x: -4811, y: 63, z: -5011 }, 62, pond.FEET)
  assert.deepEqual(found.map(s => [s.x, s.z, s.dx, s.dz]), [[-4809.5, -5010.5, -1, 0], [-4810.5, -5009.5, 0, -1]])
  const hidden = createPhysics({ world: { getBlock: (x, y, z) => (z >= -5010 || x >= -4810 ? { ...pond.getBlock(x, y, z), known: false } : pond.getBlock(x, y, z)) }, allowWater: true })
  assert.deepEqual(sides(hidden, { x: -4811, y: 63, z: -5011 }, 62, pond.FEET), [], 'cells that were not received are not sides')
  const via = found[0], ledge = { x: -4810.5, z: -5010.5 }
  assert.ok(Math.abs(aim({ x: -4809.7, z: -5013.1 }, via, ledge)) < 10, 'off the line: along the bank toward the side cell')
  assert.ok(Math.abs(aim({ x: -4809.6, z: -5010.4 }, via, ledge) - 90) < 10, 'on the line: into the ledge')
})
