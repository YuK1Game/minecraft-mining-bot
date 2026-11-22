'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createWorld } = require('../src/host/world')
const { surveyMine } = require('../src/modes/mining/mine-survey')
const { planMine, evaluateMineGeometry, lowerLevels } = require('../src/modes/mining/mine-plan')
const { createMineGeometry, mineSteps, stepCells, classifyMineCell, point, key, MAX_SHAFT_DEPTH } = require('../src/modes/mining/mine-geometry')
const { mineWorldScope, mineLiveScope, createMineState, advanceMineState, resumeMineState, skipMineSegment } = require('../src/modes/mining/mine-state')
const { createMineLighting, receivedLight } = require('../src/modes/mining/mine-lighting')
const { createMineStorage } = require('../src/modes/mining/mine-storage')
const { bottomSlab } = require('../src/modes/mining/mine-observed')
const saved = require('./fixtures/mine-tunnel-ore-in-view.json')

const state = () => ({ phase: 'spawned', profile: 'mine-test', realm: { id: 'realm' }, dimension: 'overworld', worldSeed: '123', connectionId: 'connection', startedAt: '2026-11-21T00:00:00Z', runtimeEntityId: '1', lifecycle: { deathId: 0 }, health: 20 })
function fixture ({ full = false } = {}) {
  const names = [...new Set(['air', 'stone', 'deepslate', 'diamond_ore', 'deepslate_diamond_ore', 'water', 'chest', 'torch', 'leaf_litter', 'cobblestone', 'cobblestone_slab', ...Object.values(saved.legend)])]
  const registry = { blocksByRuntimeId: Object.fromEntries(names.map((name, id) => [id, { stateId: id, name, boundingBox: ['air', 'water', 'torch', 'leaf_litter'].includes(name) ? 'empty' : 'block', hardness: name === 'deepslate' ? 3 : 1.5, diggable: name !== 'air' && name !== 'water' }])), blockStates: names.map(name => ({ name, states: name === 'cobblestone_slab' ? { 'minecraft:vertical_half': 'bottom' } : {} })), handleStartGame () {} }
  const world = createWorld({ registry }), current = state()
  world.applyPacket('start_game', { dimension: 'overworld' })
  const uniform = (sy, id) => {
    let n = id << 1; const bytes = []
    while (n > 127) { bytes.push((n & 127) | 128); n >>>= 7 } bytes.push(n)
    return Buffer.from([9, 1, sy & 255, 1, ...bytes])
  }
  const section = (x, y, z, name = 'stone') => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: uniform(y, name === 'unknown' ? 999 : names.indexOf(name)) }] })
  const put = (p, name) => world.applyPacket('update_block', { position: p, block_runtime_id: names.indexOf(name), layer: 0 })
  if (full) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = -4; y <= 4; y++) section(x, y, z, y === 4 ? 'air' : y < 0 ? 'deepslate' : 'stone')
  return { world, current, getState: () => structuredClone(current), section, put }
}
const geometry = options => createMineGeometry({ scope: mineWorldScope(state()), anchor: { x: 0, z: 0 }, direction: 'east', width: 24, length: 24, surfaceY: 64, upperY: 32, lowerY: -52, ...options })

test('saved 2475 received cells pass through the real World; unknown palette cells and changed terrain remain untrusted', async () => {
  const f = fixture(), sections = new Set(); let expectedOres = 0
  for (const [y, rows] of Object.entries(saved.rows)) for (let z = 0; z < rows.length; z++) for (let x = 0; x < rows[z].length; x++) {
    const p = { x: saved.x0 + x, y: Number(y), z: saved.z0 + z }, id = [Math.floor(p.x / 16), Math.floor(p.y / 16), Math.floor(p.z / 16)].join(',')
    if (!sections.has(id)) { sections.add(id); f.section(...id.split(',').map(Number), 'unknown') }
    const name = saved.legend[rows[z][x]]; f.put(p, name)
    if (name.endsWith('_ore')) expectedOres++
  }
  const bounds = { min: { x: saved.x0, y: 14, z: saved.z0 }, max: { x: saved.x0 + 14, y: 24, z: saved.z0 + 14 } }
  const survey = await surveyMine({ ...f, bounds })
  assert.equal(survey.status, 'ready'); assert.equal(survey.known, 2475); assert.equal(survey.ores.length, expectedOres); assert.equal(expectedOres, 83)
  assert.equal(survey.at({ x: saved.x0 - 1, y: 20, z: saved.z0 }).known, false)
  assert.equal(survey.current(), true)
  f.put({ x: saved.x0, y: 20, z: saved.z0 }, 'air')
  assert.equal(survey.current(), false)
})

