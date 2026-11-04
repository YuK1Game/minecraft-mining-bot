'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createRuntime } = require('../src/runtime')
const { createSessionCache } = require('../src/session-cache')
const { createEntities } = require('../src/entities')

const copy = value => structuredClone(value)
const DAMAGE_STOP = 'ダメージを検知しました。'
function fixture (t) {
  let time = 10000; let stamp = 1; let cover = false
  t.mock.method(Date, 'now', () => time)
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Runtime engagement tests must never contact an API') })
  const state = { phase: 'spawned', profile: 'bot', realm: { id: 'offline' }, dimension: 'overworld', connectionId: 'offline', startedAt: 'offline', runtimeEntityId: '1', gameMode: 'survival', health: 20, dead: false, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: stamp, rotation: { yaw: -90, pitch: 0 }, selectedSlot: 0, rawSelectedSlot: 0, rawServerSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: null, inventory: { known: true, items: [] }, capabilities: {} }
  const entities = createEntities()
  const startGame = { runtime_entity_id: 1n, entity_id: 100n, current_tick: 500n, player_position: copy(state.position), rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  entities.applyPacket('start_game', startGame)
  entities.applyPacket('add_entity', { entity_type: 'minecraft:zombie', runtime_id: 77n, unique_id: 99n, position: { x: 1.5, y: 65, z: 0.5 }, attributes: [{ name: 'minecraft:health', value: 20 }] })
  const cache = createSessionCache()
  cache.observe('start_game', startGame)
  cache.observe('item_registry', { itemstates: [{ name: 'minecraft:air', runtime_id: 0 }, { name: 'minecraft:rotten_flesh', runtime_id: 778 }] })
  cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })) })
  const packets = []; const lifecycle = []
  const shared = { autoWanted: false, loadingScreenEnded: true, vitals: { hunger: { value: 20, source: 'server_attribute' } } }
  const world = { getBlock: (x, y, z) => {
    const solid = (x === 0 || x === 1) && z === 0 && y <= 64 || cover && x >= 3 && x <= 6 && y >= 57 && y <= 65
    return { known: true, position: { x, y, z }, name: solid ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: solid ? 'block' : 'empty', runtimeId: solid ? 20 : 0, properties: {}, extra: [] }
  }, stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 9 }) }
  const getState = () => ({ ...copy(state), rawServerPosition: copy(state.position), rawServerPositionUpdatedAt: state.positionUpdatedAt, ...(shared.prediction ? { position: copy(shared.prediction.position), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: shared.prediction.updatedAt, predicted: copy(shared.prediction) } : {}) })
  const host = { client: { queue: (name, params) => { packets.push({ name, params: copy(params), at: time }); return { tick: params.tick } }, close: () => lifecycle.push('close'), disconnect: () => lifecycle.push('disconnect') }, getState, getServerState: () => copy(state), entities, world, cache, shared, meta: { version: '1.26.60', startGame, startGameReceivedAt: performance.now() }, apiUrl: 'http://127.0.0.1:49999', allocate: () => -1, commitInventory () {}, setPrediction: prediction => { shared.prediction = { ...copy(prediction), updatedAt: ++stamp } }, setEquipmentPrediction () {}, setCapabilities () {}, log () {}, noteProgress () {} }
  const runtime = createRuntime(host)
  t.after(() => runtime.dispose('test_cleanup'))
  const observe = (name, packet) => { entities.applyPacket(name, packet); runtime.applyPacket(name, packet) }
  const damageAndKnockback = async () => {
    state.health = 17
    observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 17 }] })
    observe('set_entity_motion', { runtime_entity_id: 1n, velocity: { x: -0.12, y: 0.24, z: 0 }, tick: 0n })
    assert.equal(runtime.snapshot().lastServerMotion?.accepted, true)
    assert.equal(runtime.snapshot().lastServerMotion?.velocity.y, 0.24)
    observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
    assert.equal(runtime.snapshot().combat.engaging, true, 'a target observation during the received impulse must preserve the committed engagement')
    await runtime.stopActions(DAMAGE_STOP)
    assert.equal(runtime.snapshot().combat.engaging, true, 'the exact damage stop keeps the committed engagement')
    assert.equal(runtime.snapshot().movement.phase, 'stopped')
    assert.equal(runtime.snapshot().mining.phase, 'stopped')
    state.position = { x: 0.35, y: 66.62, z: 0.5 }; state.positionUpdatedAt = ++stamp; state.positionSource = 'move_player'; shared.prediction = null
    observe('move_player', { runtime_id: 1n, position: copy(state.position), on_ground: true, mode: 'normal' })
  }
  return { runtime, state, entities, packets, lifecycle, observe, damageAndKnockback, setCover: value => { cover = value }, advance: ms => { time += ms } }
}
const attacks = packets => packets.filter(packet => packet.name === 'inventory_transaction' && packet.params.transaction?.transaction_type === 'item_use_on_entity')
async function waitForHits (packets, count, debug = null) {
  for (let n = 0; n < 250 && attacks(packets).length < count; n++) await delay(5)
  assert.equal(attacks(packets).length, count, JSON.stringify({ reason: `expected ${count} legal entity attacks`, state: debug?.() }))
}

