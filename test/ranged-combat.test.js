'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { buildStationaryInput } = require('../src/input')
const { createRangedCombat, bowBodyAim } = require('../src/ranged-combat')

const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const rawItem = (networkId, count, stackId) => ({ ...air(), network_id: networkId, count, has_stack_id: true, stack_id: stackId })
const enchantments = entries => ({ version: 1, nbt: { type: 'compound', name: '', value: { ench: { type: 'list', value: { type: 'compound', value: entries.map(([id, lvl]) => ({ id: { type: 'short', value: id }, lvl: { type: 'short', value: lvl } })) } } } } })
function fixture ({ arrows = 3, arrowMetadata = 0, bowNbt = null, bowSlot = 0, equipped = true, autoConfirm = true, owner = '101', inventoryDelta = true, onSleep = null, onRelease = null, ...options } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'fixture-A', startedAt: 'fixture-start', runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', health: 20, rawSelectedSlot: 0, rawServerSelectedSlot: 0, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true }, lifecycle: { deathId: 0 } }
  const bag = new Map(Array.from({ length: 36 }, (_, i) => [i, air()]))
  bag.set(bowSlot, rawItem(302, 1, 41)); if (arrows) bag.set(10, { ...rawItem(303, arrows, 42), metadata: arrowMetadata })
  if (bowNbt) bag.get(bowSlot).extra = { ...bag.get(bowSlot).extra, has_nbt: true, nbt: bowNbt }
  const names = new Map([[302, 'minecraft:bow'], [303, 'minecraft:arrow'], [304, 'minecraft:stone']])
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 10.5, y: 65, z: 0.5 } }
  const actors = [target]; const blocks = new Map(); const packets = []; const uses = []; const equipCalls = []; const uncertainties = []
  let time = 1000; let running = false; let sent = 0; let queued = null; let released = 0; let ranged
  const inventory = () => [...bag].filter(([, r]) => r.count).map(([slot, r]) => ({ slot, name: names.get(r.network_id), count: r.count, stackId: r.stack_id }))
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, inventory: inventory() }), rawItem: slot => bag.has(slot) ? structuredClone(bag.get(slot)) : null }
  const input = { stats: () => ({ running, sent, target: null, lastError: null }), lookAt: point => { input.aim = structuredClone(point) }, start: () => { running = true; sent++ }, stop: () => { running = false; queued = null }, sendTransaction: (value, callbacks) => { queued = { value, callbacks }; uses.push({ at: time, value: structuredClone(value) }) } }
  const observe = (name, packet) => {
    if (name === 'add_entity' && packet.entity_type === 'minecraft:arrow') {
      const old = actors.findIndex(e => e.runtimeId === String(packet.runtime_id)); if (old >= 0) actors.splice(old, 1)
      actors.push({ runtimeId: String(packet.runtime_id), uniqueId: String(packet.unique_id), entityType: packet.entity_type, dimension: state.dimension, kind: 'entity', alive: true, positionKnown: true, position: structuredClone(packet.position) })
    }
    if (name === 'remove_entity') { const old = actors.findIndex(e => e.uniqueId === String(packet.entity_id_self)); if (old >= 0) actors.splice(old, 1) }
    ranged.applyPacket(name, packet)
  }
  const confirm = () => {
    const vector = { x: input.aim.x - state.position.x, y: input.aim.y - state.position.y, z: input.aim.z - state.position.z }; const d = Math.hypot(vector.x, vector.y, vector.z)
    observe('add_entity', { runtime_id: BigInt(900 + released), unique_id: BigInt(-900 - released), entity_type: 'minecraft:arrow', position: { ...state.position, y: state.position.y - 0.1 }, velocity: { x: vector.x / d * 3, y: vector.y / d * 3, z: vector.z / d * 3 }, metadata: owner == null ? [] : [{ key: 'owner_eid', type: 'long', value: BigInt(owner) }] })
    if (inventoryDelta) { const r = bag.get(10); bag.set(10, r.count > 1 ? { ...r, count: r.count - 1 } : air()); observe('inventory_slot', { window_id: 'inventory', slot: 10, item: bag.get(10) }) }
  }
  ranged = createRangedCombat({ client: { queue: (name, params) => {
    packets.push({ at: time, name, params: structuredClone(params), sent })
    if (name === 'inventory_transaction') { released++; onRelease?.({ state, target, actors, ranged, packets }); if (autoConfirm) confirm() }
    if (name === 'mob_equipment') { state.rawSelectedSlot = state.rawServerSelectedSlot = params.selected_slot; observe('mob_equipment', params) }
  } }, getState: () => state, world: { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', extra: [] } }, entities: { snapshot: () => structuredClone(actors) }, crafting, equip: async slot => {
    equipCalls.push(slot)
    if (equipped) { const source = bag.get(slot); bag.set(slot, bag.get(0)); bag.set(0, source) }
    return { serverConfirmed: equipped, slot: 0 }
  }, getInput: () => input, getSelfUniqueId: () => '101', onUncertain: event => uncertainties.push(event), now: () => time, sleep: async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    time += ms
    if (running) { if (queued) { const q = queued; queued = null; q.callbacks.onSent() }; sent += Math.max(1, Math.floor(ms / 50)) }
    onSleep?.({ state, target, actors, ranged, time, sent, input, bag, blocks, observe })
    await turn()
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }, ...options })
  return { state, target, actors, bag, blocks, packets, uses, equipCalls, crafting, ranged, observe, input, uncertainties, confirm, now: () => time }
}

