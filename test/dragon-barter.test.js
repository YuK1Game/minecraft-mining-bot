'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  PEARL_TARGET,
  PIGLIN_COOLDOWN_MS,
  BARTER_WAIT_AFTER_DROP_MS,
  MAX_SURVEY_STEPS,
  barterGoldGoal,
  isBarterablePiglin,
  barterDrops,
  stepBarter
} = require('../src/modes/dragon-barter')
const { stepNether } = require('../src/modes/dragon-nether')
const { createDragonStronghold } = require('../src/modes/dragon-stronghold')
const { createEntities } = require('../src/host/entities')
const { createState } = require('../src/host/state')

const gate = { x: 0, y: 60, z: 0 }
const obsidian = { known: true, boundingBox: 'block', name: 'minecraft:obsidian', extra: [] }
const portal = { known: true, boundingBox: 'empty', name: 'minecraft:portal', extra: [] }
const empty = { known: true, boundingBox: 'empty', name: 'minecraft:air', extra: [] }

function makeNetherCtx ({ dimension = 'nether', cargo = {}, worn = [{ name: 'minecraft:golden_boots' }], health = 20, drop = null, now = () => 100000 } = {}) {
  const server = createState('barter-test')
  server.applyPacket('start_game', { dimension: 'overworld', runtime_entity_id: 1n, player_position: { x: 2.5, y: 61.62, z: 0.5 } })
  server.applyPacket('change_dimension', { dimension: dimension === 'nether' ? 1 : 0, position: { x: 2.5, y: 61.62, z: 0.5 } })
  const actors = createEntities({})
  actors.applyPacket('start_game', { dimension, runtime_entity_id: 1n })
  const items = Object.entries({ cooked_beef: 32, cobblestone: 64, ...cargo }).map(([name, count], slot) => ({ name: 'minecraft:' + name, count, slot }))
  const memory = {
    nether: { gate, homeGate: gate, sheltered: true, roundTrip: true, brewed: true, fortressReturn: true, barterGoal: PEARL_TARGET },
    lastLife: { connectionId: 'a', deathId: 0 }
  }
  const walks = []
  const acquired = []
  const ctx = {
    memory,
    shared: {},
    cancelled: () => false,
    getFeet: () => ({ x: 2.5, y: 60, z: 0.5 }),
    where: () => ({ x: 2.5, y: 61.62, z: 0.5 }),
    getBlock: (x, y, z) => y === 59 ? obsidian : x === 0 && [60, 61].includes(y) && z === 0 ? portal : empty,
    runtime: {
      raw: () => ({ dimension: server.snapshot().dimension, health, connectionId: 'a' }),
      inventory: () => ({ known: true, items }),
      host: () => ({ entities: actors, world: {} }),
      armor: () => ({ known: true, worn })
    },
    supplies: {
      countPotion: () => 1,
      prepare: async () => ({ done: true }),
      remainingEffect: () => 0,
      acquire: async (name, count) => { acquired.push([name, count]); return { done: false, reason: `acquiring ${name} ${count}` } }
    },
    operations: { armor: { equipBest: async () => {} } },
    hands: { walk: async p => { walks.push(p); return true }, approach: async () => true },
    drop: drop ?? (async (slot, count) => {
      const row = items.find(i => i.slot === slot)
      if (!row || row.count < count) return { phase: 'failed', serverConfirmed: false }
      row.count -= count
      return { phase: 'completed', serverConfirmed: true, slot, count, left: row.count }
    }),
    now
  }
  return { ctx, actors, items, walks, acquired }
}

test('barterGoldGoal clamps batch size cleanly between 16 and 48 ingots', () => {
  assert.equal(barterGoldGoal(1), 16)
  assert.equal(barterGoldGoal(4), 16)
  assert.equal(barterGoldGoal(6), 24)
  assert.equal(barterGoldGoal(20), 48)
})

