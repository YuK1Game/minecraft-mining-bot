'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const observed = require('./fixtures/learning-risk-shore-current.json')

test('captured life66 old81tick path remains physical but now fails18m archer clearance before any execution', () => {
  const state = structuredClone(observed.state), cells = new Map(observed.rows.map(([x, y, z, type]) => [`${x},${y},${z}`, observed.templates[type]]))
  const world = { getBlock: (x, y, z) => cells.get(`${x},${y},${z}`) ?? { known: false } }
  const nav = createNavigator({ world, allowWater: true }), initial = nav.physics.fromServer(state)
  const all = structuredClone(state.entities); for (const e of all) delete e.terrainOcclusion
  const evaluation = evaluateThreats(state, all, { observationRadius: 32 })
  assert.equal(evaluation.requiresObservation, false); assert.equal(evaluation.threats.length, 0)
  const skeleton = evaluation.outsideDanger.find(a => a.runtimeId === '2132')
  assert.equal(skeleton.legacyRadius, undefined); assert.equal(skeleton.dangerRadius, 18); assert.equal(skeleton.riskAccepted, undefined)
  assert.ok(Math.abs(skeleton.distance - 18.765759099426884) < 1e-6)
  const circles = evaluation.outsideDanger.map(a => ({ id: a.runtimeId, position: a.position, minDistance: a.dangerRadius, padding: 0.5 }))
  assert.equal(nav.plan(initial, observed.target, { maxDistance: 12, maxExpanded: 500, avoidance: circles }).ready, false)
  // Explicit OLD10 counterfactual, never current-policy movement admission.
  const oldCircles = evaluation.outsideDanger.map(a => ({id:a.runtimeId,position:a.position,minDistance:['minecraft:skeleton','minecraft:stray','minecraft:bogged'].includes(a.name)?10:a.dangerRadius,padding:.5}))
  const route = nav.plan(initial, observed.target, { maxDistance: 12, maxExpanded: 500, avoidance: oldCircles })
  assert.equal(route.ready, true, route.reason)
  const stepper = nav.createStepper(route, initial, { maxTicks: 100 }), trace = [initial.position]
  let frame, ticks = 0
  for (; ticks < 100; ticks++) { frame = stepper.next(); trace.push(frame.predictedState.position); if (frame.phase !== 'moving') break }
  assert.equal(ticks + 1, 81); assert.equal(frame.phase, 'awaiting_server_confirmation')
  assert.equal(frame.predictedState.onGround, true); assert.equal(frame.predictedState.isInWater, false)
  assert.equal(nav.verifyOrigin(frame.predictedState), true)
  for (const a of evaluation.outsideDanger) {
    const hardFloor = a.name === 'minecraft:creeper' ? 5.5 : ['ranged', 'ranged_possible'].includes(a.category) ? 4 : 3.5
    const nearest = Math.min(...trace.map((p, index) => {
      const from = trace[Math.max(0, index - 1)], delta = { x:p.x-from.x, y:p.y-from.y, z:p.z-from.z }, length = delta.x**2+delta.y**2+delta.z**2
      const t = length ? Math.max(0,Math.min(1,((a.position.x-from.x)*delta.x+(a.position.y-from.y-1.62)*delta.y+(a.position.z-from.z)*delta.z)/length)) : 0
      return Math.hypot(from.x+delta.x*t-a.position.x,from.y+1.62+delta.y*t-a.position.y,from.z+delta.z*t-a.position.z)
    }))
    assert.ok(nearest >= hardFloor, a.name + ' ' + nearest)
  }
  const end = frame.predictedState.position
  assert.ok(Math.abs(Math.hypot(end.x - skeleton.position.x, end.y + 1.62 - skeleton.position.y, end.z - skeleton.position.z) - 16.450949719853597) < 0.1)
  assert.ok(Math.hypot(end.x-skeleton.position.x,end.y+1.62-skeleton.position.y,end.z-skeleton.position.z)<skeleton.dangerRadius,'the old physical endpoint violates the new clearance')
  assert.equal(route.serverConfirmed, false)
})