test('ranged preview needs a real bow, ordinary arrows, hostile unique target and distance beyond melee', () => {
  assert.equal(fixture().ranged.preview('70').ready, true)
  const missing = fixture(); missing.bag.set(0, air()); assert.equal(missing.ranged.preview('70').code, 'NO_BOW')
  assert.equal(fixture({ arrows: 0 }).ranged.preview('70').code, 'NO_AMMO')
  for (const change of [{ kind: 'player', entityType: 'minecraft:player' }, { hostile: false, entityType: 'minecraft:cow' }, { uniqueId: null }, { dimension: 'nether' }, { positionKnown: false }]) { const f = fixture(); Object.assign(f.target, change); assert.equal(f.ranged.preview('70').ready, false) }
  const near = fixture(); near.target.position.x = 2; assert.equal(near.ranged.preview('70').code, 'RANGE')
  const far = fixture(); far.target.position.x = 40; assert.equal(far.ranged.preview('70').code, 'RANGE')
  assert.equal(fixture().ranged.preview('bad').ready, false)
})

test('known body LOS and friendly/player corridor are checked, including actors behind target', () => {
  const f = fixture(); f.blocks.set('5,66,0', { known: false }); assert.equal(f.ranged.preview('70').code, 'LOS_BLOCKED')
  f.blocks.set('5,66,0', { known: true, name: 'minecraft:water', extra: [] }); assert.equal(f.ranged.preview('70').code, 'LOS_BLOCKED')
  for (const x of [5, 14]) { const p = fixture(); p.actors.push({ ...p.target, runtimeId: '71', uniqueId: '-701', hostile: false, entityType: 'minecraft:cow', position: { x, y: 65, z: 0.5 } }); assert.equal(p.ranged.preview('70').code, 'ACTOR_IN_SHOT_PATH') }
  const player = fixture(); player.actors.push({ ...player.target, runtimeId: '71', uniqueId: '-701', kind: 'player', entityType: 'minecraft:player', hostile: false, position: { x: 0, y: 65, z: 7 } }); assert.equal(player.ranged.preview('70').ready, true)
})

function otherPlayer (f, position, extra = {}) { return { ...f.target, runtimeId: '71', uniqueId: '-701', kind: 'player', entityType: 'minecraft:player', hostile: false, position, ...extra } }

