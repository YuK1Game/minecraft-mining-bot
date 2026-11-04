'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTunneling } = require('../src/tunneling')
const { createExcavation } = require('../src/excavation')
const { createNavigator } = require('../src/navigation')
const { selectVisibleBlockFace } = require('../src/aim')

const key = point => `${point.x},${point.y},${point.z}`
const point = (x, y, z) => ({ x, y, z })
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

test('online learning HP1 tunneling retains received ore, tool and death proof requirements', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.tunneling.preview(f.decision).code, 'LOW_HEALTH')
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.tunneling.preview(f.decision).ready, true)
  f.state.heldItem = null; assert.equal(f.tunneling.preview(f.decision).ready, false)
  f.state.heldItem = f.tool; f.set(f.decision.target, { known: false }); assert.equal(f.tunneling.preview(f.decision).ready, false)
  f.state.health = 0; assert.equal(f.tunneling.preview(f.decision).ready, false)
})

function fixture ({ height = 6, target = point(3, 0, 0), options = {} } = {}) {
  let time = 0
  let stamp = 0
  let miningState = { phase: 'idle' }
  let movementState = { phase: 'idle' }
  const overrides = new Map()
  const calls = []
  const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air', hardness: 1.5, runtimeId: name === 'air' ? 0 : name.includes('ore') ? 2 : 1, extra: [] })
  const set = (position, value) => overrides.set(key(position), typeof value === 'string' ? block(value) : value)
  const world = { getBlock: (x, y, z) => overrides.get(`${x},${y},${z}`) ?? block(y < height ? 'stone' : 'air') }
  set(target, 'diamond_ore')
  const tool = { name: 'minecraft:iron_pickaxe', slot: 0, count: 1, metadata: 0, durabilityKnown: true, durabilityUsed: 0 }
  const state = { phase: 'spawned', position: { x: 0.5, y: height + 1.62001037597656, z: 0.5 }, rawServerPosition: { x: 0.5, y: height + 1.62001037597656, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: 'initial', gameMode: 'survival', health: 20, dimension: 'overworld', startedAt: 'session', connectionId: 'socket', selectedSlot: 0, rawSelectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [tool] }, heldItem: tool, hostiles: [] }
  const getState = () => structuredClone(state)
  function canSee (p) {
    const eye = state.position
    const destination = { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }
    const distance = Math.hypot(eye.x - destination.x, eye.y - destination.y, eye.z - destination.z)
    if (distance > 4.5 || Math.floor(eye.x) === p.x && Math.floor(eye.z) === p.z && p.y <= Math.round(eye.y - 1.62)) return false
    const count = Math.ceil(distance / 0.08)
    for (let index = 0; index < count; index++) {
      const ratio = index / count
      const through = { x: Math.floor(eye.x + (destination.x - eye.x) * ratio), y: Math.floor(eye.y + (destination.y - eye.y) * ratio), z: Math.floor(eye.z + (destination.z - eye.z) * ratio) }
      if (key(through) !== key(p) && !AIR.has(world.getBlock(through.x, through.y, through.z).name)) return false
    }
    return true
  }
  const mining = {
    preview: targets => { const p = targets[0]; calls.push({ type: 'mining_preview', target: { ...p } }); return { ready: canSee(p), targets: [{ position: { ...p }, name: world.getBlock(p.x, p.y, p.z).name }], errors: ['not visible'] } },
    start: targets => { const p = targets[0]; calls.push({ type: 'mine', target: { ...p } }); assert.notEqual(key(p), key(target)); set(p, 'air'); tool.durabilityUsed++; miningState = { phase: 'completed' }; return miningState },
    stop: () => { calls.push({ type: 'mining_stop' }); miningState = { phase: 'stopped' } }
  }
  const movement = {
    preview: target => { calls.push({ type: 'movement_preview', target: { ...target } }); return { ready: AIR.has(world.getBlock(Math.floor(target.x), target.y, Math.floor(target.z)).name) && AIR.has(world.getBlock(Math.floor(target.x), target.y + 1, Math.floor(target.z)).name) } },
    start: target => {
      calls.push({ type: 'move', target: { ...target } })
      state.position = { x: target.x, y: target.y + 1.62, z: target.z }
      state.positionUpdatedAt = `working-${++stamp}`
      state.positionSource = 'client_prediction'
      state.predicted = { position: { ...state.position }, physicsState: { onGround: true, isInWater: false } }
      movementState = { phase: 'awaiting_server_confirmation' }
      return movementState
    },
    stop: () => { calls.push({ type: 'movement_stop' }); movementState = { phase: 'stopped' } }
  }
  const timing = { timeoutMs: 100, pollMs: 10, clock: () => time, delay: async milliseconds => { time += milliseconds } }
  const excavation = createExcavation({ getState, world, mining, movement, getMining: () => miningState, getMovement: () => movementState, ...timing, stepTimeoutMs: 500 })
  const makeTunneling = (extra = {}) => createTunneling({ getState, world, excavation, movement, getMovement: () => movementState, mining, ...timing, batchTimeoutMs: 2000, ...options, ...extra })
  const tunneling = makeTunneling()
  const decision = { type: 'tunnel', target: { ...target }, resourceTarget: { ...target }, targetOre: { position: { ...target }, name: 'minecraft:diamond_ore' }, resource: 'diamond', requiredToolTier: 3, requiresLivePreview: true }
  return { tunneling, makeTunneling, excavation, world, set, state, tool, calls, mining, movement, decision, canSee }
}