test('isBarterablePiglin accepts peaceful adult Nether Piglins and rejects babies, brutes and unsafe neighbors', () => {
  const adult = { runtimeId: '10', entityType: 'minecraft:piglin', dimension: 'nether', alive: true, positionKnown: true, position: { x: 4, y: 60, z: 0 }, hostile: false, animalMeta: { flagsKnown: true, baby: false } }
  assert.equal(isBarterablePiglin(adult, [adult]), true)
  assert.equal(isBarterablePiglin({ ...adult, animalMeta: { flagsKnown: true, baby: true } }, [adult]), false)
  assert.equal(isBarterablePiglin({ ...adult, baby: true }, [adult]), false)
  assert.equal(isBarterablePiglin({ ...adult, dimension: 'overworld' }, [adult]), false)
  assert.equal(isBarterablePiglin({ ...adult, entityType: 'minecraft:piglin_brute' }, [adult]), false)
  const bruteNear = { runtimeId: '11', entityType: 'minecraft:piglin_brute', dimension: 'nether', alive: true, positionKnown: true, position: { x: 6, y: 60, z: 0 } }
  assert.equal(isBarterablePiglin(adult, [adult, bruteNear]), false)
})

test('barterDrops prioritizes ender pearls and potions ahead of secondary loot', () => {
  const drops = barterDrops([
    { kind: 'item', name: 'minecraft:string' },
    { kind: 'item', name: 'minecraft:obsidian' },
    { kind: 'item', name: 'minecraft:ender_pearl' },
    { kind: 'item', name: 'minecraft:potion' },
    { kind: 'item', name: 'minecraft:netherrack' }
  ])
  assert.deepEqual(drops.map(d => d.name), [
    'minecraft:ender_pearl',
    'minecraft:potion',
    'minecraft:obsidian',
    'minecraft:string'
  ])
})

test('stepBarter requires golden boots, paces 1 ingot per adult Piglin on server confirmation, and collects dropped pearls first', async () => {
  let clock = 100000
  const dropsSent = []
  const { ctx, actors, items, walks } = makeNetherCtx({
    cargo: { gold_ingot: 4 },
    drop: async (slot, count) => {
      dropsSent.push([slot, count])
      const row = items.find(i => i.slot === slot)
      row.count -= count
      return { phase: 'completed', serverConfirmed: true, slot, count, left: row.count }
    },
    now: () => clock
  })
  actors.applyPacket('add_entity', {
    runtime_id: 40n,
    unique_id: 40n,
    entity_type: 'minecraft:piglin',
    position: { x: 4.5, y: 60, z: 0.5 },
    metadata: [{ key: 'flags', value: { baby: false, tamed: false, leashed: false } }]
  })

  // Drops 1 gold ingot to the nearby adult Piglin and records cooldown.
  const first = await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20, now: () => clock })
  assert.equal(first.done, false)
  assert.equal(dropsSent.length, 1)
  assert.equal(dropsSent[0][1], 1)
  assert.equal(items.find(i => i.name === 'minecraft:gold_ingot').count, 3)

  // Within cooldown, does not spam another ingot at the same Piglin.
  clock += 2000
  const waiting = await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20, now: () => clock })
  assert.equal(dropsSent.length, 1)
  assert.match(waiting.reason, /待っています/)

  // When a pearl drops on reachable ground, retrieves it before dropping more gold.
  actors.applyPacket('item_registry', { itemstates: [{ runtime_id: 99, name: 'minecraft:ender_pearl' }] })
  actors.applyPacket('add_item_entity', {
    runtime_entity_id: 50n,
    entity_id_self: 50n,
    item: { network_id: 99, count: 4 },
    position: { x: 3.5, y: 60, z: 0.5 }
  })
  clock += PIGLIN_COOLDOWN_MS
  const pickup = await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20, now: () => clock })
  assert.equal(dropsSent.length, 1)
  assert.equal(walks.length, 1)
  assert.match(pickup.reason, /ドロップ/)

  // Once server-confirmed inventory holds 20 pearls, initiates return to overworld.
  actors.applyPacket('take_item_entity', { runtime_entity_id: 50n })
  items.push({ name: 'minecraft:ender_pearl', count: 20, slot: 8 })
  await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20, now: () => clock })
  assert.equal(ctx.memory.nether.returning, 'barter')
})

