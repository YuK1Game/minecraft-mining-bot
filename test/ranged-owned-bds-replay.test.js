'use strict'

// Historical owned offline BDS receipts only. No socket, Realm, fresh gameplay
// proof or goal credit is produced by these deterministic controller replays.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createRangedCombat } = require('../src/ranged-combat')
const { createCrafting } = require('../src/crafting')
const { createEntities } = require('../src/entities')
const { createState } = require('../src/state')
const { createWorld } = require('../src/world')
const captured = require('./fixtures/bds-owned-bow-1.26.60.json')

function revive (value) {
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data)
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]))
  return value
}
function historicalReplay ({ metadata = null, omitAmmo = false, omitArrow = false, arrowBeforeRelease = false, late = false, replaceScope = false, replaceTargetDuringDraw = false } = {}) {
  const fixture = revive(structuredClone(captured))
  const packets = [], delivered = [], equipCalls = [], uncertainties = []
  const observation = createState(fixture.sourceUsername, () => '2026-11-01T10:11:09.788Z')
  const entities = createEntities(), world = createWorld({ version: fixture.version })
  let selected = null, time = 1000, running = false, sent = 0, queued = null, releaseAt = null, ranged, targetReplaced = false
  let connectionId = 'historical-test-replay:' + fixture.sourceConnectionId
  const pending = []
  const getState = () => ({ ...observation.snapshot(), phase: 'spawned', profile: fixture.sourceUsername, realm: { id: 'owned-historical-test' }, connectionId, dimension: 'overworld', rawSelectedSlot: selected, rawServerSelectedSlot: selected, equipmentServerConfirmed: Number.isInteger(selected), inventory: { known: crafting.snapshot().inventoryKnown }, lifecycle: { deathId: 0 } })
  const crafting = createCrafting({ client: { queue: () => { throw Error('Historical replay never submits crafting requests') } }, getState, allocateRequestId: () => -1 })
  function receive (receipt, variation = 'unmodified historical server receipt') {
    const { name, packet } = receipt
    observation.applyPacket(name, packet); crafting.applyPacket(name, packet); entities.applyPacket(name, packet); world.applyPacket(name, packet)
    if (name === 'player_hotbar' && packet.window_id === 'inventory') selected = packet.selected_slot
    delivered.push({ name, at: time, historicalAt: receipt.at, classification: variation })
    ranged?.applyPacket(name, packet)
  }
  for (const receipt of fixture.initialReceipts) receive(receipt)
  const input = {
    stats: () => ({ running, sent, target: null, lastError: null }),
    lookAt: point => { input.aim = structuredClone(point) },
    start: () => { running = true; sent++ },
    stop: () => { running = false; queued = null },
    sendTransaction: (value, callbacks) => { queued = { value, callbacks }; packets.push({ name: 'test_input_use', at: time, value: structuredClone(value) }) }
  }
  const released = () => {
    releaseAt = time
    if (replaceScope) connectionId += ':test-replaced-scope'
    for (const receipt of fixture.releasedReceipts) {
      if (receipt.name === 'inventory_content' && omitAmmo || ['add_entity', 'set_entity_data'].includes(receipt.name) && (omitArrow || arrowBeforeRelease)) continue
      if (['add_entity', 'set_entity_data'].includes(receipt.name) && metadata) receipt.packet.metadata = metadata(structuredClone(receipt.packet.metadata), fixture)
      pending.push({ due: time + (late ? 600 : receipt.at - fixture.inputRelease.at), receipt, variation: metadata && ['add_entity', 'set_entity_data'].includes(receipt.name) ? 'negative/representation test variation of historical arrow metadata' : undefined })
    }
  }
  ranged = createRangedCombat({ client: { queue: (name, packet) => {
    packets.push({ name, at: time, packet: structuredClone(packet) })
    if (name === 'inventory_transaction') released()
    if (name === 'mob_equipment') { selected = packet.selected_slot; ranged.applyPacket(name, packet) }
  } }, getState, world, entities, crafting, getInput: () => input, getSelfUniqueId: () => fixture.selfUniqueId,
  equip: async slot => { equipCalls.push(slot); return { serverConfirmed: slot === selected, slot } },
  onUncertain: event => uncertainties.push(event), shotTimeoutMs: 500, now: () => time,
  sleep: async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('test aborted'), { name: 'AbortError' })
    time += ms
    if (running) { if (queued) { const current = queued; queued = null; current.callbacks.onSent() }; sent += Math.max(1, Math.floor(ms / 50)) }
    if (replaceTargetDuringDraw && !targetReplaced && ranged.snapshot().phase === 'charging') {
      targetReplaced = true
      const replacement = structuredClone(fixture.initialReceipts.find(r => r.name === 'add_entity' && String(r.packet.runtime_id) === fixture.target.runtimeId))
      replacement.packet.unique_id = '-999999999'
      receive(replacement, 'negative test variation: target runtime reused by a different UID')
    }
    for (const entry of pending.filter(entry => entry.due <= time)) { pending.splice(pending.indexOf(entry), 1); receive(entry.receipt, entry.variation) }
    await turn()
    if (signal?.aborted) throw Object.assign(new Error('test aborted'), { name: 'AbortError' })
  } })
  if (arrowBeforeRelease) for (const receipt of fixture.releasedReceipts.filter(r => ['add_entity', 'set_entity_data'].includes(r.name))) receive(receipt, 'negative test: historical arrow replayed before current release')
  return { fixture, ranged, crafting, world, getState, packets, delivered, equipCalls, uncertainties, input, pending, run: () => ranged.engage(fixture.target.runtimeId, { maxShots: 1, durationMs: 5000 }), afterResult: () => { for (const entry of pending.splice(0)) receive(entry.receipt, 'negative test: late historical receipt after result') }, releaseAt: () => releaseAt }
}

