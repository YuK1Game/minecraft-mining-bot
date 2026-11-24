'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineActions, visibleMinePlacement } = require('../src/modes/mining/mine-actions')
const { receivedLight, createMineLighting } = require('../src/modes/mining/mine-lighting')
const { bottomSlab } = require('../src/modes/mining/mine-observed')
const { cargo } = require('../src/modes/mining/mine-storage')
const { createMineGeometry, mineSteps, stepCells } = require('../src/modes/mining/mine-geometry')

const solid = { known: true, name: 'minecraft:stone', boundingBox: 'block' }
const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
function fixture () {
  const state = { profile: 'test', realm: { id: 'realm' }, dimension: 'overworld', phase: 'spawned', health: 20, connectionId: 'a', startedAt: 'start', runtimeEntityId: '1', lifecycle: { deathId: 0 } }
  const inventory = { known: true, items: [{ slot: 0, name: 'minecraft:cobblestone', count: 10 }, { slot: 1, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100 }] }
  let placed = air, stop = false, sends = 0, receive = false, proofs = true, feet = { x: 0.5, y: 0.5, z: 0.5 }
  const ctx = { runtime: { raw: () => state, inventory: () => inventory, mineConfirmPosition: async () => ({ serverConfirmed: proofs }) },
    shared: {}, memory: { early: { mine: { branch: { plan: { scope: { profile: 'test', realmId: 'realm', dimension: 'overworld' } } } } } },
    getBlock: (x, y, z) => x === 1 && y === 1 && z === 1 ? placed : solid,
    getFeet: () => feet, cancelled: () => stop, saveMine: async () => true, hands: { walk: async to => { feet = { ...to }; return true }, mine: async () => { placed = air; return true } },
    operations: { interactions: { previewHouseBlock: () => ({ ready: true }), placeHouseBlock: async () => { sends++; if (receive) { placed = { ...solid, name: 'minecraft:cobblestone' }; inventory.items[0].count-- } } }, crafting: {}, inventory: {} }
  }
  return { ctx, ports: createMineActions(ctx), state, inventory, sends: () => sends, setReceive: value => { receive = value }, stop: () => { stop = true }, setProof: value => { proofs = value } }
}

test('real HousePorts placement does not complete or replay without block and inventory receipts', async () => {
  const f = fixture(), request = { position: { x: 1, y: 1, z: 1 }, name: 'cobblestone' }
  const first = await f.ports.place(request)
  assert.equal(first.code, 'MINE_PLACEMENT_UNCONFIRMED')
  assert.equal(f.ctx.memory.early.mine.branch.pendingAction.stage, 'attempting')
  const second = await f.ports.place(request)
  assert.equal(second.code, 'MINE_ACTION_UNCONFIRMED')
  assert.equal(f.sends(), 1)
})

test('an unconfirmed ordinary placement is retried once after confirmed air and replenished stock', async () => {
  const f = fixture(), request = { position: { x: 1, y: 1, z: 1 }, name: 'cobblestone' }
  const branch = f.ctx.memory.early.mine.branch
  assert.equal((await f.ports.place(request)).code, 'MINE_PLACEMENT_UNCONFIRMED')
  const original = branch.pendingAction
  f.ctx.runtime.minePlacementAudit = async () => ({ target: { serverConfirmed: false } })
  assert.equal(await f.ports.reconcilePlacement(), false)
  assert.equal(branch.pendingAction, original)
  f.ctx.runtime.minePlacementAudit = async () => ({ target: { serverConfirmed: true } })
  f.inventory.items[0].count--
  assert.equal(await f.ports.reconcilePlacement(), false)
  assert.equal(branch.pendingAction, original)

  f.inventory.items[0].count++
  assert.equal(await f.ports.reconcilePlacement(), true)
  assert.equal(branch.pendingAction, undefined)
  assert.equal(branch.lastReconciledPlacement.pending, original)
  assert.equal(f.sends(), 1)

  assert.equal((await f.ports.place(request)).code, 'MINE_PLACEMENT_UNCONFIRMED')
  assert.equal(branch.pendingAction.retryAfterAudit, true)
  assert.equal(await f.ports.reconcilePlacement(), false)
  assert.equal((await f.ports.place(request)).code, 'MINE_ACTION_UNCONFIRMED')
  assert.equal(f.sends(), 2)
})

