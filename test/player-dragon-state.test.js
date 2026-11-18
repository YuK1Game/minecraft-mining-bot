'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createDragonState } = require('../src/modes/dragon-state')
const { createDimensionHandoff } = require('../src/host/dimension-handoff')
const { createState } = require('../src/host/state')
const { createSessionCache } = require('../src/host/session-cache')

test('server dimension switch requires matching ACK and destination terrain; reload sees the new dimension and no old container', async () => {
  const { state, applyPacket } = createState('bot')
  applyPacket('start_game', { runtime_entity_id: 42n, dimension: 0, player_position: { x: 2, y: 64, z: 3 } })
  const shared = {}, sent = [], cache = createSessionCache()
  let known = false, resumed = 0
  const handoff = createDimensionHandoff({ state, shared, queue: (name, body) => sent.push([name, body]), terrainKnown: () => known, getLife: () => ({ deathId: 3 }), stopActions: () => {}, ready: () => { resumed++ } })
  cache.observe('start_game', { dimension: 0 })
  cache.observe('container_open', { window_id: 5 })
  const from = state.dimension
  const packet = { dimension: 1, position: { x: 6, y: 66, z: 5 }, respawn: false, loading_screen_id: 0 }
  applyPacket('change_dimension', packet)
  cache.observe('change_dimension', packet)
  handoff.begin(from, packet)
  await Promise.resolve()
  assert.equal(shared.loadingScreenEnded, false)
  assert.equal(sent[0][1].loading_screen_id, 0)
  handoff.observe('player_action', { runtime_entity_id: 7, action: 14 })
  assert.equal(sent.length, 1)
  handoff.observe('player_action', { runtime_entity_id: 42, action: 'dimension_change_ack' })
  assert.equal(sent.length, 2)
  assert.equal(shared.loadingScreenEnded, false)
  known = true
  handoff.observe('subchunk', {})
  assert.deepEqual(sent.map(([name, body]) => [name, body.type ?? body.action]), [['serverbound_loading_screen', 1], ['player_action', 'dimension_change_ack'], ['serverbound_loading_screen', 2]])
  assert.equal(shared.dragonDimensionTransition.from, 'overworld')
  assert.equal(shared.dragonDimensionTransition.respawn, false)
  assert.equal(shared.loadingScreenEnded, true)
  assert.equal(resumed, 1)
  assert.equal(handoff.credits({ runtime_entity_id: 99, status: 0 }), false)
  assert.equal(handoff.credits({ runtime_entity_id: 42, status: 1 }), false)
  assert.equal(handoff.credits({ runtime_entity_id: 42, status: 0 }), true)
  assert.equal(sent.at(-1)[1].status, 1)
  const replay = []
  cache.replay(name => replay.push(name))
  assert.deepEqual(replay, ['start_game', 'change_dimension'])
})

test('death returning from the End persists separately from progress; delayed steps and other Realm/account/world records are isolated', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'player-dragon-state-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const live = { profile: 'bot', realm: { id: 'r1' }, connectionId: 'c1', startedAt: 't1', dimension: 'end', health: 20, position: { x: 1, y: 61, z: 3 } }
  const life = { deathId: 0, dead: false }
  let shared = {}, seed = 11n
  const open = () => createDragonState({ root, shared, getState: () => live, getLife: () => life, getWorldId: () => seed })
  let state = open()
  await state.observe()
  const end = state.record()
  end.stage = 'end'; end.stronghold.portal = { x: 18, y: 15, z: 30 }
  assert.equal(await state.save(end), true)
  const oldFight = state.record()
  oldFight.end.victory = { by: 'old-attack' }
  Object.assign(life, { deathId: 1, dead: false })
  shared.dragonDeathLocation = { connectionId: 'c1', deathId: 1, dimension: 'end', position: { x: 18, y: 63, z: 20 } }
  shared.dragonDimensionTransition = { connectionId: 'c1', deathId: 1, sequence: 12, from: 'end', to: 'overworld', position: { x: 16, y: 15, z: 31 }, respawn: true }
  live.dimension = 'overworld'; live.position = shared.dragonDimensionTransition.position
  await state.observe()
  assert.equal(await state.save(oldFight), false)
  let saved = state.snapshot()
  assert.equal(saved.end.victory, undefined)
  assert.equal(saved.stage, 'end')
  assert.equal(saved.recovery.dimension, 'end')
  assert.equal(saved.recovery.position.x, 18)
  assert.equal(saved.lastTransition.respawn, true)
  shared = {}; live.connectionId = 'c2'; life.deathId = 0
  state = open()
  await state.observe()
  assert.equal(state.record().recovery.dimension, 'end')
  const tick = state.record(), stale = state.record()
  tick.recovery = null
  assert.equal(await state.save(tick), true)
  assert.equal(await state.save(stale), false)
  live.profile = 'other'; assert.equal(state.record().stage, 'early')
  live.profile = 'bot'; live.realm.id = 'other'; assert.equal(state.record().stage, 'early')
  live.realm.id = 'r1'; seed = 12n; assert.equal(state.record().stage, 'early')
  seed = 11n
  saved = state.record()
  assert.equal(saved.stronghold.portal.x, 18)
  assert.equal(saved.recovery, null)
})

