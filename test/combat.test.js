'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createEntities } = require('../src/entities')
const { createCombat } = require('../src/combat')

function fixture (options = {}) {
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '1', dimension: 'overworld', health: 20, selectedSlot: 0, rawSelectedSlot: 0, rawServerSelectedSlot: 0, position: { x: 0.5, y: 66.62, z: 0.5 } }
  const entities = createEntities()
  entities.applyPacket('start_game', { runtime_entity_id: 1n, entity_id: 100n, dimension: 'overworld' })
  const raw = { network_id: 777, count: 1, metadata: 0, has_stack_id: true, stack_id: 42, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
  const inventory = { authority: true, openContainer: null }
  const crafting = { rawItem: () => structuredClone(raw), snapshot: () => structuredClone(inventory) }
  const blocks = new Map()
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', extra: [] } }
  const packets = []
  const order = []
  let running = false
  let sent = 0
  let timestamp = 1000
  const input = { stats: () => ({ running, sent, tick: String(sent), target: null }), lookAt: position => order.push({ kind: 'look', position }), start () { running = true; sent++; order.push({ kind: 'input_tick' }) }, stop () { running = false } }
  const combat = createCombat({ client: { queue: (name, params) => { packets.push({ name, params }); order.push({ kind: 'attack' }) } }, getState: () => state, world, entities, crafting, getInput: () => input, attackTimeoutMs: 60, now: () => timestamp, ...options })
  function observe (name, packet) { entities.applyPacket(name, packet); combat.applyPacket(name, packet) }
  function addMob (type = 'minecraft:zombie', runtimeId = 77n, uniqueId = 99n, position = { x: 1.5, y: 65, z: 0.5 }) {
    observe('add_entity', { entity_type: type, runtime_id: runtimeId, unique_id: uniqueId, position, attributes: [{ name: 'minecraft:health', value: 20 }] })
  }
  addMob()
  return { combat, state, entities, raw, inventory, blocks, packets, order, input, observe, addMob, advance: milliseconds => { timestamp += milliseconds } }
}
async function waitForAttack (packets) {
  for (let attempt = 0; attempt < 100 && !packets.length; attempt++) await delay(5)
  assert.ok(packets.length, 'expected an attack after an input tick')
}

test('learning chicken hunt uses real low body aim, rejects observed baby or ownership, and never claims food from death alone', async () => {
  const f = fixture(); f.state.health = 1
  f.addMob('minecraft:chicken', 80n, 180n)
  assert.equal(f.combat.previewHunt('80').ready, false)
  f.state.threatPolicy = 'online_learning'
  const preview = f.combat.previewHunt('80')
  assert.equal(preview.ready, true); assert.equal(preview.target.aimPoint.y, 65.3)
  assert.deepEqual(preview.yieldRisk, { foodYieldConfirmed: false, age: 'unknown' })
  const snapshot = f.entities.snapshot.bind(f.entities)
  for (const change of [{ isBaby: true }, { baby: true }, { owned: true }, { ownerId: '-99' }, { customName: 'Pet' }, { nameTag: 'Pet' }, { protected: true }]) {
    f.entities.snapshot = options => snapshot(options).map(entity => entity.runtimeId === '80' ? { ...entity, ...change } : entity)
    assert.equal(f.combat.previewHunt('80').ready, false, JSON.stringify(change))
  }
  f.entities.snapshot = snapshot
  const hunt = f.combat.hunt('80'); await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 80n, event_id: 'death_animation' })
  const result = await hunt
  assert.equal(result.reaction, 'death_animation'); assert.equal(result.collected, false); assert.equal(result.botCausedDamage, null)
})

test('PvP, NPCs, custom mobs, unknown positions and targets outside 2.8 are never attacked', async () => {
  const { combat, entities, addMob, packets } = fixture()
  entities.applyPacket('add_player', { runtime_id: 78n, unique_id: 98n, username: 'Zombie', position: { x: 1.5, y: 66.62, z: 0.5 } })
  addMob('minecraft:npc', 79n, 97n)
  addMob('custom:zombie', 80n, 96n)
  addMob('minecraft:skeleton', 81n, 95n, null)
  addMob('minecraft:creeper', 82n, 94n, { x: 4, y: 66.62, z: 0.5 })
  for (const id of ['1', '78', '79', '80', '81', '82', '999']) {
    assert.equal(combat.preview(id).ready, false)
    await assert.rejects(combat.attack(id))
  }
  assert.equal(packets.length, 0)
})

test('melee defense uses the configured ranged-threat policy consistently', () => {
  const f = fixture()
  f.state.health = 13; f.state.threatPolicy = 'balanced_mining'; f.state.inventory = { known: true, items: [] }
  f.inventory.inventoryKnown = true; f.inventory.inventory = [{ slot: 0, name: 'minecraft:wooden_sword', count: 1, stackId: 42 }]
  f.addMob('minecraft:skeleton', 81n, 95n, { x: 23.5, y: 66.62, z: 0.5 })
  assert.equal(f.combat.previewEngage('77').ready, true)
  f.state.threatPolicy = undefined
  assert.equal(f.combat.previewEngage('77').ready, false)
  f.state.threatPolicy = 'balanced_mining'; f.state.health = 11
  assert.equal(f.combat.previewEngage('77').ready, false)
})

test('health, unknown items, inventory screens, blocked sight and unknown terrain prevent attacks', async () => {
  const f = fixture()
  for (const health of [0, 10, null, NaN]) {
    f.state.health = health
    await assert.rejects(f.combat.attack('77'))
  }
  f.state.health = 20
  f.inventory.openContainer = { id: 2, type: 'inventory' }
  await assert.rejects(f.combat.attack('77'), /画面/)
  f.inventory.openContainer = null
  f.raw.has_stack_id = false
  await assert.rejects(f.combat.attack('77'), /持ち物/)
  f.raw.has_stack_id = true
  f.blocks.set('1,66,0', { known: true, name: 'minecraft:stone', extra: [] })
  await assert.rejects(f.combat.attack('77'), /視線/)
  f.blocks.set('1,66,0', { known: false })
  await assert.rejects(f.combat.attack('77'), /地形/)
  assert.equal(f.packets.length, 0)
})

test('look/input precedes a current-schema entity attack and sending alone remains only requested', async () => {
  const { combat, packets, order, input } = fixture()
  const attack = combat.attack('77')
  assert.equal(packets.length, 0)
  assert.deepEqual(order.map(event => event.kind), ['look', 'input_tick'])
  await waitForAttack(packets)
  const packet = packets[0]
  assert.equal(packet.name, 'inventory_transaction')
  assert.equal(packet.params.transaction.transaction_type, 'item_use_on_entity')
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(packet)).data.params.transaction
  assert.equal(decoded.transaction_type, 'item_use_on_entity')
  assert.equal(decoded.transaction_data.action_type, 'attack')
  assert.equal(decoded.transaction_data.entity_runtime_id, 77n)
  assert.equal(decoded.transaction_data.held_item.network_id, 777)
  assert.equal(decoded.transaction_data.held_item.stack_id, 42)
  assert.equal(decoded.transaction_data.hand, 'main_hand')
  assert.equal(decoded.transaction_data.hotbar_slot, 0)
  assert.deepEqual(decoded.transaction_data.click_pos, { x: 0, y: 0, z: 0 })
  assert.deepEqual(order.map(event => event.kind), ['look', 'input_tick', 'attack'])
  const result = await attack
  assert.equal(result.phase, 'requested')
  assert.equal(result.reaction, 'unconfirmed')
  assert.equal(result.botCausedDamage, null)
  assert.equal(input.stats().running, false)
})

test('matching server reactions are observed without claiming who caused damage and cooldown prevents rapid repeats', async () => {
  const { combat, observe, packets } = fixture()
  const attack = combat.attack('77')
  await waitForAttack(packets)
  observe('entity_event', { runtime_entity_id: 55n, event_id: 'hurt_animation', data: 0 })
  assert.equal(combat.snapshot().lastResult.phase, 'requested')
  observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation', data: 0 })
  const result = await attack
  assert.equal(result.phase, 'observed')
  assert.equal(result.reaction, 'hurt_animation')
  assert.equal(result.attribution, 'unconfirmed')
  await assert.rejects(combat.attack('77'), /連打/)
  assert.equal(packets.length, 1)
})