test('a placement audit does not clear the checkpoint after a scope change or failed save', async () => {
  const f = fixture(), request = { position: { x: 1, y: 1, z: 1 }, name: 'cobblestone' }
  await f.ports.place(request)
  const branch = f.ctx.memory.early.mine.branch, original = branch.pendingAction
  f.ctx.runtime.minePlacementAudit = async () => {
    f.state.connectionId = 'changed'
    return { target: { serverConfirmed: true } }
  }
  assert.equal(await f.ports.reconcilePlacement(), false)
  assert.equal(branch.pendingAction, original)
  f.state.connectionId = 'a'
  f.ctx.runtime.minePlacementAudit = async () => ({ target: { serverConfirmed: true } })
  f.ctx.saveMine = async () => false
  assert.equal(await f.ports.reconcilePlacement(), false)
  assert.equal(branch.pendingAction, original)
  assert.equal(branch.lastReconciledPlacement, undefined)
})

test('received placement clears its durable intent and cancelled runs cannot reuse a block as progress', async () => {
  const f = fixture(), request = { position: { x: 1, y: 1, z: 1 }, name: 'cobblestone' }
  f.setReceive(true)
  const result = await f.ports.place(request)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.ctx.memory.early.mine.branch.pendingAction, undefined)
  assert.equal(f.inventory.items[0].count, 9)
  f.stop()
  assert.equal((await f.ports.place(request)).status, 'interrupted')
})

test('movement prediction is followed by the server position witness', async () => {
  const f = fixture(), destination = { x: 0.5, y: 0.5, z: 0.5 }
  f.setProof(false)
  assert.equal((await f.ports.walk(destination)).code, 'MINE_POSITION_UNCONFIRMED')
  f.setProof(true)
  assert.equal((await f.ports.walk(destination)).serverConfirmed, true)
})

test('a supported navigator arrival is witnessed at its actual position and a wide miss is rejected', async () => {
  const f = fixture(), destination = { x: 1.5, y: 66, z: 6.5 }, actual = { x: 1.6487445, y: 66, z: 6.49555 }, requested = []
  f.ctx.getFeet = () => actual
  f.ctx.runtime.mineConfirmPosition = async to => { requested.push(to); return { serverConfirmed: true } }
  assert.equal((await f.ports.confirmPosition(destination)).serverConfirmed, true)
  assert.deepEqual(requested, [actual])
  actual.x = 1.71
  assert.equal((await f.ports.confirmPosition(destination)).code, 'MINE_POSITION_UNCONFIRMED')
  assert.equal(requested.length, 1)
})

test('a replaced Realm cannot apply an old mine placement', async () => {
  const f = fixture()
  f.state.realm.id = 'other'
  assert.equal((await f.ports.place({ position: { x: 1, y: 1, z: 1 }, name: 'cobblestone' })).code, 'MINE_SCOPE_UNKNOWN')
  assert.equal(f.sends(), 0)
})

test('a received unchanged block can resume an interrupted break after a new connection', async () => {
  const f = fixture(), position = { x: 1, y: 1, z: 1 }
  f.setReceive(true)
  await f.ports.place({ position, name: 'cobblestone' })
  f.ctx.memory.early.mine.branch.pendingAction = { key: 'dig:1,1,1', kind: 'dig', position, scope: 'previous-connection', stage: 'attempting' }
  f.state.connectionId = 'next'
  const resumed = await f.ports.mine(position)
  assert.equal(resumed.code, 'MINE_AIR_RECEIVED')
  assert.equal(resumed.serverConfirmed, true)
  assert.equal(f.ctx.memory.early.mine.branch.pendingAction, undefined)
})

