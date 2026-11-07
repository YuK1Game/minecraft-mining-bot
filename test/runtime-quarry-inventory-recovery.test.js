'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../src/runtime'), 'utf8')
function section (from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert.ok(a >= 0 && b > a)
  return source.slice(a, b)
}

// Execute the actual automatic trigger, idle guard, request limiter/scope and
// fresh-main acknowledgement together. No production testing API is added.
function fixture () {
  let clock = 100000
  class ClockDate extends Date { constructor (...args) { super(...(args.length ? args : [clock])) } static now () { return clock } }
  const wire = [], state = { profile: 'quarry-test', realm: { id: '1' }, connectionId: 'socket', startedAt: 'started', runtimeEntityId: '1', dimension: 'overworld', phase: 'spawned', gameMode: 'survival', health: 20, lifecycle: { deathId: 1, dead: false }, inventory: { known: false } }
  const client = { queue: (name, packet) => wire.push({ name, packet: structuredClone(packet) }) }
  const context = { Date: ClockDate, Object, Number, String, JSON, Math, Error, Promise, Set, structuredClone,
    host: { client, meta: { profile: state.profile, version: '1.26.60', startGame: { runtime_entity_id: 1n } }, shared: { autoWanted: false, loadingScreenEnded: true, deathRespawn: { deathId: 1 }, inventoryUncertain: { at: clock - 1000, reason: 'withdraw receipt timeout' } } },
    inventoryResyncClient: client, disposed: false, disposing: false, replaying: false, ownedCall: 0, pendingStops: new Set(), userBehaviorTickTask: null, inputOwner: 'idle', quarryCombatArmed: true,
    raw: () => state, inventoryLifeBaseKey: () => 'same-life', verifiedInitialLifeReceipt: () => null,
    prepareInventoryLifeReceipt: () => assert.fail('Known scope must not prepare a replacement life'),
    combatOwned: false, userBehaviorSnapshot: () => ({ cleanupUnconfirmed: false }), userBehaviorOwns: () => context.combatOwned, motionActive: () => false,
    input: { stats: () => ({ running: false }) }, autonomy: { snapshot: () => ({ actionActive: false }) },
    craftStatus: () => ({ pendingRequestId: null }), interactions: { snapshot: () => ({ pendingOperation: null }) }, mining: { snapshot: () => ({ phase: 'idle' }) }, walker: { snapshot: () => ({ phase: 'idle' }) }
  }
  for (const name of ['idleSafety', 'excavation', 'tunneling', 'recovery', 'foraging', 'surfaceReturn', 'shelter', 'hut', 'guardRoute', 'food', 'inventory', 'furnace', 'chest', 'combat']) context[name] = { snapshot: () => ({ busy: false }) }
  vm.createContext(context)
  vm.runInContext(section('  function requestInventoryResyncWithReceipt (', '  // Wear better owned armor') + section('  function maybeResyncInventory ()', '  function observeInventoryResync (') + section('  function observeInventoryResync (', '  function publishWalker ()'), context)
  return { context, state, wire, setTime: value => { clock = value }, tick: () => context.maybeResyncInventory(), full: () => context.observeInventoryResync({ input: Array.from({ length: 36 }, () => ({ network_id: 0, count: 0 })) }) }
}

test('quarry-only recovery waits for combat to finish, sends one bounded read and awaits a genuine full-main receipt', () => {
  const f = fixture()
  f.context.combatOwned = true; f.tick()
  assert.equal(f.wire.length, 0, 'no inventory request while combat owns control')
  f.context.combatOwned = false; f.tick()
  assert.equal(f.wire.length, 1)
  assert.equal(f.context.host.shared.autoWanted, false)
  assert.equal(f.context.host.shared.inventoryResync.lastRequest.status, 'REQUEST_SENT')
  assert.ok(f.context.host.shared.inventoryUncertain)
  f.context.observeInventoryResync({ input: Array(35).fill({}) })
  assert.equal(f.context.host.shared.inventoryResync.lastRequest.status, 'REQUEST_SENT')
  f.full()
  assert.equal(f.context.host.shared.inventoryResync.lastRequest.status, 'FRESH_MAIN_OBSERVED')
  assert.equal(f.context.host.shared.inventoryResync.count, 0)
  f.setTime(119999); f.tick(); assert.equal(f.wire.length, 1)
  f.setTime(120000); f.tick(); assert.equal(f.wire.length, 2)
})

test('quarry-only recovery preserves the three-consecutive-failure window and never resets it on send', () => {
  const f = fixture()
  for (const at of [100000, 120000, 140000]) { f.setTime(at); f.tick() }
  assert.equal(f.wire.length, 3)
  assert.equal(f.context.host.shared.inventoryResync.count, 3)
  f.setTime(160000); f.tick(); assert.equal(f.wire.length, 3)
  f.setTime(220000); f.tick(); assert.equal(f.wire.length, 4)
  assert.equal(f.context.host.shared.inventoryResync.count, 1)
})

test('stopped, dead, other-life and incomplete scopes cannot promote old or unsolicited inventory observations', () => {
  const stopped = fixture(); stopped.context.quarryCombatArmed = false; stopped.tick(); assert.equal(stopped.wire.length, 0)
  const dead = fixture(); dead.state.health = 0; dead.state.lifecycle.dead = true; dead.tick(); assert.equal(dead.wire.length, 0)
  const life = fixture(); life.tick(); life.context.host.shared.deathRespawn.deathId = 2; life.state.lifecycle.deathId = 2; life.full()
  assert.equal(life.context.host.shared.inventoryResync.lastRequest.status, 'REQUEST_SENT')
  const missing = fixture(); missing.state.connectionId = null; missing.tick(); assert.equal(missing.wire.length, 0)
})