test('health decreases and unique-ID removal are recognized only for the requested hostile', async () => {
  const f = fixture()
  const attack = f.combat.attack('77')
  await waitForAttack(f.packets)
  f.observe('update_attributes', { runtime_entity_id: 77n, attributes: [{ name: 'minecraft:health', current: 18 }] })
  assert.equal((await attack).reaction, 'health_decreased')
  f.advance(750)
  const second = f.combat.attack('77')
  for (let attempt = 0; attempt < 100 && f.packets.length < 2; attempt++) await delay(5)
  f.observe('remove_entity', { entity_id_self: 77n })
  assert.equal(f.combat.snapshot().pendingTargetRuntimeId, '77')
  f.observe('remove_entity', { entity_id_self: 99n })
  assert.equal((await second).reaction, 'target_removed')
})

test('death or a target changing identity during the look tick cancels before an attack can be sent', async () => {
  const f = fixture()
  const attack = f.combat.attack('77')
  f.state.health = 0
  f.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 0 }] })
  await assert.rejects(attack)
  assert.equal(f.packets.length, 0)
  assert.equal(f.input.stats().running, false)
  const other = fixture()
  const target = other.combat.attack('77')
  other.observe('add_player', { runtime_id: 77n, unique_id: 99n, username: 'Player', position: { x: 1.5, y: 66.62, z: 0.5 } })
  await assert.rejects(target, /敵モブ/)
  assert.equal(other.packets.length, 0)
})

test('the real defend deadline terminates even when the injected observation clock does not advance', async () => {
  const f = fixture()
  const started = performance.now()
  const result = await f.combat.defend({ durationMs: 100, maxHits: 3 })
  assert.equal(result.reason, 'duration_limit')
  assert.ok(performance.now() - started < 350)
  assert.ok(f.packets.length <= 1)
  assert.equal(f.input.stats().running, false)
})

test('short defend is bounded, requires a reachable hostile and exposes only server-observed reactions', async () => {
  const f = fixture()
  const defending = f.combat.defend({ durationMs: 1000, maxHits: 1 })
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation', data: 0 })
  const result = await defending
  assert.equal(result.reason, 'hit_limit')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].phase, 'observed')
  assert.equal(result.recommendation, 'avoid')
  await assert.rejects(f.combat.defend({ durationMs: Infinity }))
  await assert.rejects(f.combat.defend({ maxHits: 4 }))
  const other = fixture()
  other.observe('remove_entity', { entity_id_self: 99n })
  assert.equal((await other.combat.defend()).reason, 'no_reachable_hostile')
  assert.equal(other.packets.length, 0)
})

test('food previews are passive, allow positive low health and only widen the explicit hunt operation', async () => {
  const f = fixture()
  f.state.health = 3.43
  for (const [index, animal] of ['cow', 'pig', 'sheep'].entries()) {
    const id = BigInt(80 + index)
    f.addMob(`minecraft:${animal}`, id, id + 100n)
    const preview = f.combat.previewHunt(String(id))
    assert.equal(preview.ready, true)
    assert.equal(preview.purpose, 'food')
    assert.equal(preview.collected, false)
    assert.equal(f.combat.preview(String(id)).ready, false)
  }
  assert.equal(f.order.length, 0)
  assert.equal(f.packets.length, 0)
  await assert.rejects(f.combat.attack('77'), /10以下/)
  await assert.rejects(f.combat.defend(), /10以下/)
  for (const health of [0, null, NaN]) { f.state.health = health; assert.equal(f.combat.previewHunt('80').ready, false) }
  f.state.health = 0.1
  assert.equal(f.combat.previewHunt('80').ready, true)
})

test('hunt rejects players, NPCs, pets, other animals, custom names, missing positions and other dimensions', async () => {
  const f = fixture()
  const excluded = ['wolf', 'cat', 'wandering_trader', 'llama', 'trader_llama', 'chicken', 'horse', 'npc', 'zombie']
  for (const [index, type] of excluded.entries()) {
    const id = BigInt(80 + index)
    f.addMob(`minecraft:${type}`, id, id + 100n)
    assert.equal(f.combat.previewHunt(String(id)).ready, false)
    await assert.rejects(f.combat.hunt(String(id)))
  }
  f.addMob('custom:cow', 100n, 200n)
  f.addMob('minecraft:cow', 101n, 201n, null)
  f.entities.applyPacket('add_player', { runtime_id: 102n, unique_id: 202n, username: 'Cow', position: { x: 1.5, y: 66.62, z: 0.5 } })
  for (const id of ['1', '100', '101', '102', '999']) assert.equal(f.combat.previewHunt(id).ready, false)
  f.addMob('minecraft:cow', 103n, 203n)
  f.state.dimension = 'nether'
  assert.equal(f.combat.previewHunt('103').ready, false)
  assert.equal(f.packets.length, 0)
})

test('one low-health hunt observes only the matching server reaction without claiming food or damage attribution', async () => {
  const f = fixture()
  f.state.health = 3.43
  f.addMob('minecraft:cow', 80n, 180n)
  const hunt = f.combat.hunt('80')
  assert.equal(f.combat.snapshot().purpose, 'hunt')
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal(f.combat.snapshot().pendingTargetRuntimeId, '80')
  f.observe('entity_event', { runtime_entity_id: 80n, event_id: 'hurt_animation' })
  const result = await hunt
  assert.equal(result.phase, 'observed', 'low health must not be rejected by the normal defense session during packet handling')
  assert.equal(result.reaction, 'hurt_animation')
  assert.equal(result.purpose, 'food')
  assert.equal(result.collected, false)
  assert.equal(result.botCausedDamage, null)
  assert.equal(result.attribution, 'unconfirmed')
  assert.equal(f.packets.length, 1)
  assert.equal(f.input.stats().running, false)
  await assert.rejects(f.combat.hunt('80'), /連打/)
  f.state.health = 20
  await assert.rejects(f.combat.attack('77'), /連打/, 'hunt and self-defense share one cooldown')
})

test('hunt uses the raw server-selected empty hand and never a predicted MobEquipment slot', async () => {
  const empty = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
  const weapon = { network_id: 777, count: 1, metadata: 0, has_stack_id: true, stack_id: 42, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
  const f = fixture({ crafting: { rawItem: slot => structuredClone(slot === 0 ? empty : weapon), snapshot: () => ({ authority: true, inventoryKnown: true, openContainer: null }) } })
  f.state.health = 3.43
  f.state.selectedSlot = 1
  f.state.equipmentServerConfirmed = false
  f.addMob('minecraft:pig', 80n, 180n)
  assert.equal(f.combat.previewHunt('80').slot, 0)
  const hunt = f.combat.hunt('80')
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 80n, event_id: 'hurt_animation' })
  await hunt
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(f.packets[0])).data.params.transaction.transaction_data
  assert.equal(decoded.entity_runtime_id, 80n)
  assert.equal(decoded.hotbar_slot, 0)
  assert.equal(decoded.held_item.network_id, 0)
  assert.equal(f.packets.some(packet => packet.name === 'mob_equipment'), false)
  assert.equal(f.state.selectedSlot, 1, 'planning cannot rewrite the host equipment prediction')
})

test('hunt requires raw selected-slot evidence, clear known sight, close range and actual inventory', async () => {
  const f = fixture()
  f.addMob('minecraft:sheep', 80n, 180n)
  delete f.state.rawSelectedSlot; delete f.state.rawServerSelectedSlot
  await assert.rejects(f.combat.hunt('80'), /スロット/)
  f.state.rawSelectedSlot = 0
  f.inventory.inventoryKnown = false
  await assert.rejects(f.combat.hunt('80'), /取得/)
  f.inventory.inventoryKnown = true
  f.blocks.set('1,66,0', { known: false })
  await assert.rejects(f.combat.hunt('80'), /地形/)
  f.blocks.set('1,66,0', { known: true, name: 'minecraft:stone', extra: [] })
  await assert.rejects(f.combat.hunt('80'), /視線/)
  f.blocks.clear()
  f.addMob('minecraft:cow', 81n, 181n, { x: 3.31, y: 66.62, z: 0.5 })
  await assert.rejects(f.combat.hunt('81'), /2.8/)
  f.observe('entity_event', { runtime_entity_id: 80n, event_id: 'death_animation' })
  await assert.rejects(f.combat.hunt('80'), /生存/)
  assert.equal(f.packets.length, 0)
})