test('connection receiver carries live End credits to the Overworld without a death; it discards previous terrain, actors and equipment evidence', async () => {
  const { createHostPacketReceiver, respawnTerrainKnown } = require('../src/host/host')
  const { createWorld } = require('../src/host/world')
  const { createEntities } = require('../src/host/entities')
  const { createLifecycle } = require('../src/host/lifecycle')
  const { createInventoryStore } = require('../src/inventory/inventory-store')
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const codec = createSerializer('1.26.60'), decode = createDeserializer('1.26.60')
  const { state, applyPacket } = createState('bot')
  const shared = {}, sent = [], world = createWorld(), entities = createEntities(), cache = createSessionCache()
  const slots = createInventoryStore({ shared }), life = createLifecycle({ client: { queue: () => assert.fail('living transfer must not request a death respawn') }, getState: () => state })
  const handoff = createDimensionHandoff({
    state, shared, getLife: life.stats, stopActions: () => {}, ready: () => {},
    terrainKnown: p => respawnTerrainKnown(world, p),
    queue: (name, params) => sent.push(decode.parsePacketBuffer(codec.createPacketBuffer({ name, params })).data)
  })
  const { receive } = createHostPacketReceiver({ state, shared, meta: { version: '1.26.60' }, cache, world, entities, applyState: applyPacket, getLifecycle: () => life, getDimensionHandoff: () => handoff, getCurrent: () => ({ applyPacket: (name, packet) => slots.apply(name, packet) }) })
  const position = { x: 4.5, y: 66.62, z: 4.5 }
  const section = dimension => ({ dimension, cache_enabled: false, origin: { x: 0, y: 4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success_all_air' }] })
  receive('start_game', { runtime_entity_id: 42n, entity_id: 22n, dimension: 2, player_position: position, block_network_ids_are_hashes: true })
  receive('set_health', { health: 20 })
  receive('inventory_content', { window_id: 'armor', input: [{ network_id: 1, count: 1 }, ...Array.from({ length: 3 }, () => ({ network_id: 0, count: 0 }))] })
  receive('subchunk', section(2))
  receive('add_entity', { runtime_id: 91n, unique_id: 92n, entity_type: 'minecraft:ender_dragon', position })
  assert.equal(entities.snapshot({ kind: 'all' }).length, 1)
  assert.equal(respawnTerrainKnown(world, position), true)
  receive('show_credits', { runtime_entity_id: 42n, status: 0 })
  receive('change_dimension', { dimension: 0, position, respawn: false, loading_screen_id: 37 })
  await Promise.resolve()
  assert.equal(life.stats().deathId, 0)
  assert.equal(life.stats().dead, false)
  assert.equal(entities.snapshot({ kind: 'all' }).length, 0)
  assert.equal(slots.missing(['armor']).length, 4)
  assert.equal(respawnTerrainKnown(world, position), false)
  receive('subchunk', section(2))
  receive('player_action', { runtime_entity_id: 42n, action: 'dimension_change_ack' })
  assert.equal(shared.loadingScreenEnded, false)
  assert.deepEqual(sent.map(p => p.name), ['show_credits', 'serverbound_loading_screen', 'player_action'])
  receive('subchunk', section(0))
  receive('inventory_content', { window_id: 'armor', input: [{ network_id: 1, count: 1 }, ...Array.from({ length: 3 }, () => ({ network_id: 0, count: 0 }))] })
  assert.equal(slots.missing(['armor']).length, 0)
  assert.equal(shared.loadingScreenEnded, true)
  assert.equal(shared.dragonDimensionTransition.respawn, false)
  assert.equal(sent.at(-1).params.loading_screen_id, 37)
  assert.equal(sent.at(-1).params.type, 2)
})