test('an observed empty-box floor torch stays transparent to the ore ray like real Aim without becoming a dig or an air confirmation', () => {
  const f = fixture({ height: 65, target: point(3, 66, 0) })
  const position = point(1, 66, 0)
  const torch = { known: true, name: 'minecraft:torch', boundingBox: 'empty', diggable: true, hardness: 0, runtimeId: 3, properties: { torch_facing_direction: 'top' }, extra: [] }
  f.set(position, torch)
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, plan.reason)
  assert.equal(plan.oreAccessible, true)
  assert.equal(plan.steps.length, 0)
  assert.ok(selectVisibleBlockFace({ eye: f.state.position, target: f.decision.target, world: f.world, maxReach: 4.5 }))
  assert.equal(f.world.getBlock(position.x, position.y, position.z).name, 'minecraft:torch', 'the observed torch is never converted to AIR')
  assert.equal(f.calls.length, 0, 'the accessibility preview must not request mining, movement or a completion receipt')
  for (const value of [
    { ...torch, known: false },
    { ...torch, boundingBox: 'block' },
    { ...torch, extra: [{ name: 'minecraft:water' }] },
    { ...torch, extra: [{ name: 'minecraft:air' }] },
    { ...torch, name: 'minecraft:water' },
    { ...torch, name: 'minecraft:lantern' }
  ]) {
    f.set(position, value)
    const rejected = f.tunneling.preview(f.decision)
    assert.notEqual(rejected.oreAccessible, true, JSON.stringify({ name: value.name, known: value.known, bbox: value.boundingBox, extra: value.extra }))
    assert.equal(f.calls.length, 0)
  }
})

test('known deep terrain yields bounded normal stairs toward the observed ore without scheduling the ore or own support', () => {
  const f = fixture({ height: 63, target: point(-41, -6, 12) })
  const before = structuredClone(f.state)
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, plan.reason)
  assert.ok(plan.steps.length >= 60 && plan.steps.length <= 192)
  assert.ok(plan.plannedDigBlocks <= 250)
  assert.equal(plan.withinDurability, true)
  let previous = point(0, 63, 0)
  const returnFloors = new Set(['0,62,0'])
  for (const step of plan.steps) {
    const next = step.targetCell
    assert.equal(Math.abs(next.x - previous.x) + Math.abs(next.z - previous.z), 1)
    assert.ok([0, -1].includes(next.y - previous.y))
    for (const block of step.blocksToMine) {
      assert.notEqual(key(block), key(f.decision.target))
      assert.ok(block.x !== previous.x || block.z !== previous.z)
      assert.ok(block.y >= next.y)
      assert.equal(returnFloors.has(key(block)), false, `A prior return floor would be excavated at ${key(block)}`)
    }
    returnFloors.add(key({ ...next, y: next.y - 1 }))
    previous = next
  }
  assert.ok(previous.y <= -5)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.state, before)
  assert.equal(f.world.getBlock(-41, -6, 12).name, 'minecraft:diamond_ore')
})

test('a batch digs at most three adjacent steps, observes real air, preserves raw pose, and leaves ore mining for another action', async () => {
  const f = fixture()
  const initial = { ...f.state.rawServerPosition }
  const result = await f.tunneling.execute(f.decision, { maxSteps: 3, maxDigBlocks: 9 })
  assert.equal(result.phase, 'predicted')
  assert.equal(result.partial, true)
  assert.equal(result.steps.length, 3)
  assert.ok(result.digBlocks > 0 && result.digBlocks <= 9)
  assert.equal(result.collected, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.positionSource, 'client_prediction')
  assert.equal(result.busy, false)
  assert.deepEqual(f.state.rawServerPosition, initial)
  assert.equal(f.calls.filter(call => call.type === 'move').length, 3)
  assert.equal(f.calls.filter(call => call.type === 'mine').length, result.digBlocks)
  assert.equal(f.world.getBlock(3, 0, 0).name, 'minecraft:diamond_ore')
})