test('known players to the side or behind the shooter may play nearby outside the broad shot corridor', () => {
  for (const position of [{ x: 0.5, y: 65, z: 7 }, { x: -6.5, y: 65, z: 0.5 }, { x: 14.5, y: 65, z: 4.5 }]) {
    const f = fixture(); f.actors.push(otherPlayer(f, position))
    assert.equal(f.ranged.preview('70').ready, true, JSON.stringify(position))
  }
})

test('players near the launch point, on the current line and behind the target remain protected', () => {
  for (const position of [{ x: -0.75, y: 65, z: 0.5 }, { x: 0.5, y: 65, z: 1.75 }, { x: 5, y: 65, z: 0.5 }, { x: 14, y: 65, z: 0.5 }, { x: 19.5, y: 65, z: 0.5 }]) {
    const f = fixture(); f.actors.push(otherPlayer(f, position))
    assert.equal(f.ranged.preview('70').code, 'OTHER_PLAYER', JSON.stringify(position))
  }
})

test('unknown player runtime identity, position or world scope still veto even when the last coordinate is to the side', () => {
  for (const extra of [{ runtimeId: null }, { positionKnown: false }, { position: null }, { dimension: null }, { dimension: 'unknown' }]) {
    const f = fixture(); f.actors.push(otherPlayer(f, { x: 0.5, y: 65, z: 7 }, extra))
    assert.equal(f.ranged.preview('70').code, 'ACTOR_UNKNOWN')
  }
})

test('an off-corridor player present during a fake draw does not block ordinary owned-arrow and ammo proof', async () => {
  const f = fixture(); f.actors.push(otherPlayer(f, { x: 0.5, y: 65, z: 7 }))
  const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.equal(result.shotsConfirmed, 1)
  assert.equal(f.packets.filter(packet => packet.name === 'inventory_transaction').length, 1)
  assert.equal(result.targetDead, false)
  assert.equal(result.serverConfirmed, false)
})

test('a known player moving from the side into the continuing ray cancels a fake draw with confirmed cleanup', async () => {
  let moved = false
  const f = fixture({ onSleep: ({ ranged, actors }) => { if (!moved && ranged.snapshot().phase === 'charging') { moved = true; actors.find(actor => actor.runtimeId === '71').position = { x: 14, y: 65, z: 0.5 } } } })
  f.actors.push(otherPlayer(f, { x: 0.5, y: 65, z: 7 }))
  const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.equal(result.code, 'OTHER_PLAYER')
  assert.equal(f.packets.some(packet => packet.name === 'inventory_transaction'), false)
  assert.equal(f.packets.filter(packet => packet.name === 'mob_equipment').length, 1)
  assert.equal(f.bag.get(10).count, 3)
  assert.equal(f.ranged.snapshot().cleanupUnconfirmed, false)
})

test('Bedrock aim uses eye coordinates, forward-positive Z and clamped pitch', () => {
  const a = bowBodyAim({ x: 0, y: 2, z: 0 }, { entityType: 'minecraft:zombie', position: { x: 10, y: 0, z: 0 } })
  assert.equal(a.yaw, -90); assert.ok(a.pitch > 0 && a.pitch < 90); assert.equal(a.mode, 'body_los')
  assert.equal(bowBodyAim({ x: 0, y: 0, z: 0 }, { position: { x: 0, y: 100, z: 0 } }).pitch, -90)
})

test('server-confirmed equip, actual 20-tick charge, normal release and real ammo+owned-arrow proof', async () => {
  const f = fixture({ bowSlot: 14 })
  const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.deepEqual(f.equipCalls, [14]); assert.equal(f.uses.length, 1)
  const release = f.packets.find(p => p.name === 'inventory_transaction')
  assert.ok(release.at - f.uses[0].at >= 1000); assert.ok(release.sent >= 22)
  assert.equal(release.params.transaction.transaction_type, 'item_release'); assert.equal(release.params.transaction.transaction_data.action_type, 'release'); assert.deepEqual(release.params.transaction.actions, [])
  assert.equal(result.shotsConfirmed, 1); assert.equal(result.attempts[0].confirmedBy, 'own_arrow_spawn_and_server_inventory_delta'); assert.equal(result.targetDead, false); assert.equal(result.serverConfirmed, false); assert.equal(result.botCausedDeath, null)
  assert.equal(f.bag.get(10).count, 2)
})

