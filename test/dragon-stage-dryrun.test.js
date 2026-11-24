'use strict'

// Stage-by-stage dry-run integration tests covering Nether -> Stronghold -> End
// transitions and completion criteria before full live-Realm end-to-end runs.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { stepNether } = require('../src/modes/dragon-nether')
const { createDragonStronghold } = require('../src/modes/dragon-stronghold')
const { runDragonEndStep } = require('../src/modes/dragon-end')

function makeBlocks (entries) {
  const map = new Map()
  for (const [x, y, z, name, extra = {}] of entries) {
    map.set(`${x},${y},${z}`, { known: true, name, boundingBox: /air|portal|fire/.test(name) ? 'empty' : 'block', ...extra })
  }
  return (x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false }
}

test('dragon-stage-dryrun (Nether): records departure scope before portal crossing and verifies transition proof', async () => {
  const memory = {
    stage: 'nether',
    lastLife: { connectionId: 'conn-1', deathId: 0 },
    lastTransition: null,
    nether: { homeGate: { x: 4, y: 64, z: 4 }, gate: null, blazeDone: false }
  }
  const worldEntries = []
  for (let x = 0; x <= 8; x++) for (let z = 0; z <= 8; z++) {
    worldEntries.push([x, 63, z, 'minecraft:stone'])
    worldEntries.push([x, 64, z, 'minecraft:air'])
    worldEntries.push([x, 65, z, 'minecraft:air'])
  }
  worldEntries.push([4, 64, 4, 'minecraft:portal', { properties: { portal_axis: 'x' } }])
  const getBlock = makeBlocks(worldEntries)

  const ctx = {
    memory,
    shared: { playerHouse: { origin: { x: -20, y: 64, z: -20 } } },
    getBlock,
    getFeet: () => ({ x: 2.5, y: 64, z: 4.5 }),
    where: () => ({ x: 2.5, y: 65.62, z: 4.5 }),
    cancelled: () => false,
    log: () => {},
    runtime: {
      raw: () => ({ dimension: 'overworld', connectionId: 'conn-1', health: 20, dead: false }),
      armor: () => ({ known: true, worn: [{ name: 'minecraft:golden_boots' }] }),
      inventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:cooked_beef', count: 32 }, { slot: 1, name: 'minecraft:cobblestone', count: 64 }] })
    },
    supplies: {
      prepare: async () => ({ done: true, reason: 'ready' }),
      countPotion: () => 0,
      remainingEffect: () => 0,
      acquire: async () => ({ done: false, reason: 'supply' })
    },
    hands: { walk: async () => true, approach: async () => true },
    operations: { quarry: { travelStatus: () => ({ busy: false }) } }
  }

  // First tick saves the departure scope before stepping into the portal.
  const first = await stepNether(ctx)
  assert.equal(first.done, false)
  assert.equal(memory.nether.departure?.from, 'overworld')
  assert.equal(memory.nether.departure?.connectionId, 'conn-1')
  assert.equal(memory.nether.departure?.deathId, 0)
})

test('dragon-stage-dryrun (Stronghold): transitions back to Nether when blaze rods and powder are exhausted', async () => {
  const memory = {
    stage: 'stronghold',
    nether: { homeGate: { x: 10, y: 64, z: 10 } },
    stronghold: { surface: { x: 12, y: 64, z: 12 } }
  }
  const getBlock = makeBlocks([
    [10, 63, 10, 'minecraft:grass_block'],
    [10, 64, 10, 'minecraft:air'],
    [10, 65, 10, 'minecraft:air']
  ])
  const ctx = {
    memory,
    shared: { inventoryUncertain: false },
    getBlock,
    getFeet: () => ({ x: 10.5, y: 64, z: 10.5 }),
    where: () => ({ x: 10.5, y: 65.62, z: 10.5 }),
    cancelled: () => false,
    log: () => {},
    runtime: {
      raw: () => ({ dimension: 'overworld', health: 20, dead: false }),
      inventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:ender_pearl', count: 8 }] }),
      host: () => ({ entities: { snapshot: () => [] } })
    },
    hands: { walk: async () => true, approach: async () => true },
    supplies: { acquire: async () => ({ done: false, reason: 'waiting' }) },
    operations: {
      quarry: { travelStatus: () => ({ busy: false }) },
      interactions: {},
      inventory: { equip: async () => {} }
    }
  }
  const stronghold = createDragonStronghold(ctx)
  const res = await stronghold.step(memory, {})
  assert.equal(memory.stage, 'nether', 'missing blaze materials routes back to Nether')
  assert.equal(memory.stronghold.resumeSurface, true)
  assert.match(res.reason, /ネザー/)
})

test('dragon-stage-dryrun (End): completes only after verified End->Overworld non-respawn transition', async () => {
  const record = {
    victory: true,
    preexisting: false,
    returnAttempt: { connectionId: 'conn-end', sequence: 5, life: 2 }
  }
  const ctx = {
    memory: {
      lastTransition: {
        connectionId: 'conn-end',
        sequence: 6,
        deathId: 2,
        respawn: false,
        from: 'end',
        to: 'overworld'
      }
    },
    getBlock: () => ({ known: true, name: 'minecraft:air' }),
    getFeet: () => ({ x: 0.5, y: 64, z: 0.5 }),
    runtime: {
      raw: () => ({ dimension: 'overworld', health: 20, dead: false, spawnPending: false, lifecycle: { deathId: 2 } }),
      host: () => ({ getLife: () => ({ deathId: 2 }), entities: { snapshot: () => [] } })
    }
  }

  // A respawn transition must NEVER count as victory return.
  ctx.memory.lastTransition.respawn = true
  const rejected = await runDragonEndStep(ctx, record)
  assert.equal(rejected.phase, 'waiting')
  assert.notEqual(record.returned, true)

  // Real non-respawn portal transition completes the expedition.
  ctx.memory.lastTransition.respawn = false
  const done = await runDragonEndStep(ctx, record)
  assert.equal(done.phase, 'complete')
  assert.equal(record.returned, true)
})
