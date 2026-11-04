'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextSurvivalAction } = require('../src/survival-planner')
const { nextDiamondAction } = require('../src/diamond-planner')

function fixture () {
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, startedAt: 'session', connectionId: 'socket', version: '1.26.60', selectedSlot: 0, heldItem: null, inventory: { known: true, items: [] }, world: { initialized: true, loadedSections: 27, version: '1.26.60' }, capabilities: { mining: true, movement: true } }
  const map = new Map()
  const set = (x, y, z, name, metadata = {}) => map.set(`${x},${y},${z}`, { known: true, position: { x, y, z }, name: `minecraft:${name}`, properties: {}, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', extra: [], ...metadata })
  for (let x = -4; x <= 8; x++) for (let y = 62; y <= 72; y++) for (let z = -4; z <= 4; z++) set(x, y, z, y < 64 ? 'stone' : y === 64 ? 'grass_block' : 'air')
  for (let y = 65; y <= 68; y++) set(3, y, 0, 'oak_log')
  set(3, 69, 0, 'oak_leaves')
  set(1, 65, 1, 'stone')
  const plan = { ready: true, type: 'soil_hill_shelter', id: 'soil-1', outsideStandpoint: { x: 0.5, y: 65, z: 0.5 }, entry: { x: 1, y: 65, z: 0 }, inner: { x: 2, y: 65, z: 0 }, doorCells: [{ x: 1, y: 65, z: 0 }, { x: 1, y: 66, z: 0 }] }
  const observations = { blocks: [...map.values()], crafting: { previews: {} }, shelter: { preview: plan, status: { phase: 'idle', usable: false } }, capabilities: { build_shelter: true, leave_shelter: true, scan_blocks: true, explore: true, craft: true, place_block: true, use_table: true, equip: true, collect_drops: true, respawn: true } }
  const items = values => { state.inventory.items = values.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) }
  const hold = name => { const item = state.inventory.items.find(item => item.name === `minecraft:${name}`); state.heldItem = structuredClone(item); state.selectedSlot = item.slot }
  const refresh = () => { observations.blocks = [...map.values()] }
  const table = () => { set(-1, 65, 1, 'crafting_table'); observations.craftingTable = { known: true, usable: true, position: { x: -1, y: 65, z: 1 } }; refresh() }
  const base = () => { observations.shelter.status = { established: true, structureIntact: true, serverConfirmed: true, inside: false, entranceClosed: false, closed: false, usable: false, phase: 'idle' }; observations.shelter.preview = { ready: false, code: 'NO_KNOWN_SOIL_HILL' } }
  const preview = (output, times = 1, extra = {}) => { observations.crafting.previews[output] = { ready: true, output: { name: `minecraft:${output}`, count: output === 'stick' ? 4 : output.endsWith('_planks') ? times * 4 : 1 }, times, recipeNetworkId: 1911, ...extra } }
  return { state, observations, map, set, plan, items, hold, refresh, table, base, preview, next: options => nextSurvivalAction(state, observations, options) }
}

test('unreceived remote station remains history while first sword funds a local table from four or eight planks', () => {
  const f = fixture(), memory = { known: true, serverConfirmed: true, placedByBot: true, position: { x: -17, y: 65, z: 0 } }
  f.observations.stations = { craftingTable: memory }
  f.items([['oak_planks', 4]])
  const before = structuredClone(f.observations.stations), wood = f.next({ firstWoodenSwordOnly: true })
  assert.equal(wood.type, 'gather_logs'); assert.equal(wood.count, 1)
  assert.equal(wood.resource ?? wood.stage, 'logs')
  f.items([['oak_planks', 8]]); f.preview('crafting_table')
  const table = f.next({ firstWoodenSwordOnly: true })
  assert.equal(table.type, 'craft'); assert.equal(table.output, 'minecraft:crafting_table')
  assert.equal(table.requiresLivePreview, true)
  assert.equal(table.serverConfirmed, undefined)
  assert.deepEqual(f.observations.stations, before)
  f.items([['oak_planks', 4], ['crafting_table', 1]])
  assert.equal(f.next({ firstWoodenSwordOnly: true }).type, 'place_crafting_table', 'an actual inventory table still supplies the material budget')
  assert.deepEqual(f.observations.stations, before)
})