test('a hunt revalidates identity and life during its look tick and cancels before sending a hit', async () => {
  const changed = fixture()
  changed.state.health = 3.43
  changed.addMob('minecraft:cow', 80n, 180n)
  const hunt = changed.combat.hunt('80')
  changed.addMob('minecraft:pig', 80n, 181n)
  await assert.rejects(hunt, /個体/)
  assert.equal(changed.packets.length, 0)
  const dead = fixture()
  dead.state.health = 3.43
  dead.addMob('minecraft:sheep', 80n, 180n)
  const pending = dead.combat.hunt('80')
  dead.state.health = 0
  dead.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 0 }] })
  await assert.rejects(pending)
  assert.equal(dead.packets.length, 0)
  assert.equal(dead.input.stats().running, false)
})

test('a nearby zombie above known leaf litter is aimed inside its body and sends one normal attack', async () => {
  const f = fixture()
  f.state.health = 14
  f.addMob('minecraft:zombie', 528n, 1528n, { x: 2.6, y: 65, z: 0.5 })
  f.blocks.set('2,65,0', { known: true, name: 'minecraft:leaf_litter', boundingBox: 'empty', extra: [] })
  f.blocks.set('1,66,0', { known: true, name: 'minecraft:short_grass', boundingBox: 'empty', extra: [] })
  const preview = f.combat.preview('528')
  assert.equal(preview.ready, true)
  assert.ok(Math.abs(preview.distance - Math.hypot(2.1, 0.72)) < 1e-10, 'reach and LOS use the same actual body aim point')
  assert.deepEqual(preview.target.position, { x: 2.6, y: 65, z: 0.5 }, 'do not rewrite the tracked foot position')
  assert.deepEqual(preview.target.aimPoint, { x: 2.6, y: 65.9, z: 0.5 })
  const attack = f.combat.attack('528')
  assert.deepEqual(f.order[0], { kind: 'look', position: preview.target.aimPoint })
  await waitForAttack(f.packets)
  assert.equal(f.packets[0].params.transaction.transaction_data.entity_runtime_id, 528n)
  f.observe('entity_event', { runtime_entity_id: 528n, event_id: 'hurt_animation' })
  assert.equal((await attack).reaction, 'hurt_animation')
  assert.equal(f.packets.length, 1)
})

test('low mobs use low body points and unspecified sizes are not treated as tall humanoids', () => {
  const f = fixture()
  const heights = [['skeleton', 0.9], ['drowned', 0.9], ['spider', 0.4], ['cave_spider', 0.2], ['silverfish', 0.15], ['slime', 0.2], ['hoglin', 0.3]]
  for (const [index, [type, height]] of heights.entries()) {
    const id = BigInt(200 + index)
    f.addMob(`minecraft:${type}`, id, id + 100n)
    const preview = f.combat.preview(String(id))
    assert.equal(preview.ready, true, type)
    assert.equal(preview.target.aimPoint.y, 65 + height, type)
  }
  assert.equal(f.order.length, 0)
  assert.equal(f.packets.length, 0)
})

test('the field zombie body is within the unchanged 2.8 reach even when its foot is more than three blocks away', async () => {
  const f = fixture()
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.1, y: 65, z: 0.5 })
  const footDistance = Math.hypot(3.1 - 0.5, 65 - 66.62)
  assert.ok(footDistance > 3)
  const preview = f.combat.preview('77')
  assert.equal(preview.ready, true)
  assert.deepEqual(preview.target.aimPoint, { x: 3.1, y: 65.9, z: 0.5 })
  assert.ok(Math.abs(preview.distance - Math.hypot(2.6, 0.72)) < 1e-10)
  assert.ok(preview.distance < 2.8)
  const task = f.combat.attack('77')
  await waitForAttack(f.packets)
  const decoded = createDeserializer('1.26.60').parsePacketBuffer(createSerializer('1.26.60').createPacketBuffer(f.packets[0])).data.params.transaction
  assert.equal(decoded.transaction_type, 'item_use_on_entity')
  assert.equal(decoded.transaction_data.action_type, 'attack')
  assert.equal(decoded.transaction_data.entity_runtime_id, 77n)
  assert.equal(decoded.transaction_data.held_item.stack_id, 42)
  assert.deepEqual(f.order[0].position, preview.target.aimPoint)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).phase, 'observed')
})

test('body reach accepts 2.8 exactly and rejects 2.81 without substituting a taller unknown-size body', async () => {
  const f = fixture()
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.3, y: 65.72, z: 0.5 })
  assert.equal(f.combat.preview('77').ready, true)
  assert.equal(f.combat.preview('77').distance, 2.8)
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.31, y: 65.72, z: 0.5 })
  assert.equal(f.combat.preview('77').ready, false)
  await assert.rejects(f.combat.attack('77'), /2.8/)
  assert.equal(f.packets.length, 0)
  f.addMob('minecraft:hoglin', 77n, 99n, { x: 3.1, y: 65, z: 0.5 })
  assert.equal(f.combat.preview('77').ready, false, 'the existing low fallback offset must not be raised to make the target reachable')
})

test('short defense uses body preview after broad-phase selection and does not drop a legal body target', async () => {
  const f = fixture()
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.1, y: 65, z: 0.5 })
  const task = f.combat.defend({ durationMs: 1000, maxHits: 1 })
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).reason, 'hit_limit')
  assert.equal(f.packets.length, 1)
})

test('plants need an observed empty box and solid, waterlogged, custom or unknown cells still block body sight', async () => {
  const f = fixture()
  const blockers = [
    { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] },
    { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block', extra: [] },
    { known: true, name: 'minecraft:leaf_litter', boundingBox: 'block', extra: [] },
    { known: true, name: 'minecraft:leaf_litter', extra: [] },
    { known: true, name: 'minecraft:leaf_litter', boundingBox: 'empty', extra: [{ name: 'minecraft:water' }] },
    { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [{ name: 'minecraft:water' }] },
    { known: true, name: 'minecraft:water', boundingBox: 'block', extra: [] },
    { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [{ known: false }] },
    { known: true, name: 'minecraft:lava', boundingBox: 'empty', extra: [] },
    { known: true, name: 'custom:grass', boundingBox: 'empty', extra: [] },
    { known: false, name: 'minecraft:short_grass', boundingBox: 'empty' }
  ]
  for (const block of blockers) {
    f.blocks.set('1,66,0', block)
    assert.equal(f.combat.preview('77').ready, false, JSON.stringify(block))
    await assert.rejects(f.combat.attack('77'), /視線|地形/)
  }
  assert.equal(f.packets.length, 0)
})

test('received collision-free water permits an attack while unknown or obstructed water does not', async () => {
  for (const name of ['minecraft:water', 'minecraft:flowing_water']) {
    const f = fixture()
    f.blocks.set('1,66,0', { known: true, name, boundingBox: 'empty', extra: [] })
    assert.equal(f.combat.preview('77').ready, true, name)
    const work = f.combat.attack('77')
    await waitForAttack(f.packets)
    f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
    assert.equal((await work).reaction, 'hurt_animation')
  }
})

function waterCreeperFixture () {
  const f = fixture()
  f.state.inventory = { known: true, items: [] }; f.state.heldItem = null; f.state.equipmentServerConfirmed = true
  f.inventory.inventoryKnown = true; f.inventory.inventory = []
  Object.assign(f.raw, { network_id: 0, count: 0, has_stack_id: false, stack_id: 0 })
  f.blocks.set('0,65,0', { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] })
  f.addMob('minecraft:creeper', 77n, 99n, { x: 3.55, y: 65, z: 0.5 })
  f.observe('set_entity_data', { runtime_entity_id: 77n, tick: 1n, metadata: [{ key: 'flags', value: { ignited: false, powered: false, charged: false } }, { key: 'fuse_length', value: -1 }] })
  return f
}