test('survey keeps all 900 ore positions, and can yield, cancel and reject a changed life', async () => {
  const f = fixture({ full: true })
  for (let x = -15; x < 15; x++) for (let z = -15; z < 15; z++) f.put({ x, y: 32, z }, 'iron_ore')
  const bounds = { min: { x: -15, y: 32, z: -15 }, max: { x: 14, y: 32, z: 14 } }
  let yields = 0
  const observed = await surveyMine({ ...f, bounds, batchSize: 128, yieldNow: async () => { yields++ } })
  assert.equal(observed.ores.length, 900); assert.ok(yields >= 7)
  const abort = new AbortController()
  const cancelled = await surveyMine({ ...f, bounds, batchSize: 128, yieldNow: async () => abort.abort() }, { signal: abort.signal })
  assert.equal(cancelled.status, 'cancelled')
  const changed = await surveyMine({ ...f, bounds, batchSize: 128, yieldNow: async () => { f.current.lifecycle.deathId++ } })
  assert.equal(changed.code, 'MINE_SCOPE_CHANGED')
})

test('subchunk survey requests use only announced columns and never certify cells from a sent request', async () => {
  const f = fixture(), packets = [], bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 31, z: 15 } }
  f.world.applyPacket('level_chunk', { dimension: 0, x: 0, z: 0, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  const survey = await surveyMine({ ...f, bounds, requestSections: packet => packets.push(packet), maxRequests: 2 })
  assert.equal(packets.length, 2); assert.ok(packets.every(packet => packet.origin.x === 0))
  assert.equal(survey.known, 0); assert.equal(survey.unknown, 32 * 32 * 16)
  assert.equal(survey.status, 'partial'); assert.deepEqual(survey.ores, [])
})

test('all orientations have a fixed 2x2 shaft, external ladder backing, short construction steps and separated large chest pairs', () => {
  for (const direction of ['east', 'south', 'west', 'north']) {
    const plan = geometry({ direction, expectedDrops: { upper: 10000, lower: 10000 } })
    assert.equal(plan.shaft.columns.length, 4)
    assert.equal(plan.shaft.columns.some(p => p.x === plan.shaft.ladder.support.x && p.z === plan.shaft.ladder.support.z), false)
    assert.equal(plan.shaft.columns.some(p => p.x === Math.floor(plan.shaft.topLanding.x) && p.z === Math.floor(plan.shaft.topLanding.z)), false)
    assert.equal(plan.shaft.topLanding.y, plan.site.surfaceY)
    assert.equal(plan.shaft.entryTorch.support.y, plan.site.surfaceY - 1)
    for (const layer of plan.layers) {
      const storage = plan.storage.find(s => s.layer === layer.id)
      assert.equal(storage.pairs.filter(pair => pair.purpose === 'cargo').length, 4)
      assert.equal(storage.pairs.filter(pair => pair.purpose === 'supply').length, 1)
      for (const [i, pair] of storage.pairs.entries()) for (const other of storage.pairs.slice(i + 1)) for (const a of pair.positions) for (const b of other.positions) assert.ok(Math.abs(a.x - b.x) + Math.abs(a.z - b.z) > 1, 'different pairs never form a row of touching chests')
      for (const step of mineSteps(plan, { layer: layer.id })) {
        assert.ok(step.count <= 3)
        const cells = stepCells(plan, step)
        assert.equal(cells.stand.y, layer.y - 0.5)
        assert.ok(cells.floor.every(f => f.position.y === layer.y - 1 && f.half === 'bottom'))
        assert.ok(cells.clear.every(p => p.y >= layer.y && p.y < layer.y + (step.kind === 'branch' ? 2 : 3)))
      }
    }
    assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 50000)
  }
})

