'use strict'
// Live 2026-11-14 10:55: the bot climbed out of a water corner onto a one-block
// ledge (server-confirmed) by holding forward+jump; before, every ordinary plan
// ended in a replan after a server correction.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planWaterExit, createWaterExitStepper } = require('../src/water-exit')

// A tiny physics stand-in: water at y<=58 in column z<=14; a stone ledge top at
// y=59 for z>=15. Holding forward+jump rises 0.4/tick and moves +z 0.25/tick;
// once over the ledge and at y>=59 the body stands on it.
function physics ({ unknownHead = false, solidHead = false } = {}) {
  const blocks = (p) => {
    const { x, y, z } = p
    if (z >= 15 && y === 58) return { name: 'minecraft:stone', known: true, shapes: [[0, 0, 0, 1, 1, 1]] }
    if (z >= 15 && y === 60 && solidHead) return { name: 'minecraft:stone', known: true, shapes: [[0, 0, 0, 1, 1, 1]] }
    if (z >= 15 && y === 60 && unknownHead) return { name: 'minecraft:air', known: false, shapes: [] }
    if (z <= 14 && y <= 58) return { name: 'minecraft:water', known: true, shapes: [] }
    return { name: 'minecraft:air', known: true, shapes: [] }
  }
  return {
    blockAt: p => blocks({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }),
    step (s, controls) {
      const p = { ...s.position }
      if (controls.forward) p.z += 0.25
      if (controls.jump) p.y = Math.min(59, p.y + 0.4)
      if (p.z >= 15 && p.y < 59) p.z = 14.7 // pressed against the ledge until high enough
      const onLedge = p.z >= 15 && p.y >= 59
      return { ...s, position: p, velocity: { x: 0, y: 0, z: 0 }, onGround: onLedge, isInWater: !onLedge && p.y < 59.2, isInLava: false }
    },
    toServerPosition: s => ({ ...s.position, y: s.position.y + 1.62 })
  }
}
const initial = { position: { x: -14.7, y: 58.1, z: 14.7 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, isInWater: true, yaw: 0, pitch: 0 }
const target = { x: -14.5, y: 59, z: 15.5 }

test('a water exit plan holds forward+jump onto an adjacent received ledge', () => {
  const route = planWaterExit({ physics: physics(), initial, target })
  assert.equal(route.ready, true, route.reason)
  assert.ok(route.exitFrames.every(f => f.controls.forward && f.controls.jump))
})

test('an unknown or blocked head room above the ledge is refused (unknown is never safe)', () => {
  assert.match(planWaterExit({ physics: physics({ unknownHead: true }), initial, target }).reason, /received and passable/)
  assert.match(planWaterExit({ physics: physics({ solidHead: true }), initial, target }).reason, /received and passable/)
})

test('only from water and only to a ledge within six blocks', () => {
  assert.match(planWaterExit({ physics: physics(), initial: { ...initial, isInWater: false, position: { x: -14.7, y: 61, z: 14.7 } }, target }).reason, /only in water/)
  assert.match(planWaterExit({ physics: physics(), initial, target: { x: -14.5, y: 59, z: 23.5 } }).reason, /within six blocks/)
})

// Live 2026-11-14 20:00: in a lake the shore was three blocks away.
test('a swim of a few blocks toward a received ledge is planned and ends standing on it', () => {
  const start = { ...initial, position: { x: -14.7, y: 58.1, z: 11.7 } }
  const route = planWaterExit({ physics: physics(), initial: start, target })
  assert.equal(route.ready, true, route.reason)
  assert.equal(route.exitFrames.at(-1).state.position.y, 59)
})

test('the stepper keeps the same input through a server correction and stops on the ledge', () => {
  const p = physics(), route = planWaterExit({ physics: p, initial, target })
  const stepper = createWaterExitStepper({ route, initial, physics: p })
  stepper.next(); stepper.next()
  const resumed = stepper.resumeReplay({ ...initial, position: { x: -14.7, y: 58.2, z: 14.7 } })
  assert.equal(resumed.accepted, true)
  let frame
  for (let i = 0; i < 60; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation')
  assert.equal(frame.predictedState.position.y, 59)
})