test('the water-only creeper strike uses a bounded 3.2-block range and does not change ordinary attacks', async () => {
  const f = waterCreeperFixture()
  assert.equal(f.combat.preview('77').ready, false)
  const preview = f.combat.previewWaterCreeper('77')
  assert.equal(preview.ready, true, JSON.stringify(preview))
  assert.ok(preview.distance > 2.8 && preview.distance <= 3.2)
  const work = f.combat.waterCreeperAttack('77')
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await work).reaction, 'hurt_animation')
  assert.equal(f.packets.length, 1)
})

test('water creeper defense accepts a server-confirmed rotten-flesh stack without inventing its identity', () => {
  const f = waterCreeperFixture()
  Object.assign(f.raw, { network_id: 777, count: 1, has_stack_id: true, stack_id: 42 })
  f.state.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1, networkId: 777 }]
  f.state.heldItem = { ...f.state.inventory.items[0] }
  f.inventory.inventory = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1, stackId: 42 }]
  assert.equal(f.combat.previewWaterCreeper('77').ready, true)
  f.inventory.inventory[0].stackId = 43
  assert.equal(f.combat.previewWaterCreeper('77').ready, false)
})

test('the water creeper strike requires known water, full health and a safe identified threat set', async () => {
  for (const mode of ['dry', 'blocked_head', 'health', 'inventory', 'charged', 'unknown_fuse', 'late_fuse', 'unknown_position', 'second_close', 'second_primed', 'third', 'out_of_range', 'other_item']) {
    const f = waterCreeperFixture()
    if (mode === 'dry') f.blocks.set('0,65,0', { known: true, name: 'minecraft:air', extra: [] })
    if (mode === 'blocked_head') f.blocks.set('0,66,0', { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] })
    if (mode === 'health') f.state.health = 19
    if (mode === 'inventory') f.state.inventory.uncertain = true
    if (mode === 'charged') f.observe('set_entity_data', { runtime_entity_id: 77n, tick: 2n, metadata: [{ key: 'flags', value: { ignited: false, powered: true, charged: false } }] })
    if (mode === 'unknown_fuse') { f.entities.applyPacket('entity_event', { runtime_entity_id: 77n, event_id: 'creeper_prime_fuse' }); f.entities.applyPacket('set_entity_data', { runtime_entity_id: 77n, tick: 2n, metadata: [{ key: 'flags', value: { ignited: true, powered: false, charged: false } }] }) }
    if (mode === 'late_fuse') f.observe('set_entity_data', { runtime_entity_id: 77n, tick: 2n, metadata: [{ key: 'flags', value: { ignited: true, powered: false, charged: false } }, { key: 'fuse_length', value: 19 }] })
    if (mode === 'unknown_position') f.addMob('minecraft:zombie', 78n, 101n, null)
    if (mode === 'second_close' || mode === 'second_primed' || mode === 'third') {
      f.addMob('minecraft:creeper', 78n, 101n, { x: mode === 'second_close' ? -3 : -5, y: 65, z: 0.5 })
      f.observe('set_entity_data', { runtime_entity_id: 78n, tick: 1n, metadata: [{ key: 'flags', value: { ignited: mode === 'second_primed', powered: false, charged: false } }, { key: 'fuse_length', value: mode === 'second_primed' ? 25 : -1 }] })
      if (mode === 'third') f.addMob('minecraft:zombie', 79n, 102n, { x: 0.5, y: 65, z: 5 })
    }
    if (mode === 'out_of_range') f.entities.applyPacket('move_entity', { runtime_entity_id: 77n, position: { x: 4, y: 65, z: 0.5 } })
    if (mode === 'other_item') { Object.assign(f.raw, { network_id: 777, count: 1, has_stack_id: true, stack_id: 42 }); f.state.inventory.items = [{ slot: 0, name: 'minecraft:stone', count: 1, stackId: 42 }]; f.state.heldItem = f.state.inventory.items[0] }
    assert.equal(f.combat.previewWaterCreeper('77').ready, false, mode)
    await assert.rejects(f.combat.waterCreeperAttack('77'), undefined, mode)
    assert.equal(f.packets.length, 0, mode)
  }
})

test('water creeper strike rechecks the target and secondary threat after the look tick', async () => {
  for (const mode of ['target_replaced', 'target_primed_late', 'secondary_added', 'damage', 'water_unknown']) {
    const f = waterCreeperFixture()
    const work = f.combat.waterCreeperAttack('77')
    if (mode === 'target_replaced') f.addMob('minecraft:creeper', 77n, 101n, { x: 3.55, y: 65, z: 0.5 })
    if (mode === 'target_primed_late') f.observe('set_entity_data', { runtime_entity_id: 77n, tick: 2n, metadata: [{ key: 'flags', value: { ignited: true, powered: false, charged: false } }, { key: 'fuse_length', value: 4 }] })
    if (mode === 'secondary_added') { f.addMob('minecraft:creeper', 78n, 101n, { x: -5, y: 65, z: 0.5 }); f.observe('set_entity_data', { runtime_entity_id: 78n, tick: 1n, metadata: [{ key: 'flags', value: { ignited: false, powered: false, charged: false } }, { key: 'fuse_length', value: -1 }] }) }
    if (mode === 'damage') f.state.health = 19
    if (mode === 'water_unknown') f.blocks.set('0,65,0', { known: false })
    await assert.rejects(work, undefined, mode)
    assert.equal(f.packets.length, 0, mode)
  }
})

test('an aborted water creeper strike stops waiting for a server reaction and releases input', async () => {
  const f = waterCreeperFixture(); const controller = new AbortController()
  const work = f.combat.waterCreeperAttack('77', { signal: controller.signal })
  await waitForAttack(f.packets)
  controller.abort(new Error('water escape cancelled'))
  await assert.rejects(work, /water escape cancelled/)
  assert.equal(f.combat.snapshot().busy, false)
  assert.equal(f.input.stats().running, false)
})

test('body sight is checked again after the look tick before attack dispatch', async () => {
  for (const block of [{ known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }, { known: false }]) {
    const f = fixture()
    const attack = f.combat.attack('77')
    assert.deepEqual(f.order[0].position, { x: 1.5, y: 65.9, z: 0.5 })
    f.blocks.set('1,66,0', block)
    await assert.rejects(attack, /視線|地形/)
    assert.equal(f.packets.length, 0)
    assert.equal(f.input.stats().running, false)
  }
})

test('an observed empty-box torch does not block melee sight but unknown, solid, wet or other torch types do', async () => {
  const f = fixture()
  const torch = { known: true, name: 'minecraft:torch', boundingBox: 'empty', properties: { torch_facing_direction: 'top' }, extra: [] }
  for (const change of [{ known: false }, { boundingBox: 'block' }, { extra: [{ name: 'minecraft:water' }] }, { name: 'minecraft:redstone_torch' }]) {
    f.blocks.set('1,66,0', { ...torch, ...change })
    assert.equal(f.combat.preview('77').ready, false, JSON.stringify(change))
  }
  f.blocks.set('1,66,0', torch)
  assert.equal(f.combat.preview('77').ready, true)
  const task = f.combat.attack('77')
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).phase, 'observed')
  assert.equal(f.packets.length, 1)
})

test('boss mobs are excluded from automatic self-defense and direct attack previews', async () => {
  const f = fixture()
  for (const [index, type] of ['wither', 'ender_dragon'].entries()) {
    const id = BigInt(300 + index)
    f.addMob(`minecraft:${type}`, id, id + 100n)
    assert.equal(f.combat.preview(String(id)).ready, false)
    await assert.rejects(f.combat.attack(String(id)), /ボス/)
  }
  assert.equal(f.packets.length, 0)
})

