'use strict'

// Controlled known synthetic terrain. Native prediction is never a server
// receipt, mined ore, inventory gain or proof of a current Realm route.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTunneling } = require('../src/tunneling')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const knownBlock = (name, position) => ({ known: true, name: `minecraft:${name}`, position, runtimeId: name === 'air' ? 0 : 1, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air' && name !== 'bedrock', hardness: name === 'air' ? -1 : 1.5, properties: name === 'bedrock' ? { infiniburn_bit: 0 } : {}, extra: [] })

function staircase ({ down = false } = {}) {
  const changes = new Map(), floors = [], calls = []
  const foot = x => 4 + Math.max(0, Math.min(x, 7))
  for (let x = -1; x <= 9; x++) floors.push({ x, y: foot(x) - 1, z: 0 })
  const target = down ? { x: -1, y: 4, z: 0 } : { x: 8, y: 11, z: 0 }
  const world = { getBlock (x, y, z) {
    const position = { x, y, z }, changed = changes.get(key(position))
    if (changed) return changed
    if (x < -2 || x > 10 || y < 0 || y > 19 || z < -2 || z > 2) return { known: false, position }
    if (key(position) === key(target)) return knownBlock('diamond_ore', position)
    const base = foot(x)
    return knownBlock(z === 0 && y >= base && y <= base + 2 ? 'air' : z === 0 && y === base - 1 ? 'stone' : 'bedrock', position)
  } }
  const tool = { slot: 0, name: 'minecraft:iron_pickaxe', count: 1, stackId: 42, durabilityKnown: true, durabilityUsed: 138, maxDurability: 250, durabilityRemaining: 112 }
  const state = { phase: 'spawned', profile: 'synthetic-return-stairs', realm: { id: '21225335' }, connectionId: 'synthetic-stairs-cid', startedAt: 'synthetic-stairs-session', runtimeEntityId: '1', lifecycle: { deathId: 390, phase: 'alive' }, dimension: 'overworld', gameMode: 'survival', health: 20, threatPolicy: 'online_learning', entities: [], position: { x: down ? 6.5 : 0.5, y: (down ? 10 : 4) + 1.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 'synthetic-start', rawSelectedSlot: 0, rawServerSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [tool] }, heldItem: tool }
  state.rawServerPosition = copy(state.position)
  const decision = { type: 'tunnel', stage: 'diamond', target: copy(target), resourceTarget: copy(target), targetOre: { name: 'minecraft:diamond_ore', position: copy(target) }, resource: 'diamond', requiredToolTier: 3 }
  const noAction = type => () => { calls.push(type); throw Error('A pure stair preview must emit no operation: ' + type) }
  const make = () => createTunneling({ getState: () => copy(state), world, getPreservedFloors: () => copy(floors), onPreserveFloor: noAction('preserve'), excavation: { preview: noAction('excavation_preview'), execute: noAction('excavation_execute'), stop: noAction('excavation_stop') }, movement: { preview: noAction('movement_preview'), start: noAction('movement_start'), stop: noAction('movement_stop') }, getMovement: noAction('movement_state'), mining: { preview: noAction('mining_preview') } })
  const physics = createPhysics({ world, version: '1.26.60' }), navigator = createNavigator({ world, physics, version: '1.26.60' })
  const initial = physics.fromServer(state)
  return { state, tool, decision, world, changes, floors, calls, make, tunneling: make(), physics, navigator, initial, set: (position, value) => changes.set(key(position), typeof value === 'string' ? knownBlock(value, position) : { ...value, position }) }
}

function nativeTrace (f, target) {
  const before = copy(f.initial)
  const route = f.navigator.plan(f.initial, target, { maxDistance: 12, maxExpanded: 1500 })
  assert.equal(route.ready, true, route.reason)
  const stepper = f.navigator.createStepper(route, f.initial, { maxTicks: 300, sprint: false })
  let frame, jumps = 0, ceilingCollisions = 0, frames = 0
  for (; frames < 301; frames++) {
    frame = stepper.next()
    if (frame.controls?.jump) jumps++
    if (frame.predictedState?.isCollidedVertically && frame.predictedState?.onGround === false) ceilingCollisions++
    if (frame.phase !== 'moving') break
  }
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
  assert.equal(frame.predictedState.onGround, true)
  assert.equal(frame.predictedState.position.y, target.y)
  assert.ok(Math.hypot(frame.predictedState.position.x - target.x, frame.predictedState.position.z - target.z) <= 0.4)
  assert.equal(frame.serverConfirmed, false)
  assert.deepEqual(f.initial, before, 'the actual Native source state remains intact')
  return { frame, route, frames, jumps, ceilingCollisions }
}

