'use strict'

const test = require('node:test'), assert = require('node:assert/strict')
const { plannerWorld } = require('./helpers/branch-mine-planner-world')
const { planMine, evaluateMineGeometry } = require('../src/modes/mining/mine-plan')
const { surveyMine } = require('../src/modes/mining/mine-survey')
const { planMineExtension } = require('../src/modes/mining/mine-extension')
const { createMineGeometry, extendMineGeometry, mineSteps, stepCells, point } = require('../src/modes/mining/mine-geometry')
const { mineWorldScope, createMineState, extendMineProgress, resumeMineState } = require('../src/modes/mining/mine-state')
const { ensureMineLayer } = require('../src/modes/mining/mine-sites')
const options = { origin: { x: 0.5, y: 64, z: 0.5 }, width: 24, length: 24, searchRadius: 0, upperYs: [32], maxCandidates: 8 }

test('received upper iron starts a real single-layer plan while every lower section remains unknown', async () => {
  const f = plannerWorld({ minSection: 1 })
  for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) f.put({ x, y: 32, z }, 'iron_ore')
  const out = await planMine({ ...f, ...options, resource: 'raw_iron', targetCount: 8 })
  assert.equal(out.code, 'MINE_TARGET_REACHABLE', JSON.stringify(out))
  assert.deepEqual(out.plan.layers, [{ id: 'upper', y: 32 }])
  assert.equal(out.plan.lowerPending, true); assert.equal(out.plan.shaft.bottomY, 32)
  assert.equal(f.world.getBlock(0, -54, 0).known, false)
  assert.ok(mineSteps(out.plan).every(step => step.layer === 'upper'))
  assert.ok(out.plan.storage.every(room => room.layer === 'upper'))
  assert.ok(out.plan.evaluation.oreUnion.every(ore => ore.position.y >= 31))
})

test('shaft exterior cave sealing counts a shared ladder backing once in the received material estimate', async () => {
  const f = plannerWorld(), plan = createMineGeometry({ scope: mineWorldScope(f.current), anchor: { x: 0, z: 0 }, width: 16, length: 16, surfaceY: 64, upperY: 32 })
  f.put(point(plan, 9, 32, 7), 'iron_ore')
  const evaluate = async () => {
    const survey = await surveyMine({ ...f, bounds: { min: { x: -4, y: 30, z: -4 }, max: { x: 20, y: 67, z: 20 } } })
    return evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => survey.at(p) })
  }
  const baseline = await evaluate()
  f.put({ ...plan.shaft.ladder.support, y: 40 }, 'air')
  const cave = await evaluate()
  assert.equal(baseline.eligible, true); assert.equal(cave.eligible, true)
  assert.equal(cave.costs.caveSealPlacements, baseline.costs.caveSealPlacements + 1)
  assert.equal(cave.costs.supportPlacements, baseline.costs.supportPlacements, 'the ladder backing is already paid by the shaft perimeter seal')
})

test('requested gold and redstone retain their own lower heights beside a deeper diamond, including heights above the lowest upper candidate', async () => {
  for (const [resource, block] of [['raw_gold', 'gold_ore'], ['redstone', 'redstone_ore']]) {
    const f = plannerWorld()
    for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) f.put({ x, y: 20, z }, block)
    f.put({ x: 0, y: -54, z: 0 }, 'deepslate_diamond_ore')
    const out = await planMine({ ...f, ...options, upperYs: [16, 32, 48], maxCandidates: 32, resource, targetCount: 8 })
    assert.equal(out.code, 'MINE_TARGET_REACHABLE', JSON.stringify(out))
    assert.equal(out.plan.layers.length, 2)
    assert.ok([19, 20].includes(out.plan.layers[1].y))
    assert.ok(out.plan.evaluation.availableTargetOre >= 8)
  }
})

function constructedUpper (f) {
  const plan = createMineGeometry({ scope: mineWorldScope(f.current), anchor: { x: 0, z: 0 }, width: 16, length: 16, surfaceY: 64, upperY: 32 })
  for (const step of mineSteps(plan)) {
    const cells = stepCells(plan, step)
    for (const p of cells.clear) f.put(p, 'air')
    for (const { position } of cells.floor) f.put(position, 'cobblestone_slab')
    for (const { position } of cells.torch) f.put(position, 'torch')
  }
  for (const room of plan.storage) for (const pair of room.pairs) for (const p of pair.positions) f.put(p, 'chest')
  for (let y = 32; y <= 64; y++) for (const [i, column] of plan.shaft.columns.entries()) f.put({ ...column, y }, i === 0 ? 'ladder' : 'cobblestone')
  for (const landing of plan.shaft.landings) {
    for (const p of landing.clear) f.put(p, 'air')
    for (const { position } of landing.floor) f.put(position, 'cobblestone_slab')
  }
  f.put({ ...plan.shaft.columns[3], y: 32 }, 'torch')
  f.put(plan.shaft.entryTorch.position, 'torch')
  return plan
}