test('storage uses both torch walls at four-block pitch, covering every open floor cell to design light 8', () => {
  const plan = geometry({ expectedDrops: { upper: 10000 } })
  for (const layer of plan.layers) {
    const cells = mineSteps(plan, { layer: layer.id }).filter(step => step.kind === 'storage').map(step => stepCells(plan, step))
    const torches = cells.flatMap(c => c.torch)
    for (const floor of cells.flatMap(c => c.floor)) {
      const p = { ...floor.position, y: floor.position.y + 1 }
      const distance = Math.min(...torches.map(t => Math.abs(p.x - t.position.x) + Math.abs(p.y - t.position.y) + Math.abs(p.z - t.position.z)))
      assert.ok(14 - distance >= 8)
    }
    assert.ok(torches.some(t => t.face === 2) && torches.some(t => t.face === 3))
  }
})

test('vein permissions preserve torch cells and their ore-bearing supports in every orientation', () => {
  for (const direction of ['east', 'south', 'west', 'north']) {
    const plan = geometry({ direction })
    let protectedSupport = false
    for (const step of mineSteps(plan)) for (const torch of stepCells(plan, step).torch) {
      for (const p of [torch.position, torch.support]) {
        const role = classifyMineCell(plan, p)
        assert.equal(role.protected, true); assert.equal(role.allowedDig, false)
        assert.equal(role.role, 'lighting')
      }
      if (step.kind === 'main') protectedSupport = true
    }
    assert.ok(protectedSupport)
    assert.equal(classifyMineCell(plan, point(plan, 12, 33, 3)).role, 'vein_candidate')
  }
})

test('planner compares upper heights, directions and rectangles with uncapped actual World ore observations', { timeout: 20000 }, async t => {
  const f = fixture({ full: true })
  for (let x = -14; x < 14; x++) for (let z = -14; z < 14; z++) f.put({ x, y: 32, z }, 'iron_ore')
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) f.put({ x, y: -51, z }, 'deepslate_diamond_ore')
  const start = performance.now()
  const result = await planMine({ ...f, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'raw_iron', targetCount: 32 })
  assert.equal(result.status, 'planned', JSON.stringify(result))
  assert.equal(result.code, 'MINE_TARGET_REACHABLE')
  assert.equal(result.plan.layers[0].y, 32)
  assert.ok(result.diagnostics.observedOres > 256)
  assert.equal(result.diagnostics.dimensions.length, 6)
  assert.equal(result.diagnostics.evaluated, result.diagnostics.prefiltered)
  assert.ok(result.diagnostics.work < 8000000)
  assert.ok(performance.now() - start < 15000)
  const e = result.plan.evaluation
  assert.equal(new Set(e.oreUnion.map(ore => key(ore.position))).size, e.oreUnion.length)
  assert.ok(e.targetCost > 0 && e.totalCost >= e.targetCost)
  assert.ok(e.costs.excavationBlocks > 0 && e.costs.floorPlacements > 0 && e.costs.ladderPlacements > 0 && e.costs.shaftBackfill > 0 && e.costs.torchPlacements > 0 && e.costs.chestPlacements > 0 && e.costs.haulDistance > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(result.plan)) < 500000)
  t.diagnostic(JSON.stringify({ generated: result.diagnostics.candidates, evaluated: result.diagnostics.evaluated, work: result.diagnostics.work, elapsedMs: Math.round(performance.now() - start), planBytes: Buffer.byteLength(JSON.stringify(result.plan)) }))
})

test('quantity completion cost grows with the needed prefix; unavailable quantity remains an explicit shortfall', async () => {
  const f = fixture({ full: true })
  for (let x = -15; x < 15; x++) for (let z = -15; z < 15; z++) f.put({ x, y: 32, z }, 'iron_ore')
  f.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
  const options = { ...f, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'raw_iron', sizes: [16, 32], upperYs: [32], maxLowerLevels: 1, searchRadius: 0 }
  const small = await planMine({ ...options, targetCount: 8 }), large = await planMine({ ...options, targetCount: 300 }), short = await planMine({ ...options, targetCount: 4096 })
  assert.equal(small.code, 'MINE_TARGET_REACHABLE'); assert.equal(large.code, 'MINE_TARGET_REACHABLE')
  assert.ok(small.plan.evaluation.targetCost < large.plan.evaluation.targetCost)
  assert.ok(large.plan.evaluation.availableTargetOre >= 300)
  assert.equal(short.code, 'MINE_RESOURCE_SHORTFALL'); assert.equal(short.plan.evaluation.meetsTarget, false)
  assert.ok(short.plan.evaluation.shortfall > 0)
})