test('unreceived remote station cannot stall the shared bootstrap and later stone-sword table preparation', () => {
  const f = fixture(); f.state.threatPolicy = 'online_learning'
  f.observations.stations = { craftingTable: { known: true, serverConfirmed: true, position: { x: -17, y: 65, z: 0 } } }
  f.items([['wooden_sword', 1], ['oak_planks', 4]])
  const pickPreparation = f.next({ deferOptionalShelter: true, objective: 'diamond' })
  assert.equal(pickPreparation.type, 'gather_logs')
  assert.notEqual(pickPreparation.resource ?? pickPreparation.stage, 'crafting_table')
  assert.equal(pickPreparation.preparation, 'sword_bootstrap')
  f.items([['wooden_sword', 1], ['wooden_pickaxe', 1], ['cobblestone', 5], ['stick', 1], ['oak_planks', 4]])
  f.preview('crafting_table')
  const station = f.next({ deferOptionalShelter: true, objective: 'diamond' })
  assert.equal(station.type, 'craft'); assert.equal(station.output, 'minecraft:crafting_table')
  assert.notEqual(station.type, 'complete')
})

test('received reachable table is reused while unknown replacement or unusable access cannot supply its budget', () => {
  const f = fixture(); f.table(); f.items([['oak_planks', 2], ['stick', 4]])
  f.preview('wooden_sword', 1, { ready: false, needsCraftingTable: true })
  const use = f.next({ firstWoodenSwordOnly: true })
  assert.equal(use.type, 'open_crafting_table')
  assert.deepEqual(use.target, f.observations.craftingTable.position)
  for (const mode of ['unknown', 'stone', 'unusable']) {
    const invalid = fixture(); invalid.table(); invalid.items([['oak_planks', 4]])
    if (mode === 'unknown') invalid.set(-1, 65, 1, 'crafting_table', { known: false })
    if (mode === 'stone') invalid.set(-1, 65, 1, 'stone')
    if (mode === 'unusable') { invalid.observations.craftingTable.usable = false; invalid.set(-1, 65, 1, 'crafting_table', { usable: false }) }
    invalid.refresh()
    const next = invalid.next({ firstWoodenSwordOnly: true })
    assert.equal(next.type, 'gather_logs', mode)
    assert.equal(next.count, 1, mode)
  }
})

test('online learning HP1 first sword still follows two received logs and exact wooden recipe budget', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.next({ firstWoodenSwordOnly: true }).code, 'low_health')
  f.state.threatPolicy = 'online_learning'
  const action = f.next({ firstWoodenSwordOnly: true })
  assert.equal(action.type, 'gather_logs'); assert.equal(action.count, 2)
  f.items([['oak_log', 2]])
  const craft = f.next({ firstWoodenSwordOnly: true })
  assert.equal(craft.output, 'minecraft:oak_planks'); assert.equal(craft.times, 2)
  f.state.lifecycle = { dead: true }
  assert.equal(f.next({ firstWoodenSwordOnly: true }).type, 'respawn')
})

test('an observed barehand soil shelter precedes wood and stone-sword preparation', () => {
  const f = fixture()
  const before = structuredClone({ state: f.state, observations: f.observations })
  const action = f.next()
  assert.equal(action.type, 'build_shelter')
  assert.deepEqual(action.plan, f.plan)
  assert.equal(action.requiresLivePreview, true)
  assert.equal(action.requiresServerBlocks, true)
  assert.deepEqual(action.goal, { diamond: 1 })
  assert.deepEqual({ state: f.state, observations: f.observations }, before)
  f.observations.capabilities.build_shelter = false
  assert.equal(f.next().type, 'capability_required')
  assert.equal(f.next().capability, 'build_shelter')
})