function armedFixture (options = {}) {
  const f = fixture(options)
  f.inventory.inventoryKnown = true
  f.inventory.inventory = [{ slot: 0, name: 'minecraft:stone_sword', count: 1, stackId: 42 }]
  f.state.inventory = { known: true, items: structuredClone(f.inventory.inventory) }
  return f
}

test('low-health emergency attack is one scoped zombie strike with a confirmed sword', async () => {
  const f = armedFixture(); f.state.health = 9.631
  assert.equal(f.combat.preview('77').ready, false)
  assert.equal(f.combat.previewEmergency('77').ready, true)
  const task = f.combat.emergencyAttack('77')
  await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).phase, 'observed')
  assert.equal(f.packets.length, 1)
  for (const mode of ['health', 'weapon', 'other', 'skeleton']) {
    const g = armedFixture(); g.state.health = 9
    if (mode === 'health') g.state.health = 6
    if (mode === 'weapon') g.inventory.inventory[0].name = 'minecraft:stick'
    if (mode === 'other') g.addMob('minecraft:creeper', 78n, 98n, { x: 2, y: 65, z: 0.5 })
    if (mode === 'skeleton') g.addMob('minecraft:skeleton', 77n, 99n)
    assert.equal(g.combat.previewEmergency('77').ready, false, mode)
    await assert.rejects(g.combat.emergencyAttack('77'))
    assert.equal(g.packets.length, 0)
  }
})

test('ordinary defense can strike a visible zombie with a server-confirmed empty hand', async () => {
  const f = armedFixture(); f.state.health = 20; f.state.inventory = { known: true, items: [] }; f.inventory.inventory = []
  Object.assign(f.raw, { network_id: 0, count: 0, has_stack_id: false, stack_id: 0 })
  assert.equal(f.combat.preview('77').ready, true)
  const task = f.combat.attack('77'); await waitForAttack(f.packets); f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' }); assert.equal((await task).phase, 'observed')
  assert.equal(f.packets.length, 1)
})

test('one emergency zombie strike can explicitly monitor one identified distant skeleton', async () => {
  const f = armedFixture(); f.state.health = 10
  f.addMob('minecraft:skeleton', 78n, 98n, { x: 21.5, y: 65, z: 0.5 })
  assert.equal(f.combat.previewEmergency('77').ready, false)
  assert.equal(f.combat.previewEmergency('77', { allowDistantRanged: true }).ready, true)
  const attack = f.combat.emergencyAttack('77', { allowDistantRanged: true }); await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await attack).phase, 'observed')
  for (const mode of ['near', 'extra', 'replacement']) {
    const g = armedFixture(); g.state.health = 10
    g.addMob('minecraft:skeleton', 78n, 98n, { x: mode === 'near' ? 17.5 : 21.5, y: 65, z: 0.5 })
    if (mode === 'extra') g.addMob('minecraft:zombie', 79n, 97n, { x: 5, y: 65, z: 0.5 })
    if (mode === 'replacement') {
      const task = g.combat.emergencyAttack('77', { allowDistantRanged: true })
      g.addMob('minecraft:skeleton', 78n, 123n, { x: 21.5, y: 65, z: 0.5 })
      await assert.rejects(task)
    } else await assert.rejects(g.combat.emergencyAttack('77', { allowDistantRanged: true }))
    assert.equal(g.packets.length, 0, mode)
  }
})

test('one emergency zombie strike monitors a second identified zombie at a safe distance', async () => {
  const f = armedFixture(); f.state.health = 12.631
  f.addMob('minecraft:zombie', 78n, 98n, { x: 8.5, y: 65, z: 0.5 })
  assert.equal(f.combat.previewEmergency('77').ready, false)
  assert.equal(f.combat.previewEmergency('77', { allowDistantZombie: true }).ready, true)
  const task = f.combat.emergencyAttack('77', { allowDistantZombie: true }); await waitForAttack(f.packets)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).phase, 'observed')
  for (const mode of ['near', 'low_health', 'extra', 'replacement']) {
    const g = armedFixture(); g.state.health = mode === 'low_health' ? 10 : 12.631
    g.addMob('minecraft:zombie', 78n, 98n, { x: mode === 'near' ? 6 : 8.5, y: 65, z: 0.5 })
    if (mode === 'extra') g.addMob('minecraft:creeper', 79n, 97n, { x: 5, y: 65, z: 0.5 })
    if (mode === 'replacement') {
      const attack = g.combat.emergencyAttack('77', { allowDistantZombie: true })
      g.addMob('minecraft:zombie', 78n, 123n, { x: 8.5, y: 65, z: 0.5 })
      await assert.rejects(attack)
    } else await assert.rejects(g.combat.emergencyAttack('77', { allowDistantZombie: true }))
    assert.equal(g.packets.length, 0, mode)
  }
})

test('group-monitored emergency strike rejects closer, replaced, new or unsupported secondary enemies', async () => {
  const setup = () => { const f = armedFixture(); f.state.health = 12.631; f.addMob('minecraft:zombie', 78n, 98n, { x: 10, y: 65, z: 0.5 }); f.addMob('minecraft:spider', 79n, 97n, { x: 8.5, y: 65, z: 0.5 }); f.addMob('minecraft:witch', 80n, 96n, { x: 19, y: 65, z: 0.5 }); return f }
  const f = setup(); assert.equal(f.combat.previewEmergency('77', { allowGuardedGroup: true }).ready, true)
  const task = f.combat.emergencyAttack('77', { allowGuardedGroup: true }); await waitForAttack(f.packets); f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' }); assert.equal((await task).phase, 'observed')
  for (const mode of ['near', 'unsupported', 'extra', 'low_health', 'replacement']) {
    const g = setup()
    if (mode === 'near') g.addMob('minecraft:spider', 79n, 97n, { x: 6, y: 65, z: 0.5 })
    if (mode === 'unsupported') g.addMob('minecraft:creeper', 79n, 97n, { x: 6, y: 65, z: 0.5 })
    if (mode === 'extra') g.addMob('minecraft:zombie', 81n, 95n, { x: 9, y: 65, z: 0.5 })
    if (mode === 'low_health') g.state.health = 10
    if (mode === 'replacement') {
      const attack = g.combat.emergencyAttack('77', { allowGuardedGroup: true }); g.addMob('minecraft:spider', 79n, 123n, { x: 8.5, y: 65, z: 0.5 }); await assert.rejects(attack)
    } else await assert.rejects(g.combat.emergencyAttack('77', { allowGuardedGroup: true }))
    assert.equal(g.packets.length, 0, mode)
  }
})

test('guarded emergency attack can strike a spider only with sufficient health and a distant zombie', async () => {
  const setup = () => { const f = armedFixture(); f.state.health = 10.631; f.addMob('minecraft:spider', 77n, 99n); f.addMob('minecraft:zombie', 78n, 98n, { x: 11, y: 65, z: 0.5 }); return f }
  const f = setup(); assert.equal(f.combat.previewEmergency('77').ready, false); assert.equal(f.combat.previewEmergency('77', { allowDistantZombie: true }).ready, true)
  const task = f.combat.emergencyAttack('77', { allowDistantZombie: true }); await waitForAttack(f.packets); f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' }); assert.equal((await task).phase, 'observed')
  const low = setup(); low.state.health = 10; await assert.rejects(low.combat.emergencyAttack('77', { allowDistantZombie: true }))
  const close = setup(); close.addMob('minecraft:zombie', 78n, 98n, { x: 6, y: 65, z: 0.5 }); await assert.rejects(close.combat.emergencyAttack('77', { allowDistantZombie: true }))
})

