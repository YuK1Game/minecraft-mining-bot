'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextBootstrapAction, inventoryCounts } = require('../src/planner')

function fixture () {
  const snapshot = {
    phase: 'spawned', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 },
    version: '1.26.60', world: { initialized: true, loadedSections: 1, version: '1.26.60' },
    inventory: { known: true, items: [] }, selectedSlot: 0, heldItem: null,
    capabilities: { mining: true, movement: true }
  }
  const map = new Map()
  const set = (x, y, z, name, extra = {}) => map.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, position: { x, y, z }, extra: [], ...extra })
  for (let x = -2; x <= 7; x++) for (let y = 63; y <= 71; y++) for (let z = -2; z <= 3; z++) set(x, y, z, y <= 64 ? 'stone' : 'air')
  for (let y = 65; y <= 68; y++) set(2, y, 0, 'oak_log')
  set(2, 69, 0, 'oak_leaves')
  const observations = { blocks: [...map.values()], capabilities: { craft: true, place_block: true, equip: true, use_table: true, scan_blocks: true, collect_drops: true }, crafting: { previews: {} } }
  const items = entries => { snapshot.inventory.items = entries.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) }
  const refresh = () => { observations.blocks = [...map.values()] }
  const preview = (name, times = 1, ready = true, extra = {}) => { observations.crafting.previews[name] = { ready, output: { name: `minecraft:${name}`, count: times * (name.endsWith('_planks') || name === 'stick' ? 4 : 1) }, times, recipeNetworkId: 100, ...extra } }
  return { snapshot, observations, set, refresh, items, preview, next: () => nextBootstrapAction(snapshot, observations) }
}

test('online learning bootstrap at HP1 still requires a received natural tree and real inventory', () => {
  const f = fixture(); f.snapshot.health = 1
  assert.equal(f.next().code, 'low_health')
  f.snapshot.threatPolicy = 'online_learning'
  assert.equal(f.next().type, 'gather_logs')
  f.set(2, 69, 0, 'air'); f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
  f.snapshot.inventory.known = false
  assert.equal(f.next().code, 'inventory_unknown')
  f.snapshot.inventory.known = true; f.snapshot.health = 0
  assert.equal(f.next().type, 'stop')
})

test('counts raw logs separately from boards, stripped wood and stone blocks', () => {
  const counts = inventoryCounts([
    { name: 'minecraft:oak_log', count: 2 }, { name: 'acacia_log', count: 1 },
    { name: 'minecraft:oak_planks', count: 12 }, { name: 'stripped_oak_log', count: 9 },
    { name: 'oak_wood', count: 8 }, { name: 'stone', count: 64 }, { name: 'cobblestone', count: 5 }
  ])
  assert.deepEqual(counts, { logs: 3, planks: 12, sticks: 0, craftingTables: 0, stone: 5 })
})

test('natural tree requires adjacent trunk and matching leaves and never guesses a lone placed log', () => {
  const f = fixture()
  const action = f.next()
  assert.equal(action.type, 'gather_logs')
  assert.equal(action.count, 3)
  assert.equal(action.block, 'minecraft:oak_log')
  assert.equal(action.treeEvidence.species, 'oak')
  f.set(2, 69, 0, 'air'); f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
  f.set(2, 66, 0, 'oak_log', { protected: true })
  f.set(2, 65, 0, 'air'); f.set(2, 67, 0, 'air'); f.set(2, 68, 0, 'air')
  f.set(2, 69, 0, 'oak_leaves'); f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
})

test('tree harvesting selects its bottom layer before the geometrically nearer upper trunk and advances after a cut', () => {
  const f = fixture()
  assert.ok(Math.hypot(2.5 - f.snapshot.position.x, 66.5 - f.snapshot.position.y) < Math.hypot(2.5 - f.snapshot.position.x, 65.5 - f.snapshot.position.y))
  const first = f.next()
  assert.equal(first.type, 'gather_logs')
  assert.deepEqual(first.target, { x: 2, y: 65, z: 0 })
  assert.equal(first.treeEvidence.harvestOrder, 'bottom_up')
  assert.equal(first.treeEvidence.componentBottom, 65)
  assert.equal(first.treeEvidence.componentLogPositions.length, 4)
  assert.ok(first.treeEvidence.componentLogPositions.some(position => position.y === 68), 'upper logs remain structural evidence')
  f.set(2, 65, 0, 'air'); f.refresh()
  const second = f.next()
  assert.equal(second.type, 'gather_logs')
  assert.deepEqual(second.target, { x: 2, y: 66, z: 0 })
  assert.equal(second.treeEvidence.componentBottom, 66)
  assert.equal(second.treeEvidence.componentLogPositions.length, 3)
})

