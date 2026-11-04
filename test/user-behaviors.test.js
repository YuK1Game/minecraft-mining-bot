'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createUserBehaviors } = require('../src/user-behaviors')
const turn = () => new Promise(resolve => setImmediate(resolve))
async function turns (count = 12) { for (let n = 0; n < count; n++) await turn() }
function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

function fixture ({ real = false } = {}) {
  let time = 1000, rootHeld = null, rootSequence = 0, enabled = true, bedEnabled = true, cleanupKnown = true, bedPending = null, bedBusy = false, sleeping = false, sleepDay = false, meleeBusy = false, cleanupRanged = false
  const events = [], rootCalls = [], packets = [], actors = [], removed = [], controllerPackets = []
  const state = { profile: 'composition', playerName: 'ObservedPlayer', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'life', runtimeEntityId: '1', lifecycle: { deathId: 0, phase: 'alive' }, phase: 'spawned', gameMode: 'survival', health: 1, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, selectedSlot: 0, inventory: { known: true, items: [] }, entities: actors }
  const entities = { snapshot: () => structuredClone(actors), snapshotRemoved: () => structuredClone(removed) }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:grass_block' : 'minecraft:air', runtimeId: y < 65 ? 2 : 0, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
  const controller = name => ({
    preview: runtimeId => ({ ready: true, targetRuntimeId: runtimeId }),
    engage: async runtimeId => { events.push(`engage_${name}`); meleeBusy = name === 'melee'; const actor = actors.find(value => value.runtimeId === runtimeId); actor.alive = false; actor.lastEvent = { event: 'death_animation' }; meleeBusy = false; return { phase: 'completed', code: 'TARGET_DEAD', targetRuntimeId: actor.runtimeId, targetUniqueId: actor.uniqueId, targetDead: true, serverConfirmed: true, hitsRequested: 1 } },
    cancel: reason => events.push(`cancel_${name}`), drain: async () => { events.push(`drain_${name}`) }, snapshot: () => ({ busy: name === 'melee' && meleeBusy, cleanupUnconfirmed: name === 'ranged' && cleanupRanged }), applyPacket: (name, packet) => controllerPackets.push({ controller: name, packet, health: state.health })
  })
  const melee = controller('melee'), ranged = controller('ranged')
  const bed = {
    preview: () => ({ ready: bedEnabled && !sleeping || sleeping && sleepDay, action: sleeping && sleepDay ? 'wake' : 'place', code: bedEnabled ? null : 'BED_ITEM_REQUIRED' }),
    execute: async () => { bedBusy = true; events.push(sleeping ? 'bed_wake' : 'bed_execute'); if (sleeping) { sleeping = false; bedBusy = false; return { sleeping: false } }; bedPending = deferred(); await bedPending.promise; bedBusy = false; return { sleeping } },
    cancel: () => { events.push('bed_cancel'); bedPending?.resolve(); bedBusy = false },
    drain: async () => { events.push('bed_drain'); return cleanupKnown ? [{ status: 'fulfilled' }] : [{ status: 'rejected', reason: new Error('Unknown bed cleanup') }] },
    snapshot: () => ({ busy: bedBusy, sleeping }),
    applyPacket: (name, packet) => { if (name === 'sleep') sleeping = true; if (name === 'wake') sleeping = false; if (name === 'dead') sleeping = false }, ownsTarget: () => true
  }
  const options = {
    client: { queue: (...args) => packets.push(args) }, getState: () => state, getRawState: () => state, world, entities, crafting: { snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [], pendingRequestId: null }), rawItem: empty }, inventory: { equipForCombat: async slot => ({ slot, serverConfirmed: true }), cancel: () => {} }, getInput: () => ({ stats: () => ({ running: false, target: null, sent: 0 }), stop () {}, lookAt () {}, start () {} }), getSelfUniqueId: () => 1n,
    getClock: () => ({ time: sleepDay ? 25000 : 13000, source: 'server_sync_world_clocks' }), getBedMemory: () => null, setBedMemory () {}, placeBed: async () => { throw new Error('No real bed item in smoke test') }, useBed: async () => {}, wakeBed: async () => {}, mineBed: async () => {}, cancelBedActions: async () => { events.push('root_bed_cleanup'); return { cleaned: cleanupKnown } },
    canAct: () => enabled, now: () => time, wallNow: () => time, sleep: async () => turn(),
    acquireControl: async args => { assert.equal(rootHeld, null, 'one protective Root owner at a time'); const token = { id: ++rootSequence }; rootHeld = { kind: args.kind, claimId: args.claimId, token }; rootCalls.push({ type: 'acquire', ...args, token }); events.push(`acquire_${args.kind}`); return { acquired: true, token } },
    resumeControl: async args => { rootCalls.push({ type: 'resume', ...args }); assert.equal(args.kind, rootHeld.kind); assert.equal(args.claimId, rootHeld.claimId); assert.strictEqual(args.token, rootHeld.token); events.push(`resume_${args.kind}`); rootHeld = null; return { resumed: true } },
    ...(real ? {} : { controllers: { melee, ranged, bed } })
  }
  const facade = createUserBehaviors(options)
  const hostile = (runtimeId = '70', x = 2) => ({ kind: 'mob', hostile: true, alive: true, positionKnown: true, entityType: 'minecraft:zombie', runtimeId, uniqueId: '-' + runtimeId, dimension: 'overworld', position: { x, y: 65, z: 0.5 } })
  return { facade, state, actors, events, packets, rootCalls, controllerPackets, hostile, advance: ms => { time += ms }, held: () => rootHeld, setEnabled: value => { enabled = value }, setBed: value => { bedEnabled = value }, setCleanup: value => { cleanupKnown = value }, setSleeping: value => { sleeping = value }, setDay: value => { sleepDay = value }, setBowCleanup: value => { cleanupRanged = value }, finishBed: () => bedPending?.resolve(), bed }
}