test('critical health permits only the explicitly scoped zombie strike with distant ranged observation', async () => {
  const setup = () => { const f = armedFixture(); f.state.health = 4.631; f.addMob('minecraft:skeleton', 78n, 98n, { x: 23.5, y: 65, z: 0.5 }); return f }
  const f = setup(); assert.equal(f.combat.previewEmergency('77', { allowDistantRanged: true }).ready, false)
  assert.equal(f.combat.previewEmergency('77', { allowDistantRanged: true, allowCritical: true }).ready, true)
  const task = f.combat.emergencyAttack('77', { allowDistantRanged: true, allowCritical: true }); await waitForAttack(f.packets); f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' }); assert.equal((await task).phase, 'observed')
  for (const mode of ['skeleton_close', 'zombie_extra', 'dead', 'spider_target']) {
    const g = setup()
    if (mode === 'skeleton_close') g.addMob('minecraft:skeleton', 78n, 98n, { x: 19, y: 65, z: 0.5 })
    if (mode === 'zombie_extra') g.addMob('minecraft:zombie', 79n, 97n, { x: 9, y: 65, z: 0.5 })
    if (mode === 'dead') g.state.health = 0
    if (mode === 'spider_target') g.addMob('minecraft:spider', 77n, 99n)
    await assert.rejects(g.combat.emergencyAttack('77', { allowDistantRanged: true, allowCritical: true }))
    assert.equal(g.packets.length, 0, mode)
  }
})

test('critical attack reach remains below the Bedrock survival three-block bound', async () => {
  const f = armedFixture(); f.state.health = 4.631
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.3, y: 65, z: 0.5 })
  assert.equal(f.combat.previewEmergency('77', { allowCritical: true }).ready, true)
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.38, y: 65, z: 0.5 })
  assert.equal(f.combat.previewEmergency('77', { allowCritical: true }).ready, false)
  assert.equal(f.packets.length, 0)
})

test('one creeper strike requires explicit scope and stops on observed prime, new threat or health loss', async () => {
  const setup = () => { const f = armedFixture(); f.state.health = 7.631; f.addMob('minecraft:creeper', 77n, 99n); return f }
  const f = setup(); assert.equal(f.combat.previewEmergency('77').ready, false); assert.equal(f.combat.previewEmergency('77', { allowEmergencyCreeper: true }).ready, true)
  const task = f.combat.emergencyAttack('77', { allowEmergencyCreeper: true }); await waitForAttack(f.packets); f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' }); assert.equal((await task).phase, 'observed'); assert.equal(f.packets.length, 1)
  for (const mode of ['primed', 'other', 'damage', 'low_health', 'replacement']) {
    const g = setup()
    if (mode === 'low_health') g.state.health = 6
    if (mode === 'other') g.addMob('minecraft:zombie', 78n, 98n, { x: 4, y: 65, z: 0.5 })
    if (mode === 'primed') g.observe('entity_event', { runtime_entity_id: 77n, event_id: 'creeper_prime_fuse' })
    if (mode === 'damage' || mode === 'replacement') {
      const attack = g.combat.emergencyAttack('77', { allowEmergencyCreeper: true })
      if (mode === 'damage') g.state.health--
      else g.addMob('minecraft:creeper', 77n, 123n)
      await assert.rejects(attack)
    } else await assert.rejects(g.combat.emergencyAttack('77', { allowEmergencyCreeper: true }))
    assert.equal(g.packets.length, 0, mode)
  }
})
async function waitForHits (packets, count) {
  for (let attempt = 0; attempt < 250 && packets.filter(packet => packet.name === 'inventory_transaction').length < count; attempt++) await delay(5)
  assert.equal(packets.filter(packet => packet.name === 'inventory_transaction').length, count, `expected ${count} entity attacks`)
}

function unarmedFixture () {
  const body = { known: true }
  const f = fixture({ verifyUnarmedBody: (state, { continuation }) => body.known && !state.physicsState.isInWater && !state.physicsState.isInLava && (state.physicsState.onGround === true || continuation) })
  Object.assign(f.raw, { network_id: 0, count: 0, has_stack_id: false, stack_id: 0 })
  Object.assign(f.inventory, { inventoryKnown: true, inventory: [] })
  Object.assign(f.state, { profile: 'unarmed', realm: { id: '42' }, connectionId: 'socket', inventory: { known: true, items: [] }, heldItem: null, equipmentServerConfirmed: true, physicsState: { onGround: true, isInWater: false, isInLava: false, velocity: { x: 0, y: 0, z: 0 } } })
  return { ...f, body }
}

test('committed unarmed entry is explicit, healthy, body-proven and limited to one confirmed zombie', async () => {
  const ready = unarmedFixture()
  assert.equal(ready.combat.previewEngage('77', { allowUnarmed: true }).ready, true)
  assert.equal(ready.combat.previewEngage('77').ready, false, 'the ordinary sword contract remains unchanged')
  assert.equal(ready.packets.length, 0)
  for (const mode of ['health', 'drowned', 'husk', 'other', 'unknown', 'body', 'water', 'airborne', 'equipment', 'inventory', 'hand']) {
    const f = unarmedFixture()
    if (mode === 'health') f.state.health = 17
    if (['drowned', 'husk'].includes(mode)) f.addMob(`minecraft:${mode}`, 77n, 99n)
    if (mode === 'other') f.addMob('minecraft:skeleton', 78n, 98n, { x: 5, y: 65, z: 0.5 })
    if (mode === 'unknown') f.addMob('minecraft:zombie', 78n, 98n, null)
    if (mode === 'body') f.body.known = false
    if (mode === 'water') f.state.physicsState.isInWater = true
    if (mode === 'airborne') f.state.physicsState.onGround = false
    if (mode === 'equipment') f.state.equipmentServerConfirmed = false
    if (mode === 'inventory') f.state.inventory.known = false
    if (mode === 'hand') Object.assign(f.raw, { network_id: 777, count: 1, has_stack_id: true, stack_id: 42 })
    assert.equal(f.combat.previewEngage('77', { allowUnarmed: true }).ready, false, mode)
    await assert.rejects(f.combat.engage('77', { allowUnarmed: true, durationMs: 30000, maxHits: 24 }), undefined, mode)
    assert.equal(f.packets.length, 0, mode)
  }
})

test('five unarmed punches remain committed through health 20 to 17 and bounded knockback before the next legal hit', async () => {
  const f = unarmedFixture()
  const task = f.combat.engage('77', { allowUnarmed: true, durationMs: 30000, maxHits: 24 })
  for (let hit = 1; hit <= 5; hit++) {
    await waitForHits(f.packets, hit)
    f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
    if (hit < 5) f.advance(750)
  }
  f.state.health = 17; f.state.physicsState.onGround = false; f.state.physicsState.velocity = { x: -0.12, y: 0.24, z: 0 }
  f.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 17 }] })
  f.observe('update_attributes', { runtime_entity_id: 77n, attributes: [{ name: 'minecraft:health', current: 1.5 }] })
  f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 5.5, y: 65, z: 0.5 } })
  f.advance(749); await delay(110)
  assert.equal(f.packets.length, 5, 'knockback and cooldown cannot authorize an early extra attack')
  assert.equal(f.combat.snapshot().engaging, true)
  f.state.physicsState.onGround = true; f.state.physicsState.velocity = { x: 0, y: 0, z: 0 }
  f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 1.5, y: 65, z: 0.5 } }); f.advance(1)
  await waitForHits(f.packets, 6)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'death_animation' })
  const result = await task
  assert.equal(result.allowUnarmed, true); assert.equal(result.hitsRequested, 6); assert.equal(result.lastHealth, 17)
  assert.equal(result.targetStopped, true); assert.equal(result.serverConfirmed, true); assert.equal(result.botCausedDeath, null)
})

test('the explicit unarmed budget can exceed eight hits while an unchanged confirmed rotten-flesh hand remains bound', async () => {
  const f = unarmedFixture()
  Object.assign(f.raw, { network_id: 777, count: 1, has_stack_id: true, stack_id: 42 })
  f.inventory.inventory = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1, stackId: 42 }]
  f.state.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1, networkId: 777 }]
  f.state.heldItem = { ...f.state.inventory.items[0] }
  assert.equal(f.combat.previewEngage('77', { allowUnarmed: true }).ready, true)
  const task = f.combat.engage('77', { allowUnarmed: true, durationMs: 30000, maxHits: 24 })
  for (let hit = 1; hit <= 9; hit++) {
    await waitForHits(f.packets, hit)
    f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' }); f.advance(750)
  }
  f.raw.stack_id = 43; f.inventory.inventory[0].stackId = 43
  f.observe('inventory_slot', {})
  const result = await task
  assert.equal(result.hitsRequested, 9)
  assert.equal(result.targetStopped, false, 'a replacement stack cannot inherit the original hand commitment')
  assert.equal(f.input.stats().running, false)
})