test('historical owned BDS receipts confirm the actual owner_eid despite default arrow_shooter_id zero, with actual 3-to-2 ammo delta', async () => {
  const f = historicalReplay()
  assert.equal(f.fixture.kind, 'historical_owned_offline_bds_test_fixture')
  assert.equal(f.fixture.productionHistoricalResult.code, 'SHOT_UNCONFIRMED')
  assert.equal(f.world.stats().decodeErrors, 0)
  assert.equal(f.world.getBlock(0, 99, 0).name, 'minecraft:stone')
  assert.equal(f.world.getBlock(5, 101, 0).name, 'minecraft:air')
  assert.equal(f.ranged.preview(f.fixture.target.runtimeId).arrows, 3)
  const result = await f.run()
  assert.equal(result.shotsConfirmed, 1)
  assert.equal(result.code, 'SHOT_LIMIT')
  assert.deepEqual(f.equipCalls, [0])
  assert.equal(result.attempts[0].arrowRuntimeId, '19')
  assert.equal(result.attempts[0].confirmedBy, 'own_arrow_spawn_and_server_inventory_delta')
  assert.equal(result.attempts[0].arrowsBefore, 3)
  assert.equal(result.attempts[0].arrowsAfter, 2)
  assert.equal(result.attempts[0].ammoConsumedConfirmed, true)
  // The real BDS arrow carried the actor critical flag: the 20-tick draw was a full-power shot.
  assert.equal(result.attempts[0].fullChargeConfirmed, true)
  assert.ok(result.attempts[0].arrowSpeed > 2.9 && result.attempts[0].arrowSpeed < 3.2)
  assert.equal(result.attempts[0].aimMode, 'ballistic_lead')
  const use = f.packets.find(p => p.name === 'test_input_use'), release = f.packets.find(p => p.name === 'inventory_transaction')
  assert.ok(release.at - use.at >= 1000)
  const historicalRelease = structuredClone(f.fixture.inputRelease.packet)
  // The live proof used calibrated input prediction; replay retains the actual
  // last server float pose, which differs by about ten micrometers vertically.
  assert.ok(Math.abs(release.packet.transaction.transaction_data.head_pos.y - historicalRelease.transaction.transaction_data.head_pos.y) < 0.0001)
  historicalRelease.transaction.transaction_data.head_pos = f.getState().position
  assert.deepEqual(release.packet, historicalRelease)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.targetDead, false)
  assert.equal(result.botCausedDamage, null)
  assert.equal(result.botCausedDeath, null)
})