test('a lower extension whose shaft would pass through a received cave is not planned', async () => {
  const f = plannerWorld(), plan = constructedUpper(f)
  for (let u = 8; u <= 12; u++) for (let v = 6; v <= 9; v++) f.put(point(plan, u, -20, v), 'diamond_ore')
  f.put({ ...plan.shaft.columns[2], y: 5 }, 'air')
  const out = await planMineExtension({ ...f, plan, resource: 'diamond', targetCount: 4 })
  assert.equal(out.status, 'blocked', JSON.stringify(out)); assert.equal(out.code, 'MINE_NO_SAFE_RESOURCE_PLAN')
})

test('lower extension surveys only new construction and preserves upper chests, slab floor, shaft identity and progress', async () => {
  const f = plannerWorld(), plan = constructedUpper(f)
  for (let u = 8; u <= 12; u++) for (let v = 6; v <= 9; v++) f.put(point(plan, u, -20, v), 'diamond_ore')
  const out = await planMineExtension({ ...f, plan, resource: 'diamond', targetCount: 4 })
  assert.equal(out.status, 'planned', JSON.stringify(out))
  const extended = out.plan
  assert.equal(extended.id, plan.id); assert.equal(extended.revision, 2); assert.equal(extended.lowerPending, false)
  assert.deepEqual(extended.site, plan.site)
  assert.deepEqual(extended.segments.filter(s => s.layer === 'upper'), plan.segments)
  assert.deepEqual(extended.storage.filter(s => s.layer === 'upper'), plan.storage)
  assert.deepEqual(extended.shaft.landings.filter(s => s.layer === 'upper'), plan.shaft.landings)
  assert.deepEqual(extended.shaft.ladder, plan.shaft.ladder)
  assert.equal(extended.evaluation.scope, 'lower_extension_only')
  assert.equal(extended.evaluation.existingUpperRequiresLiveValidation, true)
  assert.ok(extended.evaluation.oreUnion.every(ore => ore.position.y < 32))
  const upper = { ...createMineState(plan, { layer: 'upper' }), cursor: 1, confirmedSteps: 1, status: 'building' }
  const progress = extendMineProgress({ upper }, { previous: plan, plan: extended })
  assert.deepEqual(progress.upper, upper); assert.equal(progress.lower.cursor, 0)
  assert.equal(resumeMineState(progress.upper, { plan: extended, scope: extended.scope }).cursor, 1)
  const moved = structuredClone(extended); moved.segments[0].from.x++
  assert.throws(() => extendMineProgress({ upper }, { previous: plan, plan: moved }), /MOVED_EXISTING_WORK/)
})

test('unknown lower extension waits without altering durable upper work, then receives and saves the same-site expansion', async () => {
  const f = plannerWorld({ minSection: 1 }), plan = constructedUpper(f), upper = createMineState(plan, { layer: 'upper' })
  upper.cursor = 1; upper.confirmedSteps = 1; upper.status = 'building'
  const branch = { plan, progress: { upper }, shaft: { depth: 32, landings: { upper: true }, entry: true }, storage: { pairs: { 'upper:supply': { slots: 54 } } } }
  const before = structuredClone(branch), observed = [], saved = []
  const ctx = { shared: {}, memory: { early: { mine: { branch } } }, cancelled: () => false, getFeet: () => plan.shaft.approach, getBlock: f.world.getBlock,
    runtime: { mineState: f.getState, inventory: () => ({ known: true, items: [] }), host: () => ({ world: f.world }) }, minePorts: { observe: async request => {
      observed.push(request)
      return require('../src/modes/return/return-result').blocked('MINE_TERRAIN_UNREQUESTABLE', { kind: 'position_changed' }, { evidence: { requested: 0, packets: 0, reason: 'unannounced_or_pending' } })
    } }, saveMine: async () => { saved.push(structuredClone(branch)); return true } }
  const first = await ensureMineLayer(ctx, branch, { resource: 'diamond', targetHeld: 4 })
  assert.equal(first.status, 'blocked'); assert.equal(first.code, 'MINE_TERRAIN_UNREQUESTABLE')
  assert.deepEqual(branch.plan, before.plan); assert.deepEqual(branch.progress, before.progress)
  assert.ok(observed.length > 0)
  const previousSearch = branch.extensionSearch
  await ensureMineLayer(ctx, branch, { resource: 'diamond', targetHeld: 4 })
  assert.equal(branch.extensionSearch, previousSearch, 'unchanged unknown terrain does not rerun the expensive survey')
  f.receive(-4, 0)
  for (let u = 8; u <= 12; u++) for (let v = 6; v <= 9; v++) f.put(point(plan, u, -20, v), 'diamond_ore')
  const expanded = await ensureMineLayer(ctx, branch, { resource: 'diamond', targetHeld: 4 })
  assert.equal(expanded.code, 'MINE_LAYER_PLANNED', JSON.stringify(expanded)); assert.equal(expanded.serverConfirmed, true)
  assert.equal(branch.plan.id, before.plan.id); assert.equal(branch.plan.layers.length, 2)
  assert.deepEqual(branch.progress.upper, before.progress.upper)
  assert.deepEqual(branch.shaft, before.shaft); assert.deepEqual(branch.storage, before.storage)
  assert.equal(branch.progress.lower.cursor, 0); assert.equal(branch.extensionSearch, undefined)
  assert.ok(saved.some(record => record.plan.layers.length === 2))
})

