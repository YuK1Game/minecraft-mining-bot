'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCombatExposure } = require('../src/combat-exposure')
const reach = require('../src/threat-reachability')
const { evaluateThreats } = require('../src/threats')
const { createEntities } = require('../src/entities')
const { createCombatCoordinator } = require('../src/combat-coordinator')
const { createMeleeCombat } = require('../src/melee-combat')
const { createRangedCombat } = require('../src/ranged-combat')
const { engagementAllowed } = require('../src/combat-profiles')

const stone = Object.freeze({ known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] })
const air = Object.freeze({ known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
const state = () => ({ phase: 'spawned', health: 20, dimension: 'overworld', runtimeEntityId: '1', position: { x: 0.5, y: 65.62, z: 0.5 }, threatPolicy: 'balanced_mining' })
const zombie = () => ({ runtimeId: '2', uniqueId: '-2', entityType: 'minecraft:zombie', kind: 'mob', hostile: true, alive: true, positionKnown: true, position: { x: 6.5, y: 64, z: 0.5 }, dimension: 'overworld' })
function corridor ({ unknown = () => false, blocked = () => false } = {}) {
  return {
    revision: () => 1,
    getBlock: (x, y, z) => unknown(x, y, z) ? { known: false } : x < 0 || x > 6 || z !== 0 || y < 64 || y > 65 || blocked(x, y, z) ? stone : air
  }
}
const exposure = world => createCombatExposure({ world, entities: { motion: () => null }, scopeOf: () => 'same-life' })

test('real combat exposure preserves unknown passage and floor evidence between received endpoints', () => {
  const cases = {
    passage: (x, y, z) => x === 3 && z === 0 && (y === 64 || y === 65),
    floor: (x, y, z) => x === 3 && z === 0 && y === 63,
    enemy_floor: (x, y, z) => x === 6 && z === 0 && y === 63
  }
  for (const [name, unknown] of Object.entries(cases)) {
    const world = corridor({ unknown }), current = state(), actor = zombie()
    assert.equal(world.getBlock(0, 63, 0).known, true)
    assert.equal(world.getBlock(0, 64, 0).known, true)
    assert.equal(world.getBlock(6, 64, 0).known, true)
    const result = exposure(world).evaluate(actor, current)
    assert.equal(result.evidence.routeToBot, null, name)
    assert.equal(result.unknown, true, name)
    assert.equal(result.reason, 'ATTACK_ACCESS_UNKNOWN', name)
    assert.equal(result.intercept, false, 'unknown access does not authorize an attack')
  }
})

test('legacy flood evidence never removes an enemy because a passage or its supporting floor was unreceived', () => {
  for (const unknown of [(x, y, z) => x === 3 && z === 0 && y >= 64 && y <= 65, (x, y, z) => x === 3 && z === 0 && y === 63]) {
    reach.clear()
    const current = state(), actor = zombie(), world = corridor({ unknown })
    reach.refresh(current, [actor], { world, now: 1000 })
    const evaluated = evaluateThreats(current, [actor], { now: () => 1100 })
    assert.equal(reach.snapshot().unknownTouched, true)
    assert.equal(reach.verdict(current, actor, 1100), null)
    assert.equal(evaluated.unreachable.length, 0)
    assert.equal(evaluated.threats.length, 1)
  }
  reach.clear()
})

test('received closed passages remain known blocked and an observed route remains reachable', () => {
  const current = state(), actor = zombie()
  const blocked = corridor({ blocked: (x, y, z) => x === 3 && z === 0 && y >= 64 && y <= 65 })
  const negative = exposure(blocked).evaluate(actor, current)
  assert.equal(negative.evidence.routeToBot, false)
  assert.equal(negative.unknown, false)
  assert.equal(negative.reason, 'ENEMY_ATTACK_ROUTE_BLOCKED')
  const clear = exposure(corridor()).evaluate(actor, current)
  assert.equal(clear.evidence.routeToBot, true)
  assert.equal(clear.intercept, true)
  const sideUnknown = corridor({ unknown: (x, y, z) => x === 4 && z === 1 && y >= 64 && y <= 65 })
  assert.equal(reach.seekCells(sideUnknown, actor.position, { ...current.position, y: 64 }), true)
})

test('observed water supports the existing water route without requiring an unseen floor below it', () => {
  const water = { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] }
  const ground = corridor({ unknown: (x, y, z) => y === 63 && z === 0 && x >= 0 && x <= 6 })
  const world = { revision: () => 1, getBlock: (x, y, z) => y === 64 && z === 0 && x >= 0 && x <= 6 ? water : ground.getBlock(x, y, z) }
  const current = state(), actor = zombie()
  assert.equal(exposure(world).evaluate(actor, current).evidence.routeToBot, true)
  reach.clear()
  reach.refresh(current, [actor], { world, now: 1000 })
  assert.equal(reach.verdict(current, actor, 1100), true)
  reach.clear()
})

// This fixture supplies observed inventory and packets to the real tracker,
// exposure, coordinator and attack previews. Acquisition is denied after it
// is recorded: the test never sends an attack or fabricates a kill receipt.
function receivedCombat (type, distance = 10) {
  const current = { ...state(), profile: 'test-bot', realm: { id: '12' }, connectionId: 'connection-A', startedAt: 'session-A', gameMode: 'survival', lifecycle: { deathId: 0 }, positionSource: 'start_game', selectedSlot: 0, rawSelectedSlot: 0, rawServerSelectedSlot: 0 }
  const entities = createEntities()
  entities.applyPacket('start_game', { runtime_entity_id: 1n, entity_id: 101n, dimension: 0 })
  entities.applyPacket('add_entity', { runtime_id: 70n, unique_id: -700n, entity_type: type, position: { x: current.position.x + distance, y: 64, z: 0.5 } })
  const empty = { network_id: 0, count: 0, metadata: 0, has_stack_id: false }
  const slots = new Map(Array.from({ length: 36 }, (_, slot) => [slot, empty]))
  slots.set(0, { network_id: 302, count: 1, metadata: 0, has_stack_id: true, stack_id: 41 })
  slots.set(1, { network_id: 300, count: 1, metadata: 0, has_stack_id: true, stack_id: 42 })
  slots.set(10, { network_id: 303, count: 4, metadata: 0, has_stack_id: true, stack_id: 43 })
  const items = [{ slot: 0, name: 'minecraft:bow', count: 1, stackId: 41 }, { slot: 1, name: 'minecraft:wooden_sword', count: 1, stackId: 42 }, { slot: 10, name: 'minecraft:arrow', count: 4, stackId: 43 }]
  current.inventory = { known: true, items }
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, inventory: items }), rawItem: slot => structuredClone(slots.get(slot)) }
  const world = { revision: () => 1, getBlock: (x, y, z) => y < 64 ? stone : air }
  const client = { queue: () => { throw new Error('This integration must not send an attack') } }
  const shared = { client, getState: () => current, world, entities, crafting, equip: async () => { throw new Error('No equipment mutation expected') }, getInput: () => null }
  const melee = createMeleeCombat({ ...shared, getRawState: () => current })
  const ranged = createRangedCombat({ ...shared, getSelfUniqueId: () => '101' })
  const threat = createCombatExposure({ world, entities, scopeOf: s => JSON.stringify([s.connectionId, s.lifecycle.deathId]) })
  const acquisitions = []
  const coordinator = createCombatCoordinator({ getState: () => current, entities, melee, ranged, canAct: () => true, canEngage: (actor, s) => threat.evaluate(actor, s).intercept, acquire: async request => { acquisitions.push(request); return { acquired: false } }, resume: async () => { throw new Error('Denied acquisition cannot release an owner') } })
  return { current, entities, melee, ranged, world, threat, coordinator, acquisitions, target: () => entities.get('70') }
}