test('stepBarter retreats when golden boots are missing and no spare boots are held', async () => {
  const { ctx } = makeNetherCtx({ cargo: { gold_ingot: 16 }, worn: [{ name: 'minecraft:diamond_boots' }] })
  await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20 })
  assert.equal(ctx.memory.nether.returning, 'supplies')
})

test('stepBarter waits briefly after last gold drop, then returns to restock gold', async () => {
  let clock = 200000
  const { ctx } = makeNetherCtx({ cargo: {}, now: () => clock })
  ctx.memory.nether.lastBarterDropAt = clock - 1000
  const wait = await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20, now: () => clock })
  assert.equal(ctx.memory.nether.returning, undefined)
  assert.match(wait.reason, /待っています/)

  clock += BARTER_WAIT_AFTER_DROP_MS
  await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20, now: () => clock })
  assert.equal(ctx.memory.nether.returning, 'barter')
})

test('stepBarter marks barterExhausted and returns when no Piglin is found within survey budget', async () => {
  const { ctx } = makeNetherCtx({ cargo: { gold_ingot: 16 } })
  ctx.memory.nether.barterSurveySteps = MAX_SURVEY_STEPS
  await stepBarter(ctx, ctx.memory.nether, { pearlTarget: 20 })
  assert.equal(ctx.memory.nether.barterExhausted, true)
  assert.equal(ctx.memory.nether.returning, 'barter_none')
})

test('stepNether acquires gold_ingot in overworld for barterGoal and completes when pearls reach target', async () => {
  const { ctx, items, acquired } = makeNetherCtx({ dimension: 'overworld', cargo: { ender_pearl: 5 } })
  const res = await stepNether(ctx)
  assert.equal(res.done, false)
  assert.deepEqual(acquired, [['gold_ingot', 48]])

  items.find(i => i.name === 'minecraft:ender_pearl').count = 20
  const done = await stepNether(ctx)
  assert.equal(done.done, true)
  assert.equal(ctx.memory.nether.barterGoal, undefined)
  assert.equal(ctx.shared.dragonGoldBoots, false)
})

test('stronghold prefers Nether Piglin bartering for pearls and falls back to cave Enderman hunt when exhausted', async () => {
  const AIR = { name: 'minecraft:air', known: true, boundingBox: 'empty', runtimeId: 0, extra: [] }
  const makeJob = record => createDragonStronghold({
    shared: {},
    getFeet: () => ({ x: 3, y: 63, z: 2 }),
    where: () => ({ x: 3, y: 64.62, z: 2 }),
    hands: { walk: async () => true, approach: async () => true },
    getBlock: () => AIR,
    operations: { quarry: { travelStatus: () => ({ busy: false }) }, interactions: {}, inventory: { equip: async () => {} } },
    supplies: { acquire: async () => ({ done: false, reason: 'wait' }) },
    cancelled: () => false,
    runtime: {
      raw: () => ({ dimension: 'overworld' }),
      inventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:blaze_powder', count: 20 }] }),
      host: () => ({ entities: { snapshot: () => [] } })
    }
  })

  const barterRecord = {
    stage: 'stronghold',
    stronghold: { surface: { x: 42, y: 63, z: 2 } },
    nether: { homeGate: { x: 2, y: 63, z: 2 } }
  }
  const routed = await makeJob(barterRecord).step(barterRecord)
  assert.equal(barterRecord.stage, 'nether')
  assert.equal(barterRecord.nether.barterGoal, 20)
  assert.equal(barterRecord.stronghold.resumeSurface, true)
  assert.match(routed.reason, /ピグリン交易/)

  const fallbackRecord = {
    stage: 'stronghold',
    stronghold: {},
    nether: { homeGate: { x: 2, y: 63, z: 2 }, barterExhausted: true }
  }
  const cave = await makeJob(fallbackRecord).step(fallbackRecord)
  assert.equal(fallbackRecord.stage, 'stronghold')
  assert.match(cave.reason, /洞窟/)
})
