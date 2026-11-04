'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const { createInput } = require('../src/input')
const { createCombat } = require('../src/combat')
const { createMeleeCombat } = require('../src/melee-combat')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')

function fixture (kind = 'legacy', { water = false, nativeFailure = false, fakeInput = false, fakeCounter = false } = {}) {
  const start = performance.now(), packets = []
  const state = { profile: 'bot', realm: { id: '21225335' }, phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 16, connectionId: 'scope', startedAt: 'start', runtimeEntityId: '1', lifecycle: { deathId: 14 }, rawSelectedSlot: 0, selectedSlot: 0, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 1, rotation: { yaw: -90, pitch: 0 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:wooden_sword', count: 1 }] } }
  const raw = { network_id: 300, count: 1, metadata: 0, has_stack_id: true, stack_id: 40, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
  const empty = { ...raw, network_id: 0, count: 0, has_stack_id: false, stack_id: undefined }
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: kind === 'legacy' ? 'minecraft:cow' : 'minecraft:zombie', hostile: kind !== 'legacy', alive: true, positionKnown: true, dimension: 'overworld', position: { x: 1.5, y: 65, z: 0.5 } }
  const actors = [target], blocked = new Map()
  const world = { getBlock: (x, y, z) => blocked.get(`${x},${y},${z}`) ?? { known: true, name: water ? 'minecraft:water' : 'minecraft:air', boundingBox: 'empty', extra: [] } }
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, inventory: [{ slot: 0, name: 'minecraft:wooden_sword', count: 1, stackId: 40 }] }), rawItem: slot => structuredClone(slot === 0 ? raw : empty) }
  let controller, cursor = { tick: '1001', queuedAt: Date.now() }
  const client = { queue: (name, params) => {
    packets.push({ name, params: structuredClone(params), at: performance.now() - start })
    if (name === 'player_auth_input') { cursor = { tick: String(params.tick), queuedAt: Date.now() }; return { tick: params.tick } }
    if (kind === 'legacy' && name === 'inventory_transaction') controller.applyPacket('entity_event', { runtime_entity_id: 70n, event_id: 'hurt_animation' })
  } }
  let running = false
  const input = fakeInput ? { lookAt () {}, start () { running = true }, stop () { running = false }, stats: () => ({ running, sent: fakeCounter && running ? 1 : 0, tick: '1000', target: null, lastError: null }) } : createInput({ client, getState: () => state, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: start, clock: () => performance.now(), getQueuedCursor: () => cursor, ...(nativeFailure ? { frameProvider: () => { throw new Error('actual native frame-provider failure') } } : {}) })
  const entities = { snapshot: () => structuredClone(actors), nearby: () => structuredClone(actors) }
  controller = kind === 'legacy' ? createCombat({ client, getState: () => state, world, entities, crafting, getInput: () => input, now: () => 1000, attackTimeoutMs: 60 }) : createMeleeCombat({ client, getState: () => state, getRawState: () => state, world, entities, crafting, getInput: () => input, equip: async () => ({ serverConfirmed: true }), now: () => performance.now() })
  const run = () => kind === 'legacy' ? controller.hunt('70') : controller.engage('70', { critical: false, maxHits: 1, durationMs: 1200 })
  return { state, target, raw, blocked, input, packets, controller, run, attacks: () => packets.filter(packet => packet.name === 'inventory_transaction') }
}

test('aim handoff uses a real future-cursor input receipt after 55ms before Legacy hunt and water ordinary melee', async t => {
  for (const kind of ['legacy', 'melee']) {
    const f = fixture(kind, { water: kind === 'melee' }), work = f.run(); t.after(() => f.input.stop())
    await delay(55)
    assert.equal(f.input.stats().sent, 0, 'the healthy shared cursor is still one tick ahead at the old fixed timeout')
    assert.equal(f.attacks().length, 0)
    const result = await work, aim = f.packets.find(packet => packet.name === 'player_auth_input'), attack = f.attacks()[0]
    assert.ok(aim && attack); assert.ok(aim.at >= 90 && aim.at < 250, String(aim.at))
    assert.ok(f.packets.indexOf(aim) < f.packets.indexOf(attack)); assert.ok(BigInt(aim.params.tick) > 1001n)
    assert.equal(kind === 'legacy' ? result.collected : result.attempts[0].criticalAttempt, false)
    assert.equal(result.botCausedDamage, null)
    const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
    const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: attack.name, params: attack.params })).data.params
    assert.equal(decoded.transaction.transaction_type, 'item_use_on_entity'); assert.equal(decoded.transaction.transaction_data.action_type, 'attack')
  }
})

test('aim handoff with no actual tick advance terminates even with a frozen injected Legacy clock', async () => {
  for (const kind of ['legacy', 'melee']) {
    const f = fixture(kind, { fakeInput: true, fakeCounter: true }), start = performance.now()
    if (kind === 'legacy') await assert.rejects(f.run(), /tick/)
    else assert.equal((await f.run()).code, 'INPUT_UNCONFIRMED')
    assert.ok(performance.now() - start < 400); assert.equal(f.attacks().length, 0); assert.equal(f.input.stats().running, false)
  }
})

test('aim handoff fails honestly on actual frame-provider failure without dispatching either attack', async () => {
  for (const kind of ['legacy', 'melee']) {
    const f = fixture(kind, { nativeFailure: true })
    if (kind === 'legacy') await assert.rejects(f.run(), /actual native frame-provider failure/)
    else assert.equal((await f.run()).code, 'INPUT_UNCONFIRMED')
    assert.equal(f.attacks().length, 0); assert.equal(f.input.stats().running, false)
  }
})

test('aim handoff rechecks cancellation, scope, UID, reach, sight, real hand and death before any actual attack', async () => {
  for (const kind of ['legacy', 'melee']) for (const mode of ['cancel', 'scope', 'uid', 'reach', 'sight', 'hand', 'death']) {
    const f = fixture(kind), work = f.run()
    await delay(5)
    if (mode === 'cancel') f.controller.cancel('explicit aim cancellation')
    if (mode === 'scope') f.state.connectionId = 'another'
    if (mode === 'uid') f.target.uniqueId = '-999'
    if (mode === 'reach') f.target.position.x = 9
    if (mode === 'sight') f.blocked.set('1,66,0', { known: false })
    if (mode === 'hand') f.raw.stack_id = 999
    if (mode === 'death') f.state.health = 0
    if (kind === 'legacy') await assert.rejects(work)
    else assert.equal((await work).shotsRequested ?? f.attacks().length, 0)
    assert.equal(f.attacks().length, 0, `${kind}/${mode}`); assert.equal(f.input.stats().running, false)
  }
})

test('aim handoff preserves Legacy forage damage interruption and positive-health water melee continuation', async () => {
  for (const kind of ['legacy', 'melee']) {
    const f = fixture(kind, { water: kind === 'melee' }), work = f.run()
    await delay(5); f.state.health = 15
    if (kind === 'legacy') { await assert.rejects(work, /被ダメージ/); assert.equal(f.attacks().length, 0) }
    else { const result = await work; assert.equal(result.hitsRequested, 1); assert.equal(f.attacks().length, 1); assert.equal(result.attempts[0].criticalAttempt, false) }
  }
})