test('food-gated first-sword mode stays within the two-log wooden recipe even with funded stone or a ready shelter', () => {
  const f = fixture()
  f.state.health = 13.90063
  f.items([['wooden_pickaxe', 1], ['cobblestone', 12]])
  const action = f.next({ firstWoodenSwordOnly: true })
  assert.equal(action.type, 'gather_logs')
  assert.equal(action.count, 2)
  assert.equal(action.preparation, 'wooden_sword')
  assert.equal(action.subgoal.name, 'wooden_sword')
  f.items([['oak_log', 2], ['cobblestone', 12]])
  const planks = f.next({ firstWoodenSwordOnly: true })
  assert.equal(planks.output, 'minecraft:oak_planks')
  assert.equal(planks.times, 2)
  assert.equal(planks.preparation, 'wooden_sword')
  for (const sword of ['wooden_sword', 'stone_sword', 'golden_sword', 'iron_sword']) {
    f.items([[sword, 1]])
    assert.equal(f.next({ firstWoodenSwordOnly: true }), null, 'received sword acquisition ends this restricted subgoal')
  }
})

test('shelter approaches and currently revalidated partial work remain explicit actions', () => {
  const f = fixture()
  f.observations.shelter.preview = { ready: false, code: 'APPROACH_REQUIRED', approach: { target: { x: 4.5, y: 65, z: 2.5 }, candidateId: 'soil-2' }, proposal: { type: 'move_to', target: { x: 4.5, y: 65, z: 2.5 }, goal: { stone: 16 } } }
  let action = f.next()
  assert.equal(action.type, 'move_to')
  assert.equal(action.resource, 'shelter')
  assert.deepEqual(action.goal, { diamond: 1 })
  f.observations.shelter.memo = { site: f.plan, closed: true, usable: true, serverConfirmed: true }
  f.observations.shelter.preview = null
  assert.equal(f.next().code, 'shelter_revalidation_required', 'a remembered closed flag is not current geometry evidence')
  f.observations.shelter.preview = { ready: false, resumeReady: true, canResume: true, site: f.plan }
  action = f.next()
  assert.equal(action.type, 'build_shelter')
  assert.ok(action.memo)
})

test('a distant unverified remembered shelter does not block local resource preparation', () => {
  const f = fixture()
  f.state.position = { x: 40.5, y: 66.62, z: 0.5 }
  f.observations.shelter.memo = { site: f.plan, requiresWorldValidation: true, pendingPlacement: null }
  f.observations.shelter.preview = null
  const before = structuredClone(f.observations.shelter.memo)
  const decision = f.next()
  assert.notEqual(decision.code, 'shelter_revalidation_required')
  assert.notEqual(decision.type, 'leave_shelter')
  assert.deepEqual(f.observations.shelter.memo, before)
  for (const mode of ['pending', 'unknown_anchor', 'inside', 'near']) {
    const current = fixture()
    current.state.position = { x: mode === 'near' ? 2 : 40.5, y: 66.62, z: 0.5 }
    current.observations.shelter.preview = null
    current.observations.shelter.memo = { site: mode === 'unknown_anchor' ? {} : current.plan, pendingPlacement: mode === 'pending' ? { requiresReconciliation: true } : null }
    if (mode === 'inside') current.observations.shelter.status.inside = true
    assert.equal(current.next().code, 'shelter_revalidation_required', mode)
  }
})

test('a closed occupied refuge requires a real exit even when a sword is already held', () => {
  const f = fixture()
  f.observations.shelter.status = { usable: true, closed: true, serverConfirmed: true, inside: true, entranceClosed: true, memo: { site: f.plan } }
  f.items([['stone_sword', 1]])
  assert.equal(f.next().type, 'leave_shelter')
  f.observations.capabilities.leave_shelter = false
  assert.equal(f.next().capability, 'leave_shelter')
})

test('an established open base with current intact geometry does not trigger a rebuild loop', () => {
  const f = fixture()
  f.base()
  f.items([['stone_sword', 1]])
  assert.equal(f.next(), null)
  f.observations.shelter.status.structureIntact = false
  assert.notEqual(f.next(), null)
  f.observations.shelter.status.structureIntact = true
  f.observations.shelter.status.serverConfirmed = false
  assert.notEqual(f.next(), null)
})

