'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createAutonomyRuntime } = require('../src/runtime/autonomy-runtime')
const { createAutonomy } = require('../src/survival/autonomy')
const { nextDiamondAction } = require('../src/survival/diamond-planner')
const { nextSurvivalAction } = require('../src/survival/survival-planner')
const { supplyScope, stationWorldScope } = require('../src/survival/supply-return')
const { createPlayerWorkstationRuntime } = require('../src/modes/player-workstation-runtime')
const { evaluateThreats } = require('../src/combat/threats')
const { resourceMinHealth } = require('../src/safety/learning-health')

// Actual AutonomyRuntime, autonomy controller, planners and station observer.
// The recovery execution port records dispatch only: actual interaction,
// ownership, mining and received pickup are covered in player-workstations.test.
function fixture (t) {
  const items = [['stone_pickaxe', 1], ['stone_sword', 1], ['oak_planks', 3], ['stick', 2], ['furnace', 1], ['bread', 1]]
    .map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot, ...(name === 'stone_pickaxe' ? { durabilityKnown: true, durabilityRemaining: 131, maxDurability: 131, durabilityUsed: 0 } : {}) }))
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'autonomy-station', startedAt: '2026-11-18T00:00:00.000Z', runtimeEntityId: '41',
    dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', health: 20, version: '1.26.60',
    position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, rawSelectedSlot: 0, heldItem: { ...items[0] }, equipmentServerConfirmed: true,
    inventory: { known: true, items }, entities: [], entityStats: { unknownPositions: 0 },
    world: { initialized: true, loadedSections: 27, version: '1.26.60' }, capabilities: { mining: true, movement: true } }
  const target = { x: -1, y: 65, z: 1 }, key = p => `${p.x},${p.y},${p.z}`
  const getBlock = (x, y, z) => {
    const table = key({ x, y, z }) === key(target), solid = y < 65 || table
    return { known: true, position: { x, y, z }, name: table ? 'minecraft:crafting_table' : solid ? 'minecraft:stone' : 'minecraft:air', runtimeId: table ? 300 : solid ? 1 : 0, boundingBox: solid ? 'block' : 'empty', properties: {}, extra: [] }
  }
  const blocks = []
  for (let x = -4; x <= 8; x++) for (let y = 62; y <= 69; y++) for (let z = -4; z <= 4; z++) blocks.push(getBlock(x, y, z))
  const record = { id: 'owned-preparation-table', item: 'minecraft:crafting_table', position: target, worldScope: stationWorldScope(state), source: 'server_station_placement', temporary: true,
    serverConfirmed: true, fingerprint: { name: 'minecraft:crafting_table', runtimeId: 300, properties: {} }, phase: 'placed', pending: null, attempts: 0 }
  const shared = { botMode: 'player', playerWanted: true, deathRespawn: { deathId: 3 }, playerHouse: { done: true }, playerWorkstations: { version: 1, records: [record] },
    vitals: { hunger: { source: 'server_attribute', value: 20 } }, worldClocks: { overworld: { name: 'minecraft:overworld', time: 6000 } } }
  const calls = [], snapshots = { phase: 'idle' }, snapshot = () => snapshots
  const stationRuntime = createPlayerWorkstationRuntime({ shared, getState: () => state, getBlock, getFurnace: () => ({}), getMotion: snapshot, operations: {}, file: null })
  const stationOperations = {
    observe: observed => { calls.push(['station-observe', observed]); return stationRuntime.observe(observed) },
    recover: async (id, options) => { calls.push(['station-recover', id, options.signal]); return { phase: 'deferred', collected: false, serverConfirmed: false, code: 'dispatch_boundary' } }
  }
  const shelter = { snapshot: () => ({ phase: 'idle', established: true, structureIntact: true, serverConfirmed: true, inside: false }), memo: () => ({}), preview: () => ({ ready: false, code: 'NO_KNOWN_SOIL_HILL' }) }
  const observations = { state, blocks, drops: [], entities: [], crafting: { previews: {} }, craftingTable: { known: true, usable: true, position: target },
    portableWorksite: { enabled: true, scope: supplyScope(state), deployed: false }, capabilities: { craft: true, place_block: true, use_table: true, equip: true, collect_drops: true, scan_blocks: true } }
  const nativeRequire = createRequire(path.resolve(__dirname, '..', 'src', 'runtime.js'))
  let ports
  const rt = {
    require: nativeRequire, createAutonomy: input => { ports = input; return createAutonomy({ ...input, intervalMs: 60000 }) },
    host: { shared, meta: { profile: state.profile }, entities: { stats: () => state.entityStats, snapshot: () => [] }, world: { getBlock, stats: () => state.world }, log () {}, noteProgress () {} },
    runtimeOperations: { operations: { playerWorkstations: stationOperations } }, observedState: () => state, raw: () => state, working: () => state, actualLifeId: () => 3,
    activeBase: () => shelter, safetySnapshot: () => ({ running: false }),
    runner: { observe: async () => { calls.push(['runner-observe']); return observations }, actions: {} }, diamondActions: {},
    mining: { snapshot, preview: () => ({ ready: false }) }, movement: { snapshot }, crafting: { snapshot }, furnace: { snapshot }, chest: { snapshot }, prospecting: { snapshot }, armor: { snapshot: () => ({ known: true, worn: [] }) },
    observePortableWorksite: value => value, observeStationSupplies: value => value, observeStoneAccess: async value => { calls.push(['stone-access']); return value },
    planningWorld: { getBlock }, nextDiamondAction, nextSurvivalAction, evaluateThreats, resourceMinHealth,
    recovery: { preview: () => ({ ready: false }), execute: async () => { calls.push(['safety-recover']); return { phase: 'deferred', serverConfirmed: false } } },
    food: { preview: () => ({ ready: false }) }, combat: { preview: () => ({ ready: false }), snapshot },
    nutritionInventoryReady: value => value.inventory?.known === true && !value.inventory.uncertain,
    nutritionSword: value => value.inventory.items.some(item => item.count > 0 && item.name.endsWith('_sword')),
    isSupportedFood: name => name === 'minecraft:bread', nutritionSourceAllowed: () => false,
    localLearningWork: () => ({ eligible: false }), readyNightSoilShelter: () => null, longTravelLogAllowance: () => false,
    immediateDiamond: () => false, normalizeUnobservedTunnel: decision => decision, normalizeReachableTunnel: (_state, decision) => decision,
    selectReadyOreTunnel: (_state, decision) => decision, requireIdle () {}
  }
  const autonomy = createAutonomyRuntime(rt).autonomy
  t.after(() => autonomy.stop('test cleanup'))
  const tick = async () => { autonomy.start({ objective: 'diamond' }); return autonomy.tick() }
  return { state, target, shared, rt, calls, ports, autonomy, tick, observations }
}