test('1.26.60 serializer round-trips actual bow-use and release packet shapes', async () => {
  const f = fixture(); await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  const serializer = createSerializer('1.26.60'); const parser = createDeserializer('1.26.60')
  const use = buildStationaryInput({ position: f.state.position, pitch: 0, yaw: -90, tick: 2n }); use.transaction = f.uses[0].value; use.input_data = ['item_interact']
  const decodedUse = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'player_auth_input', params: use })).data.params
  assert.equal(decodedUse.transaction.data.action_type, 'click_air'); assert.equal(decodedUse.transaction.data.held_item.network_id, 302)
  const release = f.packets.find(p => p.name === 'inventory_transaction')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: release.name, params: release.params })).data.params
  assert.equal(decoded.transaction.transaction_data.action_type, 'release'); assert.equal(decoded.transaction.transaction_data.hand, 'main_hand')
})

test('equip without server confirmation never starts use or releases', async () => {
  const f = fixture({ bowSlot: 14, equipped: false }); const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.equal(result.code, 'EQUIP_UNCONFIRMED'); assert.equal(f.uses.length, 0); assert.equal(f.packets.length, 0)
})

test('a foreign/missing owner or inventory delta alone never confirms a fired shot or kill', async () => {
  for (const options of [{ owner: '999' }, { owner: null }, { inventoryDelta: false }]) {
    const f = fixture({ ...options, shotTimeoutMs: 500 }); const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
    assert.equal(result.code, 'SHOT_UNCONFIRMED'); assert.equal(result.shotsConfirmed, 0); assert.equal(result.targetDead, false); assert.equal(result.serverConfirmed, false)
  }
})

test('normal shots repeat only with server proof and stop naturally when real arrows run out', async () => {
  const f = fixture({ arrows: 2 }); const result = await f.ranged.engage('70', { maxShots: 5, durationMs: 10000 })
  assert.equal(result.code, 'NO_AMMO'); assert.equal(result.shotsRequested, 2); assert.equal(result.shotsConfirmed, 2); assert.equal(f.uses.length, 2); assert.equal(f.bag.get(10).count, 0)
  const releases = f.packets.filter(p => p.name === 'inventory_transaction'); assert.ok(releases[1].at - releases[0].at >= 1000)
})

test('only server health-zero/death evidence for the bound UID confirms target death, with no attribution claim', async () => {
  let done = false
  const f = fixture({ onSleep: ({ ranged, observe }) => { if (!done && ranged.snapshot().shotsConfirmed === 1) { done = true; observe('update_attributes', { runtime_entity_id: 70n, attributes: [{ name: 'minecraft:health', current: 0 }] }) } } })
  const result = await f.ranged.engage('70', { maxShots: 3, durationMs: 10000 })
  assert.equal(result.code, 'TARGET_DEAD'); assert.equal(result.serverConfirmed, true); assert.equal(result.targetDead, true); assert.equal(result.botCausedDeath, null)
})

test('runtime-ID reuse and removal cannot turn a foreign death into a confirmed kill', async () => {
  let changed = false
  const f = fixture({ onSleep: ({ target, observe }) => { if (!changed) { changed = true; target.uniqueId = '-999'; observe('entity_event', { runtime_entity_id: 70n, event_id: 'death_animation' }) } } })
  const result = await f.ranged.engage('70', { maxShots: 2, durationMs: 5000 }); assert.equal(result.targetDead, false); assert.equal(f.packets.some(p => p.name === 'inventory_transaction'), false)
  const removed = fixture({ onSleep: ({ observe }) => observe('remove_entity', { entity_id_self: -700n }) }); const r = await removed.ranged.engage('70', { maxShots: 1, durationMs: 5000 }); assert.equal(r.code, 'TARGET_REMOVED'); assert.equal(r.serverConfirmed, false)
})