test('bootstrap decisions gather real wood then five stone without turning the diamond goal into a preparation completion', () => {
  const f = fixture()
  f.base()
  assert.equal(f.next().type, 'gather_logs')
  assert.equal(f.next().count, 2)
  assert.equal(f.next().preparation, 'wooden_sword')
  f.items([['wooden_sword', 1], ['wooden_pickaxe', 1], ['cobblestone', 2]])
  f.hold('wooden_pickaxe')
  f.state.walking = { phase: 'awaiting_server_confirmation', running: false }
  const action = f.next()
  assert.equal(action.type, 'mine_stone')
  assert.equal(action.count, 3)
  assert.deepEqual(action.goal, { diamond: 1 })
  assert.equal(action.preparation, 'sword_bootstrap')
})

test('two real logs prepare planks, a table, sticks and an early wooden sword before any pickaxe or stone work', () => {
  const f = fixture()
  f.base()
  const before = structuredClone({ state: f.state, observations: f.observations })
  assert.equal(f.next().count, 2)
  assert.equal(f.next().preparation, 'wooden_sword')
  assert.deepEqual({ state: f.state, observations: f.observations }, before)
  f.items([['oak_log', 2]])
  let action = f.next()
  assert.equal(action.type, 'preview_craft')
  assert.equal(action.output, 'minecraft:oak_planks')
  assert.equal(action.times, 2)
  f.preview('oak_planks', 2)
  assert.equal(f.next().type, 'craft')
  assert.equal(f.state.inventory.items[0].name, 'minecraft:oak_log', 'a proposal never commits material conversion')
  f.items([['oak_planks', 8]])
  f.preview('crafting_table')
  assert.equal(f.next().output, 'minecraft:crafting_table')
  f.items([['oak_planks', 4], ['crafting_table', 1]])
  assert.equal(f.next().type, 'place_crafting_table')
  f.table()
  f.items([['oak_planks', 4]])
  assert.equal(f.next().output, 'minecraft:stick')
  f.preview('stick')
  assert.equal(f.next().type, 'craft')
  f.items([['oak_planks', 2], ['stick', 4]])
  assert.equal(f.next().output, 'minecraft:wooden_sword')
  assert.equal(f.next().type, 'preview_craft')
  f.preview('wooden_sword', 1, { ready: false, needsCraftingTable: true })
  assert.equal(f.next().type, 'open_crafting_table')
  f.preview('wooden_sword')
  action = f.next()
  assert.equal(action.type, 'craft')
  assert.equal(action.output, 'minecraft:wooden_sword')
  assert.equal(action.recipeNetworkId, 1911)
  assert.equal(action.preparation, 'wooden_sword')
  assert.notEqual(f.next(), null, 'a preview and proposed craft are not an inventory sword')
  f.items([['wooden_sword', 1], ['stick', 3]])
  action = f.next()
  assert.equal(action.type, 'gather_logs')
  assert.equal(action.preparation, 'sword_bootstrap')
  assert.equal(action.counts.swords, 0, 'the final preparation still requires stone or better')
  assert.equal(action.counts.woodenSwords, 1)
  assert.deepEqual(action.goal, { diamond: 1 })
})

test('an existing pickaxe cannot hide the early sword deficit and stale recipes or missing capabilities cannot complete it', () => {
  const f = fixture()
  f.base(); f.table()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 2], ['oak_planks', 2], ['stick', 1]])
  f.hold('wooden_pickaxe')
  f.preview('wooden_sword', 2)
  assert.equal(f.next().type, 'preview_craft')
  assert.equal(f.next().output, 'minecraft:wooden_sword')
  f.preview('wooden_sword')
  assert.equal(f.next().type, 'craft')
  f.observations.capabilities.craft = false
  assert.equal(f.next().type, 'capability_required')
  assert.equal(f.next().capability, 'craft')
  f.state.inventory.known = false
  assert.equal(f.next().code, 'inventory_unknown')
  const noTable = fixture()
  noTable.base()
  noTable.items([['crafting_table', 1], ['oak_planks', 4]])
  noTable.observations.capabilities.place_block = false
  assert.equal(noTable.next().capability, 'place_block')
})