test('visible reachable upper logs cannot replace an obscured bottom; the planner approaches the bottom instead', () => {
  const f = fixture()
  f.set(1, 65, 0, 'short_grass', { boundingBox: 'empty' })
  f.refresh()
  const action = f.next()
  assert.equal(action.type, 'move_to')
  assert.deepEqual(action.resourceTarget, { x: 2, y: 65, z: 0 })
  assert.equal(action.treeEvidence.componentBottom, 65)
  assert.equal(action.requiresLivePreview, true)
})

test('an upper trunk in reach while its bottom is out of reach causes a bottom approach rather than an upper cut', () => {
  const f = fixture()
  f.snapshot.position.y = 69.62
  for (let y = 65; y <= 67; y++) f.set(0, y, 0, 'stone')
  f.refresh()
  const centerDistance = y => Math.hypot(2.5 - f.snapshot.position.x, y + 0.5 - f.snapshot.position.y)
  assert.ok(centerDistance(66) < 4.5)
  assert.ok(centerDistance(65) > 4.5)
  const action = f.next()
  assert.equal(action.type, 'move_to')
  assert.deepEqual(action.resourceTarget, { x: 2, y: 65, z: 0 })
  assert.equal(action.treeEvidence.harvestOrder, 'bottom_up')
  assert.equal(action.requiresLivePreview, true)
})

test('unobserved, protected or forbidden bottoms never promote upper logs to harvest targets', () => {
  for (const flags of [{ known: false }, { protected: true }, { natural: false }]) {
    const f = fixture()
    f.set(2, 65, 0, 'oak_log', flags); f.refresh()
    assert.equal(f.next().type, 'scan_blocks')
  }
  const other = fixture()
  other.set(2, 65, 0, 'oak_log', { protected: true })
  for (let y = 65; y <= 68; y++) other.set(6, y, 0, 'birch_log')
  other.set(6, 69, 0, 'birch_leaves'); other.refresh()
  const selected = other.next()
  assert.equal(selected.type, 'move_to')
  assert.deepEqual(selected.resourceTarget, { x: 6, y: 65, z: 0 })
})

function branchingAcacia () {
  const f = fixture()
  for (let y = 65; y <= 69; y++) f.set(2, y, 0, 'air')
  f.snapshot.position = { x: -11.55, y: 69.62, z: 10.5 }
  for (let x = -15; x <= -5; x++) for (let y = 66; y <= 79; y++) for (let z = 4; z <= 13; z++) f.set(x, y, z, y <= 67 ? 'stone' : 'air')
  const logs = [
    { x: -11, y: 70, z: 8 }, { x: -11, y: 71, z: 8 },
    { x: -10, y: 72, z: 8 }, { x: -9, y: 73, z: 8 },
    { x: -8, y: 74, z: 9 }, { x: -7, y: 75, z: 9 }
  ]
  for (const p of logs) f.set(p.x, p.y, p.z, 'acacia_log')
  f.set(-7, 76, 9, 'acacia_leaves')
  f.refresh()
  return { ...f, logs }
}

test('diagonal connected acacia branches provide canopy evidence for a reachable lower trunk', () => {
  const f = branchingAcacia()
  const before = structuredClone({ snapshot: f.snapshot, observations: f.observations })
  const action = f.next()
  assert.equal(action.type, 'gather_logs')
  assert.equal(action.block, 'minecraft:acacia_log')
  assert.deepEqual(action.target, { x: -11, y: 70, z: 8 })
  assert.deepEqual(action.treeEvidence.leafPosition, { x: -7, y: 76, z: 9 })
  assert.deepEqual(action.treeEvidence.canopyBranchPosition, { x: -7, y: 75, z: 9 })
  assert.equal(action.treeEvidence.componentSize, 6)
  assert.equal(action.requiresLivePreview, true)
  assert.deepEqual({ snapshot: f.snapshot, observations: f.observations }, before)
  f.observations.blocks.reverse()
  assert.deepEqual(f.next(), action, 'component evidence is deterministic regardless of observation ordering')
})

