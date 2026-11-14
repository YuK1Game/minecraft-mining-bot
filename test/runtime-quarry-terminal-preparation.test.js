'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createSnapshotReader } = require('../src/runtime-observation-views')
const { inventoryRefreshDelay, refreshInventoryWithRetry } = require('../src/inventory-refresh')

const source = fs.readFileSync(require.resolve('../src/runtime'), 'utf8')
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `actual Runtime section: ${from}`)
  return source.slice(start, end)
}

// Execute the actual idle guard, ordinary-action guard, and actual adapter
// callback together. The fake ports return received observations; no game
// connection, credentials, or public testing API is introduced.
function fixture ({ remaining = 2, lastRequestedAt = null, onDelay = null } = {}) {
  let clock = 100000, fresh = 0, equips = 0, armorEquips = 0
  const events = [], actors = [], busy = () => ({ snapshot: () => ({ busy: false }) })
  const state = { profile: 'terminal-test', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', dimension: 'overworld', runtimeEntityId: '41', lifecycle: { deathId: 1 }, phase: 'spawned', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, stackId: 42, durabilityKnown: true, durabilityRemaining: remaining }] } }
  const context = {
    ownedCall: 0, disposed: false, disposing: false, pendingStops: new Set(), userBehaviorTickTask: null, inputOwner: 'idle', inventoryBusy: false, craftPending: null, motion: false, manualArmorOwner: null,
    host: { shared: { autoWanted: false, equipment: null, ...(lastRequestedAt == null ? {} : { inventoryResync: { lastRequestedAt } }) }, entities: { snapshot: () => structuredClone(actors) } },
    Date: { now: () => clock }, Error, Promise, Object, Number, Math,
    setTimeout: (fn, ms) => setImmediate(() => { clock += ms; events.push(`wait:${ms}`); onDelay?.(context); fn() }),
    quarryState: () => structuredClone(state), working: () => structuredClone(state), raw: () => structuredClone(state),
    userScope: s => JSON.stringify([s.profile, s.realm.id, s.connectionId, s.startedAt, s.dimension, s.runtimeEntityId, s.lifecycle.deathId]),
    userBehaviorSnapshot: () => ({}), userBehaviorOwns: () => false, motionActive: () => context.motion,
    createSnapshotReader, inventoryRefreshDelay,
    chestStatus: () => context.chest.snapshot(),
    resetHeld: () => false, chunkMoveHeld: () => false, chunkMoveDepth: 0,
    manualChestStorage: null, manualShulkerTask: null, quarryPlacementPreparation: null,
    input: { stats: () => ({ running: false }) }, autonomy: { snapshot: () => ({ actionActive: false }) },
    idleSafety: busy(), excavation: busy(), tunneling: busy(), recovery: busy(), foraging: busy(), surfaceReturn: busy(), shelter: busy(), hut: busy(), guardRoute: busy(),
    mining: { snapshot: () => ({ phase: 'idle' }) }, walker: { snapshot: () => ({ phase: 'idle' }) },
    food: busy(), furnace: busy(), chest: busy(), interactions: { snapshot: () => ({ pendingOperation: null }) }, combat: busy(), quarryPillar: busy(),
    quarryJob: { holdsWork: () => true }, quarryCombatArmed: false, armorTask: null, longTravel: null,
    craftStatus: () => ({ pendingRequestId: context.craftPending, openContainer: null }),
    inventory: {
      snapshot: () => ({ busy: context.inventoryBusy }),
      equipForMining: async slot => {
        equips++; events.push('equip')
        assert.equal(context.ownedCall, 1, 'equipment is still protected by its owner')
        assert.throws(() => context.inventoryResyncIdle(), e => e.code === 'BUSY', 'the real idle guard remains closed inside equip')
        return { slot, serverConfirmed: true }
      }
    },
    armor: { preview: () => true, equipBest: async () => { armorEquips++; return [] } }
  }
  context.refreshInventoryWithRetry = options => refreshInventoryWithRetry({ ...options, now: () => clock, sleep: ms => new Promise(resolve => context.setTimeout(resolve, ms)) })
  context.own = fn => async (...args) => { context.ownedCall++; try { return await fn(...args) } finally { context.ownedCall-- } }
  context.adapter = { resyncInventory: async ({ signal }) => {
    assert.equal(context.ownedCall, 0)
    context.inventoryResyncIdle()
    assert.equal(signal?.aborted, false)
    fresh++; events.push('fresh-main')
    state.inventory.items[0].durabilityRemaining = 1
    return true
  } }
  const code = section('  function requireIdle (', '  function inventoryLifeBaseKey') + section('  function inventoryResyncIdle (', '  function inventoryResyncSuccessKey') + section('  function inventoryResyncDelay ()', '  function requestInventoryResync (') + section('  function nearestHostileDistance ()', '  function maybeResyncInventory') + '\nthis.ports = {\n' + section('      prepareMining: async (tool, { signal } = {}) => {', '      // Fresh inventory + selected slot') + '\n};'
  vm.runInNewContext(code, context, { filename: 'actual-runtime-terminal-ports.js' })
  return { context, state, actors, events, tool: { kind: 'pickaxe', name: 'minecraft:diamond_pickaxe', slot: 0, remaining, reserve: 1 }, fresh: () => fresh, equips: () => equips, armorEquips: () => armorEquips, time: () => clock, advance: ms => { clock += ms } }
}

test('terminal fresh is outside the real idle guard owner and equipment is acquired only after fresh proof', async () => {
  const f = fixture(); const signal = new AbortController().signal
  const result = await f.context.ports.prepareMining(f.tool, { signal })
  assert.equal(f.fresh(), 1)
  assert.equal(f.equips(), 1)
  assert.deepEqual(f.events, ['fresh-main', 'equip'])
  assert.equal(result.toolObservation.durabilityRemaining, 1)
  assert.equal(result.toolObservation.stackId, 42)
  assert.equal(f.context.ownedCall, 0)
})

test('terminal cooldown is bounded, yields outside ownership, and requests a new fresh inventory', async () => {
  const f = fixture({ lastRequestedAt: 100000 })
  await f.context.ports.prepareMining(f.tool, { signal: new AbortController().signal })
  assert.equal(f.time(), 120000)
  assert.ok(f.events.filter(v => v.startsWith('wait:')).length > 1)
  assert.equal(f.fresh(), 1)
  assert.equal(f.equips(), 1)
  assert.deepEqual(f.events.slice(-2), ['fresh-main', 'equip'])
})

test('abort, changed life and damage while waiting cannot reach the fresh/equip ports', async () => {
  for (const mode of ['abort', 'life', 'damage']) {
    const abort = new AbortController()
    const f = fixture({ lastRequestedAt: 100000, onDelay: () => { if (mode === 'abort') abort.abort(); else if (mode === 'life') f.state.lifecycle.deathId++; else f.state.health-- } })
    await assert.rejects(f.context.ports.prepareMining(f.tool, { signal: abort.signal }))
    assert.equal(f.fresh(), 0, mode)
    assert.equal(f.equips(), 0, mode)
    assert.equal(f.context.ownedCall, 0)
  }
})

test('the real idle and ordinary-action guards still reject competing work', async () => {
  const f = fixture(); f.context.inventoryBusy = true
  await assert.rejects(f.context.ports.prepareMining(f.tool, { signal: new AbortController().signal }), e => e.code === 'BUSY')
  assert.equal(f.fresh(), 0)
  assert.equal(f.equips(), 0)
  const healthy = fixture({ remaining: 100 }); healthy.context.motion = true
  await assert.rejects(healthy.context.ports.prepareMining(healthy.tool, { signal: new AbortController().signal }), /前の操作/)
  assert.equal(healthy.equips(), 0)
})

test('healthy tools keep the ordinary equipment path without a fresh request or cooldown wait', async () => {
  const f = fixture({ remaining: 100, lastRequestedAt: 100000 })
  const result = await f.context.ports.prepareMining(f.tool, { signal: new AbortController().signal })
  assert.equal(f.fresh(), 0)
  assert.deepEqual(f.events, ['equip'])
  assert.equal(result.toolObservation.durabilityRemaining, 100)
})

test('armor also runs for an armed quarry, keeping interval, busy-inventory and nearby-hostile guards', async () => {
  const f = fixture()
  f.context.maybeEquipArmor(); assert.equal(f.armorEquips(), 0)
  f.context.quarryCombatArmed = true
  f.context.maybeEquipArmor(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.armorEquips(), 1)
  f.context.maybeEquipArmor(); assert.equal(f.armorEquips(), 1, 'three-second interval stays in force')
  f.advance(3000); f.context.inventoryBusy = true
  f.context.maybeEquipArmor(); assert.equal(f.armorEquips(), 1)
  f.advance(3000); f.context.inventoryBusy = false
  f.actors.push({ hostile: true, alive: true, position: { x: 1, y: 66.62, z: 0.5 } })
  f.context.maybeEquipArmor(); assert.equal(f.armorEquips(), 1)
  f.advance(3000); f.actors.length = 0
  f.context.maybeEquipArmor(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.armorEquips(), 2)
})