test('dense observed veins resize cargo capacity for the final room on both layers', async () => {
  const f = fixture({ full: true })
  for (let x = -15; x < 15; x++) for (let z = -15; z < 15; z++) for (const y of [31, 32, 33, 34]) f.put({ x, y, z }, 'iron_ore')
  f.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
  const result = await planMine({ ...f, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'diamond', width: 32, length: 32, upperYs: [32], maxLowerLevels: 1, searchRadius: 0 })
  assert.equal(result.status, 'planned', JSON.stringify(result))
  assert.equal(result.plan.layers.length, 2, 'an initial diamond request still plans both layers')
  assert.ok(result.plan.storage.find(room => room.layer === 'upper').pairs.filter(p => p.purpose === 'cargo').length > 1)
  for (const room of result.plan.storage) {
    const cargo = room.pairs.filter(p => p.purpose === 'cargo').length
    assert.ok(cargo * room.cargoSlots * 64 >= result.plan.evaluation.estimatedDrops[room.layer])
    assert.ok(room.estimatedDrops >= result.plan.evaluation.estimatedDrops[room.layer])
    assert.equal(room.pairs.filter(p => p.purpose === 'supply').length, 1)
  }
})

test('yield counts the executor two-high frontier pockets and direct floor excavation, excluding roof, deep floor and torch supports', async () => {
  const f = fixture({ full: true }), plan = geometry({ width: 16, length: 16 })
  const pocket = point(plan, 11, 32, 6), directFloor = point(plan, 9, 31, 7)
  const excluded = [point(plan, 8, 35, 7), point(plan, 8, 30, 7), point(plan, 8, 33, 6), point(plan, 3, 32, 2)]
  for (const p of [pocket, directFloor, ...excluded]) f.put(p, 'iron_ore')
  f.put(point(plan, 2, 32, 3), 'air')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -4, y: -60, z: -4 }, max: { x: 36, y: 67, z: 36 } } })
  const out = await evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', targetCount: 8, checkpoint: async () => {}, read: p => survey.at(p) })
  assert.equal(out.eligible, true); assert.equal(out.availableTargetOre, 2); assert.equal(out.shortfall, 6)
  assert.deepEqual(new Set(out.oreUnion.map(ore => key(ore.position))), new Set([key(pocket), key(directFloor)]))
  assert.equal(out.costs.veinExcavation, 2); assert.equal(out.costs.veinBackfill, 2)
  assert.ok(out.costs.caveSealPlacements > 0)
})

