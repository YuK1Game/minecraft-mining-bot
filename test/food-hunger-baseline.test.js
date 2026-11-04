'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { createFood } = require('../src/food')

const at = '2026-11-01T04:21:47.000Z'
const time = Date.parse(at)
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const item = count => ({ ...air(), network_id: 300, count, has_stack_id: true, stack_id: 81 })
function fixture () {
  const state = { profile: 'bot', realm: { id: '21225335' }, connectionId: '85a7e65e-8372-4363-830f-d55a60bdafe0', startedAt: '2026-10-31T23:43:20.653Z', dimension: 'overworld', runtimeEntityId: '273', lifecycle: { deathId: 148, dead: false }, phase: 'spawned', gameMode: 'survival', health: 4, spawnPending: false, threatPolicy: 'online_learning', position: { x: -36.5, y: 67.62, z: 52.5 }, rawSelectedSlot: 0, inventory: { known: true, items: [] } }
  const bag = Array.from({ length: 36 }, air); bag[0] = item(1)
  const wire = [], commits = [], uncertainties = []
  let busy = false, sent = 0, running = false
  const crafting = { rawItem: slot => structuredClone(bag[slot]), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [{ slot: 0, name: 'minecraft:chicken', count: bag[0].count, stackId: bag[0].stack_id }] }) }
  const input = { stats: () => ({ sent, running, target: null }), start: () => { running = true; sent++ }, stop: () => { running = false }, sendTransaction: (packet, options) => { wire.push(packet); options.onSent(); sent++ } }
  const food = createFood({ client: { queue: (...args) => wire.push(args) }, getState: () => state, crafting, getInput: () => input, allocateLegacyId: () => -202, isBusy: () => busy, onInventory: p => commits.push(p), onUncertain: p => uncertainties.push(p), now: () => time })
  const scope = { profile: state.profile, realmId: state.realm.id, connectionId: state.connectionId, startedAt: state.startedAt, dimension: state.dimension, runtimeEntityId: state.runtimeEntityId, deathId: 148 }
  const respawn = { deathId: 148, connectionId: state.connectionId, phase: 'confirmed', serverConfirmed: true, at: '2026-11-01T04:04:15.000Z' }
  const observation = { value: 17, source: 'server_attribute', observedAt: '2026-11-01T04:15:10.000Z', scope, respawn }
  return { state, bag, wire, commits, uncertainties, food, observation, setBusy: value => { busy = value } }
}

test('actual Host-life hunger17 baseline restores after start_game replay and admits chicken without packet or consumption credit', () => {
  const f = fixture()
  f.food.applyPacket('start_game', {})
  assert.equal(f.food.preview().code, 'HUNGER_UNKNOWN')
  assert.equal(f.food.restoreHunger(f.observation).restored, true)
  assert.equal(f.food.preview().ready, true)
  assert.equal(f.food.snapshot().hunger, 17)
  assert.equal(f.food.snapshot().lastResult, null)
  assert.deepEqual(f.wire, []); assert.deepEqual(f.commits, []); assert.deepEqual(f.uncertainties, [])
})

test('baseline restores all valid received values0..20 but never overwrites already received hunger', () => {
  for (const value of [0, 17, 20]) {
    const f = fixture(); assert.equal(f.food.restoreHunger({ ...f.observation, value }).restored, true)
    assert.equal(f.food.snapshot().hunger, value)
    assert.equal(f.food.restoreHunger({ ...f.observation, value: 9 }).reason, 'already_known')
    assert.equal(f.food.snapshot().hunger, value)
  }
  const f = fixture(); f.food.applyPacket('update_attributes', { runtime_entity_id: 273n, attributes: [{ name: 'minecraft:player.hunger', current: 16 }] })
  assert.equal(f.food.restoreHunger(f.observation).reason, 'already_known'); assert.equal(f.food.snapshot().hunger, 16)
})