test('a corridor uses a disposable iron-or-below pick down to 1 use, and pauses at 0 or on a reserved diamond pick', async () => {
  const f = fixture(), position = { x: 1, y: 1, z: 1 }
  f.setReceive(true)
  await f.ports.place({ position, name: 'cobblestone' })
  f.inventory.items[1].name = 'minecraft:diamond_pickaxe'
  f.inventory.items[1].durabilityRemaining = 2
  assert.equal((await f.ports.mine(position)).code, 'MINE_TOOL_SUPPLY')
  assert.equal(f.ctx.getBlock(1, 1, 1).name, 'minecraft:cobblestone')
  f.inventory.items[1].name = 'minecraft:iron_pickaxe'
  f.inventory.items[1].durabilityRemaining = 1
  assert.equal((await f.ports.mine(position)).code, 'MINE_AIR_RECEIVED')
})

test('spawn prevention requires a received bottom slab property', () => {
  const slab = { ...solid, name: 'minecraft:cobblestone_slab' }
  assert.equal(bottomSlab(slab), false)
  assert.equal(bottomSlab({ ...slab, properties: { top_slot_bit: 1 } }), false)
  assert.equal(bottomSlab({ ...slab, properties: { 'minecraft:vertical_half': { value: 'bottom' } } }), true)
})

test('finishing cannot open a floor hole when no replacement slab is carried', async () => {
  const position = { x: 1, y: 0, z: 1 }
  const ctx = { cancelled: () => false, getBlock: () => solid }
  const light = createMineLighting(ctx, { block: () => solid, inventory: () => ({ known: true, items: [] }), mine: () => assert.fail('the supported floor must stay in place') })
  const out = await light.finish({ finish: { lightTarget: 8 } }, { shaft: true, clear: [], floor: [position] })
  assert.equal(out.code, 'MINE_FLOOR_MATERIAL_MISSING')
})

test('light crosses received open cells but not a wall, unknown cell, lava or a temporary furnace', () => {
  const target = [{ x: 0, y: 1, z: 0 }]
  const corridor = (middle, source = 'minecraft:torch') => (x, y, z) => {
    if (y !== 1 || z !== 0 || x < 0 || x > 3) return solid
    if (x === 1 && middle) return middle
    return x === 3 ? { known: true, name: source, boundingBox: 'empty' } : air
  }
  assert.equal(receivedLight(corridor(null), target).safe, true)
  for (const barrier of [solid, { known: false }]) assert.equal(receivedLight(corridor(barrier), target).safe, false)
  for (const name of ['minecraft:lava', 'minecraft:lit_furnace', 'minecraft:soul_torch']) assert.equal(receivedLight(corridor(null, name), target).safe, false)
})

test('planned cargo stores surplus ores and rubble while retaining requested material and repair blocks', () => {
  const inventory = { known: true, items: [
    { slot: 0, name: 'minecraft:diamond', count: 32 }, { slot: 1, name: 'minecraft:cobblestone', count: 64 },
    { slot: 2, name: 'minecraft:cobblestone', count: 64 }, { slot: 3, name: 'minecraft:iron_pickaxe', count: 1 },
    { slot: 4, name: 'minecraft:torch', count: 32 }, { slot: 5, name: 'minecraft:raw_iron', count: 64 }
  ] }
  assert.deepEqual(cargo(inventory, { diamond: 8, raw_iron: 32 }).map(i => [i.slot, i.count]), [[0, 24], [2, 64], [5, 32]])
  assert.equal(cargo({ ...inventory, uncertain: true }), null)
})