test('default geometry can finish every short segment and receive both layers of double chests through real lighting and storage', async t => {
  const f = fixture({ full: true }), plan = geometry(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-plan-finish-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let feet, view = {}, epoch = 0
  const block = p => f.world.getBlock(p.x, p.y, p.z), passable = b => b.known && ['minecraft:air', 'minecraft:torch'].includes(b.name)
  const inventory = { known: true, items: [
    ...Array.from({ length: 32 }, (_, slot) => ({ slot, name: 'minecraft:cobblestone_slab', count: 64 })),
    { slot: 32, name: 'minecraft:torch', count: 64 }, { slot: 33, name: 'minecraft:torch', count: 64 },
    { slot: 34, name: 'minecraft:chest', count: 16 }, { slot: 35, name: 'minecraft:cobblestone', count: 64 }
  ] }, branch = { plan, progress: { upper: { cursor: 0 }, lower: { cursor: 0 } }, shaft: { landings: { upper: true, lower: true } } }
  const ctx = { root, shared: {}, memory: { early: { mine: { branch } } }, cancelled: () => false, getBlock: f.world.getBlock, getFeet: () => feet,
    runtime: { raw: f.getState }, operations: { interactions: {}, crafting: { closeContainer: () => { view = {} } }, chest: {
      snapshot: () => view,
      open: async position => { view = { window: { id: 1, epoch: ++epoch, scope: 'fixture', position, slotCount: 54 }, contentsKnown: true, slots: Array.from({ length: 54 }, (_, slot) => ({ known: true, slot, count: 0, name: null })) }; return { windowId: 1 } }
    } } }
  const done = (code, evidence = {}) => ({ status: 'completed', code, serverConfirmed: true, evidence })
  const actions = { block, inventory: () => inventory, save: async () => true, done,
    observe: async () => assert.fail('all intended finish cells have received terrain'),
    walk: async target => {
      const base = { x: Math.floor(target.x), y: Math.ceil(target.y), z: Math.floor(target.z) }, floor = block({ ...base, y: base.y - 1 })
      assert.ok(passable(block(base)) && passable(block({ ...base, y: base.y + 1 })) && floor.boundingBox === 'block', `walkable ${JSON.stringify(target)}`)
      assert.equal(target.y, base.y - (bottomSlab(floor) ? 0.5 : 0)); feet = target; return done('POSITION_RECEIVED')
    },
    mine: async position => { assert.ok(Math.floor(feet.x) !== position.x || Math.floor(feet.z) !== position.z, 'floor replacement never mines the current stand'); f.put(position, 'air'); return done('AIR_RECEIVED') },
    place: async request => {
      assert.equal(block(request.position).name, 'minecraft:air')
      const name = request.name.replace(/^minecraft:/, ''), item = inventory.items.find(item => item.name === 'minecraft:' + name && item.count > 0)
      assert.ok(item, `received ${name} available before placement`)
      item.count--; f.put(request.position, name); return done('BLOCK_RECEIVED')
    }
  }
  const lighting = createMineLighting(ctx, actions), storage = createMineStorage(ctx, actions)
  for (const layer of plan.layers) {
    const landing = plan.shaft.landings.find(p => p.layer === layer.id)
    for (const p of landing.clear) f.put(p, 'air')
    f.put(landing.floor[0].position, 'cobblestone_slab'); f.put({ ...landing.clear[0], y: layer.y + 1 }, 'torch'); feet = landing.stand
    const steps = mineSteps(plan, { layer: layer.id })
    for (const [index, step] of steps.entries()) {
      const cells = stepCells(plan, step)
      for (const p of cells.clear) f.put(p, 'air')
      let result
      for (let attempt = 0; attempt < 12; attempt++) { result = await lighting.finish(plan, cells); if (result.status !== 'partial') break }
      assert.equal(result.status, 'completed', `${step.id}: ${JSON.stringify(result)}`)
      assert.equal(result.evidence.light.safe, true)
      await actions.walk(cells.stand); branch.progress[layer.id].cursor = index + 1
      if (step.kind === 'storage' && steps[index + 1]?.kind !== 'storage') {
        const stored = await storage.ensure(plan, layer.id)
        assert.equal(stored.status, 'completed', `${layer.id}: ${JSON.stringify(stored)}`)
        for (const pair of plan.storage.find(room => room.layer === layer.id).pairs) assert.equal(branch.storage.pairs[pair.id].slots, 54)
        const targets = steps.filter(s => s.kind === 'storage').flatMap(s => stepCells(plan, s).floor.map(f => ({ ...f.position, y: f.position.y + 1 })))
        assert.equal(receivedLight(f.world.getBlock, targets).safe, true, 'chest placement keeps storage floor lighting confirmed')
      }
    }
  }
  const placedSlabs = mineSteps(plan).reduce((n, step) => n + stepCells(plan, step).floor.length, 0)
  assert.equal(inventory.items.filter(item => item.name === 'minecraft:cobblestone_slab').reduce((n, item) => n + item.count, 0), 32 * 64 - placedSlabs)
})

test('regional search measures the entrance height at each horizontal candidate', async () => {
  const f = fixture({ full: true })
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) f.put({ x, y: 32, z }, 'iron_ore')
  // The observation centre is above the level of every available entrance.
  const chosen = await planMine({ ...f, origin: { x: 0.5, y: 66, z: 0.5 }, resource: 'raw_iron', upperYs: [32],
    width: 16, length: 16, searchRadius: 4, maxCandidates: 12 })
  assert.equal(chosen.status, 'planned', JSON.stringify(chosen.diagnostics))
  assert.equal(chosen.plan.shaft.topY, 64)
  assert.equal(chosen.plan.shaft.topLanding.y, 64)
})