test('a received shulker reaches real ranged selection and both attack eligibility checks', async () => {
  const far = receivedCombat('minecraft:shulker')
  assert.equal(far.target().kind, 'mob')
  assert.equal(far.target().hostile, true)
  const preview = far.ranged.preview('70')
  assert.equal(preview.ready, true, JSON.stringify(preview))
  assert.equal((await far.coordinator.tick()).code, 'ACQUIRE_DENIED')
  assert.equal(far.acquisitions.length, 1)
  const near = receivedCombat('minecraft:shulker', 1.7)
  const melee = near.melee.preview('70', { critical: false })
  assert.equal(melee.ready, true, JSON.stringify(melee))
})

test('packet classification never turns passive, provoked-only or unknown types into automatic attackers', async () => {
  for (const type of ['minecraft:cow', 'minecraft:wolf', 'minecraft:piglin', 'minecraft:enderman', 'minecraft:zombie_horse', 'minecraft:unregistered_enemy']) {
    const f = receivedCombat(type, 1.7)
    assert.equal(f.target().hostile, false, type)
    assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE', type)
    assert.equal(f.acquisitions.length, 0, type)
    assert.equal(f.melee.preview('70', { critical: false }).ready, false, type)
  }
})

test('avoid-only profiles remain observable danger but cannot reach direct attack previews', async () => {
  for (const type of ['minecraft:warden', 'minecraft:wither', 'minecraft:ender_dragon', 'minecraft:elder_guardian', 'minecraft:creaking']) {
    const near = receivedCombat(type, 1.7)
    assert.equal(near.target().hostile, true, `${type} stays visible to danger observation`)
    assert.equal(engagementAllowed(type, { distance: 1.7, provoked: true }), false)
    assert.equal(near.melee.preview('70', { critical: false }).ready, false, type)
    assert.equal((await near.coordinator.tick()).code, 'NO_CANDIDATE', type)
    const far = receivedCombat(type)
    assert.equal(far.ranged.preview('70').ready, false, type)
  }
})