test('runtime idle safety commits one empty-hand zombie engagement through fifth-hit damage and knockback to a sixth observed removal', async t => {
  const f = fixture(t)
  assert.equal(f.packets.length, 0)
  f.runtime.operations.safety.start()
  f.advance(600)
  for (let hit = 1; hit <= 6; hit++) {
    await waitForHits(f.packets, hit, () => { const snapshot = f.runtime.snapshot(); return { safety: snapshot.safety, combat: snapshot.combat, idle: snapshot.idle } })
    const packet = attacks(f.packets).at(-1).params.transaction.transaction_data
    assert.equal(packet.entity_runtime_id, 77n)
    assert.equal(packet.action_type, 'attack')
    assert.equal(packet.held_item.network_id, 0)
    if (hit === 6) f.observe('remove_entity', { entity_id_self: 99n })
    else {
      f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
      if (hit === 5) await f.damageAndKnockback()
      f.advance(750)
    }
  }
  for (let n = 0; n < 250 && (f.runtime.snapshot().combat.engaging || f.runtime.snapshot().safety.busy); n++) await delay(5)
  const combat = f.runtime.snapshot().combat
  assert.equal(combat.engaging, false)
  assert.equal(combat.lastResult.hitsRequested, 6)
  assert.equal(combat.lastResult.reaction, 'target_removed')
  assert.equal(combat.lastResult.targetState, 'removed')
  assert.equal(combat.lastResult.botCausedDeath, null)
  assert.equal(combat.lastResult.attribution, 'unconfirmed')
  assert.equal(f.state.health, 17)
  assert.deepEqual(f.state.inventory.items, [])
  assert.equal(f.runtime.snapshot().safety.emergencySent, false)
  assert.deepEqual(f.lifecycle, [])
})

test('explicit near-matching stops cancel the inherited unarmed engagement and drain further sends', async t => {
  const f = fixture(t)
  const work = f.runtime.operations.combat.engage('77', { allowUnarmed: true, durationMs: 30000, maxHits: 24 })
  await waitForHits(f.packets, 1)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  await f.runtime.stopActions(DAMAGE_STOP + '手動停止')
  const result = await work
  assert.equal(result.code, 'cancelled')
  assert.equal(f.runtime.snapshot().combat.engaging, false)
  const count = attacks(f.packets).length
  f.advance(1500); await delay(110)
  assert.equal(attacks(f.packets).length, count)
  assert.deepEqual(f.lifecycle, [])
})

test('runtime combat rebuilds thick-cover evidence for a drowned before admitting the single clear zombie', async t => {
  const f = fixture(t)
  f.setCover(true)
  f.observe('add_entity', { entity_type: 'minecraft:drowned', runtime_id: 78n, unique_id: 98n, position: { x: 8.5, y: 57, z: 0.5 }, attributes: [{ name: 'minecraft:health', value: 20 }] })
  const first = f.runtime.snapshot().entities.find(actor => actor.runtimeId === '78').terrainOcclusion
  assert.equal(first.suppressed, true)
  assert.equal(f.runtime.operations.combat.previewEngage('77', { allowUnarmed: true }).ready, true)
  const trackerSnapshot = f.entities.snapshot.bind(f.entities)
  t.mock.method(f.entities, 'snapshot', (...args) => trackerSnapshot(...args).map(actor => actor.runtimeId === '78' ? { ...actor, terrainOcclusion: copy(first) } : actor))
  f.advance(2000)
  assert.equal(f.runtime.operations.combat.previewEngage('77', { allowUnarmed: true }).ready, true, 'an expired tracker proof is freshly recomputed from the still-known wall')
  assert.ok(f.runtime.snapshot().entities.find(actor => actor.runtimeId === '78').terrainOcclusion.createdAt > first.createdAt)
  const work = f.runtime.operations.combat.engage('77', { allowUnarmed: true, durationMs: 30000, maxHits: 24 })
  await waitForHits(f.packets, 1)
  f.observe('entity_event', { runtime_entity_id: 77n, event_id: 'hurt_animation' })
  await f.runtime.stopActions('coverage_test_finished')
  assert.equal((await work).code, 'cancelled')
  f.setCover(false); f.advance(2000)
  assert.equal(f.runtime.operations.combat.previewEngage('77', { allowUnarmed: true }).ready, false, 'the copied old proof cannot hide the newly open path')
  assert.equal(f.runtime.snapshot().entities.find(actor => actor.runtimeId === '78').terrainOcclusion.suppressed, false)
  assert.equal(attacks(f.packets).length, 1)
  assert.deepEqual(f.lifecycle, [])
})
