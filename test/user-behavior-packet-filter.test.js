'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPortableBed } = require('../src/portable-bed')
const { createUserBehaviors } = require('../src/user-behaviors')

function portableFixture ({ owned = false } = {}) {
  let reads = 0; let cancelled = 0
  const state = { profile: 'packet-filter', playerName: 'Bot', realm: { id: '1' }, dimension: 'overworld', connectionId: 'c1', startedAt: 't1', runtimeEntityId: '41', phase: 'spawned', gameMode: 'survival', health: 20, dead: false, lifecycle: { deathId: 0 }, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, entities: [] }
  const foot = { x: 2, y: 65, z: 0 }; const head = { x: 2, y: 65, z: 1 }
  const block = (position, isHead) => ({ known: true, position, name: 'minecraft:bed', boundingBox: 'block', runtimeId: isHead ? 18903 : 18895, properties: { direction: 0, head_piece_bit: Number(isHead), occupied_bit: 0 }, extra: [] })
  const blocks = new Map([[`${foot.x},${foot.y},${foot.z}`, block(foot, false)], [`${head.x},${head.y},${head.z}`, block(head, true)]])
  let memory = { version: 1, sequence: 0, lifeSerial: 0, record: owned ? { version: 1, source: 'server_bed_placement', verified: true, owner: JSON.stringify(['packet-filter', '1', 'overworld', 'Bot']), connectionId: 'c1', foot: block(foot, false), head: block(head, true), phase: 'placed' } : null, sleep: null, lastSleep: null }
  const actor = createPortableBed({ getState: () => { reads++; return state }, getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', extra: [] }, getClock: () => ({ time: 13000, source: 'server_set_time' }), getMemory: () => memory, setMemory: value => { memory = value }, equip: async () => {}, place: async () => {}, use: async () => {}, wake: async () => {}, mine: async () => {}, cancelActions: () => { cancelled++ } })
  return { actor, state, blocks, foot, head, memory: () => memory, reads: () => reads, cancelled: () => cancelled }
}

test('portable bed ignores chunk, actor movement and unrelated observations without reading state', () => {
  const f = portableFixture()
  const packets = [['level_chunk', {}], ['subchunk', {}], ['move_entity_delta', {}], ['move_entity', {}], ['move_player', {}], ['inventory_content', {}], ['inventory_slot', {}], ['entity_event', { event_id: 'hurt_animation' }], ['animate', { action_id: 'swing_arm' }], ['set_entity_data', { metadata: [{ key: 'flags', value: {} }] }], ['update_attributes', { attributes: [{ name: 'minecraft:movement', current: 0.1 }] }], ['update_block', { position: f.foot }], ['update_subchunk_blocks', {}]]
  for (let i = 0; i < 100; i++) for (const [name, packet] of packets) assert.equal(f.actor.applyPacket(name, packet), false)
  assert.equal(f.reads(), 0)
  assert.equal(f.memory().sleep, null)
})

test('own sleep, wake, authoritative death and connection boundaries remain immediate', () => {
  const f = portableFixture()
  assert.equal(f.actor.applyPacket('set_entity_data', { runtime_entity_id: 41n, metadata: [{ key: 'player_flags', value: 2 }, { key: 'player_bed_position', value: f.foot }] }), true)
  assert.equal(f.memory().sleep.sleeping, true)
  const sequence = f.memory().sequence
  assert.equal(f.actor.applyPacket('set_entity_data', { runtime_entity_id: 99n, metadata: [{ key: 'player_flags', value: 0 }] }), false)
  assert.equal(f.memory().sequence, sequence)
  assert.equal(f.actor.applyPacket('animate', { runtime_entity_id: 41n, action_id: 'wake_up' }), true)
  assert.equal(f.memory().sleep.sleeping, false)
  f.state.health = 0; f.state.dead = true
  assert.equal(f.actor.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 0 }] }), true)
  assert.equal(f.memory().sleep, null)
  const life = f.memory().lifeSerial
  f.state.health = 20; f.state.dead = false
  assert.equal(f.actor.applyPacket('set_health', { health: 20 }), true)
  assert.equal(f.memory().deadObserved, false)
  assert.equal(f.actor.applyPacket('respawn', {}), true)
  assert.equal(f.memory().lifeSerial, life + 1)
  for (const name of ['start_game', 'change_dimension', 'disconnect', 'close']) assert.equal(f.actor.applyPacket(name, {}), true)
})

