'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTunneling } = require('../src/tunneling')
const { createExcavation } = require('../src/excavation')
const { createMining } = require('../src/mining')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')

const key = p => `${p.x},${p.y},${p.z}`
const copy = v => structuredClone(v)
const air = b => ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(b?.name)
const block = (name, position) => ({ known: true, name: `minecraft:${name}`, position, runtimeId: name === 'air' ? 0 : 1, properties: {}, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air', hardness: name === 'air' ? -1 : 1.5, extra: [] })
const templateWorld = { getBlock: (x, y, z) => block(y < 4 ? 'stone' : 'air', { x, y, z }) }
const preparedPhysics = createPhysics({ world: templateWorld, version: '1.26.60' })

function fixture (context = null, { height = 4, target = { x: 3, y: 0, z: 0 } } = {}) {
  let time = 10000, stamp = 0, inputRunning = false, motionOrigin
  const changes = new Map(), floors = new Map(), events = [], packets = [], predictions = [], miningReceipts = []
  const world = { getBlock: (x, y, z) => {
    const p = { x, y, z }
    if (x < -6 || x > 9 || y < -4 || y > 10 || z < -6 || z > 6) return { known: false, position: p }
    return changes.get(key(p)) ?? block(y < height ? 'stone' : 'air', p)
  } }
  const tool = { slot: 0, name: 'minecraft:stone_pickaxe', count: 1, stackId: 42, durabilityKnown: true, durabilityUsed: 0, maxDurability: 131, durabilityRemaining: 131 }
  const state = { phase: 'spawned', profile: 'controlled-native-stone', realm: { id: '21225335' }, connectionId: 'controlled-stone-cid', startedAt: 'controlled-stone-start', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0, phase: 'alive' }, gameMode: 'survival', health: 20, threatPolicy: 'online_learning', entities: [], position: { x: 0.5, y: height + 1.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: 'controlled-initial', selectedSlot: 0, rawSelectedSlot: 0, rawServerSelectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [tool] }, heldItem: tool }
  state.rawServerPosition = copy(state.position)
  const physics = preparedPhysics.withWorld(world)
  const navigator = createNavigator({ world, physics, version: '1.26.60' })
  const initial = physics.fromServer(state)
  const input = { lookAt: point => events.push({ type: 'aim', point: copy(point) }), start: () => { inputRunning = true }, stop: () => { inputRunning = false }, stats: () => ({ running: inputRunning }), sendAction: (action, point, face, hit) => {
    events.push({ type: 'mining_action', action, point: copy(point), face, hit: copy(hit) })
    if (action !== 'start_break') return
    const before = world.getBlock(point.x, point.y, point.z)
    assert.equal(before.known, true)
    assert.equal(floors.has(key(point)), false, 'controlled mining cannot remove a preserved floor')
    changes.set(key(point), block('air', copy(point)))
    tool.durabilityUsed++
    tool.durabilityRemaining--
    miningReceipts.push({ point: copy(point), name: before.name, source: 'CONTROLLED_IN_MEMORY_RECEIVED_AIR', inventoryCredit: 0 })
  } }
  const mining = createMining({ getState: () => copy(state), world, getInput: () => input, now: () => time })
  const movement = createMovement({ client: { queue: (name, params) => { packets.push({ name, params: copy(params) }); return { tick: params.tick } } }, getState: () => ({ ...copy(state), position: copy(motionOrigin.position), positionSource: motionOrigin.positionSource, positionUpdatedAt: motionOrigin.positionUpdatedAt, predicted: copy(motionOrigin.predicted) }), world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 10000, clock: () => time,
    onPrediction: prediction => { state.position = copy(prediction.position); state.positionSource = 'client_prediction'; state.positionUpdatedAt = `controlled-native-${++stamp}`; state.predicted = copy(prediction); predictions.push(copy(prediction)) } })
  const ownedMovement = { preview: (point, options) => { motionOrigin = copy(state); events.push({ type: 'movement_preview', point: copy(point) }); return movement.preview(point, options) }, start: (point, options) => { motionOrigin = copy(state); return movement.start(point, options) }, stop: reason => movement.stop(reason) }
  const delay = async milliseconds => { time += milliseconds; context?.mock.timers.tick(milliseconds) }
  const timing = { timeoutMs: 5000, pollMs: 100, clock: () => time, delay }
  const excavation = createExcavation({ getState: () => copy(state), world, mining, movement: ownedMovement, getMining: () => mining.snapshot(), getMovement: () => movement.snapshot(), ...timing, stepTimeoutMs: 10000 })
  const makeTunneling = extra => createTunneling({ getState: () => copy(state), world, excavation, movement: ownedMovement, mining, getMovement: () => movement.snapshot(), getPreservedFloors: () => [...floors.values()], onPreserveFloor: p => floors.set(key(p), copy(p)), ...timing, batchTimeoutMs: 30000, ...extra })
  const tunneling = makeTunneling()
  context?.after(() => { mining.stop(); movement.stop() })
  const decision = { type: 'tunnel', resource: 'stone', target: copy(target), block: 'minecraft:stone', requiredToolTier: 1, requiresLivePreview: true, requiresKnownDurability: true }
  return { state, tool, world, changes, floors, events, packets, predictions, miningReceipts, mining, movement, ownedMovement, excavation, tunneling, makeTunneling, decision, physics, navigator, initial, delay }
}

test('explicit stone access bounds and full known durability do not broaden legacy ore defaults', () => {
  const f = fixture()
  const result = f.tunneling.preview(f.decision)
  assert.equal(result.ready, true, JSON.stringify(result))
  assert.ok(result.steps.length <= 6)
  assert.ok(result.plannedDigBlocks <= 16)
  assert.ok(result.steps.every(step => step.blocksToMine.every(p => key(p) !== key(f.decision.target))))
  assert.ok(result.steps.every(step => key({ ...step.targetCell, y: step.targetCell.y - 1 }) !== key(f.decision.target)), 'the goal cannot become any future standing floor')
  for (const [name, value] of Object.entries({ maxDistance: 7, maxVertical: 7, maxRouteSteps: 7, maxRouteDigBlocks: 17, maxExpanded: 3001 })) assert.equal(f.tunneling.preview(f.decision, { [name]: value }).code, 'INVALID_BOUNDS', name)
  f.tool.durabilityUsed = 131 - result.plannedDigBlocks - 1
  f.tool.durabilityRemaining = 131 - f.tool.durabilityUsed
  assert.equal(f.tunneling.preview(f.decision).code, 'TOOL_WORN_OUT')
  f.tool.durabilityUsed = 0; f.tool.durabilityRemaining = 131
  assert.equal(f.tunneling.preview({ ...f.decision, resource: undefined }).code, 'RESOURCE_CHANGED')
})

test('real Mining, Excavation and Native queues advance bounded stone batches, preserve floors and return', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  const initialInventory = f.state.inventory.items.map(item => ({ slot: item.slot, name: item.name, count: item.count }))
  const goal = copy(f.decision.target), initialAnchor = copy(f.state.rawServerPosition)
  let result, batches = 0
  while (batches++ < 6) {
    result = await f.tunneling.execute(f.decision)
    assert.equal(result.ok, true)
    assert.ok(result.steps.length <= 1)
    assert.ok(result.digBlocks <= 3)
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.collected, false)
    assert.equal(f.world.getBlock(goal.x, goal.y, goal.z).name, 'minecraft:stone', 'Tunneling must leave the selected resource untouched')
    assert.ok(f.miningReceipts.every(receipt => key(receipt.point) !== key(goal)))
    if (result.oreAccessible) break
  }
  assert.equal(result.oreAccessible, true, JSON.stringify(result))
  assert.equal(f.mining.preview([goal]).ready, true, 'handback requires the real current Mining preview')
  assert.ok(f.packets.some(packet => packet.name === 'player_auth_input'))
  assert.ok(f.predictions.length > 10)
  assert.ok(f.floors.size >= 3)
  assert.ok(f.miningReceipts.filter(receipt => receipt.name === 'minecraft:stone').length >= 8, 'at least eight synthetic stone clearances must have controlled received-air receipts')
  assert.deepEqual(f.state.inventory.items.map(item => ({ slot: item.slot, name: item.name, count: item.count })), initialInventory, 'air receipts earn no item inventory credit')
  assert.deepEqual(f.state.rawServerPosition, initialAnchor)

  // Return geometry is checked only after the controlled receipts. Explicitly
  // clear any known overhead stone through ordinary real Mining, preserving
  // all occupied floors. These are synthetic receipts, never live observations.
  for (const p of f.floors.values()) assert.equal(air(f.world.getBlock(p.x, p.y, p.z)), false)
  for (let pass = 0; pass < 4; pass++) {
    const physical = copy(f.state.predicted.physicsState)
    const route = f.navigator.plan(physical, f.initial.position, { maxDistance: 6, maxExpanded: 1000 })
    if (route.ready) {
      const stepper = f.navigator.createStepper(route, physical, { maxTicks: 200, sprint: false })
      let frame
      for (let tick = 0; tick < 201; tick++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
      if (frame.phase === 'awaiting_server_confirmation') {
        assert.equal(frame.predictedState.onGround, true)
        assert.equal(frame.predictedState.position.y, f.initial.position.y)
        assert.equal(frame.serverConfirmed, false)
        assert.ok(Math.hypot(frame.predictedState.position.x - f.initial.position.x, frame.predictedState.position.z - f.initial.position.z) <= 0.4)
        for (const p of f.floors.values()) assert.equal(air(f.world.getBlock(p.x, p.y, p.z)), false)
        return
      }
    }
    const eye = f.state.position, candidates = []
    for (let x = -1; x <= 6; x++) for (let z = -2; z <= 2; z++) for (let y = Math.round(eye.y - 1.62) + 2; y <= 5; y++) {
      const p = { x, y, z }
      if (!f.floors.has(key(p)) && !air(f.world.getBlock(x, y, z)) && f.mining.preview([p]).ready) candidates.push(p)
    }
    for (const p of candidates.slice(0, 8)) { if (!f.mining.preview([p]).ready) continue; f.mining.start([p]); await f.delay(100); assert.equal(f.mining.snapshot().phase, 'completed') }
  }
  assert.fail('No fully known Native return trace was proved')
})