test('successive bounded batches eventually expose ore to live preview but never mine it or invent a diamond', async () => {
  const f = fixture()
  let result
  for (let count = 0; count < 8; count++) {
    result = await f.tunneling.execute(f.decision, { maxSteps: 2, maxDigBlocks: 6 })
    if (result.oreAccessible) break
  }
  assert.equal(result.phase, 'completed')
  assert.equal(result.oreAccessible, true)
  assert.equal(f.canSee(f.decision.target), true)
  assert.equal(result.collected, false)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:diamond'), false)
  assert.equal(f.world.getBlock(3, 0, 0).name, 'minecraft:diamond_ore')
})

test('an existing safe corridor uses movement without excavation', async () => {
  const f = fixture({ target: point(6, 6, 0) })
  for (let x = 0; x < 6; x++) for (const y of [6, 7]) f.set(point(x, y, 0), 'air')
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, plan.reason)
  assert.ok(plan.steps.every(step => step.kind === 'move'))
  const result = await f.tunneling.execute(f.decision, { maxSteps: 3, maxDigBlocks: 0 })
  assert.equal(result.oreAccessible, true)
  assert.equal(f.calls.filter(call => call.type === 'mine').length, 0)
  assert.ok(f.calls.some(call => call.type === 'move'))
})

test('unknown terrain, lava, water and falling material block a sealed route without destructive attempts', async () => {
  for (const hazard of [{ known: false }, 'lava', 'water', 'gravel']) {
    const f = fixture()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.set(point(dx, 6, dz), hazard)
    const preview = f.tunneling.preview(f.decision, { maxExpanded: 80 })
    assert.equal(preview.ready, false)
    await assert.rejects(f.tunneling.execute(f.decision, { maxExpanded: 80 }), error => error.code === 'NO_SAFE_ROUTE')
    assert.equal(f.calls.filter(call => call.type === 'mine' || call.type === 'move').length, 0)
  }
})