test('committed unarmed defense stops at health six, large damage or any lost hand, scope, body or participant proof', async () => {
  for (const mode of ['health_six', 'large_damage', 'new_actor', 'unknown_actor', 'body', 'water', 'hand', 'slot', 'scope', 'replacement', 'long_airborne']) {
    const f = unarmedFixture(); const task = f.combat.engage('77', { allowUnarmed: true, durationMs: 30000, maxHits: 24 })
    await waitForHits(f.packets, 1)
    if (mode === 'health_six' || mode === 'large_damage') f.state.health = mode === 'health_six' ? 6 : 14
    if (mode === 'new_actor') f.addMob('minecraft:skeleton', 78n, 98n, { x: 5, y: 65, z: 0.5 })
    if (mode === 'unknown_actor') f.addMob('minecraft:zombie', 78n, 98n, null)
    if (mode === 'body') f.body.known = false
    if (mode === 'water') f.state.physicsState.isInWater = true
    if (mode === 'hand') Object.assign(f.raw, { network_id: 777, count: 1, has_stack_id: true, stack_id: 42 })
    if (mode === 'slot') f.state.rawServerSelectedSlot = 1
    if (mode === 'scope') f.state.connectionId = 'replaced'
    if (mode === 'replacement') f.addMob('minecraft:zombie', 77n, 999n)
    if (mode === 'long_airborne') { f.state.physicsState.onGround = false; f.observe('entity_event', { runtime_entity_id: 1n, event_id: 'hurt_animation' }); f.advance(1001) }
    f.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: f.state.health }] })
    const result = await task
    assert.equal(result.targetStopped, false, mode); assert.equal(f.combat.snapshot().engaging, false, mode); assert.equal(f.packets.length, 1, mode)
    assert.equal(f.input.stats().running, false, mode)
  }
  const f = unarmedFixture()
  for (const options of [{ allowUnarmed: true, maxHits: 25 }, { allowUnarmed: true, durationMs: 30001 }, { maxHits: 9 }, { durationMs: 6001 }]) await assert.rejects(f.combat.engage('77', options))
})

test('engagement entry is passive and requires a confirmed selected sword, health above ten and one known melee actor', async () => {
  const f = armedFixture()
  assert.equal(f.combat.previewEngage('77').ready, true)
  assert.equal(f.order.length, 0)
  for (const health of [0, 6, 10, null, NaN]) {
    f.state.health = health
    await assert.rejects(f.combat.engage('77'))
  }
  f.state.health = 20
  for (const name of ['minecraft:stone_pickaxe', 'minecraft:stick']) {
    f.inventory.inventory[0].name = name
    await assert.rejects(f.combat.engage('77'), /剣/)
  }
  f.inventory.inventory[0].name = 'minecraft:stone_sword'
  f.inventory.inventory[0].stackId = 999
  await assert.rejects(f.combat.engage('77'), /剣/)
  f.inventory.inventory[0].stackId = 42
  f.state.rawServerSelectedSlot = 1
  await assert.rejects(f.combat.engage('77'), /剣/)
  f.state.rawServerSelectedSlot = 0
  f.inventory.inventoryKnown = false
  await assert.rejects(f.combat.engage('77'), /持ち物/)
  assert.equal(f.packets.length, 0)
  for (const type of ['creeper', 'skeleton', 'wither', 'ender_dragon', 'npc']) {
    const other = armedFixture()
    other.addMob(`minecraft:${type}`, 77n, 99n)
    await assert.rejects(other.combat.engage('77'))
    assert.equal(other.packets.length, 0)
  }
})

test('one melee engagement continues through normal damage to health eight and observes five hits without claiming a kill', async () => {
  const f = armedFixture()
  const task = f.combat.engage('77', { durationMs: 6000, maxHits: 8 })
  for (let hit = 1; hit <= 5; hit++) {
    await waitForHits(f.packets, hit)
    const packet = f.packets.at(-1).params.transaction.transaction_data
    assert.equal(packet.entity_runtime_id, 77n)
    assert.equal(packet.action_type, 'attack')
    assert.equal(packet.held_item.stack_id, 42)
    if (hit === 5) f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'death_animation' })
    else {
      f.state.health -= 3
      f.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: f.state.health }] })
      f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
      f.advance(750)
    }
  }
  const result = await task
  assert.equal(result.phase, 'observed')
  assert.equal(result.reaction, 'death_animation')
  assert.equal(result.hitsRequested, 5)
  assert.equal(result.lastHealth, 8)
  assert.equal(result.targetState, 'dead')
  assert.equal(result.botCausedDamage, null)
  assert.equal(result.botCausedDeath, null)
  assert.equal(result.attribution, 'unconfirmed')
  assert.equal(f.combat.snapshot().engaging, false)
  assert.equal(f.combat.preview('77').ready, false, 'ordinary self-defense still needs health above ten')
})

test('knockback within six waits without movement or early extra hits and resumes only on the same actor returning', async () => {
  const f = armedFixture()
  const task = f.combat.engage('77', { durationMs: 3000, maxHits: 4 })
  await waitForHits(f.packets, 1)
  f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 4.5, y: 65, z: 0.5 } })
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  f.advance(750)
  await delay(130)
  assert.equal(f.packets.length, 1)
  assert.equal(f.combat.snapshot().engaging, true)
  assert.equal(f.combat.snapshot().busy, false)
  await assert.rejects(f.combat.attack('77'), /前の/)
  await assert.rejects(f.combat.defend(), /進行中/)
  await assert.rejects(f.combat.engage('77'), /進行中/)
  f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 1.5, y: 65, z: 0.5 } })
  await waitForHits(f.packets, 2)
  f.observe('remove_entity', { entity_id_self: 99n })
  const result = await task
  assert.equal(result.reaction, 'target_removed')
  assert.equal(result.targetState, 'removed')
  assert.equal(result.botCausedDeath, null, 'despawn/removal is not a kill attribution')
  assert.equal(result.hitsRequested, 2)
})

test('engagement entry and its six-block knockback boundary both use body aim distance', async () => {
  const f = armedFixture()
  f.addMob('minecraft:zombie', 77n, 99n, { x: 3.1, y: 65, z: 0.5 })
  assert.equal(f.combat.previewEngage('77').ready, true)
  assert.ok(Math.abs(f.combat.previewEngage('77').distance - Math.hypot(2.6, 0.72)) < 1e-10)
  const task = f.combat.engage('77')
  await waitForHits(f.packets, 1)
  f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 6.4, y: 65, z: 0.5 } })
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  f.advance(750)
  await delay(120)
  assert.ok(Math.hypot(6.4 - 0.5, 65 - 66.62) > 6, 'foot distance lies outside the wait radius')
  assert.equal(f.combat.snapshot().engaging, true, 'body distance remains within six')
  assert.equal(f.packets.length, 1)
  f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 0.5 + Math.sqrt(6.01 ** 2 - 0.72 ** 2), y: 65, z: 0.5 } })
  const result = await task
  assert.equal(result.phase, 'stopped')
  assert.match(result.reason, /6ブロック/)
  assert.equal(result.hitsRequested, 1)
  const tooFar = armedFixture()
  tooFar.addMob('minecraft:zombie', 77n, 99n, { x: 3.31, y: 65.72, z: 0.5 })
  assert.equal(tooFar.combat.previewEngage('77').ready, false)
  await assert.rejects(tooFar.combat.engage('77'), /2.8/)
  assert.equal(tooFar.packets.length, 0)
})