test('connected-log detection does not legitimize a lone placed log, leafless construction or a different species bridge', () => {
  const lone = branchingAcacia()
  for (const p of lone.logs.slice(1)) lone.set(p.x, p.y, p.z, 'air')
  lone.set(-11, 71, 9, 'acacia_leaves')
  lone.refresh()
  assert.equal(lone.next().type, 'scan_blocks')
  const leafless = branchingAcacia()
  leafless.set(-7, 76, 9, 'air'); leafless.refresh()
  assert.equal(leafless.next().type, 'scan_blocks')
  const mixed = branchingAcacia()
  mixed.set(-10, 72, 8, 'birch_log'); mixed.refresh()
  assert.equal(mixed.next().type, 'scan_blocks')
})

test('a leafy branched crown remaining after trunk removal is recognized without accepting a simple diagonal log row', () => {
  const f = fixture()
  for (let y = 65; y <= 69; y++) f.set(2, y, 0, 'air')
  const branches = [{ x: 2, y: 68, z: 0 }, { x: 3, y: 69, z: 0 }, { x: 4, y: 70, z: 0 }, { x: 3, y: 70, z: 1 }]
  for (const p of branches) f.set(p.x, p.y, p.z, 'oak_log')
  f.set(4, 71, 0, 'oak_leaves'); f.refresh()
  const action = f.next()
  assert.equal(action.type, 'gather_logs')
  assert.deepEqual(action.target, branches[0])
  assert.equal(action.treeEvidence.structure, 'branched_canopy')
  f.set(4, 71, 0, 'air'); f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
  f.set(4, 71, 0, 'oak_leaves')
  f.set(3, 70, 1, 'air')
  f.set(5, 71, 0, 'oak_log')
  f.set(5, 72, 0, 'oak_leaves'); f.refresh()
  assert.equal(f.next().type, 'scan_blocks', 'a straight diagonal row has no trunk pair or branching evidence')
})

test('protected or explicitly unnatural bridges cannot supply tree evidence and unknown target neighbours remain unsafe', () => {
  for (const flags of [{ protected: true }, { natural: false }, { known: false }]) {
    const f = branchingAcacia()
    f.set(-10, 72, 8, 'acacia_log', flags); f.refresh()
    assert.equal(f.next().type, 'scan_blocks')
  }
  const unknown = branchingAcacia()
  for (const p of unknown.logs) unknown.set(p.x - 1, p.y, p.z, 'air', { known: false })
  unknown.refresh()
  assert.equal(unknown.next().type, 'scan_blocks')
})

test('oversized connected log construction is rejected as a whole rather than mining an unvisited fragment', () => {
  const f = fixture()
  for (let y = 65; y <= 193; y++) f.set(2, y, 0, 'oak_log')
  f.set(2, 194, 0, 'oak_leaves'); f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
})

test('missing movement or breaking capability is explicit; the planner does not break arbitrary terrain', () => {
  const f = fixture()
  f.snapshot.capabilities.mining = false
  const missingBreak = f.next()
  assert.equal(missingBreak.type, 'capability_required')
  assert.equal(missingBreak.capability, 'break_block')
  f.snapshot.capabilities.mining = true
  f.snapshot.position.x = -4.5
  f.snapshot.capabilities.movement = false
  const missingMove = f.next()
  assert.equal(missingMove.type, 'capability_required')
  assert.equal(missingMove.capability, 'move')
})

test('an inaccessible upper branch is skipped in favor of a farther trunk reachable from known ground', () => {
  const f = fixture()
  for (let y = 65; y <= 69; y++) f.set(2, y, 0, 'air')
  for (let x = -2; x <= 7; x++) for (let y = 72; y <= 75; y++) for (let z = -2; z <= 3; z++) f.set(x, y, z, 'air')
  // The floating remnants are geometrically closer, but their bottom centre is
  // 4.88 blocks above the eye of anyone standing on the observed ground.
  f.set(2, 71, 0, 'acacia_log'); f.set(2, 72, 0, 'acacia_log'); f.set(2, 73, 0, 'acacia_leaves')
  for (let y = 65; y <= 68; y++) f.set(6, y, 0, 'birch_log')
  f.set(6, 69, 0, 'birch_leaves')
  f.refresh()
  const action = f.next()
  assert.equal(action.type, 'move_to')
  assert.equal(action.block, 'minecraft:birch_log')
  assert.equal(action.resourceTarget.x, 6)
  assert.equal(action.target.y, 65, 'movement target is a real ground-top feet position')
  assert.equal(action.near, undefined, 'do not ask the executor to stand near the unreachable branch')
})

