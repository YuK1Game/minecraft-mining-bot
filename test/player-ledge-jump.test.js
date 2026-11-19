'use strict'

// Off a ledge deeper than three blocks, at the cost of health, when nothing else leads off it
// (movement/build-route.js `maxFall`, navigation.js `dropLimit`, modes/player-build-walk.js).
// Real Realm 2026-11-19 17:19-17:37 JST: respawned with empty hands in the house. The door step
// was three cobblestones in the air (-4899..-4897, 76, -4986); the ground stood at y 72 to the
// west and y 71 to the south and east. 「掘る・積む道もありません（NO_BUILD_ROUTE）」 sixty times.
const test = require('node:test')
const assert = require('node:assert/strict')
const { planBuildRoute } = require('../src/movement/build-route')
const { buildWalk } = require('../src/modes/player-build-walk')
const { createNavigator } = require('../src/movement/navigation')

const solid = name => ({ known: true, name: `minecraft:${name}`, boundingBox: 'block', properties: {}, extra: [] })
const air = { known: true, name: 'minecraft:air', boundingBox: 'empty', properties: {}, extra: [] }
// The received columns round the door step: the house wall to the north, the step, the ground below.
function porch () {
  const top = (x, z) => z <= -4987 ? 79 : x <= -4900 ? 72 : 71
  return (x, y, z) => {
    if (z === -4986 && x >= -4899 && x <= -4897) return y === 76 ? solid('cobblestone') : y <= 71 ? solid('stone') : air
    if (z <= -4987) return y <= top(x, z) ? solid('oak_planks') : air
    return y <= top(x, z) ? solid(y === top(x, z) ? 'grass_block' : 'stone') : air
  }
}
const start = { x: -4898, y: 77, z: -4986 }, target = { x: -4898, y: 72, z: -4980 }
const onGround = cell => cell.y <= 73 && cell.z >= -4984

test('the door step in the air: no way with safe drops, a jump of four with health to spare', () => {
  const getBlock = porch()
  assert.equal(planBuildRoute({ getBlock, start, target, done: onGround, allowDrop: true }).code, 'NO_BUILD_ROUTE')
  const route = planBuildRoute({ getBlock, start, target, done: onGround, allowDrop: true, maxFall: 6 })
  assert.equal(route.ok, true, route.code)
  const jump = route.steps.find(step => step.kind === 'drop')
  // West of the step the ground is one higher: the jump that costs least is taken.
  assert.deepEqual(jump, { kind: 'drop', dig: [], fall: 4, to: { x: -4900, y: 73, z: -4986 } })
  assert.equal(route.hurt, 1)
  // With one point to spare the same jump; with none, no way.
  assert.equal(planBuildRoute({ getBlock, start, target, done: onGround, allowDrop: true, maxFall: 4 }).ok, true)
  assert.equal(planBuildRoute({ getBlock, start, target, done: onGround, allowDrop: true, maxFall: 3 }).ok, false)
  // Never deeper than six, whatever is asked.
  const deep = (x, y, z) => z === 0 && x === 0 ? (y === 76 ? solid('cobblestone') : air) : y <= 68 ? solid('stone') : air
  assert.equal(planBuildRoute({ getBlock: deep, start: { x: 0, y: 77, z: 0 }, target: { x: 4, y: 69, z: 0 }, done: cell => cell.y === 69, allowDrop: true, maxFall: 20 }).ok, false)
})

test('a way without a jump is taken first, however much longer', () => {
  const getBlock = (x, y, z) => {
    // A ramp down to the east of the step, one block a cell; the ground four below to the west.
    if (x >= 0 && x <= 4 && z === 0) return y <= 76 - x ? solid('stone') : air
    return y <= 72 ? solid('stone') : air
  }
  const route = planBuildRoute({ getBlock, start: { x: 0, y: 77, z: 0 }, target: { x: -3, y: 73, z: 0 }, done: cell => cell.y === 73, allowDrop: true, maxFall: 6 })
  assert.equal(route.ok, true, route.code)
  assert.equal(route.hurt, 0)
})