test('the real thin composition instantiates existing controllers at HP1 with no invented items or acquisition', async () => {
  const f = fixture({ real: true })
  const snapshot = await f.facade.tick(); await turns()
  assert.equal(snapshot.busy, false)
  assert.equal(f.facade.snapshot().bed.sleeping, false)
  assert.equal(f.rootCalls.length, 0)
  assert.deepEqual(f.packets, [])
})

test('a stored pending bed task does not coalesce away close combat; cleanup and exact-token bed release precede combat acquisition', async () => {
  const f = fixture()
  await f.facade.tick(); await turns()
  assert.equal(f.facade.snapshot().claim.kind, 'bed')
  assert.ok(f.events.includes('bed_execute'))
  f.actors.push(f.hostile())
  await f.facade.tick(); await turns(35)
  assert.ok(f.events.includes('engage_melee'))
  assert.ok(f.events.indexOf('bed_drain') < f.events.indexOf('resume_bed'))
  assert.ok(f.events.indexOf('resume_bed') < f.events.indexOf('acquire_combat'))
  const released = f.rootCalls.find(call => call.type === 'resume' && call.kind === 'bed')
  assert.equal(released.canActNow, false, 'a preemption release cannot wake resources between owners')
  const combat = f.rootCalls.find(call => call.type === 'acquire' && call.kind === 'combat')
  assert.match(combat.claimId, /^combat:/)
  assert.equal(combat.coordinatorClaimId, 1)
  const lateResumes = f.rootCalls.filter(call => call.type === 'resume' && call.kind === 'bed')
  assert.equal(lateResumes.length, 1, 'bed finally cannot release a later combat owner')
  f.setBed(false); f.facade.cancel('End fixture'); await f.facade.drain()
})

test('unknown bed cleanup keeps the protective claim blocked and never resumes resources or starts combat', async () => {
  const f = fixture(); await f.facade.tick(); await turns()
  f.setCleanup(false); f.actors.push(f.hostile())
  await f.facade.tick(); await turns(30)
  const held = f.facade.snapshot()
  assert.equal(held.busy, true)
  assert.equal(held.blocked, true)
  assert.equal(held.cleanupUnconfirmed, true)
  assert.equal(f.rootCalls.some(call => call.type === 'resume'), false)
  assert.equal(f.events.includes('engage_melee'), false)
  f.setCleanup(true); f.advance(2500); await f.facade.tick(); await turns(20); await f.facade.tick(); await turns(25)
  assert.ok(f.events.includes('engage_melee'))
  f.setBed(false); f.facade.cancel('End fixture'); await f.facade.drain()
})

test('actual sleep pauses new combat; after the server wake receipt close combat precedes bed cleanup', async () => {
  const f = fixture(); await f.facade.tick(); await turns()
  f.setSleeping(true); f.facade.applyPacket('sleep', {})
  f.finishBed(); await turns()
  f.actors.push(f.hostile())
  await f.facade.tick(); await turns()
  assert.equal(f.facade.snapshot().sleeping, true)
  assert.equal(f.events.includes('engage_melee'), false)
  f.setSleeping(false); f.facade.applyPacket('wake', {})
  await f.facade.tick(); await turns(35)
  assert.ok(f.events.includes('engage_melee'))
  assert.equal(f.events.filter(event => event === 'bed_execute').length, 1, 'bed retrieval cannot sneak in before new close combat')
  f.setBed(false); f.facade.cancel('End fixture'); await f.facade.drain()
})

test('pre-existing ranged cleanup blocks bed work, and packet forwarding sees already-updated caller state', async () => {
  const f = fixture(); f.setBowCleanup(true)
  await f.facade.tick(); await turns()
  assert.equal(f.facade.snapshot().cleanupUnconfirmed, true)
  assert.equal(f.rootCalls.length, 0)
  f.state.health = 3
  f.facade.applyPacket('update_attributes', { runtime_entity_id: 1n })
  assert.ok(f.controllerPackets.every(packet => packet.health === 3))
})