test('isolated high branches or missing body clearance never produce a ground approach', () => {
  const f = fixture()
  for (let y = 65; y <= 69; y++) f.set(2, y, 0, 'air')
  for (let x = -2; x <= 7; x++) for (let y = 72; y <= 75; y++) for (let z = -2; z <= 3; z++) f.set(x, y, z, 'air')
  f.set(2, 71, 0, 'acacia_log'); f.set(2, 72, 0, 'acacia_log'); f.set(2, 73, 0, 'acacia_leaves')
  f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
})

test('known empty-collision plants permit a standing approach without becoming transparent to the mining sight ray', () => {
  const f = fixture()
  f.snapshot.position.x = -4.5
  for (let x = -2; x <= 7; x++) for (let z = -2; z <= 3; z++) {
    if (x !== 2 || z !== 0) f.set(x, 65, z, 'short_grass', { boundingBox: 'empty' })
  }
  // A clear selection ray is still required: leave air around the trunk while
  // keeping the actual standing cell's harmless plant in place.
  for (let x = 1; x <= 3; x++) for (let z = -1; z <= 1; z++) if (x !== 2 || z !== 0) f.set(x, 65, z, 'air', { boundingBox: 'empty' })
  f.refresh()
  const approaching = f.next()
  assert.equal(approaching.type, 'move_to')
  const footCell = f.observations.blocks.find(block => block.position.x === Math.floor(approaching.target.x) && block.position.y === approaching.target.y && block.position.z === Math.floor(approaching.target.z))
  assert.equal(footCell.name, 'minecraft:short_grass')
  assert.equal(footCell.boundingBox, 'empty')
  const blocked = fixture()
  for (let y = 65; y <= 71; y++) for (let z = -2; z <= 3; z++) blocked.set(1, y, z, 'fern', { boundingBox: 'empty' })
  blocked.refresh()
  assert.notEqual(blocked.next().type, 'gather_logs', 'empty movement collision must not bypass block-selection sight checks')
})

test('unreceived neighbours and adjacent liquids exclude a tree instead of lowering mining safeguards', () => {
  const f = fixture()
  for (let y = 65; y <= 68; y++) f.set(3, y, 0, 'water')
  f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
  for (let y = 65; y <= 68; y++) f.set(3, y, 0, 'air', { known: false })
  f.refresh()
  assert.equal(f.next().type, 'scan_blocks')
})

test('safety and busy observations dominate resource and craft decisions', () => {
  const f = fixture()
  f.snapshot.health = 5
  assert.equal(f.next().code, 'low_health')
  f.snapshot.health = 20
  f.observations.task = { phase: 'walking' }
  assert.equal(f.next().code, 'task_in_progress')
  delete f.observations.task
  f.snapshot.world.loadedSections = 0
  assert.equal(f.next().code, 'world_not_loaded')
  f.snapshot.world.loadedSections = 1
  f.snapshot.inventory.items = Array.from({ length: 36 }, (_, slot) => ({ name: 'minecraft:dirt', slot, count: 1 }))
  assert.equal(f.next().code, 'inventory_full')
})