test('already reachable stone is handed back to ordinary Mining without a dig or movement batch', async () => {
  const f = fixture(null, { height: 4, target: { x: 1, y: 3, z: 0 } })
  assert.equal(f.mining.preview([f.decision.target]).ready, true)
  const result = await f.tunneling.execute(f.decision)
  assert.equal(result.oreAccessible, true)
  assert.equal(result.steps.length, 0)
  assert.equal(result.digBlocks, 0)
  assert.equal(result.collected, false)
  assert.equal(f.packets.length, 0)
  assert.equal(f.miningReceipts.length, 0)
})

test('natural deepslate uses the real ordinary Mining preview while changed material, protection, tier or wear denies', async () => {
  const make = () => {
    const f = fixture(null, { target: { x: 1, y: 3, z: 0 } })
    f.changes.set(key(f.decision.target), block('deepslate', copy(f.decision.target)))
    f.decision.block = 'minecraft:deepslate'
    return f
  }
  const f = make(), preview = f.mining.preview([f.decision.target])
  assert.equal(preview.ready, true)
  assert.equal(preview.targets[0].name, 'minecraft:deepslate')
  const plan = f.tunneling.preview(f.decision)
  assert.equal(plan.ready, true, JSON.stringify(plan))
  assert.equal(plan.block, 'minecraft:deepslate')
  assert.equal(plan.requiredToolTier, 1)
  const result = await f.tunneling.execute(f.decision)
  assert.equal(result.oreAccessible, true)
  assert.equal(result.collected, false)
  assert.equal(f.miningReceipts.length, 0)
  for (const flags of [{ natural: false }, { protected: true }]) {
    const bad = make()
    bad.changes.set(key(bad.decision.target), { ...bad.world.getBlock(...['x', 'y', 'z'].map(k => bad.decision.target[k])), ...flags })
    assert.equal(bad.tunneling.preview(bad.decision).code, 'RESOURCE_CHANGED')
  }
  for (const name of ['cobblestone', 'cobbled_deepslate', 'stone_bricks']) {
    const bad = make()
    bad.changes.set(key(bad.decision.target), block(name, copy(bad.decision.target)))
    assert.equal(bad.tunneling.preview(bad.decision).code, 'RESOURCE_CHANGED', name)
  }
  const tier = make()
  tier.tool.name = 'minecraft:wooden_pickaxe'
  assert.equal(tier.tunneling.preview({ ...tier.decision, requiredToolTier: 2 }).code, 'TOOL_REQUIRED')
  const wear = make()
  wear.tool.durabilityKnown = false
  assert.equal(wear.tunneling.preview(wear.decision).code, 'DURABILITY_UNKNOWN')
})