test('owned bed replacement remains immediate while unrelated block changes do not read state', () => {
  const f = portableFixture({ owned: true })
  assert.equal(f.actor.applyPacket('update_block', { position: { x: 90, y: 65, z: 90 } }), false)
  assert.equal(f.reads(), 0)
  f.blocks.set(`${f.foot.x},${f.foot.y},${f.foot.z}`, { known: true, position: f.foot, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
  assert.equal(f.actor.applyPacket('update_subchunk_blocks', {}), true)
  assert.equal(f.memory().record.invalidated, true)
})

function facadeFixture () {
  let reads = 0; let bedSnapshots = 0; let sleeping = false
  const state = { profile: 'facade', realm: { id: '1' }, dimension: 'overworld', connectionId: 'c1', startedAt: 't1', runtimeEntityId: '41', phase: 'spawned', gameMode: 'survival', health: 20, lifecycle: { deathId: 0 } }
  const forwarded = []; const cancellations = []
  const getState = () => { reads++; return state }
  const controller = label => ({ applyPacket: (name, packet) => { forwarded.push([label, name, packet]) }, snapshot: () => ({ busy: false }), cancel: (reason, code) => cancellations.push([label, code]), drain: async () => {}, tick: () => Promise.resolve() })
  const melee = controller('melee'), ranged = controller('ranged'), combat = controller('combat')
  const bed = { ...controller('bed'), preview: () => ({ ready: false }), snapshot: () => { bedSnapshots++; getState(); return { busy: false, sleeping } }, applyPacket: (name, packet) => { forwarded.push(['bed', name, packet]); if (name === 'set_entity_data' && packet.runtime_entity_id === 41n) { sleeping = true; return true }; if (name === 'set_health' && packet.health === 0 || name === 'animate' && packet.action_id === 'wake_up') { sleeping = false; return true }; return false } }
  const facade = createUserBehaviors({ getState, getRawState: getState, getInput: () => ({}), getClock: () => ({ time: 13000, source: 'server_set_time' }), getBedMemory: () => null, setBedMemory () {}, placeBed: async () => {}, useBed: async () => {}, wakeBed: async () => {}, mineBed: async () => {}, cancelBedActions: () => {}, acquireControl: async () => false, resumeControl: async () => {}, canAct: () => false, isBusy: () => false, inventory: { equipForCombat: async () => {} }, controllers: { melee, ranged, combat, bed } })
  reads = 0; bedSnapshots = 0
  return { facade, state, forwarded, cancellations, reads: () => reads, bedSnapshots: () => bedSnapshots }
}

test('user behavior packet storms do not read state, snapshot beds or forward ignored packets', () => {
  const f = facadeFixture()
  for (let i = 0; i < 1000; i++) for (const name of ['level_chunk', 'subchunk', 'move_entity_delta', 'move_entity', 'move_player', 'network_chunk_publisher_update']) f.facade.applyPacket(name, {})
  assert.equal(f.reads(), 0)
  assert.equal(f.bedSnapshots(), 0)
  assert.equal(f.forwarded.length, 0)
})

test('combat inventory, equipment and arrow observations still forward without resnapshotting a bed', () => {
  const f = facadeFixture()
  for (const name of ['inventory_content', 'inventory_slot', 'mob_equipment', 'player_hotbar', 'add_entity', 'remove_entity']) f.facade.applyPacket(name, {})
  assert.equal(f.forwarded.length, 12)
  assert.equal(f.forwarded.filter(([label]) => label === 'bed').length, 0)
  assert.equal(f.reads(), 0)
  assert.equal(f.bedSnapshots(), 0)
})

test('changed bed receipts refresh the facade immediately and health-zero still cancels protection', () => {
  const f = facadeFixture()
  f.facade.applyPacket('set_entity_data', { runtime_entity_id: 41n, metadata: [{ key: 'player_flags', value: 2 }] })
  assert.equal(f.facade.snapshot().sleeping, true)
  assert.equal(f.bedSnapshots(), 1)
  assert.ok(f.cancellations.some(([label, code]) => label === 'combat' && code === 'SERVER_SLEEPING'))
  f.facade.applyPacket('animate', { runtime_entity_id: 41n, action_id: 'wake_up' })
  assert.equal(f.facade.snapshot().sleeping, false)
  f.state.health = 0
  f.facade.applyPacket('set_health', { health: 0 })
  assert.ok(f.cancellations.some(([label, code]) => label === 'combat' && code === 'SESSION_CHANGED'))
})