test('actual autonomy observation reaches the player planner and dispatches the owned table recovery action', async t => {
  const f = fixture(t), result = await f.tick()
  assert.equal(result.lastDecision.type, 'recover_workstation')
  assert.equal(result.lastDecision.workstationId, 'owned-preparation-table')
  assert.deepEqual(result.lastDecision.target, f.target)
  assert.equal(result.requiredCapability, null, 'the new action is installed in the actual controller')
  assert.deepEqual(f.calls.slice(0, 3).map(call => call[0]), ['runner-observe', 'stone-access', 'station-observe'])
  assert.equal(f.calls[2][1], f.state, 'the station observer receives the current runtime observation')
  const sent = f.calls.find(call => call[0] === 'station-recover')
  assert.equal(sent[1], 'owned-preparation-table'); assert.ok(sent[2] instanceof AbortSignal)
  assert.equal(sent[2].aborted, false)
  assert.equal(result.lastActionResult.serverConfirmed, false, 'dispatch alone never claims pickup')
})

test('the final runtime wrapper packs before departure and preserves stop, safety and station preparation decisions', async t => {
  const f = fixture(t), observed = await f.ports.observe({})
  f.rt.nextSurvivalAction = () => null
  const planned = decision => { f.rt.nextDiamondAction = () => decision; return f.ports.planAction(f.state, observed, { objective: 'diamond' }) }
  const departure = { type: 'move_to', stage: 'iron', resource: 'iron', target: { x: 12.5, y: 65, z: 0.5 }, reason: 'Move to another resource.' }
  assert.equal(planned(departure).type, 'recover_workstation')
  const preserve = [
    { type: 'stop', stage: 'safety', code: 'low_health' },
    { type: 'wait', stage: 'safety', code: 'threat_observation_unknown' },
    { type: 'move_to', stage: 'safety', target: departure.target },
    { type: 'move_to', stage: 'crafting_table', target: departure.target, stationTarget: f.target },
    { type: 'move_to', stage: 'crafting_table', target: departure.target, interactionTarget: f.target },
    { type: 'move_to', stage: 'crafting_table', target: departure.target, placementPurpose: 'crafting_table' },
    { type: 'move_to', stage: 'portable_worksite', target: departure.target },
    { type: 'craft', stage: 'portable_station_kit', output: 'minecraft:furnace' }
  ]
  for (const decision of preserve) assert.deepEqual(planned(decision), decision, JSON.stringify(decision))
  f.shared.botMode = 'quarry'
  assert.deepEqual(planned(departure), departure, 'quarry cannot inherit the player cleanup policy')
})

test('actual autonomy safety recovery takes priority over a nearby owned table', async t => {
  const f = fixture(t)
  f.rt.recovery.preview = () => ({ ready: true, alreadyAshore: false })
  const result = await f.tick()
  assert.equal(result.lastDecision.type, 'recover'); assert.equal(result.lastDecision.stage, 'safety')
  assert.equal(f.calls.filter(call => call[0] === 'safety-recover').length, 1)
  assert.equal(f.calls.filter(call => call[0] === 'station-recover').length, 0)
})

test('owned table recovery waits for the actual autonomy work-clearance handoff', async t => {
  const f = fixture(t)
  f.rt.idleSafety = { requestWorkClearance: () => { f.calls.push(['work-clearance']); return { pending: true } } }
  const result = await f.tick()
  assert.equal(result.lastDecision.type, 'recover_workstation')
  assert.equal(f.calls.filter(call => call[0] === 'work-clearance').length, 1)
  assert.equal(result.phase, 'waiting')
  assert.equal(f.calls.filter(call => call[0] === 'station-recover').length, 0)
})
