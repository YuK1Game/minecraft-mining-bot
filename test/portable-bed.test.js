'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPortableBed, bedVisibleFace, BED_HEIGHT } = require('../src/portable-bed')

function fixture (options = {}) {
  let time = 1000, memory = null, actor, unsafe = false
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, profile: 'bed-fixture', playerName: 'OwnedPlayer', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'life', runtimeEntityId: '41', lifecycle: { deathId: 0 }, position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, rawSelectedSlot: 0, equipmentServerConfirmed: true, heldItem: { name: 'minecraft:bed', count: 1, metadata: 14 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:bed', count: 1, metadata: 14, networkId: 421 }] }, entities: [], predicted: { physicsState: { onGround: true, isInWater: false, velocity: { x: 0, y: -0.0784, z: 0 } } } }
  const clock = { time: 13000, source: 'server_sync_world_clocks' }, blocks = new Map(), calls = []
  const key = p => `${p.x},${p.y},${p.z}`
  const getBlock = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', runtimeId: y < 65 ? 2 : 0, extra: [] }
  const put = (position, name, props = {}, runtimeId = 0) => blocks.set(key(position), { known: true, position: { ...position }, name, properties: props, runtimeId, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [] })
  const props = (head, occupied = false) => ({ direction: 0, head_piece_bit: Number(head), occupied_bit: Number(occupied) })
  const sleeping = value => {
    const record = memory?.record
    if (record) { put(record.foot.position, 'minecraft:bed', props(false, value), value ? 18899 : 18895); put(record.head.position, 'minecraft:bed', props(true, value), value ? 18907 : 18903) }
    actor.applyPacket('set_entity_data', { runtime_entity_id: 41n, metadata: [{ key: 'player_flags', value: value ? 2 : 0 }, ...(record ? [{ key: 'player_bed_position', value: record.head.position }] : [])], tick: BigInt(time) })
  }
  const callbacks = {
    getState: () => state, getBlock, getClock: () => clock, getMemory: () => memory, setMemory: value => { memory = structuredClone(value) }, now: () => time, delay: async ms => { time += ms }, canAct: () => !unsafe, timeoutMs: 500,
    equip: async slot => { calls.push('equip'); state.rawSelectedSlot = slot; return { slot, serverConfirmed: true } },
    place: async ({ position }) => { calls.push('place'); put(position, 'minecraft:bed', props(false), 18895); put({ ...position, z: position.z + 1 }, 'minecraft:bed', props(true), 18903); state.inventory.items = []; state.heldItem = null; return { phase: 'completed', confirmedBy: 'server_block_and_inventory' } },
    use: async () => { calls.push('use'); sleeping(true); return { phase: 'requested', serverConfirmed: false } },
    wake: async () => { calls.push('wake'); sleeping(false); actor.applyPacket('animate', { runtime_entity_id: 41n, action_id: 'wake_up' }); return { phase: 'requested' } },
    mine: async target => { calls.push('mine'); assert.equal(actor.ownsTarget(state, target, getBlock(target.x, target.y, target.z)), true); put(memory.record.foot.position, 'minecraft:air'); put(memory.record.head.position, 'minecraft:air'); state.inventory.items = [{ slot: 0, name: 'minecraft:bed', count: 1, metadata: 14, networkId: 421 }]; state.heldItem = { ...state.inventory.items[0] }; return { phase: 'completed', serverConfirmed: true } },
    cancelActions: () => { calls.push('cancel') }, ...options
  }
  actor = createPortableBed(callbacks)
  sleeping(false)
  return { state, clock, blocks, getBlock, put, calls, callbacks, sleeping, get actor () { return actor }, memory: () => memory, setUnsafe: value => { unsafe = value }, replace: () => { actor = createPortableBed(callbacks); return actor }, advance: ms => { time += ms } }
}

test('pinned Bedrock bed representation and real half-height reach agree with local 1.26.60 data', () => {
  const path = '../node_modules/minecraft-data/minecraft-data/data/bedrock/1.26.60/'
  const items = require(path + 'items.json'), blocks = require(path + 'blocks.json'), protocol = require(path + 'protocol.json')
  assert.equal(items.find(item => item.name === 'bed').id, 421)
  assert.equal(blocks.find(block => block.name === 'bed').hardness, 0.2)
  assert.equal(BED_HEIGHT, 0.5625)
  const collision = require(path + 'blockCollisionShapes.json')
  assert.equal(collision.shapes[collision.blocks.bed[0]][0][4], BED_HEIGHT)
  assert.equal(protocol.types.MetadataFlags2[1].flags.indexOf('sleeping'), 11)
  const f = fixture(), target = { x: 2, y: 65, z: 0 }
  f.put(target, 'minecraft:bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 }, 18895)
  const visible = bedVisibleFace({ eye: f.state.position, target, world: { getBlock: f.getBlock } })
  assert.ok(visible)
  assert.ok(visible.hit.y <= target.y + 0.5625)
  assert.ok(visible.distance <= 4.5)
})

test('a matching resent bed selection permits placement but still needs actual halves and consumption', async () => {
  for (const corrupt of [false, true]) {
    const f = fixture({ equip: async slot => ({ phase: 'completed', sourceSlot: slot, slot, selectionSent: true, serverConfirmed: false, selectedItem: { ...f.state.inventory.items[0], stackId: 82 + Number(corrupt) } }) })
    f.state.inventory.items[0].stackId = 82
    const result = await f.actor.execute()
    assert.equal(f.calls.includes('place'), !corrupt)
    if (!corrupt) assert.equal(result.lastResult.confirmedBy, 'two_server_bed_halves_and_inventory')
    else assert.equal(result.ownedBed, null)
  }
})

test('night places both server halves, confirms only own sleep metadata, waits for real day, wakes then mines and collects its own bed', async () => {
  const f = fixture()
  assert.equal(f.actor.preview().action, 'place')
  let result = await f.actor.execute()
  assert.equal(result.lastResult.confirmedBy, 'two_server_bed_halves_and_inventory')
  assert.equal(result.ownedBed.item.metadata, 14)
  assert.equal(f.actor.preview().action, 'sleep')
  result = await f.actor.execute()
  assert.equal(result.sleeping, true)
  assert.equal(result.lastResult.confirmedBy, 'own_server_sleep_metadata')
  assert.equal(result.lastResult.dayAdvanced, false)
  assert.equal(f.clock.time, 13000, 'other players may remain awake; local sleep cannot manufacture morning')
  assert.equal(f.actor.preview().code, 'SERVER_NIGHT_CONTINUES')
  assert.equal(f.calls.includes('mine'), false)
  f.clock.time = 25000
  assert.equal(f.actor.preview().action, 'wake')
  result = await f.actor.execute()
  assert.equal(result.sleeping, false)
  assert.equal(f.actor.preview().action, 'retrieve')
  result = await f.actor.execute()
  assert.equal(result.collected, true)
  assert.equal(result.lastResult.confirmedBy, 'owned_bed_air_and_server_inventory')
  assert.equal(result.ownedBed, null)
  assert.equal(f.state.inventory.items[0].name, 'minecraft:bed')
  assert.equal(f.state.inventory.items[0].metadata, 14)
  assert.deepEqual(f.calls, ['equip', 'place', 'use', 'wake', 'mine'])
})

test('server refusal or another player metadata never counts as sleep; requests remain bounded and online', async () => {
  const f = fixture({ use: async () => { f.actor.applyPacket('set_entity_data', { runtime_entity_id: 99n, metadata: [{ key: 'player_flags', value: 2 }, { key: 'player_bed_position', value: f.memory().record.head.position }] }); return { phase: 'requested' } } })
  await f.actor.execute()
  const result = await f.actor.execute()
  assert.equal(result.sleeping, false)
  assert.equal(result.serverConfirmed, false)
  assert.match(result.lastError, /timed out/)
  assert.equal(f.state.phase, 'spawned')
  assert.equal(f.memory().record.verified, true, 'a rejected sleep does not discard confirmed ownership')
})

test('unknown terrain, nearby enemies, foreign bed memory and absent items reject without mutating any bed', async () => {
  const unknown = fixture({ getBlock: () => ({ known: false }) })
  assert.equal(unknown.actor.preview().code, 'NO_KNOWN_BED_SPACE')
  assert.deepEqual(unknown.calls, [])
  const enemy = fixture(); enemy.state.entities.push({ runtimeId: '8', uniqueId: 'enemy', kind: 'mob', entityType: 'minecraft:zombie', alive: true, positionKnown: true, dimension: 'overworld', position: { x: 1, y: 65, z: 0 } })
  assert.equal(enemy.actor.preview().code, 'NEARBY_THREAT_OR_OWNED_ACTION')
  const absent = fixture(); absent.state.inventory.items = []; absent.state.heldItem = null
  assert.equal(absent.actor.preview().code, 'BED_ITEM_REQUIRED')
  absent.clock.time = 1000
  assert.equal(absent.actor.preview().code, 'NO_CONFIRMED_OWN_BED')
  const foreign = fixture(); await foreign.actor.execute(); foreign.state.playerName = 'AnotherPlayer'
  assert.equal(foreign.actor.preview().code, 'FOREIGN_BED_MEMORY')
  assert.equal(foreign.calls.includes('mine'), false)
})

test('confirmed ownership persists through hot reload and death, but stale life equipment and foreign replacements cannot authorize destruction', async () => {
  const f = fixture(); await f.actor.execute()
  const record = structuredClone(f.memory().record)
  f.replace(); assert.deepEqual(f.actor.snapshot().ownedBed, record)
  assert.equal(f.actor.preview().action, 'sleep')
  f.state.health = 0; f.state.lifecycle.deathId++; f.actor.applyPacket('entity_event', { runtime_entity_id: 41n, event_id: 'death_animation' })
  f.state.health = 20; f.replace(); f.sleeping(false)
  assert.deepEqual(f.actor.snapshot().ownedBed, record)
  f.clock.time = 25000
  assert.equal(f.actor.preview().action, 'retrieve')
  f.put(record.foot.position, 'minecraft:air'); f.actor.applyPacket('update_block', { position: record.foot.position })
  f.put(record.foot.position, 'minecraft:bed', record.foot.properties, record.foot.runtimeId)
  assert.equal(f.actor.preview().code, 'NO_CONFIRMED_OWN_BED', 'a received removal invalidates ownership even if an identical foreign bed appears later')
  assert.equal(f.calls.includes('mine'), false)
  const stale = fixture({ equip: async slot => { stale.state.lifecycle.deathId++; return { slot, serverConfirmed: true } } })
  const result = await stale.actor.execute()
  assert.match(result.lastError, /life/)
  assert.equal(stale.calls.includes('place'), false)
})

test('changed half fingerprints, occupied beds, non-server clock and Nether cannot be retrieved or used', async () => {
  const f = fixture(); await f.actor.execute(); f.clock.time = 25000
  const record = f.memory().record
  f.put(record.head.position, 'minecraft:bed', { ...record.head.properties, direction: 1 }, record.head.runtimeId)
  assert.equal(f.actor.preview().code, 'OWNED_BED_CHANGED_OR_UNKNOWN')
  f.put(record.head.position, 'minecraft:bed', { ...record.head.properties, occupied_bit: 1 }, record.head.runtimeId + 4)
  assert.equal(f.actor.preview().code, 'AWAKE_UNOCCUPIED_RECEIPT_REQUIRED')
  f.clock.source = 'client_prediction'; assert.equal(f.actor.preview().code, 'SERVER_CLOCK_REQUIRED')
  f.state.dimension = 'nether'; assert.equal(f.actor.preview().code, 'LIVING_CONFIRMED_STATE_REQUIRED')
  assert.equal(f.calls.includes('mine'), false)
})

test('partial placement, reused life and cancellation cannot create ownership or interrupt an unrelated actor', async () => {
  const partial = fixture({ place: async ({ position }) => { partial.put(position, 'minecraft:bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 }, 18895); partial.state.inventory.items = []; partial.state.heldItem = null; return { phase: 'completed', confirmedBy: 'server_block_and_inventory' } } })
  const placed = await partial.actor.execute()
  assert.equal(placed.ownedBed, null)
  assert.equal(placed.serverConfirmed, false)
  const f = fixture({ equip: async () => new Promise(() => {}) })
  f.actor.cancel('No owned operation')
  assert.equal(f.calls.includes('cancel'), false)
  const pending = f.actor.execute()
  await Promise.resolve()
  f.actor.cancel('Higher priority combat')
  await pending; await f.actor.drain()
  assert.equal(f.actor.snapshot().busy, false)
  assert.equal(f.calls.filter(call => call === 'cancel').length, 1)
  assert.equal(f.calls.includes('place'), false)
})

test('own authoritative health-zero clears cached sleeping through death even without an entity event or API lifecycle wrapper', async () => {
  const f = fixture(); await f.actor.execute(); await f.actor.execute()
  assert.equal(f.actor.snapshot().sleeping, true)
  const record = structuredClone(f.memory().record)
  delete f.state.lifecycle
  f.state.health = 0; f.state.dead = true
  f.actor.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 0 }] })
  assert.equal(f.actor.snapshot().sleeping, false)
  assert.equal(f.memory().sleep, null)
  assert.deepEqual(f.memory().record, record)
  f.state.health = 20; f.state.dead = false
  f.actor.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 20 }] })
  assert.equal(f.actor.snapshot().sleeping, false, 'health recovery is not a fabricated sleep/wake receipt')
  assert.deepEqual(f.actor.snapshot().ownedBed, record)
})

test('own sleep in an untracked bed remains visible but never schedules portable-bed destruction or null-record wake', () => {
  const f = fixture(); f.clock.time = 25000
  f.actor.applyPacket('set_entity_data', { runtime_entity_id: 41n, metadata: [{ key: 'player_flags', value: 2 }, { key: 'player_bed_position', value: { x: 10, y: 65, z: 10 } }] })
  assert.equal(f.actor.snapshot().sleeping, true)
  assert.equal(f.actor.preview().ready, false)
  assert.equal(f.actor.preview().code, 'SLEEP_HAS_NO_OWNED_BED_RECORD')
  assert.deepEqual(f.calls, [])
})

test('the explicitly owned bed routine remains available at HP1 through placement, sleep, normal wake and morning retrieval', async () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.actor.preview().action, 'place')
  await f.actor.execute(); await f.actor.execute()
  assert.equal(f.actor.snapshot().sleeping, true)
  f.clock.time = 25000
  await f.actor.execute(); const result = await f.actor.execute()
  assert.equal(result.collected, true)
  assert.equal(f.state.health, 1, 'the controller never invents healing or death')
})