test('a terminal health update during cooldown stops the same target without waiting for another attack', async () => {
  const f = armedFixture()
  const task = f.combat.engage('77')
  await waitForHits(f.packets, 1)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  await Promise.resolve(); await Promise.resolve()
  f.observe('update_attributes', { runtime_entity_id: 77n, attributes: [{ name: 'minecraft:health', current: 0 }] })
  const result = await task
  assert.equal(result.reaction, 'health_zero')
  assert.equal(result.hitsRequested, 1)
  assert.equal(result.serverConfirmed, true)
})

test('an explicitly configured armed engagement retains the 750ms cooldown override', async () => {
  const f = armedFixture({ cooldownMs: 600, engagementCooldownMs: 750 })
  const task = f.combat.engage('77', { durationMs: 2000, maxHits: 2 })
  await waitForHits(f.packets, 1)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  f.advance(749)
  await delay(130)
  assert.equal(f.packets.length, 1)
  f.advance(1)
  await waitForHits(f.packets, 2)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).code, 'hit_limit')
})

test('new creepers, multiple enemies, unknown walls, changed identities, dimensions or escape distance interrupt before a hit', async () => {
  const mutations = [
    f => f.addMob('minecraft:creeper', 88n, 188n, { x: 7.5, y: 65, z: 0.5 }),
    f => f.addMob('minecraft:zombie', 88n, 188n, { x: 9.5, y: 65, z: 0.5 }),
    f => f.addMob('minecraft:wither', 88n, 188n, { x: 12.5, y: 65, z: 0.5 }),
    f => { f.blocks.set('1,66,0', { known: false }); f.observe('update_block', {}) },
    f => { f.blocks.set('1,66,0', { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }); f.observe('update_block', {}) },
    f => f.addMob('minecraft:zombie', 77n, 199n),
    f => { f.state.dimension = 'nether'; f.observe('update_attributes', {}) },
    f => f.observe('move_entity', { runtime_entity_id: 77n, position: { x: 7.5, y: 65, z: 0.5 } }),
    f => f.addMob('minecraft:zombie', 88n, 188n, null)
  ]
  for (const mutate of mutations) {
    const f = armedFixture()
    const task = f.combat.engage('77')
    mutate(f)
    const result = await task
    assert.equal(result.phase, 'stopped')
    assert.equal(result.code, 'unsafe_observation')
    assert.equal(result.targetStopped, false)
    assert.equal(f.packets.length, 0)
    assert.equal(f.combat.snapshot().engaging, false)
  }
})

test('engagement stops at health six, one large damage event, explicit stop or Abort and drains its pending input', async () => {
  for (const cause of ['health_six', 'large_damage', 'death', 'explicit', 'abort']) {
    const f = armedFixture()
    const controller = new AbortController()
    const task = f.combat.engage('77', { signal: controller.signal })
    if (cause === 'explicit') f.combat.cancel('明示的に停止しました。')
    else if (cause === 'abort') controller.abort()
    else { f.state.health = cause === 'large_damage' ? 14 : cause === 'health_six' ? 6 : 0; f.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: f.state.health }] }) }
    await f.combat.drain()
    const result = await task
    assert.equal(result.phase, 'stopped', cause)
    assert.equal(result.targetStopped, false)
    assert.equal(f.packets.length, 0)
    assert.equal(f.input.stats().running, false)
    assert.equal(f.combat.snapshot().engaging, false)
  }
})

test('engagement hit and real-time limits remain bounded even with a frozen observation clock', async () => {
  const limited = armedFixture()
  const task = limited.combat.engage('77', { durationMs: 1000, maxHits: 1 })
  await waitForHits(limited.packets, 1)
  limited.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  assert.equal((await task).code, 'hit_limit')
  const timed = armedFixture()
  const began = performance.now()
  const expired = await timed.combat.engage('77', { durationMs: 100, maxHits: 8 })
  assert.equal(expired.code, 'duration_limit')
  assert.equal(expired.targetStopped, false)
  assert.ok(performance.now() - began < 350)
  const sent = timed.packets.length
  await delay(80)
  assert.equal(timed.packets.length, sent)
  for (const options of [{ durationMs: 6001 }, { durationMs: Infinity }, { maxHits: 9 }, { maxHits: 0 }]) await assert.rejects(armedFixture().combat.engage('77', options))
})

function runtimeCombatFixture (t) {
  const { createRuntime } = require('../src/runtime')
  const { createSessionCache } = require('../src/session-cache')
  const f = armedFixture()
  const packets = []
  const lifecycle = []
  const cache = createSessionCache()
  const startGame = { runtime_entity_id: 1n, current_tick: 500n, player_position: structuredClone(f.state.position), rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  cache.observe('start_game', startGame)
  cache.observe('item_registry', { itemstates: [{ name: 'minecraft:stone_sword', runtime_id: 777 }] })
  cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, slot) => slot === 0 ? structuredClone(f.raw) : { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }) })
  const world = { getBlock: (x, y, z) => ({ known: true, name: y <= 64 ? 'minecraft:grass_block' : 'minecraft:air', runtimeId: y <= 64 ? 20 : 0, boundingBox: y <= 64 ? 'block' : 'empty', properties: {}, extra: [], position: { x, y, z } }), stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 9 }) }
  const host = {
    client: { queue: (name, params) => packets.push({ name, params: structuredClone(params) }), close: () => lifecycle.push('close'), disconnect: () => lifecycle.push('disconnect') },
    getState: () => structuredClone(f.state), getServerState: () => structuredClone(f.state), entities: f.entities, world, cache,
    shared: { autoWanted: false, loadingScreenEnded: true }, meta: { version: '1.26.60', startGame, startGameReceivedAt: performance.now() }, apiUrl: 'http://127.0.0.1:49999',
    allocate: () => -1, commitInventory () {}, setPrediction () {}, setEquipmentPrediction () {}, setCapabilities () {}, log () {}, noteProgress () {}
  }
  const runtime = createRuntime(host)
  t.after(() => runtime.dispose('test_cleanup'))
  const observe = (name, packet) => { f.entities.applyPacket(name, packet); runtime.applyPacket(name, packet) }
  return { ...f, runtime, packets, lifecycle, observe }
}

test('the runtime preserves an engagement only for the exact damage stop reason and keeps its owner exclusive', async t => {
  const f = runtimeCombatFixture(t)
  assert.equal(f.packets.length, 0, 'runtime creation is passive')
  const task = f.runtime.operations.combat.engage('77', { durationMs: 2000, maxHits: 3 })
  await waitForHits(f.packets, 1)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  await delay(2)
  assert.equal(f.runtime.snapshot().combat.busy, false)
  assert.equal(f.runtime.snapshot().combat.engaging, true)
  assert.equal(f.runtime.canReload(), false)
  assert.throws(() => f.runtime.operations.crafting.openInventory(), /前の操作/)
  f.state.health = 17
  f.observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 17 }] })
  await f.runtime.stopActions('ダメージを検知しました。')
  assert.equal(f.runtime.snapshot().combat.engaging, true, 'ordinary damage must stop movement/mining while the committed fight continues')
  await waitForHits(f.packets, 2)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  await f.runtime.stopActions('ダメージを検知しました。手動停止')
  const result = await task
  assert.equal(result.code, 'cancelled', 'a near-matching reason is still an explicit stop')
  assert.equal(f.runtime.snapshot().combat.engaging, false)
  assert.deepEqual(f.lifecycle, [])
})

test('runtime dispose drains an in-flight engagement and generation fencing prevents all subsequent old sends', async t => {
  const f = runtimeCombatFixture(t)
  const rawPosition = structuredClone(f.state.position)
  const task = f.runtime.operations.combat.engage('77')
  assert.equal(f.runtime.snapshot().combat.engaging, true)
  await f.runtime.dispose('ダメージを検知しました。')
  const result = await task
  assert.equal(result.code, 'cancelled')
  assert.equal(f.runtime.snapshot().combat.engaging, false)
  const sent = f.packets.length
  await delay(110)
  assert.equal(f.packets.length, sent)
  assert.throws(() => f.runtime.operations.combat.engage('77'), /更新/)
  assert.deepEqual(f.state.position, rawPosition, 'stationary combat cannot invent a new server position')
  assert.deepEqual(f.lifecycle, [])
})