test('inventory uncertainty, unconfirmed tools and absent NBT wear observations stop before any operation', async () => {
  for (const [change, code] of [
    [f => { f.state.inventory.known = false }, 'INVENTORY_UNKNOWN'],
    [f => { f.state.equipmentServerConfirmed = false }, 'TOOL_REQUIRED'],
    [f => { f.tool.name = 'minecraft:stone_pickaxe' }, 'TOOL_REQUIRED'],
    [f => { delete f.tool.durabilityUsed; f.tool.metadata = 0 }, 'DURABILITY_UNKNOWN'],
    [f => { f.tool.durabilityUsed = 250 }, 'TOOL_EXHAUSTED'],
    [f => { f.tool.durabilityUsed = 248 }, 'TOOL_WORN_OUT']
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(f.tunneling.execute(f.decision), error => error.code === code)
    assert.equal(f.calls.filter(call => call.type === 'mine' || call.type === 'move').length, 0)
  }
})

test('range and excavation budgets cannot cause unbounded work or zero-progress success', async () => {
  const f = fixture()
  assert.equal(f.tunneling.preview(f.decision, { maxDistance: 1 }).code, 'DISTANCE_LIMIT')
  assert.equal(f.tunneling.preview(f.decision, { maxRouteSteps: 1 }).code, 'NO_SAFE_ROUTE')
  await assert.rejects(f.tunneling.execute(f.decision, { maxDigBlocks: 0 }), error => error.code === 'DIG_LIMIT')
  assert.equal(f.calls.filter(call => call.type === 'mine').length, 0)
})

test('damage and newly unknown inventory are rechecked after an actual adjacent step', async () => {
  for (const [change, code] of [[f => { f.state.health = 19 }, 'TOOK_DAMAGE'], [f => { f.state.inventory.known = false }, 'INVENTORY_UNKNOWN']]) {
    const f = fixture()
    const original = f.excavation.execute
    f.excavation.execute = async (...args) => { const result = await original(...args); change(f); return result }
    await assert.rejects(f.tunneling.execute(f.decision), error => error.code === code)
    assert.equal(f.calls.filter(call => call.type === 'move').length, 1)
    assert.ok(f.calls.some(call => call.type === 'movement_stop'))
  }
})

test('a reported excavation completion without received air cannot advance the tunnel', async () => {
  const f = fixture()
  f.excavation.execute = async () => ({ ok: true, phase: 'completed' })
  await assert.rejects(f.tunneling.execute(f.decision), error => error.code === 'BLOCK_NOT_CONFIRMED')
  assert.equal(f.calls.filter(call => call.type === 'move').length, 0)
})

test('abort interrupts a hanging callback, stops controllers, and releases the batch ownership', async () => {
  const f = fixture()
  const controller = new AbortController()
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  f.excavation.execute = () => { enter(); return new Promise(() => {}) }
  const work = f.tunneling.execute(f.decision, { signal: controller.signal })
  const rejected = assert.rejects(work, /test cancellation/)
  await entered
  await assert.rejects(f.tunneling.execute(f.decision), error => error.code === 'BUSY')
  controller.abort(new Error('test cancellation'))
  await rejected
  assert.equal(f.tunneling.snapshot().busy, false)
  assert.equal(f.tunneling.snapshot().phase, 'stopped')
  assert.ok(f.calls.some(call => call.type === 'movement_stop'))
})

test('inventory loss is monitored while a child excavation is still pending', async () => {
  const f = fixture({ options: { timeoutMs: 1000, pollMs: 5 } })
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  f.excavation.execute = () => { enter(); return new Promise(() => {}) }
  const work = f.tunneling.execute(f.decision)
  const rejected = assert.rejects(work, error => error.code === 'INVENTORY_UNKNOWN')
  await entered
  f.state.inventory.known = false
  await rejected
  assert.equal(f.tunneling.snapshot().busy, false)
  assert.ok(f.calls.some(call => call.type === 'movement_stop'))
})

test('a callback that never returns has a strict real deadline', async () => {
  const f = fixture({ options: { timeoutMs: 25 } })
  f.excavation.execute = () => new Promise(() => {})
  const began = Date.now()
  await assert.rejects(f.tunneling.execute(f.decision), error => error.code === 'TIMEOUT')
  assert.ok(Date.now() - began < 1000)
  assert.equal(f.tunneling.snapshot().busy, false)
})

test('stale or airborne working poses cannot complete a movement-only leg', async () => {
  for (const mode of ['stale', 'airborne']) {
    const f = fixture({ target: point(6, 6, 0) })
    const move = f.movement.start
    f.movement.start = target => {
      const result = move(target)
      if (mode === 'stale') f.state.positionUpdatedAt = 'initial'
      else f.state.predicted.physicsState.onGround = false
      return result
    }
    await assert.rejects(f.tunneling.execute(f.decision, { maxDigBlocks: 0 }), error => error.code === 'TIMEOUT')
    assert.equal(f.tunneling.snapshot().phase, 'failed')
    assert.equal(f.tunneling.snapshot().steps.length, 0)
  }
})

test('local dig accounting reserves durability even if the next server damage update is delayed', async () => {
  const f = fixture()
  f.tool.durabilityUsed = 245
  const mine = f.mining.start
  f.mining.start = targets => { const result = mine(targets); f.tool.durabilityUsed = 245; return result }
  await assert.rejects(f.tunneling.execute(f.decision, { maxSteps: 10, maxDigBlocks: 30 }), error => error.code === 'TOOL_WORN_OUT')
  assert.ok(f.calls.filter(call => call.type === 'mine').length <= 3)
  assert.equal(f.tool.durabilityUsed, 245)
})

test('a two-column descent cannot bore through an earlier stair floor to reach a lower ore', () => {
  const f = fixture({ height: 8, target: point(0, 0, 0) })
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) {
    if (z === 0 && (x === 0 || x === 1)) continue
    for (let y = -3; y <= 10; y++) f.set(point(x, y, z), 'bedrock')
  }
  const plan = f.tunneling.preview(f.decision, { maxDistance: 6, maxExpanded: 500 })
  assert.equal(plan.ready, false)
  assert.equal(plan.code, 'NO_SAFE_ROUTE')
  assert.equal(f.calls.length, 0)
  assert.equal(f.world.getBlock(0, 7, 0).name, 'minecraft:stone')
})