test('wood bootstrap progresses through previews without resetting to raw logs after consumption', () => {
  const f = fixture()
  f.items([['oak_log', 3]])
  assert.deepEqual([f.next().type, f.next().output, f.next().times], ['preview_craft', 'minecraft:oak_planks', 3])
  f.preview('oak_planks', 3)
  assert.equal(f.next().type, 'craft')
  f.items([['oak_planks', 12]])
  assert.equal(f.next().output, 'minecraft:crafting_table')
  f.preview('crafting_table')
  assert.equal(f.next().type, 'craft')
  f.items([['oak_planks', 8], ['crafting_table', 1]])
  f.observations.tablePlacement = { ready: true, position: { x: -1, y: 65, z: 1 } }
  assert.equal(f.next().type, 'place_crafting_table')
  f.items([['oak_planks', 8]])
  f.set(-1, 65, 1, 'crafting_table'); f.refresh()
  assert.equal(f.next().output, 'minecraft:stick')
  f.preview('stick')
  assert.equal(f.next().type, 'craft')
  f.items([['oak_planks', 6], ['stick', 4]])
  assert.equal(f.next().output, 'minecraft:wooden_pickaxe')
  f.preview('wooden_pickaxe', 1, false, { needsCraftingTable: true })
  assert.equal(f.next().type, 'open_crafting_table')
  f.preview('wooden_pickaxe')
  assert.equal(f.next().type, 'craft')
})

test('previews must match requested batch count, and a failed preview never becomes craft success', () => {
  const f = fixture()
  f.items([['oak_log', 3]])
  f.preview('oak_planks', 1)
  assert.equal(f.next().type, 'preview_craft')
  f.preview('oak_planks', 3, false, { errors: ['recipe not loaded'] })
  assert.equal(f.next().type, 'wait')
  assert.equal(f.next().code, 'craft_preview_not_ready')
  f.observations.capabilities.craft = false
  assert.equal(f.next().type, 'capability_required')
  assert.equal(f.next().capability, 'craft')
})

test('existing tools skip wood crafting, are equipped before mining, and completion needs inventory evidence', () => {
  const f = fixture()
  f.items([['iron_pickaxe', 1]])
  assert.equal(f.next().type, 'equip')
  f.snapshot.heldItem = { name: 'minecraft:iron_pickaxe', slot: 0 }
  f.set(1, 65, 1, 'stone'); f.refresh()
  const mining = f.next()
  assert.equal(mining.type, 'mine_stone')
  assert.equal(mining.count, 16)
  f.items([['iron_pickaxe', 1], ['cobblestone', 15]])
  assert.equal(f.next().type, 'mine_stone')
  assert.equal(f.next().count, 1)
  f.items([['iron_pickaxe', 1], ['cobblestone', 16]])
  assert.equal(f.next().type, 'complete')
})

test('known drops are collected before cutting more trees and lack of pickup is reported', () => {
  const f = fixture()
  f.observations.drops = [{ known: true, entityId: '20', name: 'minecraft:oak_log', count: 1, position: { x: 1, y: 65, z: 0 } }]
  assert.equal(f.next().type, 'collect_drops')
  f.observations.capabilities.collect_drops = false
  assert.equal(f.next().capability, 'collect_drops')
})

test('excluded resource blocks stay in the natural-tree graph but are not selected for another attempt', () => {
  const f = fixture()
  f.set(2, 65, 1, 'oak_log'); f.refresh()
  const first = f.next()
  assert.equal(first.type, 'gather_logs')
  f.observations.progress = { excludedResources: [{ resource: 'logs', position: first.target }] }
  const next = f.next()
  assert.equal(next.type, 'gather_logs')
  assert.notDeepEqual(next.target, first.target)
  assert.equal(next.target.y, first.target.y, 'only another bottom-layer log may replace an excluded bottom')
  assert.equal(next.treeEvidence.componentSize, first.treeEvidence.componentSize, 'exclusions cannot cut structural evidence out of a connected tree')
  f.observations.progress.excludedResources = [{ x: 2, y: 65, z: 0 }, { x: 2, y: 65, z: 1 }].map(position => ({ resource: 'logs', position }))
  assert.equal(f.next().type, 'scan_blocks')
})

test('excluded drop IDs are skipped without excluding different nearby drops', () => {
  const f = fixture()
  f.observations.drops = [
    { known: true, entityId: 'unreachable', name: 'minecraft:oak_log', count: 3, position: { x: 1, y: 65, z: 0 } },
    { known: true, runtimeId: 'reachable', name: 'minecraft:oak_log', count: 1, position: { x: 2, y: 65, z: 0 } }
  ]
  f.observations.progress = { excludedDropIds: ['unreachable'] }
  const selected = f.next()
  assert.equal(selected.type, 'collect_drops')
  assert.deepEqual(selected.targets.map(target => target.entityId), ['reachable'])
})

