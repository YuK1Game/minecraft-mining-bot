'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { placementTopVisible, planPlacementAccess } = require('../src/action-access')
const { nextBootstrapAction } = require('../src/planner')
const { nextSurvivalAction } = require('../src/survival-planner')
const { createInteractions } = require('../src/interactions')

const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function fixture () {
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '273', dimension: 'overworld', health: 20, threatPolicy: 'online_learning', position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:crafting_table', count: 1 }, { slot: 1, name: 'minecraft:oak_planks', count: 4 }, { slot: 2, name: 'minecraft:stick', count: 3 }] } }
  const blocks = new Map()
  const set = (p, name, fields = {}) => blocks.set(key(p), { known: true, position: copy(p), name: `minecraft:${name}`, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', extra: [], ...fields })
  for (let x = -5; x <= 5; x++) for (let y = 64; y <= 68; y++) for (let z = -5; z <= 5; z++) set({ x, y, z }, y === 64 ? 'grass_block' : 'air', y === 65 ? { protected: true } : {})
  const blocked = { x: 2, y: 65, z: 0 }, alternatives = [{ x: -3, y: 65, z: 0 }, { x: 0, y: 65, z: 3 }]
  for (const p of [blocked, ...alternatives]) set(p, 'air')
  set({ x: 1, y: 65, z: 0 }, 'oak_log')
  const getBlock = p => blocks.get(key(p)) ?? { known: false, position: p }
  const world = { getBlock: (x, y, z) => getBlock({ x, y, z }) }
  const raw = Array.from({ length: 36 }, empty)
  for (const item of state.inventory.items) raw[item.slot] = { ...empty(), network_id: 777 + item.slot, count: item.count, has_stack_id: true, stack_id: 90 + item.slot, block_runtime_id: 300 }
  const crafting = { rawItem: slot => copy(raw[slot]), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: state.inventory.items.map(item => ({ ...item, stackId: raw[item.slot].stack_id })) }), applyPacket () {} }
  const packets = []
  const interactions = createInteractions({ client: { queue: (...args) => packets.push(args) }, getState: () => state, world, crafting, getInput: () => ({}) })
  const observations = () => ({ blocks: [...blocks.values()], capabilities: { craft: true, place_block: true, scan_blocks: true }, crafting: { previews: {} } })
  return { state, blocks, set, blocked, alternatives, getBlock, interactions, packets, observations, visible: p => placementTopVisible({ state, target: p, getBlock }) }
}

test('blocked top-center is skipped for either real visible alternative by both preparation planners', () => {
  for (const excluded of [null, 0]) {
    const f = fixture()
    if (excluded !== null) f.set(f.alternatives[excluded], 'air', { protected: true })
    const observations = f.observations()
    observations.tablePlacement = { ready: true, position: copy(f.blocked) }
    const preview = f.interactions.previewPlace({ position: f.blocked, slot: 0 })
    assert.equal(preview.ready, false)
    assert.match(preview.errors[0], /視線/)
    assert.equal(f.visible(f.blocked), null)
    for (const plan of [nextBootstrapAction(f.state, observations), nextSurvivalAction(f.state, observations, { firstWoodenSwordOnly: true })]) {
      assert.equal(plan.type, 'place_crafting_table')
      assert.notDeepEqual(plan.target, f.blocked)
      assert.ok(f.alternatives.some(p => key(p) === key(plan.target)))
      const accepted = f.interactions.previewPlace({ position: plan.target, slot: 0 })
      assert.equal(accepted.ready, true, accepted.errors)
      assert.deepEqual(accepted.clicked, { ...plan.target, y: plan.target.y - 1 })
      assert.equal(accepted.face, 1)
      assert.equal(plan.requiresLivePreview, true)
      assert.equal(plan.serverConfirmed, undefined)
    }
    assert.equal(f.packets.length, 0, 'all proof calls remain previews')
  }
})

test('placement uses the actual primitive working eye without requiring a fresh raw self echo', () => {
  const f = fixture(), target = { x: 2, y: 65, z: 2 }
  f.state.position = { x: 0.5, y: 66.62, z: 2.5 }
  f.state.rawServerPosition = { x: 0.5, y: 66.62, z: 0.5 }
  f.set({ x: 1, y: 65, z: 0 }, 'air', { protected: true })
  f.set({ x: 1, y: 65, z: 1 }, 'stone')
  f.set(target, 'air')
  assert.equal(f.interactions.previewPlace({ position: target, slot: 0 }).ready, true, 'the unchanged executor sees only the working pose')
  assert.equal(placementTopVisible({ state: { ...f.state, rawServerPosition: null }, target, getBlock: f.getBlock })?.face, 1)
  assert.equal(f.visible(target).face, 1, 'planner uses the same pose that the actual primitive admits')
  for (const p of f.alternatives) f.set(p, 'air', { protected: true })
  const observations = f.observations(); observations.tablePlacement = { ready: true, position: target }
  for (const plan of [nextBootstrapAction(f.state, observations), nextSurvivalAction(f.state, observations, { firstWoodenSwordOnly: true })]) {
    assert.equal(plan.type, 'place_crafting_table')
    assert.equal(f.interactions.previewPlace({ position: plan.target, slot: 0 }).ready, true)
  }
})