test('a solid obstruction or an unsupported surface entrance cannot be selected as a mine', async () => {
  for (const mode of ['body', 'hole']) {
    const f = fixture({ full: true })
    for (let x = -15; x < 15; x++) for (let z = -15; z < 15; z++) f.put({ x, y: 32, z }, 'iron_ore')
    f.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
    if (mode === 'body') for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) f.section(x, 4, z, 'stone')
    else for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) f.put({ x, y: 63, z }, 'air')
    const result = await planMine({ ...f, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'raw_iron', width: 16, length: 16, searchRadius: 0, maxLowerLevels: 1, upperYs: [32] })
    assert.equal(result.status, 'blocked'); assert.equal(result.plan, undefined)
    assert.equal(result.code, 'MINE_NO_SAFE_RESOURCE_PLAN')
  }
})

test('a shaft with protected leaf litter in its first backing cell cannot be planned', async () => {
  const f = fixture({ full: true }), plan = geometry({ width: 16, length: 16 })
  const backing = { ...plan.shaft.ladder.support, y: plan.shaft.topY }
  f.put(backing, 'leaf_litter')
  f.put(point(plan, 9, 32, 7), 'iron_ore')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -4, y: -60, z: -4 }, max: { x: 36, y: 67, z: 36 } } })
  const result = await evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => survey.at(p) })
  assert.equal(result.eligible, false)
  assert.equal(result.unsafe.stage, 'surface')
  assert.ok(result.unsafe.blocks.some(block => block.at === key(backing) && block.name === 'minecraft:leaf_litter'))
})

test('a low chest foundation is rejected even though its received bounding box is block', async () => {
  const f = fixture({ full: true }), plan = geometry({ width: 16, length: 16 }), chest = plan.storage[0].pairs[0].positions[0]
  const foundation = { ...chest, y: chest.y - 1 }
  f.put(foundation, 'cobblestone_slab'); f.put(point(plan, 9, 32, 7), 'iron_ore')
  assert.equal(f.world.getBlock(foundation.x, foundation.y, foundation.z).boundingBox, 'block')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -4, y: -60, z: -4 }, max: { x: 36, y: 67, z: 36 } } })
  const result = await evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => survey.at(p) })
  assert.equal(result.eligible, false); assert.ok(result.hazards > 0)
})

test('diamond observations choose lower levels even when iron and copper are more numerous', () => {
  const survey = { bounds: { min: { y: -60 } }, ores: [
    ...Array.from({ length: 900 }, (_, i) => ({ resource: i % 2 ? 'raw_iron' : 'raw_copper', position: { x: i, y: -10, z: 0 } })),
    { resource: 'diamond', position: { x: 0, y: -51, z: 0 } }
  ] }
  assert.deepEqual(lowerLevels(survey, 16), [-52, -51])
})

test('a fully received ore-free lower area is blocked so the bounded site search can advance', async () => {
  const f = fixture({ full: true })
  const result = await planMine({ ...f, origin: { x: 0.5, y: 64, z: 0.5 }, resource: 'diamond', width: 12, length: 16, searchRadius: 0 })
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'MINE_NO_OBSERVED_LOWER_ORE')
  assert.equal(result.diagnostics.unknown, 0); assert.equal(result.diagnostics.observedOres, 0)
  assert.deepEqual(result.needsObservation, [])
})

