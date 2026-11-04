'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { supplyScope, readStationPages, currentStationPage, planSupplyReturn } = require('../src/supply-return')
const { nextDiamondAction } = require('../src/diamond-planner')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const capture = require('./fixtures/stone-kit176-supply.json')
const copy = v => structuredClone(v), key = p => `${p.x},${p.y},${p.z}`
function scene () {
  const state = copy(capture.state), floors = copy(capture.floors)
  const cells = new Map([...capture.local, ...capture.remote].map(b => [key(b.position), copy(b)]))
  const world = { getBlock: (x, y, z) => copy(cells.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } }) }
  const pages = readStationPages({ state, stations: capture.stations, world })
  const args = { state, floors, floorScope: { profile: state.profile, realmId: state.realm.id, dimension: state.dimension }, stationPage: pages.craftingTable, world }
  const observations = { state, blocks: copy(capture.local), stations: copy(capture.stations), stationPages: pages, furnace: copy(capture.furnace), ores: { coal: [], iron: [], diamond: [] }, crafting: { previews: {} }, capabilities: { move: true, scan_blocks: true, craft: true, place_block: true, use_table: true, equip: true, collect_drops: true, prospect: true, tunnel: true, mine_ore: true, place_furnace: true } }
  return { state, floors, cells, world, pages, args, observations }
}
test('actual176 table page stays separate from local resource coverage and actual AIR furnace is absent', () => {
  const f = scene(), before = copy(f.observations.blocks)
  assert.equal(currentStationPage(f.state, f.pages.craftingTable).block.name, 'minecraft:crafting_table')
  assert.equal(f.pages.furnace.block.name, 'minecraft:air'); assert.equal(currentStationPage(f.state, f.pages.furnace, 'furnace'), null)
  assert.equal(f.observations.blocks.length, 10000); assert.deepEqual(f.observations.blocks, before)
  assert.equal(f.pages.craftingTable.usable, false); assert.equal(f.pages.craftingTable.serverConfirmed, false)
})
test('preserved connected floor graph returns only two existing uphill waypoints despite initially moving away from the table', () => {
  const f = scene(), r = planSupplyReturn(f.args)
  assert.equal(r.ready, true, r.reason); assert.equal(r.waypoints.length, 2)
  assert.deepEqual(r.waypoints, [{ x: -19.5, y: 58, z: 12.5 }, { x: -18.5, y: 59, z: 12.5 }])
  assert.equal(r.serverConfirmed, false); assert.equal(r.predictionOnly, true); assert.equal(r.visitedPrefix, undefined)
  const distance = p => Math.hypot(p.x + 35.5, p.z - 50.5)
  assert.ok(distance(r.target) > distance(f.state.position)); assert.equal(r.entryRouteKnown, false)
  assert.equal(f.floors.length, 9)
})
test('unknown floor/body, blocked body, liquid, nonrecorded corridor and mismatched floor/page scope cannot authorize a return', () => {
  for (const mode of ['unknown_floor', 'unknown_body', 'solid_body', 'water', 'missing_record', 'wrong_world', 'wrong_life', 'stale']) {
    const f = scene()
    if (mode === 'unknown_floor') f.cells.set('-20,57,12', { known: false, position: { x: -20, y: 57, z: 12 } })
    if (mode === 'unknown_body') f.cells.set('-20,58,12', { known: false, position: { x: -20, y: 58, z: 12 } })
    if (['solid_body', 'water'].includes(mode)) f.cells.set('-20,58,12', { ...f.cells.get('-20,58,12'), name: mode === 'water' ? 'minecraft:water' : 'minecraft:stone', boundingBox: mode === 'water' ? 'empty' : 'block' })
    if (mode === 'missing_record') f.args.floors = [f.floors[0], f.floors[2]]
    if (mode === 'wrong_world') f.args.floorScope.realmId = 'wrong'
    if (mode === 'wrong_life') f.args.stationPage.scope = 'old'
    if (mode === 'stale') f.args.stationPage.readAt = Date.now() - 11000
    assert.equal(planSupplyReturn(f.args).ready, false, mode)
  }
})
test('inventory shortfall alone cannot bypass dead/unknown inventory, missing actual life, airborne or water state', () => {
  for (const mutate of [s => { s.health = 0 }, s => { s.inventory.known = false }, s => { s.inventory.uncertain = true }, s => { delete s.lifecycle }, s => { s.predicted.physicsState.onGround = false }, s => { s.predicted.physicsState.isInWater = true }]) {
    const f = scene(); mutate(f.state); assert.equal(planSupplyReturn(f.args).ready, false)
  }
})
test('at recorded entry level within two blocks of table height, normal wood/table fallback resumes instead of chasing distant station', () => {
  const f = scene(); f.state.position = { x: -11.5, y: 67.62, z: 12.5 }
  f.state.predicted.physicsState.position = { x: -11.5, y: 66, z: 12.5 }
  f.pages.craftingTable.scope = supplyScope(f.state)
  assert.equal(planSupplyReturn(f.args).reason, 'at_worksite')
  const action = nextDiamondAction(f.state, f.observations)
  assert.notEqual(action.supplyReturnRequested, true); assert.notEqual(action.supplyReturn, true)
})
test('actual highest connected nine-floor endpoint at feet65 permits local supplies even though the remote table stands at68', () => {
  const f = scene(); f.state.position = { x: -14.5, y: 66.62, z: 14.5 }
  f.state.predicted.physicsState.position = { x: -14.5, y: 65, z: 14.5 }
  const back = planSupplyReturn(f.args)
  assert.equal(back.ready, false); assert.equal(back.reason, 'at_supply_exit'); assert.equal(back.localSupplyFallback, true)
  assert.equal(back.serverConfirmed, false); assert.equal(back.visitedPrefix, undefined)
  f.observations.supplyReturn = back
  const action = nextDiamondAction(f.state, f.observations)
  assert.notEqual(action.supplyReturnRequested, true); assert.notEqual(action.supplyReturn, true)
})
test('actual176 Diamond decision changes underground extra-log search into bounded supply-return movement only with matching Native preview', () => {
  const f = scene(), base = { ...f.observations }; delete base.stationPages
  assert.equal(nextDiamondAction(f.state, base).subgoal.name, 'additional_wood')
  const waiting = nextDiamondAction(f.state, f.observations)
  assert.equal(waiting.supplyReturnRequested, true); assert.equal(waiting.resource, 'crafting_table')
  const r = planSupplyReturn(f.args); f.observations.supplyReturn = { ...r, nativePreview: copy(capture.nativePreview) }
  const action = nextDiamondAction(f.state, f.observations)
  assert.equal(action.type, 'move_to'); assert.equal(action.supplyReturn, true); assert.deepEqual(action.target, r.target)
  assert.equal(action.requiresReobservation, true); assert.equal(action.serverConfirmed, false)
  assert.equal(action.resourceTarget, undefined); assert.notEqual(action.type, 'complete')
  f.observations.supplyReturn.nativePreview.ready = false
  assert.equal(nextDiamondAction(f.state, f.observations).supplyReturnRequested, true)
})
test('held table, enough planks or existing logs keep ordinary crafting/placement instead of unnecessary supply return', () => {
  for (const [name, count] of [['minecraft:crafting_table', 1], ['minecraft:oak_planks', 4], ['minecraft:oak_log', 1]]) {
    const f = scene(); f.state.inventory.items = [...f.state.inventory.items.filter(i => i.name !== name), { name, count, slot: 12 }]
    assert.equal(planSupplyReturn(f.args).ready, false)
    assert.notEqual(nextDiamondAction(f.state, f.observations).supplyReturnRequested, true)
  }
})
test('productive iron preparation with a currently observed open furnace ignores even a ready supply-return proposal', () => {
  const f = scene(), position = { x: -22, y: 57, z: 12 }
  // A separate synthetic branch case, not a claim that life176 owns this
  // furnace. The actual remote AIR record remains unchanged and absent.
  f.observations.blocks.push({ known: true, position, name: 'minecraft:furnace', boundingBox: 'block', properties: {}, extra: [] })
  f.observations.furnace = { window: { id: 2, type: 'furnace', coordinates: position }, contentsKnown: true, needsOpen: false, inventoryUncertain: false, slots: ['furnace_ingredient', 'furnace_fuel', 'furnace_output'].map((role, slot) => ({ role, slot, known: true, count: 0, name: null })), progress: { burnTicksRemaining: 0 } }
  f.observations.supplyReturn = { ...planSupplyReturn(f.args), nativePreview: copy(capture.nativePreview) }
  const action = nextDiamondAction(f.state, f.observations)
  assert.equal(action.type, 'prospect'); assert.equal(action.resource, 'iron')
  assert.notEqual(action.supplyReturn, true); assert.notEqual(action.supplyReturnRequested, true)
})
test('Runtime observation validates the prefix against Native and never invents a route or replaces local blocks', async () => {
  const f = scene(), file = process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js'), source = fs.readFileSync(file, 'utf8')
  const start = source.indexOf('  async function observeStationSupplies ('), end = source.indexOf('  const autonomy = createAutonomy({', start)
  assert.ok(start >= 0 && end > start)
  const host = { shared: { deathRespawn: { deathId: 176 }, stations: capture.stations }, entities: { snapshot: () => [], stats: () => ({ unknownPositions: 0 }) }, meta: { version: '1.26.60' } }
  const make = preview => Function('host', 'working', 'planningWorld', 'readCurrentTunnelFloors', 'idlePhysics', 'createNavigator', 'evaluateThreats', 'nextDiamondAction', 'supplyScope', 'tableMaterialShortfall', 'readStationPages', 'planSupplyReturn', 'updateStationCatalog', source.slice(start, end) + '; return observeStationSupplies')(host, () => copy(f.state), f.world, () => f.floors, { withWorld: () => ({ fromServer: state => state }) }, () => ({ physics: { fromServer: state => state }, plan: () => copy(preview) }), () => ({ threats: [], outsideDanger: [], unknownPositions: [], requiresObservation: false }), nextDiamondAction, supplyScope, require('../src/supply-return').tableMaterialShortfall, readStationPages, planSupplyReturn, require('../src/supply-return').updateStationCatalog)
  const result = await make(capture.nativePreview)(f.observations, { goal: { diamond: 1 } })
  assert.equal(result.supplyReturn.ready, true); assert.equal(result.blocks.length, 10000)
  assert.deepEqual(result.blocks, f.observations.blocks); assert.equal(result.stationPages.furnace.block.name, 'minecraft:air')
  const rejected = await make({ ready: false, reason: 'current Native blocked', waypoints: [] })(f.observations, {})
  assert.equal(rejected.supplyReturn.ready, false)
})
test('actual received life176 staircase passes real Native planning for exactly the two-prefix target', () => {
  const f = scene(), r = planSupplyReturn(f.args); assert.equal(r.ready, true)
  const physics = createPhysics({ world: f.world }), nav = createNavigator({ world: f.world, physics }), route = nav.plan(physics.fromServer(f.state), r.target, { maxDistance: 12, maxExpanded: 500 })
  assert.equal(route.ready, true, route.reason); assert.equal(route.waypoints.length, 2)
  assert.deepEqual(route.waypoints.map(s => s.position), r.waypoints)
  assert.equal(route.serverConfirmed, false)
})