test('stone drops are collected before equipping or mining more blocks once a pickaxe exists', () => {
  const f = fixture()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 14]])
  f.observations.drops = [
    { known: true, entityId: '30', name: 'minecraft:cobblestone', count: 1, position: { x: 1, y: 65, z: 0 } },
    { known: true, entityId: '31', name: 'minecraft:cobbled_deepslate', count: 1, position: { x: 2, y: 65, z: 0 } }
  ]
  const action = f.next()
  assert.equal(action.type, 'collect_drops')
  assert.equal(action.stage, 'stone')
  assert.equal(action.count, 2)
  assert.equal(action.targets.length, 2)
  f.observations.capabilities.collect_drops = false
  assert.equal(f.next().capability, 'collect_drops')
})

test('planner is deterministic and leaves observations and snapshots unchanged', () => {
  const f = fixture()
  const before = structuredClone({ snapshot: f.snapshot, observations: f.observations })
  assert.deepEqual(f.next(), f.next())
  assert.deepEqual({ snapshot: f.snapshot, observations: f.observations }, before)
})

// Geometry captured from the real forest approach on 2026-10-30. This fixture
// includes only known block names/collision labels: no account or auth data.
// Layers are y=63..76, each row z=24..37, columns x=-17..-4. The capture was
// taken after death; health/dead are explicitly restored to the alive attempt.
const LIVE_APPROACH_LEGEND = {"S":{"name":"minecraft:stone","boundingBox":"block"},"C":{"name":"minecraft:coal_ore","boundingBox":"block"},"D":{"name":"minecraft:dirt","boundingBox":"block"},"G":{"name":"minecraft:grass_block","boundingBox":"block"},"T":{"name":"minecraft:short_grass","boundingBox":"empty"},".":{"name":"minecraft:air","boundingBox":"empty"},"L":{"name":"minecraft:leaf_litter","boundingBox":"empty"},"O":{"name":"minecraft:oak_leaves","boundingBox":"block"},"A":{"name":"minecraft:acacia_leaves","boundingBox":"block"},"W":{"name":"minecraft:acacia_log","boundingBox":"block"}}
const LIVE_APPROACH_LAYERS = [
  "SSSSSSSSSSDD..\nSSSSSSSSSSDG..\nCSSSSSSSSDG...\nCSSSSSSSSG....\nSSSSSSS.......\nSSSSDDD.......\nSSSSSD........\nSSSSSSD.......\nSSSSSSS.......\nSSSSSSDD.....T\nSSSSSSDD.....T\nSSSSSSSDD.TT.T\nSSSSSDSDG.T...\nSSSSSSDDGT.T..",
  "SSSSSSSSSDDG..\nSSSSSSSSSDD...\nCSSSSSSSDD....\nCDDSDSSS......\nSSDDDSD.......\nSSSSDDD.......\nSSSSDDD.......\nSSSSSDD.......\nSSSSSSD.......\nSSSSSDDD......\nSSSSDDDDG.....\nSSSSDDDDG.....\nSSSDDDDD......\nSSSDSDDDT.....",
  "SSSSSSSDDDGT..\nSSSSSSSDDDG...\nSSSSSSSDDG....\nSDDDDSDD......\nSSDDDDD.......\nSSSDDGG.......\nSSSDDDG.......\nSSDDDDD.......\nSSDDDDD.......\nSSDDDDDG......\nSDDDDDDGT.....\nSDDDDDDG......\nSDDDDDDG......\nSDSDDDDG......",
  "SSSSGGDDDG....\nSSSSGDDDDG....\nSDSSDDDDG.....\nDDDDDDDGG.....\nDDDGGDGG......\nSSDDG.T.......\nSSSDDG.G......\nSSDDDDGG......\nDDDDDDDG......\nDDDDDDG.......\nDDDDDDG.......\nDDDDDDG.......\nDDDDDGG.......\nDDDDDGG.......",
  "SDG...GGG.....\nSDG..GGGGT....\nDDD.GGGG......\nDGGGGDG.......\nDDG..G.T......\nDDDG..........\nDDDDG.........\nDDDDDGT.......\nDDDDDDG.......\nDDDDDGT..W....\nDDDDGG........\nDDDDGG........\nDDDGG.........\nDDDGG.........",
  "DD............\nDD............\nDDG...........\nDTTT.G........\nDG............\nDDG...........\nDDDGT.........\nDDGGG.........\nDDGGGG........\nDDGGG....WA...\nDGGG.T..AAA...\nDGGG..........\nDGG...........\nDGG.T.........",
  "GG............\nGG............\nGG............\nGGGG..........\nGT............\nGG............\nGGG...........\nGGLTT.........\nGG...T........\nGG............\nGTT...........\nGL............\nG.............\nG.............",
  "..............\n..............\n..............\n..............\nT.............\n..............\n.TL...........\nLL............\nLL............\nLL............\nT.............\nL.............\nL.............\n..............",
  "..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............",
  "..............\n..............\n..............\n..............\n..............\n..............\n..............\nO.............\nOO............\nOO............\nOO............\nO.............\n..............\n..............",
  "..............\n..............\n..............\n..............\n..............\n..............\n..............\nOO............\nOO............\nOO............\nOO............\nOO............\n..............\n..............",
  "..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\nO.............\nO.............\nO.............\n..............\n..............\n..............",
  "..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\nO.............\n..............\n..............\n..............\n..............",
  "........AAA...\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n..............\n.............."
]
function savedForestApproach () {
  const snapshot = {"phase":"spawned","version":"1.26.60","gameMode":"survival","position":{"x":-10.30000114440918,"y":67.62001037597656,"z":30.700000762939453},"inventory":{"known":true,"items":[]},"heldItem":null,"selectedSlot":0,"world":{"version":"1.26.60","dimension":"overworld","initialized":true,"mappingIssue":null,"loadedSections":84,"cachedSections":96,"announcedColumns":156,"levelChunks":312,"subchunks":84,"blockUpdates":2712,"decodeErrors":0,"skippedCached":0,"lastError":null},"capabilities":{"movement":true,"mining":true,"flatWalking":true,"navigationPrediction":true,"crafting":true,"interactions":true}}
  snapshot.health = 20
  snapshot.dead = false
  snapshot.position = { x: -10.5158, y: 67.62001037597656, z: 30.5706 }
  const blocks = []
  for (const [layer, text] of LIVE_APPROACH_LAYERS.entries()) {
    const rows = text.split('\n')
    for (const [row, line] of rows.entries()) for (const [column, symbol] of [...line].entries()) {
      blocks.push({ known: true, position: { x: -17 + column, y: 63 + layer, z: 24 + row }, ...LIVE_APPROACH_LEGEND[symbol], runtimeId: 0, extra: [] })
    }
  }
  return { snapshot, observations: { blocks, drops: [], capabilities: { scan_blocks: true, craft: true, place_block: true, use_table: true, equip: true, collect_drops: true }, crafting: { previews: {} } } }
}