test('a player or passive entering during charge cancels by real alternate-slot selection and never releases', async () => {
  let entered = false
  const f = fixture({ onSleep: ({ ranged, actors, target }) => { if (!entered && ranged.snapshot().phase === 'charging') { entered = true; actors.push({ ...target, runtimeId: '71', uniqueId: '-701', kind: 'player', entityType: 'minecraft:player', position: { x: 5, y: 65, z: 0.5 } }) } } })
  const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.equal(result.code, 'OTHER_PLAYER'); assert.equal(f.packets.some(p => p.name === 'inventory_transaction'), false); assert.equal(f.packets.filter(p => p.name === 'mob_equipment').length, 1)
  assert.equal(f.bag.get(10).count, 3); assert.equal(f.state.rawSelectedSlot, 1)
})

test('cancel, connection changes and natural death stop charge without another-life release', async () => {
  for (const mode of ['cancel', 'connection', 'death']) {
    let changed = false
    const f = fixture({ onSleep: ({ ranged, state, observe }) => { if (!changed && ranged.snapshot().phase === 'charging') { changed = true; if (mode === 'cancel') ranged.cancel('fixture stop'); else if (mode === 'connection') { state.connectionId = 'fixture-B'; observe('set_entity_data', {}) } else { state.health = 0; state.dead = true; observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 0 }] }) } } } })
    const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
    assert.equal(f.packets.some(p => p.name === 'inventory_transaction'), false); assert.equal(result.targetDead, false); if (mode !== 'cancel') assert.equal(f.packets.length, 0)
  }
})

test('target death during charge cancels the draw without firing an unnecessary arrow', async () => {
  let died = false
  const f = fixture({ onSleep: ({ ranged, observe }) => { if (!died && ranged.snapshot().phase === 'charging') { died = true; observe('entity_event', { runtime_entity_id: 70n, event_id: 'death_animation' }) } } })
  const result = await f.ranged.engage('70', { maxShots: 2, durationMs: 5000 })
  assert.equal(result.targetDead, true); assert.equal(result.shotsRequested, 0); assert.equal(f.packets.some(p => p.name === 'inventory_transaction'), false)
})

test('real Bedrock tipped arrow metadata is usable and requires the same actual owned projectile and consumption proof', async () => {
  for (const metadata of [1, 17, 43]) {
    const f = fixture({ arrowMetadata: metadata })
    assert.equal(f.ranged.preview('70').arrows, 3)
    const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
    assert.equal(result.shotsConfirmed, 1); assert.equal(result.attempts[0].arrowsAfter, 2)
    assert.equal(result.attempts[0].ammoConsumed, 1); assert.equal(result.attempts[0].ammoConsumedConfirmed, true)
    assert.equal(f.bag.get(10).metadata, metadata)
  }
  const invalid = fixture({ arrowMetadata: -1 }); assert.equal(invalid.ranged.preview('70').code, 'NO_AMMO')
})

test('version-resolved Bedrock Infinity plus a real plain arrow confirms firing without fabricating consumption or a kill', async () => {
  const infinity = require('minecraft-data')('bedrock_1.26.60').enchantmentsByName.infinity
  assert.equal(infinity.id, 22); assert.equal(infinity.maxLevel, 1)
  const f = fixture({ arrows: 1, bowNbt: enchantments([[infinity.id, 1]]), inventoryDelta: false })
  assert.equal(f.ranged.preview('70').infinity, true)
  const result = await f.ranged.engage('70', { maxShots: 2, durationMs: 6000 })
  assert.equal(result.shotsRequested, 2); assert.equal(result.shotsConfirmed, 2); assert.equal(f.bag.get(10).count, 1)
  for (const attempt of result.attempts) {
    assert.equal(attempt.confirmedBy, 'own_arrow_spawn_with_confirmed_infinity'); assert.equal(attempt.arrowsAfter, null)
    assert.equal(attempt.ammoConsumed, null); assert.equal(attempt.ammoConsumedConfirmed, false); assert.equal(attempt.hitConfirmed, false)
  }
  assert.equal(result.serverConfirmed, false); assert.equal(result.botCausedDeath, null); assert.equal(f.uncertainties.length, 0)
  const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
  const release = f.packets.find(packet => packet.name === 'inventory_transaction')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: release.name, params: release.params })).data.params
  const parsed = decoded.transaction.transaction_data.held_item.extra.nbt.nbt.value.ench
  assert.equal(parsed.value.value[0].id.value, infinity.id); assert.equal(parsed.value.value[0].lvl.value, 1)
  const tipped = { ...rawItem(303, 3, 44), metadata: 17 }
  const wire = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'inventory_slot', params: { window_id: 'inventory', slot: 10, item: tipped } })).data.params
  assert.equal(wire.item.metadata, 17)
})