test('the 191-block shaft boundary leaves room for lower slab feet and rejects all over-depth plans without observation retries', async () => {
  assert.equal(MAX_SHAFT_DEPTH, 191)
  const allowed = geometry({ surfaceY: 140, lowerY: -51 })
  assert.equal(allowed.shaft.topY - allowed.shaft.landings.find(p => p.layer === 'lower').stand.y, 191.5)
  assert.throws(() => geometry({ surfaceY: 140, lowerY: -52 }), /MINE_SHAFT_DEPTH_EXCEEDED/)
  assert.doesNotThrow(() => geometry({ surfaceY: 64, lowerY: -54 }))
  const f = fixture({ full: true }); f.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -1, y: -60, z: -1 }, max: { x: 1, y: 144, z: 1 } } })
  const options = { ...f, survey, resource: 'diamond', width: 12, length: 16, searchRadius: 0, upperYs: [32] }
  const mixed = await planMine({ ...options, origin: { x: 0.5, y: 140, z: 0.5 } })
  assert.deepEqual(mixed.diagnostics.lowerYs, [-51], 'too-deep candidates do not consume the feasible lower-level budget')
  const blocked = await planMine({ ...options, origin: { x: 0.5, y: 141, z: 0.5 } })
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.code, 'MINE_SHAFT_DEPTH_EXCEEDED')
  assert.equal(blocked.needsObservation, undefined); assert.equal(blocked.plan, undefined)
})

test('unknown World, changed terrain and a spent evaluation budget cannot return a completed site', async () => {
  const f = fixture()
  const unknown = await planMine({ ...f, origin: { x: 0, y: 64, z: 0 }, width: 12, length: 16 })
  assert.equal(unknown.status, 'observing'); assert.equal(unknown.plan, undefined)
  const ready = fixture({ full: true })
  ready.put({ x: 0, y: 32, z: 0 }, 'iron_ore'); ready.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
  const bounded = await planMine({ ...ready, origin: { x: 0, y: 64, z: 0 }, width: 12, length: 16, searchRadius: 0, maxWork: 1 })
  assert.equal(bounded.code, 'MINE_PLAN_BUDGET'); assert.equal(bounded.status, 'blocked')
  let changed = false
  const stale = await planMine({ ...ready, origin: { x: 0, y: 64, z: 0 }, width: 12, length: 16, yieldNow: async () => { if (!changed) { changed = true; ready.put({ x: -16, y: 14, z: -16 }, 'water') } } })
  assert.equal(stale.status, 'observing'); assert.equal(stale.plan, undefined)
})

test('saved progress is world-scoped history; only fresh ordered step receipts advance it and blocked branches never become completed', () => {
  const plan = geometry(), liveScope = mineLiveScope(state()), steps = mineSteps(plan, { layer: 'upper' })
  let progress = createMineState(plan, { layer: 'upper' })
  const confirm = step => ({ serverConfirmed: true, receivedAir: true, walkConfirmed: true, finishConfirmed: true, liveScope, planId: plan.id, stepId: step.id, cursor: progress.cursor })
  assert.throws(() => advanceMineState(progress, confirm(steps[1]), { step: steps[1], liveScope, plan }), /OUT_OF_ORDER/)
  assert.throws(() => advanceMineState(progress, { ...confirm(steps[0]), finishConfirmed: false }, { step: steps[0], liveScope, plan }), /UNCONFIRMED/)
  const first = steps[0]; progress = advanceMineState(progress, confirm(first), { step: first, liveScope, plan })
  const restored = resumeMineState(progress, { plan, scope: mineWorldScope(state()) })
  assert.equal(restored.cursor, 1); assert.equal(restored.needsRevalidation, true); assert.deepEqual(restored.receipts, [])
  assert.throws(() => resumeMineState(progress, { plan, scope: { ...plan.scope, worldSeed: 'another-world' } }), /SCOPE/)
  while (steps[progress.cursor]?.kind !== 'branch') { const step = steps[progress.cursor]; progress = advanceMineState(progress, confirm(step), { step, liveScope, plan }) }
  const completed = progress.confirmedSteps, step = steps[progress.cursor]
  progress = skipMineSegment(progress, { segmentId: step.segmentId, code: 'UNSAFE', plan, liveScope, attempts: 3 })
  assert.equal(progress.confirmedSteps, completed); assert.equal(progress.blocked.length, 1)
  while (progress.cursor < steps.length) { const step = steps[progress.cursor]; progress = advanceMineState(progress, confirm(step), { step, liveScope, plan }) }
  assert.equal(progress.status, 'partial'); assert.ok(progress.confirmedSteps < progress.stepCount)
})