test('an already funded stone sword skips the lower wooden recipe while a wooden sword alone never ends preparation', () => {
  const f = fixture()
  f.base(); f.table()
  f.items([['cobblestone', 5], ['stick', 1]])
  f.preview('stone_sword')
  assert.equal(f.next().output, 'minecraft:stone_sword')
  f.items([['wooden_sword', 1], ['wooden_pickaxe', 1]])
  f.hold('wooden_pickaxe')
  assert.equal(f.next().type, 'mine_stone')
  assert.notEqual(f.next(), null)
  f.items([['stone_sword', 1]])
  assert.equal(f.next(), null)
})

test('stone sword needs received recipe preview and actual materials; only its server inventory presence finishes preparation', () => {
  const f = fixture()
  f.base(); f.table()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 5], ['stick', 1]])
  f.hold('wooden_pickaxe')
  assert.equal(f.next().type, 'preview_craft')
  assert.equal(f.next().output, 'minecraft:stone_sword')
  f.preview('stone_sword', 2)
  assert.equal(f.next().type, 'preview_craft', 'a different recipe batch does not authorize this craft')
  f.preview('stone_sword')
  const action = f.next()
  assert.equal(action.type, 'craft')
  assert.equal(action.recipeNetworkId, 1911)
  assert.equal(action.times, 1)
  assert.notEqual(f.next(), null, 'a ready preview is not an actual sword')
  f.items([['wooden_pickaxe', 1], ['cobblestone', 3], ['stone_sword', 1]])
  assert.equal(f.next(), null)
})

test('missing sticks and table are prepared explicitly instead of trusting a stale sword recipe', () => {
  const f = fixture()
  f.base(); f.table()
  f.items([['wooden_pickaxe', 1], ['cobblestone', 5], ['oak_planks', 2]])
  assert.equal(f.next().output, 'minecraft:stick')
  f.preview('stick')
  assert.equal(f.next().type, 'craft')
  const noTable = fixture()
  noTable.base()
  noTable.items([['wooden_pickaxe', 1], ['cobblestone', 5], ['stick', 1], ['oak_planks', 4]])
  noTable.preview('stone_sword')
  assert.equal(noTable.next().output, 'minecraft:crafting_table')
})

test('table use and placement retain capability and current-block requirements', () => {
  const f = fixture()
  f.base(); f.table()
  f.items([['cobblestone', 5], ['stick', 1]])
  f.preview('stone_sword', 1, { ready: false, needsCraftingTable: true })
  assert.equal(f.next().type, 'open_crafting_table')
  f.observations.capabilities.use_table = false
  assert.equal(f.next().capability, 'use_table')
  const place = fixture()
  place.base()
  place.items([['cobblestone', 5], ['stick', 1], ['crafting_table', 1]])
  assert.equal(place.next().type, 'place_crafting_table')
  f.set(-1, 65, 1, 'air'); f.refresh()
  assert.notEqual(f.next().type, 'open_crafting_table', 'a missing actual table invalidates its remembered record')
})

test('without a soil hill the planner prepares resources, then explores only observed terrain under a finite budget', () => {
  const f = fixture()
  f.observations.shelter.preview = { ready: false, code: 'NO_KNOWN_SOIL_HILL' }
  assert.equal(f.next().type, 'gather_logs')
  f.items([['stone_sword', 1]])
  assert.equal(f.next().type, 'scan_blocks')
  f.observations.coverage = { known: 10, unknown: 0, expected: 10 }
  let action = f.next()
  assert.equal(action.type, 'explore')
  assert.equal(action.resource, 'shelter')
  assert.equal(action.allowWater, false)
  assert.equal(action.requiresKnownTerrain, true)
  f.observations.capabilities.explore = false
  assert.equal(f.next().capability, 'explore')
  f.observations.progress = { explorationAttempts: 8 }
  action = f.next()
  assert.equal(action.type, 'stop')
  assert.equal(action.code, 'shelter_search_limit')
})