test('unknown ray, protected suggestion and missing support cannot authorize placement', () => {
  for (const mode of ['unknown_ray', 'protected', 'support']) {
    const f = fixture(), target = f.alternatives[0]
    for (const p of [f.blocked, f.alternatives[1]]) f.set(p, 'air', { protected: true })
    if (mode === 'unknown_ray') f.blocks.set('-1,66,0', { known: false, position: { x: -1, y: 66, z: 0 } })
    if (mode === 'protected') f.set(target, 'air', { protected: true })
    if (mode === 'support') f.blocks.delete(key({ ...target, y: target.y - 1 }))
    const observations = f.observations(); observations.tablePlacement = { ready: true, position: copy(target) }
    for (const plan of [nextBootstrapAction(f.state, observations), nextSurvivalAction(f.state, observations, { firstWoodenSwordOnly: true })]) assert.notEqual(plan.type, 'place_crafting_table', mode)
    assert.equal(f.packets.length, 0)
  }
})

test('received leaf-litter capture moves to a full known stance then reobserves either ordinary center-top placement', t => {
  const captured = require('./fixtures/table-placement-leaf-litter.json')
  const state = copy(captured.state), blocks = new Map(captured.blocks.map(b => [key(b.position), copy(b)]))
  state.runtimeEntityId = '273'
  const getBlock = p => blocks.get(key(p)) ?? { known: false, position: p }
  const list = [...blocks.values()]
  const blocked = { x: -39, y: 70, z: 37 }
  assert.equal(placementTopVisible({ state, target: blocked, getBlock }), null)
  assert.equal(getBlock({ x: -40, y: 70, z: 37 }).name, 'minecraft:leaf_litter')
  const observations = { blocks: list, capabilities: { move: true, movement: true, craft: true, place_block: true, scan_blocks: true }, crafting: { previews: {} } }
  const before = copy({ state, observations })
  const bootstrap = nextBootstrapAction(state, observations)
  const survival = nextSurvivalAction(state, observations, { deferOptionalShelter: true, objective: 'diamond' })
  for (const plan of [bootstrap, survival]) {
    assert.equal(plan.type, 'move_to')
    assert.deepEqual(plan.target, { x: -40.5, y: 70, z: 39.5 })
    assert.equal(plan.resource, 'crafting_table')
    assert.equal(plan.allowWater, false)
    assert.equal(plan.requiresLivePreview, true)
    assert.equal(plan.requiresReobservation, true)
    assert.equal(plan.placementPurpose, 'crafting_table')
    assert.equal(plan.interactionTarget, undefined, 'an air proposal is not an existing station')
    assert.deepEqual(plan.stance, { positionTolerance: 0.25, testedPoints: 9 })
    assert.equal(plan.serverConfirmed, undefined)
  }
  assert.deepEqual({ state, observations }, before)
  const alternatives = [{ x: -43, y: 70, z: 39 }, { x: -41, y: 70, z: 41 }]
  for (const target of alternatives) {
    const access = planPlacementAccess({ state, targets: [target], blocks: list, getBlock })
    assert.deepEqual(access.standpoint, bootstrap.target)
    const arrived = { ...state, position: { ...access.standpoint, y: access.standpoint.y + 1.62 }, rawServerPosition: { ...access.standpoint, y: access.standpoint.y + 1.62 } }
    const proof = placementTopVisible({ state: arrived, target, getBlock })
    assert.equal(proof.face, 1)
    assert.deepEqual(proof.clickPos, { x: 0.5, y: 1, z: 0.5 })
    const inventory = arrived.inventory.items.map(item => ({ ...item, stackId: 100 + item.slot }))
    const rawItem = slot => {
      const item = inventory.find(item => item.slot === slot)
      return item ? { ...empty(), network_id: 777 + slot, count: item.count, has_stack_id: true, stack_id: item.stackId } : empty()
    }
    // Capture lacks stack IDs. These synthetic IDs exercise preview geometry
    // only; they establish neither real item authority nor a placement receipt.
    const interactions = createInteractions({ client: { queue () { assert.fail('read-only preview') } }, getState: () => arrived, world: { getBlock: (x, y, z) => getBlock({ x, y, z }) }, crafting: { rawItem, snapshot: () => ({ authority: true, inventoryKnown: true, inventory }), applyPacket () {} }, getInput: () => ({}) })
    for (const offset of [{ x: 0, z: 0 }, { x: 0.25, z: 0 }, { x: -0.25, z: 0 }, { x: 0, z: 0.25 }, { x: 0, z: -0.25 }, { x: 0.2, z: 0.2 }, { x: 0.2, z: -0.2 }, { x: -0.2, z: 0.2 }, { x: -0.2, z: -0.2 }]) {
      arrived.position = { x: access.standpoint.x + offset.x, y: access.standpoint.y + 1.62, z: access.standpoint.z + offset.z }
      const live = interactions.previewPlace({ position: target, slot: 3 })
      assert.equal(live.ready, true, live.errors)
      assert.equal(live.face, 1)
    }
  }
  const arrived = { ...state, position: { ...bootstrap.target, y: bootstrap.target.y + 1.62 }, rawServerPosition: { ...bootstrap.target, y: bootstrap.target.y + 1.62 } }
  const reobserved = nextBootstrapAction(arrived, observations)
  assert.equal(reobserved.type, 'place_crafting_table', 'normal new observation chooses a currently visible placement')
  assert.equal(placementTopVisible({ state: arrived, target: reobserved.target, getBlock }).face, 1)
  const unknown = new Map(blocks); unknown.delete('-41,69,39')
  const rejectedStance = planPlacementAccess({ state, targets: alternatives, blocks: list, getBlock: p => unknown.get(key(p)) })
  assert.notDeepEqual(rejectedStance?.standpoint, bootstrap.target, 'missing foot support cannot authorize the old stance')

  t.mock.timers.enable({ apis: ['setInterval'] })
  const { createPhysics } = require('../src/physics')
  const { createMovement } = require('../src/movement')
  const world = { getBlock: (x, y, z) => getBlock({ x, y, z }) }
  const physics = createPhysics({ world, version: '1.26.60' })
  const motionOrigin = { ...copy(state), positionUpdatedAt: captured.observedAt, rawServerPositionUpdatedAt: captured.observedAt, rotation: { yaw: 0, pitch: 0 } }
  const working = copy(motionOrigin), rawBefore = copy(working.rawServerPosition)
  let time = 20000
  const packets = [], receipts = []
  const movement = createMovement({ world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: time, clock: () => time, getState: () => copy(motionOrigin), client: { queue (name, packet) { packets.push({ name, packet }); return { tick: packet.tick } } }, onQueuedFrame: frame => receipts.push(frame), onPrediction: prediction => { working.position = copy(prediction.position); working.predicted = copy(prediction); working.positionSource = prediction.source } })
  t.after(() => movement.stop())
  assert.equal(movement.preview(bootstrap.target, { sprint: false }).ready, true)
  movement.start(bootstrap.target, { sprint: false })
  for (let n = 0; n < 80 && movement.snapshot().running; n++) { time += 50; t.mock.timers.tick(50) }
  const native = movement.snapshot()
  assert.equal(native.phase, 'awaiting_server_confirmation', native.reason)
  assert.equal(native.onGround, true)
  assert.equal(native.serverConfirmed, false)
  assert.equal(native.queuedReceiptConfirmed, true)
  assert.ok(receipts.length > 1 && receipts.every(receipt => receipt.receiptConfirmed))
  assert.equal(packets.length, receipts.length)
  assert.deepEqual(working.rawServerPosition, rawBefore, 'no fabricated server self echo')
  const actualNext = nextBootstrapAction(working, observations)
  assert.equal(actualNext.type, 'place_crafting_table')
  const actualProof = placementTopVisible({ state: working, target: actualNext.target, getBlock })
  assert.equal(actualProof.face, 1)
  const tableItem = working.inventory.items.find(item => item.name === 'minecraft:crafting_table')
  const inventory = working.inventory.items.map(item => ({ ...item, stackId: 100 + item.slot }))
  const preview = createInteractions({ client: { queue () { assert.fail('preview cannot place') } }, getState: () => working, world, crafting: { rawItem: slot => { const item = inventory.find(item => item.slot === slot); return item ? { ...empty(), network_id: 777 + slot, count: item.count, has_stack_id: true, stack_id: item.stackId } : empty() }, snapshot: () => ({ authority: true, inventoryKnown: true, inventory }), applyPacket () {} }, getInput: () => ({}) }).previewPlace({ position: actualNext.target, slot: tableItem.slot })
  assert.equal(preview.ready, true, preview.errors)
  assert.equal(preview.serverConfirmed, undefined)
})