test('stone scope, current or preserved target floors, current actors and unsafe or unknown geometry fail closed', () => {
  for (const mutate of [f => { f.state.profile = '' }, f => { f.state.realm = null }, f => { f.state.lifecycle.deathId = undefined }, f => { f.state.spawnPending = true }, f => { f.state.isDead = true }]) {
    const f = fixture(); mutate(f); assert.equal(f.tunneling.preview(f.decision).ready, false)
  }
  const current = fixture(null, { target: { x: 0, y: 3, z: 0 } })
  assert.equal(current.tunneling.preview(current.decision).code, 'PRESERVED_FLOOR_TARGET')
  const preserved = fixture(); preserved.floors.set(key(preserved.decision.target), copy(preserved.decision.target))
  assert.equal(preserved.tunneling.preview(preserved.decision).code, 'PRESERVED_FLOOR_TARGET')
  const actor = fixture(); actor.state.entities = [{ runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 1, y: 4, z: 0 } }]
  assert.equal(actor.tunneling.preview(actor.decision).code, 'NEARBY_THREAT')
  const unknown = fixture(); unknown.changes.set(key(unknown.decision.target), { known: false })
  assert.equal(unknown.tunneling.preview(unknown.decision).code, 'RESOURCE_UNKNOWN')
  for (const name of ['water', 'lava', 'gravel']) { const f = fixture(); f.changes.set(key(f.decision.target), block(name, copy(f.decision.target))); assert.equal(f.tunneling.preview(f.decision).ready, false) }
})