test('wrong actual scope, partial life, unconfirmed respawn, dead state and invalid timestamp/source fail closed', () => {
  const mutations = [
    o => { o.scope.deathId++ }, o => { o.scope.connectionId = 'other' }, o => { o.scope.runtimeEntityId = '274' }, o => { o.scope.profile = 'other' }, o => { o.scope.realmId = 'other' }, o => { o.scope.dimension = 'nether' }, o => { o.scope.startedAt = '2026-11-01T00:00:00Z' }, o => { delete o.scope },
    o => { o.respawn.deathId++ }, o => { o.respawn.connectionId = 'other' }, o => { o.respawn.phase = 'scheduled' }, o => { o.respawn.serverConfirmed = false }, o => { o.respawn.at = '2026-11-01T04:16:00Z' }, o => { o.respawn.at = 'invalid' },
    o => { o.observedAt = '2026-11-01T04:22:00Z' }, o => { o.observedAt = 'invalid' }, o => { o.source = 'cached_prediction' }, o => { o.value = -1 }, o => { o.value = 21 }, o => { o.value = null }, o => { o.value = '17' }, o => { o.value = NaN }
  ]
  for (const mutate of mutations) {
    const f = fixture(), value = structuredClone(f.observation); mutate(value)
    assert.equal(f.food.restoreHunger(value).restored, false); assert.equal(f.food.snapshot().hunger, null)
    assert.deepEqual(f.wire, []); assert.equal(f.food.snapshot().lastResult, null)
  }
  for (const key of ['profile', 'realm', 'connectionId', 'startedAt', 'dimension', 'runtimeEntityId', 'lifecycle']) {
    const f = fixture(); delete f.state[key]; assert.equal(f.food.restoreHunger(f.observation).restored, false, key)
  }
  for (const dead of [s => { s.health = 0 }, s => { s.dead = true }, s => { s.spawnPending = true }, s => { s.lifecycle.dead = true }, s => { s.lifecycle.deathId = null }]) {
    const f = fixture(); dead(f.state); assert.equal(f.food.restoreHunger(f.observation).restored, false)
  }
})

test('restoration is blocked by another owner or in-flight food, and cannot acknowledge a real decrement', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const busy = fixture(); busy.setBusy(true); assert.equal(busy.food.restoreHunger(busy.observation).reason, 'busy')
  const f = fixture(); f.food.restoreHunger(f.observation)
  const pending = f.food.eat().then(value => ({ value }), error => ({ error })); await nextTurn()
  assert.equal(f.food.restoreHunger(f.observation).reason, 'busy')
  f.bag[0] = air(); f.food.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: air() })
  assert.equal(f.food.snapshot().busy, true); assert.notEqual(f.food.snapshot().lastResult?.phase, 'completed')
  f.food.cancel('test cleanup'); const result = await pending
  assert.ok(result.error); assert.equal(f.commits.length, 0)
})

function runtimeHelpers (f) {
  const filename = process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js')
  const source = fs.readFileSync(filename, 'utf8')
  const start = source.indexOf('  function foodHungerScope () {'), end = source.indexOf('  function motionState () {', start)
  assert.ok(start >= 0 && end > start)
  const calls = []
  const host = { meta: {}, shared: { vitals: { hunger: structuredClone(f.observation) }, loadingScreenEnded: true, deathRespawn: structuredClone(f.observation.respawn) } }
  delete host.shared.vitals.hunger.respawn
  const food = { restoreHunger: value => { calls.push(value); return f.food.restoreHunger(value) } }
  const helpers = Function('host', 'raw', 'food', source.slice(start, end) + ';return {foodHungerScope,restoreFoodHungerBaseline}') (host, () => f.state, food)
  assert.match(source, /host\.cache\.replay\(applyPacket\)\s+replaying = false\s+restoreFoodHungerBaseline\(\)/)
  assert.match(source, /attribute\.name === 'minecraft:player\.hunger' \? \{ scope: foodHungerScope\(\) \}/)
  assert.ok(!source.slice(source.indexOf('  const operations = ')).includes('restoreHunger:'), 'baseline restoration is not an API operation')
  return { ...helpers, host, calls }
}

test('Runtime seeds post-replay from scoped current-life receipt and permits legacy own-Host epoch-bound baseline only', () => {
  for (const legacy of [false, true]) {
    const f = fixture(), h = runtimeHelpers(f)
    if (legacy) delete h.host.shared.vitals.hunger.scope
    assert.equal(h.restoreFoodHungerBaseline().restored, true)
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].scope, f.observation.scope)
    assert.equal(f.food.snapshot().hunger, 17); assert.deepEqual(f.wire, [])
  }
})

test('Runtime never replaces an explicit wrong or missing life binding and waits for terrain/loading readiness', () => {
  for (const mode of ['wrong_scope', 'null_scope', 'missing_life', 'loading', 'terrain', 'pre_life']) {
    const f = fixture(), h = runtimeHelpers(f)
    if (mode === 'wrong_scope') h.host.shared.vitals.hunger.scope.deathId++
    if (mode === 'null_scope') h.host.shared.vitals.hunger.scope = null
    if (mode === 'missing_life') delete h.host.shared.deathRespawn
    if (mode === 'loading') h.host.shared.loadingScreenEnded = false
    if (mode === 'terrain') h.host.shared.respawnTerrain = { pending: true }
    if (mode === 'pre_life') h.host.shared.vitals.hunger.observedAt = '2026-11-01T04:00:00Z'
    const result = h.restoreFoodHungerBaseline(); assert.ok(result == null || result.restored === false, mode)
    assert.equal(f.food.snapshot().hunger, null, mode)
  }
})