function hands (getBlock, feet, health) {
  const body = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, drops = []
  const firm = (x, y, z) => getBlock(x, y, z).boundingBox === 'block', open = (x, y, z) => !firm(x, y, z)
  const stand = (x, y, z) => firm(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)
  return {
    body, drops,
    ports: {
      feet: () => ({ ...body }), block: getBlock, fill: () => 0, why: () => null, reason: () => 'refused', health: () => health.value,
      canMine: () => false, canDig: () => false,
      async walk (to) { const x = Math.floor(to.x), z = Math.floor(to.z); if (!stand(x, to.y, z) || Math.abs(to.y - body.y) > Math.abs(x - Math.floor(body.x)) + Math.abs(z - Math.floor(body.z))) return false; Object.assign(body, to); return true },
      async drop (to, fall) { drops.push(fall); health.value -= Math.max(0, fall - 3); Object.assign(body, to); return true }
    }
  }
}

test('the walk jumps with full health and says what it costs; at ten health it does not', async () => {
  const logs = [], health = { value: 20 }
  const h = hands(porch(), start, health)
  const result = await buildWalk({ ports: h.ports, target, done: onGround, log: text => logs.push(text), sleep: async () => {} })
  assert.equal(result.ok, true, result.code)
  assert.deepEqual(h.drops, [4])
  assert.equal(health.value, 19)
  assert.ok(logs.some(text => /高い縁から飛び下りる（落下で体力 1 を使います）/.test(text)), logs.join('\n'))

  const weak = hands(porch(), start, { value: 10 })
  const refused = await buildWalk({ ports: weak.ports, target, done: onGround, sleep: async () => {} })
  assert.equal(refused.code, 'NO_BUILD_ROUTE')
  assert.deepEqual(weak.drops, [])
  // Health unknown: only the safe drops.
  const unknown = hands(porch(), start, { value: undefined })
  assert.equal((await buildWalk({ ports: unknown.ports, target, done: onGround, sleep: async () => {} })).code, 'NO_BUILD_ROUTE')
})

test('health lost between the plan and the edge: the jump is not taken', async () => {
  const health = { value: 20 }
  const h = hands(porch(), start, health)
  const walk = h.ports.walk
  // Hit on the way to the edge.
  h.ports.walk = async to => { health.value = 9; return walk(to) }
  const result = await buildWalk({ ports: h.ports, target, done: onGround, sleep: async () => {} })
  assert.equal(result.ok, false)
  assert.deepEqual(h.drops, [])
})

// The real navigation and physics: the predicted jump lands on the lower floor.
test('the navigation predicts a drop of four and five only when the limit allows it', () => {
  const world = { getBlock: (x, y, z) => { const b = porch()(x, y, z); return { known: true, name: b.name, properties: {}, extra: [] } } }
  const navigator = createNavigator({ world })
  // From the middle cell of the step onto the ground five below, to the south.
  let edge = navigator.physics.fromServer({ position: { x: -4898.5, y: 77 + 1.62, z: -4985.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  for (let i = 0; i < 10; i++) edge = navigator.physics.step(edge, {})
  assert.equal(edge.onGround, true)
  const south = { x: -4898.5, y: 72, z: -4984.5 }
  assert.equal(navigator.plan(edge, south, { controlledDrop: true, maxDistance: 2 }).ready, false, 'five down is over the default limit')
  assert.equal(navigator.plan(edge, south, { controlledDrop: true, dropLimit: 4, maxDistance: 2 }).ready, false, 'and over a limit of four')
  const route = navigator.plan(edge, south, { controlledDrop: true, dropLimit: 5, maxDistance: 2 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, edge)
  let frame = null
  for (let i = 0; i < 80; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
  assert.equal(frame.phase, 'awaiting_server_confirmation')
  assert.ok(Math.abs(frame.predictedState.position.y - 72) < 0.05, `feet ${frame.predictedState.position.y}`)
  assert.equal(navigator.plan(edge, south, { controlledDrop: true, dropLimit: 7, maxDistance: 2 }).ready, false, 'a limit over six is refused')
})