test('a life change after planning aborts stone execution before the next child action', async () => {
  const f = fixture()
  let previewed = 0
  const mining = { preview: targets => { previewed++; f.state.lifecycle.deathId++; return f.mining.preview(targets) } }
  const tunnel = f.makeTunneling({ mining })
  await assert.rejects(tunnel.execute(f.decision), error => error.code === 'SESSION_CHANGED')
  assert.equal(previewed, 1)
  assert.equal(f.packets.length, 0)
  assert.equal(f.miningReceipts.length, 0)
})

test('empty leaf litter is not transparent to the first actual Mining ray', () => {
  const f = fixture()
  const p = { x: 1, y: 4, z: 0 }
  f.changes.set(key(p), { ...block('leaf_litter', p), boundingBox: 'empty', hardness: 0 })
  const plan = f.excavation.preview({ target: { x: 1, y: 3, z: 0 } })
  assert.equal(plan.ready, true)
  assert.equal(plan.clearance.find(cell => key(cell.position) === key(p)).alreadyClear, true)
  assert.equal(f.mining.preview([plan.blocksToMine[0]]).ready, false)
  assert.equal(f.miningReceipts.length, 0)
  assert.equal(f.packets.length, 0)
})

test('historical302 exact moving seed cannot prove a fourth descent through its unreceived lower halo', () => {
  const captured = require('./fixtures/tunneling-stone302.json')
  const received = new Map(captured.blocks.map(b => [key(b.position), copy(b)]))
  assert.equal(received.has('-124,83,232'), false)
  const projected = new Map(), missing = new Set(), preserved = new Set(), miningPreviews = []
  const world = { getBlock: (x, y, z) => {
    const p = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, k = key(p)
    if (!received.has(k) && !projected.has(k)) missing.add(k)
    return projected.get(k) ?? received.get(k) ?? { known: false, position: p }
  } }
  const physics = preparedPhysics.withWorld(world), navigator = createNavigator({ world, physics, version: '1.26.60' })
  let state = copy(captured.state), physical = copy(state.predicted.physicsState)
  const actualSeed = copy(physical)
  const publish = next => {
    physical = copy(next)
    state.position = physics.toServerPosition(next)
    state.positionSource = 'client_prediction'
    state.positionUpdatedAt = `HISTORICAL_NATIVE_PROJECTION_${miningPreviews.length}`
    state.predicted = { position: copy(state.position), feetPosition: copy(next.position), velocity: copy(next.velocity), onGround: next.onGround, physicsState: copy(next) }
  }
  const preserve = () => { for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) preserved.add(key({ x: Math.floor(physical.position.x + dx), y: Math.round(physical.position.y) - 1, z: Math.floor(physical.position.z + dz) })) }
  const consume = stepper => {
    let frame
    for (let tick = 0; tick < 82; tick++) { frame = stepper.next(); publish(frame.predictedState); if (!['moving', 'settling'].includes(frame.phase)) break }
    return frame
  }
  preserve()
  const coast = consume(navigator.createSettler(physical, { maxTicks: 40, maxDrop: 0, maxHorizontal: 0.3 }))
  assert.equal(coast.phase, 'awaiting_server_confirmation')
  assert.deepEqual(actualSeed, captured.state.predicted.physicsState, 'captured velocity, pose, ground and controls were never reset')
  assert.ok(Math.abs(physical.position.z - 234.2967335058585) < 1e-9)
  preserve()
  const mining = createMining({ getState: () => copy(state), world, getInput: () => ({}) })
  const movement = { preview: () => { throw new Error('Pure historical proof only') }, start: () => { throw new Error('No live movement') }, stop: () => {} }
  const excavation = createExcavation({ getState: () => copy(state), world, mining, movement, getMining: () => mining.snapshot(), getMovement: () => ({ phase: 'idle' }) })
  const projectAfterPreview = target => {
    const p = { x: target.x, y: target.y, z: target.z }, b = world.getBlock(p.x, p.y, p.z)
    assert.equal(b.known, true)
    assert.equal(preserved.has(key(p)), false)
    const preview = mining.preview([target])
    assert.equal(preview.ready, true, JSON.stringify(preview))
    miningPreviews.push({ target: copy(target), name: b.name, provenance: 'HYPOTHETICAL_POST_ACK_AIR_ONLY' })
    projected.set(key(p), block('air', p))
  }
  let cell = { x: -126, y: 89, z: 234 }, last
  for (const [index, direction] of [{ x: 1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: -1 }, { x: 0, z: -1 }].entries()) {
    cell = { x: cell.x + direction.x, y: cell.y - 1, z: cell.z + direction.z }
    const plan = excavation.preview({ target: cell })
    assert.equal(plan.ready, true, JSON.stringify(plan))
    for (const entry of plan.clearance) if (entry.name === 'minecraft:leaf_litter') projectAfterPreview({ ...entry.position, accessPreparation: 'tree_access', expectedName: 'minecraft:leaf_litter' })
    for (const target of plan.blocksToMine) projectAfterPreview(target)
    const route = navigator.plan(physical, plan.target, { maxDistance: 2, maxExpanded: 64 })
    assert.equal(route.ready, true, route.reason)
    last = consume(navigator.createStepper(route, physical, { maxTicks: 80, sprint: false }))
    if (index < 3) { assert.equal(last.phase, 'awaiting_server_confirmation', last.reason); assert.equal(navigator.verifyOrigin(physical), true); preserve() }
    else { assert.equal(last.phase, 'failed'); assert.equal(last.reason, 'No safe one-tick prediction is available') }
  }
  assert.equal(missing.has('-124,83,232'), true)
  assert.equal(received.get('-124,84,232').known, true, 'known support does not fill an unknown physics broadphase cell below it')
  assert.ok(miningPreviews.some(entry => entry.name === 'minecraft:stone'))
  assert.equal(last.serverConfirmed, false)
  for (const p of preserved) assert.equal(projected.has(p), false)
})