test('Infinity still needs actual plain ammo and exact server NBT; tipped-only, malformed, Java-ID and foreign arrows get no no-consumption credit', async () => {
  const bad = [enchantments([[22, 0]]), enchantments([[22, 2]]), enchantments([[22, 1], [22, 1]]), enchantments([[51, 1]]), { type: 'compound', name: '', value: { Enchantments: { type: 'list', value: { type: 'compound', value: [] } } } }]
  for (const bowNbt of bad) {
    const f = fixture({ bowNbt, inventoryDelta: false, shotTimeoutMs: 500 })
    assert.equal(f.ranged.preview('70').infinity, false)
    assert.equal((await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })).shotsConfirmed, 0)
  }
  for (const options of [{ arrowMetadata: 17 }, { owner: '999' }, { owner: null }]) {
    const f = fixture({ ...options, bowNbt: enchantments([[22, 1]]), inventoryDelta: false, shotTimeoutMs: 500 })
    const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
    assert.equal(result.shotsConfirmed, 0); assert.equal(result.code, 'SHOT_UNCONFIRMED')
  }
  assert.equal(fixture({ arrows: 0, bowNbt: enchantments([[22, 1]]) }).ranged.preview('70').code, 'NO_AMMO')
})

test('actual server consumption on an Infinity bow takes priority, including a later receipt after FIRE completion', async () => {
  const consumed = fixture({ bowNbt: enchantments([[22, 1]]) })
  const result = await consumed.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.equal(result.attempts[0].ammoConsumed, 1); assert.equal(result.attempts[0].arrowsAfter, 2)
  const later = fixture({ bowNbt: enchantments([[22, 1]]), inventoryDelta: false })
  const early = await later.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
  assert.equal(early.attempts[0].ammoConsumed, null)
  later.bag.get(10).count = 2
  later.observe('inventory_slot', { window_id: 'inventory', slot: 10, item: later.bag.get(10) })
  const updated = later.ranged.snapshot().lastResult.attempts[0]
  assert.equal(updated.ammoConsumed, 1); assert.equal(updated.ammoConsumedConfirmed, true); assert.equal(updated.arrowsAfter, 2)
  assert.equal(early.attempts[0].ammoConsumed, null, 'a previously returned observation stays honest about what was known then')
})

test('delayed own server owner metadata binds only the cached post-release aligned spawn with the same current UID', async () => {
  for (const mode of ['own', 'foreign', 'reused', 'removed', 'unspawned']) {
    let sentOwner = false
    const f = fixture({ owner: null, shotTimeoutMs: 500, onSleep: ({ ranged, actors, observe }) => {
      if (sentOwner || ranged.snapshot().phase !== 'awaiting_fire') return
      sentOwner = true
      const arrow = actors.find(actor => actor.entityType === 'minecraft:arrow')
      if (mode === 'reused') arrow.uniqueId = '-9999'
      if (mode === 'removed') observe('remove_entity', { entity_id_self: BigInt(arrow.uniqueId) })
      observe('set_entity_data', { runtime_entity_id: mode === 'unspawned' ? 999n : BigInt(arrow.runtimeId), metadata: [{ key: 'arrow_shooter_id', type: 'long', value: mode === 'foreign' ? 999n : 101n }], tick: 20n })
    } })
    const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 5000 })
    assert.equal(result.shotsConfirmed, mode === 'own' ? 1 : 0, mode)
    assert.equal(result.targetDead, false)
  }
})