test('preserved floors survive repeated batches and replacement factories without becoming planned air', async () => {
  const journal = new Map()
  const options = {
    getPreservedFloors: () => [...journal.values()],
    onPreserveFloor: position => journal.set(key(position), structuredClone(position))
  }
  const f = fixture({ height: 12, target: point(1, 0, 0), options })
  let controller = f.tunneling
  const preview = controller.preview(f.decision)
  assert.equal(preview.ready, true, preview.reason)
  assert.equal(journal.size, 0, 'a preview must not commit hypothetical floors')
  const raw = structuredClone(f.state.rawServerPosition)
  let total = 0
  for (let batch = 0; batch < 16; batch++) {
    const previous = new Map(journal)
    const proposed = controller.preview(f.decision)
    assert.equal(proposed.ready, true, proposed.reason)
    for (const step of proposed.steps) for (const p of step.blocksToMine) assert.equal(previous.has(key(p)), false)
    const countBefore = f.calls.length
    const result = await controller.execute(f.decision, { maxSteps: 2, maxDigBlocks: 6 })
    total += result.steps.length
    for (const operation of f.calls.slice(countBefore).filter(call => call.type === 'mine')) assert.equal(previous.has(key(operation.target)), false)
    for (const position of journal.values()) assert.equal(f.world.getBlock(position.x, position.y, position.z).name, 'minecraft:stone')
    assert.equal(journal.has('0,11,0'), true, 'the original surface support must remain retained')
    assert.deepEqual(f.state.rawServerPosition, raw)
    if (result.oreAccessible) break
    controller = f.makeTunneling(options)
  }
  assert.ok(total >= 8)
  assert.equal(controller.snapshot().oreAccessible, true)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:diamond'), false)
})

test('only fresh completed steps commit floors; changed live excavation previews cannot cut retained support', async () => {
  const receipts = []
  const f = fixture({ options: { onPreserveFloor: position => receipts.push(position), getPreservedFloors: () => [point(4, 4, 4)] } })
  f.tunneling.preview(f.decision)
  assert.deepEqual(receipts, [])
  f.excavation.execute = async () => ({ ok: true, phase: 'completed' })
  await assert.rejects(f.tunneling.execute(f.decision), error => error.code === 'BLOCK_NOT_CONFIRMED')
  assert.deepEqual(receipts, [])
  const guarded = fixture({ options: { getPreservedFloors: () => [point(4, 4, 4)], onPreserveFloor: position => receipts.push(position) } })
  const original = guarded.excavation.preview
  guarded.excavation.preview = options => ({ ...original(options), blocksToMine: [point(4, 4, 4)] })
  await assert.rejects(guarded.tunneling.execute(guarded.decision), error => error.code === 'EXCAVATION_PREVIEW_REJECTED')
  assert.equal(guarded.calls.filter(call => call.type === 'mine' || call.type === 'move').length, 0)
  assert.deepEqual(receipts, [])
})

test('malformed or exhausted floor journals fail closed without discarding older return floors', async () => {
  for (const retained of [null, [point(0.5, 2, 0)], Array.from({ length: 1025 }, (_, i) => point(i, 0, 4))]) {
    const f = fixture({ options: { getPreservedFloors: () => retained } })
    assert.equal(f.tunneling.preview(f.decision).ready, false)
    await assert.rejects(f.tunneling.execute(f.decision), error => ['PRESERVED_FLOORS_INVALID', 'PRESERVED_FLOOR_LIMIT'].includes(error.code))
    assert.equal(f.calls.filter(call => call.type === 'mine' || call.type === 'move').length, 0)
  }
})

test('the carved synthetic descent keeps every previous floor and can be climbed back with actual navigation physics', () => {
  const f = fixture({ height: 12, target: point(1, 0, 0) })
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, plan.reason)
  assert.ok(plan.steps.length >= 9)
  for (const step of plan.steps) for (const position of step.blocksToMine) f.set(position, 'air')
  const navigator = createNavigator({ world: f.world })
  const last = plan.steps.at(-1)
  const initial = navigator.physics.fromServer({ position: { x: last.target.x, y: last.target.y + 1.62, z: last.target.z }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } })
  const before = structuredClone(initial)
  const route = navigator.plan(initial, { x: 0.5, y: 12, z: 0.5 }, { maxDistance: 20, maxNodes: 2000 })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial)
  let output
  let jumps = 0
  for (let tick = 0; tick < 1600; tick++) {
    output = stepper.next()
    jumps += output.controls?.jump === true ? 1 : 0
    if (output.phase !== 'moving') break
  }
  assert.equal(output.phase, 'awaiting_server_confirmation', output.reason)
  assert.ok(jumps >= 8)
  assert.equal(output.predictedState.onGround, true)
  assert.equal(output.predictedState.position.y, 12)
  assert.ok(Math.hypot(output.predictedState.position.x - 0.5, output.predictedState.position.z - 0.5) <= 0.4)
  assert.equal(output.serverConfirmed, false)
  assert.deepEqual(initial, before)
})
