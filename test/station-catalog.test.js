'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { supplyScope, stationWorldScope, updateStationCatalog, readStationPages, currentStationPage } = require('../src/supply-return')
const { nextDiamondAction } = require('../src/diamond-planner')
const sample = require('./fixtures/station-window176.json'), copy = v => structuredClone(v), key = p => `${p.x},${p.y},${p.z}`
function scene () {
  const decode = ids => ids.map(id => { const [x, y, z, type] = sample.cells[id]; return { ...copy(sample.templates[type]), position: { x, y, z } } })
  const lower = decode(sample.lower), upper = decode(sample.upper), remote = decode(sample.remembered), state = copy(sample.state)
  const cells = new Map([...remote, ...lower, ...upper].map(b => [key(b.position), b]))
  const world = { getBlock: (x, y, z) => copy(cells.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } }) }
  const observe = (blocks, pages = null) => ({ state, blocks, stations: copy(sample.stations), furnace: copy(sample.furnace), ores: copy(sample.ores), crafting: { previews: {} }, capabilities: copy(sample.capabilities), ...(pages ? { stationPages: pages } : {}) })
  const catalog = updateStationCatalog({ state, blocks: upper })
  const pages = () => readStationPages({ state, stations: sample.stations, catalog, world })
  return { state, lower, upper, world, cells, observe, catalog, pages }
}
test('captured lower/upper observations isolate the station visibility flip with exact same inventory and model state', () => {
  const f = scene()
  assert.equal(Math.max(...f.lower.map(b => b.position.y)), 69)
  assert.equal(Math.max(...f.upper.map(b => b.position.y)), 70)
  assert.equal(f.lower.filter(b => /:(?:furnace|crafting_table)$/.test(b.name)).length, 0)
  assert.equal(f.upper.filter(b => /:(?:furnace|crafting_table)$/.test(b.name)).length, 2)
  const low = nextDiamondAction(f.state, f.observe(f.lower)), high = nextDiamondAction(f.state, f.observe(f.upper))
  assert.equal(low.subgoal.name, 'additional_wood'); assert.equal(high.type, 'tunnel'); assert.equal(high.resource, 'iron')
  assert.equal(sample.state.lifecycle.deathId, 176); assert.equal(sample.state.positionSource, 'client_prediction')
})
test('discovered coordinate catalog plus consistent selected furnace page stabilizes SAME iron objective at both window heights', () => {
  const f = scene(), before = copy(f.state), pages = f.pages()
  assert.deepEqual(pages.craftingTable.position, { x: -15, y: 70, z: 7 })
  assert.deepEqual(pages.furnace.position, { x: -16, y: 70, z: 8 })
  for (const rows of [f.lower, f.upper]) {
    const action = nextDiamondAction(f.state, f.observe(rows, pages))
    assert.equal(action.type, 'tunnel'); assert.equal(action.resource, 'iron')
    assert.notEqual(action.supplyReturn, true); assert.notEqual(action.supplyReturnRequested, true)
  }
  assert.deepEqual(f.state, before); assert.equal(pages.furnace.usable, false); assert.equal(pages.furnace.serverConfirmed, false)
})
test('catalog remains coordinate history across life/reload, is world-scoped and bounded, without changing own-placement records', () => {
  const f = scene(), own = copy(sample.stations), entries = f.catalog.scopes[stationWorldScope(f.state)].entries
  assert.equal(entries.length, 2); assert.ok(entries.every(e => e.usable === undefined && e.placedByBot === undefined && e.serverConfirmed === undefined))
  f.state.lifecycle.deathId++
  const reload = updateStationCatalog({ state: f.state, blocks: f.lower, catalog: copy(f.catalog) })
  assert.equal(readStationPages({ state: f.state, stations: own, catalog: reload, world: f.world }).furnace.scope, supplyScope(f.state))
  const other = { ...f.state, realm: { id: 'other' } }
  const wrong = readStationPages({ state: other, stations: {}, catalog: reload, world: f.world })
  assert.equal(wrong.furnace, undefined); assert.deepEqual(sample.stations, own)
  let catalog
  for (let scope = 0; scope < 6; scope++) {
    const state = { ...f.state, realm: { id: String(scope) } }, blocks = Array.from({ length: 50 }, (_, i) => ({ known: true, name: i % 2 ? 'minecraft:furnace' : 'minecraft:crafting_table', position: { x: i, y: 70, z: 8 } }))
    catalog = updateStationCatalog({ state, blocks, catalog })
  }
  assert.equal(Object.keys(catalog.scopes).length, 4)
  assert.ok(Object.values(catalog.scopes).every(s => s.entries.length <= 16 && ['furnace', 'craftingTable'].every(kind => s.entries.filter(e => e.kind === kind).length <= 8)))
})
test('fresh AIR, unknown or wrong-type furnace invalidates remembered coordinate and cannot budget an iron smelting station', () => {
  for (const mode of ['air', 'unknown', 'wrong']) {
    const f = scene(), p = '-16,70,8', previous = f.cells.get(p)
    f.cells.set(p, mode === 'unknown' ? { known: false, position: previous.position } : { ...previous, name: mode === 'air' ? 'minecraft:air' : 'minecraft:stone', boundingBox: mode === 'air' ? 'empty' : 'block' })
    const pages = f.pages()
    assert.equal(currentStationPage(f.state, pages.furnace, 'furnace'), null)
    const action = nextDiamondAction(f.state, f.observe(f.lower, pages))
    assert.notEqual(action.type, 'tunnel'); assert.ok(!['put_furnace_input', 'put_furnace_fuel', 'take_furnace_output'].includes(action.type))
  }
})
test('current conflicting furnace contents retain existing management guard and catalog cannot create contents or a deposit', () => {
  const f = scene(), observations = f.observe(f.lower, f.pages())
  observations.furnace = { window: { id: 4, type: 'furnace', coordinates: { x: -16, y: 70, z: 8 } }, needsOpen: false, contentsKnown: true, inventoryUncertain: false, slots: [{ slot: 0, role: 'furnace_ingredient', known: true, count: 1, name: 'minecraft:beef' }, { slot: 1, role: 'furnace_fuel', known: true, count: 0, name: null }, { slot: 2, role: 'furnace_output', known: true, count: 0, name: null }], progress: {} }
  const before = copy(observations.furnace), action = nextDiamondAction(f.state, observations)
  assert.equal(action.type, 'capability_required'); assert.equal(action.proposedAction.type, 'manage_furnace_contents'); assert.deepEqual(observations.furnace, before)
  observations.furnace.contentsKnown = false
  assert.notEqual(nextDiamondAction(f.state, observations).type, 'put_furnace_input')
})
test('exact face/standing visibility is still required for use; productive iron-pick mining ignores optional station work', () => {
  const f = scene(), observations = f.observe(f.lower, f.pages())
  // Unknown station-page body/face geometry cannot invent an open/use action.
  observations.stationPages.furnace.blocks = observations.stationPages.furnace.blocks.map(b => key(b.position) === '-16,70,8' ? b : { known: false, position: b.position })
  const action = nextDiamondAction(f.state, observations)
  assert.notEqual(action.type, 'open_furnace'); assert.notEqual(action.type, 'put_furnace_input')
  const item = f.state.inventory.items.find(i => i.name === 'minecraft:stone_pickaxe')
  Object.assign(item, { name: 'minecraft:iron_pickaxe', maxDurability: 250, durabilityUsed: 0, durabilityRemaining: 250, durabilityKnown: true })
  f.state.heldItem = { ...item }
  const mine = nextDiamondAction(f.state, f.observe(f.lower, f.pages()))
  assert.equal(mine.resource, 'diamond'); assert.notEqual(mine.supplyReturnRequested, true)
})
test('Runtime stores discovered coordinates only in catalog and keeps lower-window objective stable on next observation', async () => {
  const f = scene(), source = fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js'), 'utf8'), start = source.indexOf('  async function observeStationSupplies ('), end = source.indexOf('  const autonomy = createAutonomy({', start)
  const own = copy(sample.stations), host = { shared: { stations: own, deathRespawn: { deathId: 176 } }, entities: { snapshot: () => [], stats: () => ({ unknownPositions: 0 }) } }
  const helper = Function('host', 'working', 'planningWorld', 'supplyScope', 'tableMaterialShortfall', 'updateStationCatalog', 'readStationPages', 'nextDiamondAction', 'readCurrentTunnelFloors', source.slice(start, end) + ';return observeStationSupplies')(host, () => copy(f.state), f.world, supplyScope, require('../src/supply-return').tableMaterialShortfall, updateStationCatalog, readStationPages, nextDiamondAction, () => assert.fail('productive ore does not request supply return'))
  const upper = await helper(f.observe(f.upper), {})
  const lower = await helper(f.observe(f.lower), {})
  assert.equal(nextDiamondAction(f.state, upper).resource, 'iron'); assert.equal(nextDiamondAction(f.state, lower).resource, 'iron')
  assert.equal(host.shared.stationCatalog.scopes[stationWorldScope(f.state)].entries.length, 2)
  assert.deepEqual(host.shared.stations, own); assert.equal(lower.blocks.length, 10000)
})
