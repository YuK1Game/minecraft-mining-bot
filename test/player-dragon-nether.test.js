'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { stepNether, portalProof, eyeBudget } = require('../src/modes/dragon-nether')
const { framePlan, nearestGate } = require('../src/modes/dragon-nether-portal')
const { createEntities } = require('../src/host/entities')
const { createState } = require('../src/host/state')

const gate = { x: 0, y: 60, z: 0 }
const obsidian = { known: true, boundingBox: 'block', name: 'minecraft:obsidian', extra: [] }
const portal = { known: true, boundingBox: 'empty', name: 'minecraft:portal', extra: [] }
const empty = { known: true, boundingBox: 'empty', name: 'minecraft:air', extra: [] }
function fixture (dimension = 'nether', cargo = {}) {
  const server = createState('dragon-test')
  server.applyPacket('start_game', { dimension: 'overworld', runtime_entity_id: 1n, player_position: { x: 2.5, y: 61.62, z: 0.5 } })
  server.applyPacket('change_dimension', { dimension: dimension === 'nether' ? 1 : 0, position: { x: 2.5, y: 61.62, z: 0.5 } })
  const actors = createEntities({})
  actors.applyPacket('start_game', { dimension, runtime_entity_id: 1n })
  const items = Object.entries({ carrot: 32, arrow: 64, cobblestone: 64, ...cargo }).map(([name, count], slot) => ({ name: 'minecraft:' + name, count, slot }))
  const memory = { nether: { gate, homeGate: gate, sheltered: true, roundTrip: true }, lastLife: { connectionId: 'a', deathId: 0 } }
  return { memory, shared: {}, cancelled: () => false, getFeet: () => ({ x: 2.5, y: 60, z: 0.5 }), where: () => ({ x: 2.5, y: 61.62, z: 0.5 }),
    getBlock: (x, y, z) => y === 59 ? obsidian : x === 0 && [60, 61].includes(y) && z === 0 ? portal : empty,
    runtime: { raw: () => ({ dimension: server.snapshot().dimension, health: 20, connectionId: 'a' }), inventory: () => ({ known: true, items }), host: () => ({ entities: actors, world: {} }), armor: () => ({ known: true, worn: [{ name: 'minecraft:golden_boots' }] }) },
    supplies: { countPotion: () => 0, prepare: async () => ({ done: true }), remainingEffect: () => 0 }, hands: { walk: async () => true } }
}

test('portal plan builds ten obsidian with grounded access steps and an empty 2 by 3 opening', () => {
  const plan = framePlan(gate), occupied = new Set(plan.map(s => JSON.stringify(s.position)))
  const obs = plan.filter(p => p.item === 'minecraft:obsidian')
  assert.equal(obs.length, 10)
  assert.equal(occupied.size, plan.length)
  for (let y = 61; y <= 63; y++) for (const x of [1, 2]) assert.equal(occupied.has(JSON.stringify({ x, y, z: 0 })), false)
  const ctx = fixture()
  assert.deepEqual(nearestGate(ctx.getBlock, { x: 3, y: 61, z: 1 }), gate)
  assert.equal(nearestGate(() => ({ known: false }), gate), null)
})

test('two witnessed rods lead back immediately, even with no brewing ingredients and only carrots as provisions', async () => {
  const ctx = fixture('nether', { blaze_rod: 2 })
  ctx.memory.nether.fortress = { x: 20, y: 60, z: 4 }
  const result = await stepNether(ctx)
  assert.equal(result.done, false)
  assert.equal(ctx.memory.nether.returning, 'first_rods')
})

test('a recorded departure and the same living connection distinguish portal travel from respawn or an old transition', () => {
  const ctx = fixture()
  ctx.memory.nether.departure = { from: 'nether', sequence: 2, connectionId: 'a', deathId: 3 }
  ctx.memory.lastTransition = { position: gate, from: 'nether', to: 'overworld', connectionId: 'a', deathId: 3, sequence: 3, respawn: false }
  const check = () => portalProof(ctx.memory, { connectionId: 'a' }, 'overworld')
  assert.equal(check(), true)
  for (const changed of [{ respawn: true }, { deathId: 4 }, { connectionId: 'b' }, { sequence: 2 }, { position: { ...gate, z: 30 } }]) {
    const save = ctx.memory.lastTransition
    ctx.memory.lastTransition = { ...save, ...changed }
    assert.equal(check(), false)
    ctx.memory.lastTransition = save
  }
})

test('remaining rods, powder and existing eyes are counted only after a confirmed trip back from the fortress', async () => {
  const ctx = fixture('overworld', { blaze_rod: 6, blaze_powder: 7, ender_eye: 1 })
  const n = ctx.memory.nether
  Object.assign(n, { brewed: true, returning: 'rods', departure: { from: 'nether', sequence: 1, connectionId: 'a', deathId: 0 } })
  ctx.memory.lastTransition = { position: gate, from: 'nether', to: 'overworld', sequence: 2, connectionId: 'a', deathId: 0, respawn: false }
  assert.equal(eyeBudget(ctx), 20)
  const out = await stepNether(ctx)
  assert.equal(out.done, true)
  assert.equal(n.fortressReturn, true)
  assert.equal(ctx.shared.dragonGoldBoots, false)
})