test('one synchronous decision shares only unchanged sight, while motion and policy remain fresh', () => {
  let reads = 0, motionReads = 0, moving = true
  const world = { revision: () => 1, getBlock: () => { reads++; return air } }
  const current = state(), actor = { ...zombie(), entityType: 'minecraft:skeleton', position: { x: 10.5, y: 64, z: 0.5 } }
  const threats = createCombatExposure({ world, entities: { motion: () => { motionReads++; return moving ? { velocity: { x: -0.05, y: 0, z: 0 }, samples: 3, ageMs: 0, stationary: false } : null } }, scopeOf: () => 'same-life' })
  threats.withDecision(() => {
    assert.equal(threats.evaluate(actor, current).awareness, 'observed_closing')
    const first = reads
    moving = false
    assert.equal(threats.evaluate(structuredClone(actor), current).awareness, 'inferred_near_visible_hostile')
    assert.equal(reads, first, 'same physical ray is reused inside this decision')
    assert.equal(motionReads, 2, 'motion is not memoized with geometry')
    actor.alive = false
    assert.equal(threats.evaluate(actor, current).reason, 'TARGET_NOT_ALIVE')
    assert.equal(reads, first)
  })
  const before = reads
  threats.evaluate(actor, current)
  assert.ok(reads > before, 'the decision cache is discarded on return')
})

test('decision sight is invalidated by exact poses, target identity, scope, terrain revision and getter replacement', () => {
  let reads = 0, revision = 1, scope = 'life-A'
  const getBlock = () => { reads++; return air }
  const world = { revision: () => revision, getBlock }
  const current = state(), actor = { ...zombie(), entityType: 'minecraft:skeleton' }
  const threats = createCombatExposure({ world, entities: { motion: () => null }, scopeOf: () => scope })
  threats.withDecision(() => {
    threats.evaluate(actor, current)
    for (const change of [() => { current.position.x += 0.01 }, () => { actor.position.x += 0.01 }, () => { actor.uniqueId = '-3' }, () => { actor.entityType = 'minecraft:stray' }, () => { scope = 'life-B' }, () => { revision++ }, () => { world.getBlock = (...args) => getBlock(...args) }]) {
      const before = reads
      change(); threats.evaluate(actor, current)
      assert.ok(reads > before, 'changed evidence cannot reuse the prior ray')
    }
  })
  assert.throws(() => threats.withDecision(() => { threats.evaluate(actor, current); throw new Error('decision interrupted') }), /decision interrupted/)
  const before = reads
  threats.evaluate(actor, current)
  assert.ok(reads > before, 'a thrown decision also discards its cache')
})

test('worlds without an authoritative revision always resample sight', () => {
  let reads = 0
  const world = { getBlock: () => { reads++; return air } }, current = state(), actor = { ...zombie(), entityType: 'minecraft:skeleton' }
  const threats = exposure(world)
  threats.withDecision(() => {
    threats.evaluate(actor, current); const before = reads
    threats.evaluate(actor, current); assert.ok(reads > before)
  })
})

test('an await ends sight sharing and a later received wall blocks the next assessment', async () => {
  let revision = 1, reads = 0, blocked = false
  const world = { revision: () => revision, getBlock: () => { reads++; return blocked ? stone : air } }
  const current = state(), actor = { ...zombie(), entityType: 'minecraft:skeleton' }, threats = exposure(world)
  await threats.withDecision(async () => {
    assert.equal(threats.evaluate(actor, current).intercept, true)
    const before = reads
    await Promise.resolve()
    threats.evaluate(actor, current)
    assert.ok(reads > before, 'no unchanged ray survives an await')
    blocked = true; revision++
    const result = threats.evaluate(actor, current)
    assert.equal(result.evidence.sight, false)
    assert.equal(result.intercept, false)
  })
})

test('real coordinator shares exposure inside selection and continuation, with a fresh ray at each boundary', async () => {
  const f = receivedCombat('minecraft:skeleton')
  let reads = 0
  const getBlock = f.world.getBlock
  f.world.getBlock = (...args) => { reads++; return getBlock(...args) }
  const samples = []
  const observe = (stage, actor, current) => {
    const before = reads, result = f.threat.evaluate(actor, current)
    samples.push({ stage, reads: reads - before })
    return result.intercept
  }
  const coordinator = createCombatCoordinator({
    getState: () => f.current, entities: f.entities, melee: f.melee, ranged: f.ranged,
    canAct: () => true,
    withDecision: fn => f.threat.withDecision(fn),
    canEngage: (actor, current) => observe('engage', actor, current),
    workGuard: {
      canSelectTarget: (actor, current) => observe('select', actor, current),
      canContinue: (actor, current) => { observe('continue', actor, current); return { allowed: false, reason: 'TEST_HOLD' } }
    },
    acquire: async () => { throw new Error('The continuation hold must prevent acquisition') },
    resume: async () => { throw new Error('No acquired owner exists') }
  })
  assert.equal((await coordinator.tick()).code, 'WORK_GUARD')
  assert.deepEqual(samples.map(s => s.stage), ['select', 'engage', 'engage', 'continue'])
  assert.ok(samples[0].reads > 0)
  assert.equal(samples[1].reads, 0, 'selection shares the exact exposure ray')
  assert.ok(samples[2].reads > 0, 'continuation is a new synchronous observation')
  assert.equal(samples[3].reads, 0, 'continuation shares geometry without caching its work guard')
})