test('a lower foot4 origin can return on known three-high stairs toward above oreY11 through a genuine normal Native route', () => {
  const f = staircase(), beforeState = copy(f.state), beforeFloors = f.floors.map(p => copy(f.world.getBlock(p.x, p.y, p.z)))
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, JSON.stringify(plan))
  assert.ok(plan.expanded > 1 && plan.expanded < 3000)
  assert.ok(plan.steps.length > 0)
  assert.ok(plan.steps.every(s => s.kind === 'move' && s.blocksToMine.length === 0))
  assert.equal(plan.plannedDigBlocks, 0)
  assert.equal(plan.withinDurability, true)
  assert.ok(plan.steps.some(s => s.targetCell.y > 4))
  const trace = nativeTrace(f, plan.approach)
  assert.ok(trace.jumps >= 1)
  assert.ok(trace.ceilingCollisions >= 1, 'the real collision model clips ordinary upward motion below the valid ceiling')
  assert.deepEqual(f.state, beforeState)
  assert.deepEqual(f.floors.map(p => f.world.getBlock(p.x, p.y, p.z)), beforeFloors)
  assert.equal(f.world.getBlock(8, 11, 0).name, 'minecraft:diamond_ore')
  assert.deepEqual(f.calls, [])
  assert.equal(plan.serverConfirmed, false)
  assert.equal(plan.collected, false)
})

test('actual Native traverses six normal clipped jumps with exactly three air blocks per stair column', () => {
  const f = staircase(), trace = nativeTrace(f, { x: 6.5, y: 10, z: 0.5 })
  assert.equal(trace.route.waypoints.filter(w => w.action === 'jump').length, 6)
  assert.ok(trace.jumps >= 6)
  assert.ok(trace.ceilingCollisions >= 6)
  assert.ok(trace.frames < 100)
  assert.equal(f.world.getBlock(0, 7, 0).boundingBox, 'block', 'the valid three-high source ceiling remains solid')
  assert.equal(f.world.getBlock(0, 6, 0).name, 'minecraft:air')
})

test('downward ore uses the same known stairs without upward digging or a changed minimumY policy', () => {
  const f = staircase({ down: true }), plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, JSON.stringify(plan))
  assert.ok(plan.steps.length > 0)
  assert.ok(plan.steps.every(s => s.kind === 'move' && s.blocksToMine.length === 0))
  let previous = 10
  for (const step of plan.steps) { assert.ok(step.targetCell.y <= previous); previous = step.targetCell.y }
  nativeTrace(f, plan.approach)
  assert.equal(f.world.getBlock(-1, 4, 0).name, 'minecraft:diamond_ore')
  assert.deepEqual(f.calls, [])
})

test('solid or unknown required source headroom remains forbidden to both tunneling and Native', () => {
  for (const value of ['bedrock', { known: false }]) {
    const f = staircase(); f.set({ x: 0, y: 6, z: 0 }, value)
    const plan = f.tunneling.preview(f.decision)
    assert.equal(plan.ready, false)
    assert.equal(plan.code, 'NO_SAFE_ROUTE')
    if (typeof value === 'object') assert.ok(plan.unknownFrontier.some(p => p.x === 0 && p.y === 6 && p.z === 0))
    assert.equal(f.navigator.plan(f.initial, { x: 6.5, y: 10, z: 0.5 }).ready, false)
    assert.deepEqual(f.calls, [])
  }
})

test('upward destination clearance must already be actual known air and is never scheduled for mining', () => {
  for (const value of ['stone', { known: false }, { ...knownBlock('air', {x:1,y:6,z:0}), extra: [{ name: 'minecraft:water' }] }]) {
    const f = staircase(); f.set({ x: 1, y: 6, z: 0 }, value)
    const plan = f.tunneling.preview(f.decision)
    assert.equal(plan.ready, false)
    assert.equal(plan.steps.length, 0)
    assert.deepEqual(f.calls, [])
  }
})

test('an actor circle across the return stairs still blocks the route while current pose is outside danger', () => {
  const f = staircase()
  f.state.entities = [{ runtimeId:'100', uniqueId:'-100', entityType:'minecraft:zombie', kind:'mob', alive:true, positionKnown:true, dimension:'overworld', position:{x:6.5,y:11.62,z:0.5} }]
  const threats = evaluateThreats(f.state, f.state.entities)
  assert.equal(threats.threats.length, 0)
  assert.equal(threats.outsideDanger.length, 1)
  assert.equal(threats.outsideDanger[0].dangerRadius, 5)
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, false)
  assert.equal(plan.code, 'NO_SAFE_ROUTE')
  assert.deepEqual(f.calls, [])
})

test('preserved support, protected ore, unknown target and ordinary distance/vertical/search budgets stay enforced', () => {
  const floor = staircase(), p = { x:0,y:3,z:0 }
  floor.decision = {type:'tunnel',resource:'stone',target:p,targetOre:{name:'minecraft:stone',position:p},requiredToolTier:1}
  assert.equal(floor.tunneling.preview(floor.decision).code, 'PRESERVED_FLOOR_TARGET')
  for (const change of [{protected:true}, {known:false}]) {
    const f=staircase(), p=f.decision.target
    f.set(p,{...f.world.getBlock(p.x,p.y,p.z),...change})
    assert.equal(f.tunneling.preview(f.decision).ready,false)
    assert.deepEqual(f.calls,[])
  }
  const f=staircase()
  assert.equal(f.tunneling.preview(f.decision,{maxDistance:3}).code,'DISTANCE_LIMIT')
  assert.equal(f.tunneling.preview(f.decision,{maxVertical:3}).code,'DISTANCE_LIMIT')
  const bounded=f.tunneling.preview(f.decision,{maxExpanded:1})
  assert.equal(bounded.ready,false);assert.equal(bounded.expanded,1)
  for(const p of f.floors) assert.equal(f.world.getBlock(p.x,p.y,p.z).name,'minecraft:stone')
  assert.deepEqual(f.calls,[])
})