test('a cancelled draw never switches to an arrow slot: the cancel slot skips ammo and bows', async () => {
  let cancelled = false
  const f = fixture({ onSleep: ({ ranged }) => { if (!cancelled && ranged.snapshot().phase === 'charging') { cancelled = true; ranged.cancel('fixture stop') } } })
  f.bag.set(1, rawItem(303, 5, 50))
  await f.ranged.engage('70', { maxShots: 1, durationMs: 3000 }).catch(() => null)
  const cancels = f.packets.filter(p => p.name === 'mob_equipment' && p.params.selected_slot !== 0)
  assert.equal(cancelled, true); assert.ok(cancels.length >= 1, 'a cancel switch was sent')
  assert.ok(cancels.every(p => p.params.selected_slot !== 1), 'never the arrow slot'); assert.equal(cancels[0].params.selected_slot, 2, 'first empty hotbar slot')
})
test('another hostile mob in the shot corridor does not block the shot; a passive one does', () => {
  const p = fixture(); p.actors.push({ ...p.target, runtimeId: '72', uniqueId: '-702', hostile: true, kind: 'mob', entityType: 'minecraft:zombie', position: { x: 5, y: 65, z: 0.5 } })
  assert.notEqual(p.ranged.preview('70').code, 'ACTOR_IN_SHOT_PATH')
  const q = fixture(); q.actors.push({ ...q.target, runtimeId: '73', uniqueId: '-703', hostile: false, entityType: 'minecraft:cow', position: { x: 5, y: 65, z: 0.5 } })
  assert.equal(q.ranged.preview('70').code, 'ACTOR_IN_SHOT_PATH')
})
test('cadence: the release goes out on the 20th draw tick and the next draw starts before the previous arrow is confirmed', async () => {
  const f = fixture({ arrows: 5 })
  const result = await f.ranged.engage('70', { maxShots: 2, durationMs: 10000 })
  const uses = f.packets.filter(p => p.name === 'inventory_transaction')
  assert.equal(uses.length, 2, JSON.stringify(result))
  assert.equal(result.shotsConfirmed, 2)
})
test('a mid-draw kill swings the drawn bow to another shootable hostile; with none the draw is cancelled without a release', async () => {
  let killed = false
  const second = { runtimeId: '71', uniqueId: '-701', kind: 'mob', entityType: 'minecraft:skeleton', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 12.5, y: 65, z: 2.5 } }
  const f = fixture({ arrows: 5, onSleep: ({ ranged, actors, target }) => {
    const s = ranged.snapshot()
    if (!killed && s.phase === 'charging') { killed = true; actors.push(structuredClone(second)); target.alive = false; ranged.applyPacket('entity_event', { runtime_entity_id: '70', event_id: 'death_animation' }) }
  } })
  const result = await f.ranged.engage('70', { maxShots: 1, durationMs: 10000 })
  const releases = f.packets.filter(p => p.name === 'inventory_transaction')
  assert.equal(releases.length, 1, 'the drawn arrow was released at the new target')
  assert.equal(result.targetRuntimeId, '71')
  let killed2 = false
  const g = fixture({ arrows: 5, onSleep: ({ ranged, target }) => { if (!killed2 && ranged.snapshot().phase === 'charging') { killed2 = true; target.alive = false; ranged.applyPacket('entity_event', { runtime_entity_id: '70', event_id: 'death_animation' }) } } })
  const r2 = await g.ranged.engage('70', { maxShots: 1, durationMs: 10000 })
  assert.equal(g.packets.filter(p => p.name === 'inventory_transaction').length, 0, 'no release without a target')
  assert.equal(r2.targetDead, true)
})