test('an exhausted optional shelter search yields to the actual diamond plan for a safely prepared miner', () => {
  const f = fixture()
  f.observations.shelter.preview = { ready: false, code: 'NO_KNOWN_SOIL_HILL' }
  f.observations.progress = { explorationAttempts: 8 }
  f.observations.coverage = { known: 10, unknown: 0, expected: 10 }
  f.observations.capabilities.prospect = true
  f.state.entities = []
  f.items([['iron_pickaxe', 1], ['stone_sword', 1]])
  Object.assign(f.state.inventory.items[0], { durabilityKnown: true, durabilityRemaining: 250, maxDurability: 250, durabilityUsed: 0 })
  f.hold('iron_pickaxe')
  const options = { objective: 'diamond', diamondCount: 1 }
  const before = structuredClone({ state: f.state, observations: f.observations })
  const decision = f.next(options) ?? nextDiamondAction(f.state, f.observations, options)
  assert.equal(decision.type, 'prospect')
  assert.equal(decision.resource, 'diamond')
  assert.deepEqual(decision.goal, { diamond: 1 })
  assert.deepEqual({ state: f.state, observations: f.observations }, before)
  f.observations.shelter.preview = f.plan
  assert.equal(f.next(options).type, 'build_shelter', 'an observed buildable shelter remains opportunistic preparation')
})

test('shelter-search fallback cannot bypass unknown danger, inadequate tools, or health', () => {
  for (const mode of ['actors_unknown', 'nearby_enemy', 'unknown_durability', 'worn', 'no_sword', 'low_health', 'other_objective']) {
    const f = fixture()
    f.observations.shelter.preview = { ready: false, code: 'NO_KNOWN_SOIL_HILL' }
    f.observations.progress = { explorationAttempts: 8 }
    f.observations.coverage = { known: 10, unknown: 0, expected: 10 }
    f.state.entities = []
    f.items([['iron_pickaxe', 1], ['stone_sword', 1]])
    Object.assign(f.state.inventory.items[0], { durabilityKnown: true, durabilityRemaining: 250 })
    f.hold('iron_pickaxe')
    if (mode === 'actors_unknown') delete f.state.entities
    if (mode === 'nearby_enemy') f.state.entities.push({ kind: 'mob', runtimeId: '9', uniqueId: '9', entityType: 'minecraft:zombie', alive: true, positionKnown: true, position: { x: 2, y: 65, z: 0.5 } })
    if (mode === 'unknown_durability') f.state.inventory.items[0].durabilityKnown = false
    if (mode === 'worn') f.state.inventory.items[0].durabilityRemaining = 4
    if (mode === 'no_sword') f.state.inventory.items.splice(1, 1)
    if (mode === 'low_health') f.state.health = 14
    const decision = f.next({ objective: mode === 'other_objective' ? 'bootstrap' : 'diamond' })
    assert.notEqual(decision, null, mode)
    assert.notEqual(decision.type, 'complete', mode)
  }
})

test('actual diamond inventory bypasses every preparation while uncertain or predicted inventory cannot finish the goal', () => {
  const f = fixture()
  f.items([['diamond', 1]])
  f.observations.capabilities.build_shelter = false
  assert.equal(f.next(), null)
  f.state.inventory.uncertain = true
  assert.equal(f.next().code, 'inventory_unknown')
  f.state.inventory.uncertain = false
  f.state.inventory.source = 'client_prediction'
  assert.equal(f.next().code, 'inventory_unknown')
})

test('death, low health, unknown inventory and active tasks prevent preparation mutations', () => {
  for (const [change, expected] of [
    [f => { f.state.health = 0; f.state.dead = true }, 'respawn'],
    [f => { f.state.health = 4 }, 'stop'],
    [f => { f.state.inventory.known = false }, 'wait'],
    [f => { f.observations.shelter.status.busy = true }, 'wait']
  ]) {
    const f = fixture(); change(f); assert.equal(f.next().type, expected)
  }
})