test('saved forest approach does not repeat its almost-reached grazing stance and tolerates normal stop drift', () => {
  const f = savedForestApproach()
  assert.equal(f.observations.blocks.length, 2744)
  const action = nextBootstrapAction(f.snapshot, f.observations)
  assert.equal(action.type, 'move_to')
  assert.deepEqual(action.resourceTarget, { x: -8, y: 67, z: 33 })
  assert.notDeepEqual(action.target, { x: -10.5, y: 66, z: 30.5 })
  assert.ok(Math.hypot(action.target.x - f.snapshot.position.x, action.target.y - (f.snapshot.position.y - 1.62), action.target.z - f.snapshot.position.z) > 0.4)
  assert.ok(action.stance.centerDistance <= 4)
  assert.ok(action.stance.worstDistance <= 4.3)
  const offsets = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.2, 0.2], [0.2, -0.2], [-0.2, 0.2], [-0.2, -0.2]]
  for (const [dx, dz] of offsets) {
    const actual = structuredClone(f.snapshot)
    actual.position = { x: action.target.x + dx, y: action.target.y + 1.62, z: action.target.z + dz }
    const next = nextBootstrapAction(actual, f.observations)
    assert.equal(next.type, 'gather_logs', 'a small normal stopping deviation must not trigger the same move again')
    assert.deepEqual(next.target, action.resourceTarget)
    assert.equal(next.treeEvidence.componentBottom, 67)
  }
})