test('legacy two-layer geometry and saved states remain valid; cancelled or unsaved extension cannot replace the upper plan', async () => {
  const f = plannerWorld(), old = createMineGeometry({ scope: mineWorldScope(f.current), anchor: { x: 0, z: 0 }, surfaceY: 64, upperY: 32, lowerY: -20 })
  assert.equal(resumeMineState(createMineState(old, { layer: 'lower' }), { plan: old, scope: old.scope }).cursor, 0)
  const plan = constructedUpper(f)
  f.put(point(plan, 9, -20, 7), 'diamond_ore')
  const abort = new AbortController(); abort.abort()
  assert.equal((await planMineExtension({ ...f, plan }, { signal: abort.signal })).status, 'cancelled')
  const branch = { plan, progress: { upper: createMineState(plan, { layer: 'upper' }) } }, previous = structuredClone(branch)
  const ctx = { shared: {}, memory: { early: { mine: { branch } } }, cancelled: () => false, getFeet: () => plan.shaft.approach, getBlock: f.world.getBlock,
    runtime: { mineState: f.getState, inventory: () => ({ known: true, items: [] }), host: () => ({ world: f.world }) }, minePorts: { observe: async () => {} }, saveMine: async () => false }
  assert.equal((await ensureMineLayer(ctx, branch, { resource: 'diamond', targetHeld: 1 })).code, 'MINE_CHECKPOINT')
  assert.deepEqual(branch, previous)
  assert.throws(() => extendMineGeometry(old, { lowerY: -30 }), /EXTENSION_INVALID/)
})

test('receiving lower observation is partial until the real extension is planned, and unfinished work blocks survey return travel', async () => {
  const f = plannerWorld({ minSection: 1 }), plan = constructedUpper(f), branch = { plan, progress: { upper: createMineState(plan, { layer: 'upper' }) } }
  let calls = 0
  const ctx = { shared: {}, memory: { early: { mine: { branch } } }, cancelled: () => false, getFeet: () => plan.shaft.approach, getBlock: f.world.getBlock,
    runtime: { mineState: f.getState, inventory: () => ({ known: true, items: [] }), host: () => ({ world: f.world }) }, saveMine: async () => true,
    minePorts: { observe: async () => { calls++; f.receive(-4, 0); return { status: 'completed', code: 'MINE_TERRAIN_RECEIVED', serverConfirmed: true } },
      walk: async () => { throw Error('unfinished work cannot start survey travel') }, ladderMove: async () => { throw Error('unfinished work cannot start return travel') } } }
  const observed = await ensureMineLayer(ctx, branch, { resource: 'diamond', targetHeld: 1 })
  assert.equal(observed.status, 'partial'); assert.equal(observed.code, 'MINE_OBSERVATION_RECEIVED')
  assert.equal(branch.plan.layers.length, 1); assert.equal(branch.progress.lower, undefined)
  branch.segmentTask = { stepId: 'unfinished' }
  branch.extensionSearch = { observation: { waits: 3 } }
  const stopped = await ensureMineLayer(ctx, branch, { resource: 'diamond', targetHeld: 1 })
  assert.equal(stopped.code, 'MINE_EXTENSION_PENDING_WORK'); assert.equal(calls, 1)
})
