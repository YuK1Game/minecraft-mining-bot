'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMineActions } = require('../src/modes/mining/mine-actions')
const { createMineSupplies } = require('../src/modes/mining/mine-supplies')
const { scopeOf } = require('../src/modes/mining/mine-observed')
const { mineWorldScope } = require('../src/modes/mining/mine-state')

function makeCtx ({ blockAt, inventoryItems, pendingAction, auditOk = true }) {
  const rawState = {
    phase: 'spawned',
    dimension: 'overworld',
    health: 20,
    dead: false,
    profile: 'bot',
    realm: { id: '42' },
    connectionId: 'c1',
    startedAt: '2026-11-27T00:00:00.000Z',
    runtimeEntityId: '1',
    lifecycle: { deathId: 0 },
    position: { x: 9943.5, y: 65.62, z: 10234.5 }
  }
  const logs = []
  const branch = {
    plan: {
      scope: mineWorldScope(rawState),
      shaft: { topY: 64, bottomY: 48, columns: [{ x: 9943, z: 10234 }], ladder: { x: 9943, z: 10234, face: 2 }, stand: { x: 9943, y: 64, z: 10234 } },
      site: { direction: 'east', anchor: { x: 9940, z: 10200 }, length: 128, width: 128 },
      layers: [{ id: 'upper', y: 48, steps: [] }],
      storage: [{ layer: 'upper', pairs: [] }],
      entrance: { x: 9943, y: 64, z: 10234 }
    },
    shaft: { depth: 48 },
    pendingAction
  }
  const ctx = {
    shared: { inventoryUncertain: false },
    memory: { early: { mine: { branch } } },
    cancelled: () => false,
    signal: new AbortController().signal,
    getBlock: (x, y, z) => blockAt(x, y, z),
    getFeet: () => ({ x: 9943.5, y: 64, z: 10234.5 }),
    operations: {},
    runtime: {
      raw: () => rawState,
      mineState: () => rawState,
      inventory: () => ({ known: true, uncertain: false, items: inventoryItems }),
      minePlacementAudit: async () => ({ target: { serverConfirmed: auditOk } })
    },
    saveMine: async () => true,
    log: line => logs.push(String(line)),
    now: () => 50000
  }
  if (branch.pendingAction && branch.pendingAction.scope == null) {
    branch.pendingAction.scope = scopeOf(ctx)
  }
  return { ctx, branch, logs }
}

test('reconcilePlacement clears timed-out furnace placement when server confirms target is still air and furnace remains held', async () => {
  const pos = { x: 9944, y: 65, z: 10235 }
  const { ctx, branch, logs } = makeCtx({
    blockAt: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }),
    inventoryItems: [{ slot: 6, name: 'minecraft:furnace', count: 1 }],
    pendingAction: { kind: 'place', key: 'place:9944,65,10235', position: pos, name: 'minecraft:furnace', before: 1, at: 10000 }
  })
  const actions = createMineActions(ctx)
  const reconciled = await actions.reconcilePlacement()
  assert.equal(reconciled, true)
  assert.equal(branch.pendingAction, undefined)
  assert.equal(branch.lastReconciledPlacement?.evidence?.kind, 'current_target_air')
  assert.ok(logs.some(line => line.includes('minecraft:furnace') && line.includes('current_target_air')))
})

test('reconcilePlacement clears timed-out crafting_table placement when server already received the placed block', async () => {
  const pos = { x: 9944, y: 65, z: 10235 }
  const { ctx, branch, logs } = makeCtx({
    blockAt: () => ({ known: true, name: 'minecraft:crafting_table', boundingBox: 'block' }),
    inventoryItems: [],
    pendingAction: { kind: 'place', key: 'place:9944,65,10235', position: pos, name: 'minecraft:crafting_table', before: 1, at: 10000 }
  })
  const actions = createMineActions(ctx)
  const reconciled = await actions.reconcilePlacement()
  assert.equal(reconciled, true)
  assert.equal(branch.pendingAction, undefined)
  assert.equal(branch.lastReconciledPlacement?.evidence?.kind, 'current_structure_received')
  assert.ok(logs.some(line => line.includes('minecraft:crafting_table') && line.includes('current_structure_received')))
})

test('mine supplies never places a furnace on top of an interactive crafting_table (live 2026-11-27 10:05 JST)', async () => {
  const placedCalls = []
  const blockAt = (x, y, z) => {
    if (x === 9944 && y === 64 && z === 10235) return { known: true, name: 'minecraft:crafting_table', boundingBox: 'block' }
    if (y <= 63) return { known: true, name: 'minecraft:grass_block', boundingBox: 'block' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
  const { ctx } = makeCtx({
    blockAt,
    inventoryItems: [
      { slot: 0, name: 'minecraft:furnace', count: 1 },
      { slot: 1, name: 'minecraft:oak_log', count: 4 },
      { slot: 2, name: 'minecraft:oak_planks', count: 4 },
      { slot: 3, name: 'minecraft:stick', count: 16 },
      { slot: 4, name: 'minecraft:cobblestone_slab', count: 64 },
      { slot: 5, name: 'minecraft:cobblestone', count: 64 }
    ]
  })
  const actions = {
    block: p => blockAt(p.x, p.y, p.z),
    inventory: () => ctx.runtime.inventory(),
    place: async req => {
      placedCalls.push(req)
      return { status: 'completed', serverConfirmed: true, evidence: { serverConfirmed: true } }
    },
    walk: async () => ({ status: 'completed', serverConfirmed: true }),
    house: {
      smelt: async () => 1,
      smeltNeed: () => null,
      why: () => null
    }
  }
  const supplies = createMineSupplies(ctx, actions, { takeHome: async () => null, acquire: async () => ({ status: 'completed' }) })
  await supplies.ensure(ctx.memory.early.mine.branch.plan, { layer: 'upper', request: { item: 'raw_iron', count: 10 }, refillTorches: true })
  assert.ok(placedCalls.length >= 1, 'furnace placement was attempted')
  const req = placedCalls.find(c => c.name === 'furnace')
  assert.ok(req, 'furnace placement request present')
  assert.notDeepEqual(req.position, { x: 9944, y: 65, z: 10235 }, 'must not place furnace on top of crafting_table')
  assert.notEqual(blockAt(req.clicked.x, req.clicked.y, req.clicked.z).name, 'minecraft:crafting_table')
})