test('rod farming switches to a return trip when no fire resistance remains', async () => {
  const ctx = fixture('nether', { blaze_rod: 1 })
  Object.assign(ctx.memory.nether, { firstReturned: true, brewed: true })
  const actors = ctx.runtime.host().entities
  actors.applyPacket('add_entity', { runtime_id: 45n, unique_id: 83n, entity_type: 'minecraft:blaze', position: { x: 8.5, y: 60, z: 0.5 } })
  assert.equal(actors.nearby(ctx.where(), { kind: 'all', radius: 40 })[0].entityType, 'minecraft:blaze')
  await stepNether(ctx)
  assert.equal(ctx.memory.nether.returning, 'supplies')
})

test('a manually stopped expedition sends no navigation or item use', async () => {
  const ctx = fixture()
  ctx.signal = AbortSignal.abort()
  ctx.runtime.host = () => { throw new Error('unexpected world access') }
  assert.equal((await stepNether(ctx)).phase, 'waiting')
})

test('first cargo banks before another outing and is withdrawn only when the brewing ingredients have arrived', async () => {
  const ctx = fixture('overworld', { blaze_rod: 2 })
  const calls = [], cargo = ctx.runtime.inventory().items
  ctx.shared.playerHouse = { origin: { x: 0, y: 58, z: 10 } }
  ctx.shared.playerBase = { x: 2, y: 60, z: 0 }
  ctx.operations = { interactions: { useDoor: () => {} } }
  const n = ctx.memory.nether
  n.firstReturned = true
  ctx.supplies.store = async (p, id, amount) => { calls.push(['deposit', id, amount]); cargo.find(i => i.name === 'minecraft:blaze_rod').count = 0; return { done: true, reason: 'deposited' } }
  ctx.supplies.withdraw = async (p, id, amount) => { calls.push(['withdraw', id, amount]); cargo.find(i => i.name === 'minecraft:blaze_rod').count = 2; return { done: true, reason: 'withdrawn' } }
  await stepNether(ctx)
  assert.equal(n.banked, true)
  await stepNether(ctx)
  assert.deepEqual(calls, [['deposit', 'blaze_rod', 2]])
  cargo.push(...['nether_wart', 'magma_cream'].map((name, i) => ({ name: 'minecraft:' + name, count: 1, slot: i + 6 })))
  await stepNether(ctx)
  assert.deepEqual(calls.at(-1), ['withdraw', 'blaze_rod', 2])
  assert.equal(n.brewing, true)
})

test('Bedrock 1.26.60 walks up onto the obsidian, crosses a real portal block and holds neutral input inside it', async () => {
  const { createNavigator } = require('../src/movement/navigation')
  const { useGate } = require('../src/modes/dragon-nether-portal')
  const lower = { x: 1, y: 61, z: 0 }
  const basalt = { ...obsidian, name: 'minecraft:netherrack', properties: {} }
  const world = { getBlock (x, y, z) {
    if (y < 60) return basalt
    if (z === 0 && x >= 0 && x <= 3 && (y === 60 || y === 64 || (x === 0 || x === 3) && y < 64)) return { ...obsidian, properties: {} }
    if (z === 0 && [1, 2].includes(x) && y >= 61 && y < 64) return { ...portal, properties: { portal_axis: 'x' } }
    return { ...empty, properties: {} }
  } }
  const nav = createNavigator({ world, version: '1.26.60' })
  let physics = nav.physics.fromServer({ position: { x: 1.5, y: 61.62, z: 2.5 }, rotation: { yaw: 180, pitch: 0 }, gameMode: 'survival' })
  let walks = 0
  const ctx = { getBlock: world.getBlock, getFeet: () => physics.position, hands: { walk: async target => {
    walks++
    const path = nav.plan(physics, target, { maxDistance: 16 })
    assert.equal(path.ready, true, path.reason)
    const stepper = nav.createStepper(path, physics)
    for (let frame = 0; frame < 160; frame++) {
      const step = stepper.next()
      if (step.phase === 'moving' || step.phase === 'settling') continue
      assert.equal(step.phase, 'awaiting_server_confirmation', step.reason)
      physics = step.predictedState
      return true
    }
    assert.fail('portal entry timed out')
  } } }
  assert.equal((await useGate(ctx, lower, 'nether')).done, false)
  for (let tick = 0; tick < 100; tick++) {
    physics = nav.physics.step(physics, {})
    const p = physics.position
    assert.equal(world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.001), Math.floor(p.z)).name, 'minecraft:portal')
  }
  assert.equal((await useGate(ctx, lower, 'nether')).done, false)
  assert.equal(walks, 1, 'no extra movement before the host confirms a dimension change')
})

test('a suspended Nether portal builds only toward a visible supported floor cell and holds on unknown or lava', () => {
  const { landingStep } = require('../src/modes/dragon-nether')
  const ctx = { getBlock: (x, y, z) => y === gate.y && x === 0 && z === 0 ? { ...portal, properties: { portal_axis: 'x' } } :
    y === gate.y - 1 && x === 0 && z === 0 ? obsidian : empty }
  assert.deepEqual(landingStep(ctx, gate), { x: 0, y: 59, z: 1 })
  const read = ctx.getBlock
  ctx.getBlock = (x, y, z) => y === 59 && z === 1 ? { ...empty, name: 'minecraft:lava' } : y === 59 && z === -1 ? { known: false } : read(x, y, z)
  assert.equal(landingStep(ctx, gate), null)
})