test('zero sentinel numeric representations keep a matching authoritative owner and never supply ownership by themselves', async () => {
  for (const zero of [0, 0n, '0']) {
    const matched = historicalReplay({ metadata: list => list.map(e => e.key === 'arrow_shooter_id' ? { ...e, value: zero } : e) })
    assert.equal((await matched.run()).shotsConfirmed, 1)
    const zeroOnly = historicalReplay({ metadata: list => list.filter(e => e.key !== 'owner_eid').map(e => e.key === 'arrow_shooter_id' ? { ...e, value: zero } : e) })
    assert.equal((await zeroOnly.run()).shotsConfirmed, 0)
  }
})

test('conflicting nonzero owners, missing ownership and malformed ownership cannot confirm from historical ammo alone', async () => {
  const variants = [
    list => list.map(e => e.key === 'arrow_shooter_id' ? { ...e, value: '999' } : e),
    list => list.map(e => e.key === 'owner_eid' ? { ...e, value: '999' } : e),
    list => list.filter(e => !['owner_eid', 'arrow_shooter_id'].includes(e.key)),
    () => [],
    () => null,
    () => [{ key: 'owner_eid', type: 'long', value: 'not-an-integer' }],
    () => [{ key: 'owner_eid', type: 'long', value: '9223372036854775808' }],
    () => [{ key: 'owner_eid', type: 'string', value: captured.selfUniqueId }],
    () => [{ key: 'owner_eid', type: 'long', value: '-1' }]
  ]
  for (const metadata of variants) {
    const f = historicalReplay({ metadata }), result = await f.run()
    assert.equal(result.shotsConfirmed, 0)
    assert.equal(result.code, 'SHOT_UNCONFIRMED')
    assert.equal(f.crafting.snapshot().inventory.find(i => i.name === 'minecraft:arrow').count, 2)
    assert.equal(result.serverConfirmed, false)
  }
})

test('historical arrow and ammo receipts are both required in the current release window', async () => {
  for (const options of [{ omitAmmo: true }, { omitArrow: true }, { arrowBeforeRelease: true }, { late: true }]) {
    const f = historicalReplay(options), result = await f.run()
    assert.equal(result.shotsConfirmed, 0, JSON.stringify(options))
    assert.equal(result.code, 'SHOT_UNCONFIRMED')
    f.afterResult()
    assert.equal(f.ranged.snapshot().lastResult.shotsConfirmed, 0)
    assert.equal(f.ranged.snapshot().lastResult.serverConfirmed, false)
  }
})

test('malformed metadata containers and entries cannot turn historical consumption into shot proof', async () => {
  for (const metadata of [() => ({}), () => [null], () => [{ key: 'owner_eid', type: 'long', value: null }]]) {
    const f = historicalReplay({ metadata }), result = await f.run()
    assert.equal(result.shotsConfirmed, 0)
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.targetDead, false)
  }
})

test('scope replacement and target UID reuse preserve historical replay cancellation and cannot promote a shot', async () => {
  const changedScope = historicalReplay({ replaceScope: true }), scopeResult = await changedScope.run()
  assert.equal(scopeResult.code, 'SESSION_CHANGED')
  assert.equal(scopeResult.shotsConfirmed, 0)
  const reused = historicalReplay({ replaceTargetDuringDraw: true }), reusedResult = await reused.run()
  assert.equal(reusedResult.code, 'TARGET_CHANGED')
  assert.equal(reusedResult.shotsRequested, 0)
  assert.equal(reused.packets.some(p => p.name === 'inventory_transaction'), false)
  assert.equal(reusedResult.targetDead, false)
})