test('each layer has sized cargo pairs plus a separated supply pair', () => {
  const plan = createMineGeometry({ scope: { profile: 'test', realmId: 'realm', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, width: 24, length: 24, surfaceY: 64, upperY: 16, lowerY: -54, expectedDrops: { upper: 6000, lower: 9000 } })
  for (const room of plan.storage) {
    assert.equal(room.pairs.filter(p => p.purpose === 'cargo').length, Math.ceil(Math.ceil(room.estimatedDrops / 64) / 43))
    assert.equal(room.pairs.filter(p => p.purpose === 'supply').length, 1)
    for (const a of room.pairs) for (const b of room.pairs) if (a !== b) for (const p of a.positions) for (const q of b.positions) assert.ok(Math.abs(p.x - q.x) + Math.abs(p.z - q.z) > 1)
  }
})

test('a cave seal uses the visible side when its first support is hidden', () => {
  const position = { x: 3, y: 1, z: 3 }, feet = { x: 1.515, y: -0.5, z: 2.504 }
  const supports = new Set(['3,0,3', '2,1,3', '4,1,3'])
  const block = p => supports.has([p.x, p.y, p.z].join(',')) ? solid : air
  const request = { position, name: 'cobblestone' }
  assert.equal(visibleMinePlacement(block, { ...request, clicked: { x: 3, y: 0, z: 3 }, face: 1 }, feet), null)
  assert.equal(visibleMinePlacement(block, request, feet)?.face, 5)
})

test('an air opening in a future torch position keeps its temporary seal record', async () => {
  const plan = createMineGeometry({ scope: { profile: 'test', realmId: 'realm', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const steps = mineSteps(plan, { layer: 'upper' }), index = steps.findIndex(step => step.kind === 'storage')
  const current = stepCells(plan, steps[index]), next = stepCells(plan, steps[index + 1])
  const target = next.torch[0].position
  const adjacent = current.clear.find(p => Math.abs(p.x - target.x) + Math.abs(p.z - target.z) === 1 && p.y === target.y)
  assert.ok(adjacent)
  const here = p => p.x === target.x && p.y === target.y && p.z === target.z
  const branch = { plan, progress: { upper: { cursor: index } }, temporarySeals: [] }
  const ctx = { memory: { early: { mine: { branch } } }, getBlock: (x, y, z) => here({ x, y, z }) ? air : solid,
    getFeet: () => ({ x: adjacent.x + 0.5, y: adjacent.y - 1, z: adjacent.z + 0.5 }), cancelled: () => false }
  let recorded = false
  const actions = { block: p => ctx.getBlock(p.x, p.y, p.z), done: () => ({ status: 'completed', serverConfirmed: true }),
    inventory: () => ({ known: true, items: [{ name: 'minecraft:cobbled_deepslate', count: 1 }] }),
    save: async () => { recorded = branch.temporarySeals.some(at => here(at) && at.name === 'minecraft:cobbled_deepslate'); return true },
    place: ({ position, name }) => { assert.deepEqual(position, target); assert.equal(name, 'minecraft:cobbled_deepslate'); assert.equal(recorded, true); return { status: 'interrupted', code: 'AFTER_SEAL_CHECKPOINT' } } }
  const out = await createMineLighting(ctx, actions).finish(plan, current)
  assert.equal(out.code, 'AFTER_SEAL_CHECKPOINT')
})

test('a future planned corridor is sealed when it opens into an unfinished cave', () => {
  const plan = createMineGeometry({ scope: { profile: 'test', realmId: 'realm', dimension: 'overworld' }, anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 16, lowerY: -54 })
  const steps = mineSteps(plan, { layer: 'upper' }), index = steps.findIndex(step => step.kind === 'main'), current = stepCells(plan, steps[index]), next = stepCells(plan, steps[index + 1])
  const future = new Set(next.clear.map(p => `${p.x},${p.y},${p.z}`))
  const ctx = { memory: { early: { mine: { branch: { plan, progress: { upper: { cursor: index } } } } } }, getBlock: () => air }
  const light = createMineLighting(ctx, { block: () => air })
  assert.ok(light.boundary(plan, current).some(p => future.has(`${p.x},${p.y},${p.z}`)))
})
