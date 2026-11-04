'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHut } = require('../src/hut')
const { createFood, isSupportedFood } = require('../src/food')
const { evaluateThreats } = require('../src/threats')
const { createAutonomy, verifiedCoveredRoom } = require('../src/autonomy')
const source = fs.readFileSync(path.join(__dirname, '../src/runtime.js'), 'utf8')
const checkStart = source.indexOf('  function canEmergencyEatHere () {')
const checkEnd = source.indexOf('  const food = createFood(', checkStart)
assert.ok(checkStart >= 0 && checkEnd > checkStart)
const checkSource = source.slice(checkStart, checkEnd).trim()
const safetyStart = source.indexOf('    planSafety: state => {')
const safetyEnd = source.indexOf('\n    planAction:', safetyStart)
assert.ok(safetyStart >= 0 && safetyEnd > safetyStart)
const safetySource = source.slice(safetyStart + '    planSafety: '.length, safetyEnd).trim().replace(/,$/, '')
const block = name => ({ known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : 1, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })
function fixture () {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'one-session', runtimeEntityId: '1', dimension: 'overworld', gameMode: 'survival', health: 13, rawSelectedSlot: 0, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:rotten_flesh', count: 2 }] }, entities: [{ runtimeId: '8', uniqueId: '8', entityType: 'minecraft:zombie', alive: true, positionKnown: true, position: { x: 3, y: 65, z: 0.5 } }] }
  const cells = new Map(), points = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) for (const y of [65, 66]) points.push({ x: dx, y, z: dz })
  points.push({ x: 0, y: 67, z: 0 })
  const key = p => `${p.x},${p.y},${p.z}`
  for (const p of points) cells.set(key(p), block('dirt'))
  const memo = { established: true, scope: { dimension: 'overworld', realmId: '42' }, site: { type: 'soil_hut', center: { x: 0, y: 65, z: 0 }, forward: { x: 0, z: -1 }, steps: [] }, placements: points.map(position => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true })) }
  const forbidden = () => assert.fail('Food preview and geometry proof must remain passive')
  const actor = { preview: forbidden, start: forbidden, stop: forbidden }
  const hut = createHut({ getState: () => state, world: { getBlock: (x, y, z) => cells.get(`${x},${y},${z}`) ?? block(y <= 64 ? 'stone' : 'air') }, planner: () => ({ ready: false }), mining: actor, movement: actor, getMining: () => ({ phase: 'idle' }), getMovement: () => ({ phase: 'idle' }), inventory: { equip: forbidden }, interactions: { previewPlace: forbidden, placeBlock: forbidden }, memo })
  const host = { shared: { vitals: { hunger: { value: 16, source: 'server_attribute' } }, worldClocks: { '0': { name: 'minecraft:overworld', time: 1000 } } }, entities: { stats: () => ({ unknownPositions: 0 }) } }
  const check = new vm.Script(`(${checkSource})`).runInNewContext({ observedState: () => state, evaluateThreats, activeBase: () => hut, host, verifiedCoveredRoom, safetySnapshot: () => ({ wanted: true, running: true, busy: false, phase: 'covered', respawnTerrain: host.shared.respawnTerrain }) })
  const air = () => ({ network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, has_stack_id: false, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  const rawFood = { ...air(), network_id: 300, count: 2, has_stack_id: true, stack_id: 81 }
  const food = createFood({ client: { queue: forbidden }, getState: () => state, crafting: { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, inventory: [{ slot: 0, name: 'minecraft:rotten_flesh', count: 2, stackId: 81 }] }), rawItem: slot => slot === 0 ? structuredClone(rawFood) : air() }, getInput: forbidden, allocateLegacyId: forbidden, canEmergencyEat: check })
  food.applyPacket('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:player.hunger', current: 16 }] })
  const planSafety = new vm.Script(`(${safetySource})`).runInNewContext({ disposed: false, disposing: false, host, recovery: { preview: () => ({ ready: false }) }, activeBase: () => hut, evaluateThreats, combat: { preview: () => ({ ready: false }), snapshot: () => ({}) }, food, isSupportedFood, foraging: { preview: () => ({ ready: false }) } })
  return { state, cells, memo, hut, host, check, food, planSafety }
}

test('received closed hut geometry allows explicit emergency food with known mobs outside', () => {
  const f = fixture()
  assert.equal(evaluateThreats(f.state, f.state.entities).threats.length, 1)
  assert.equal(f.hut.snapshot().geometryVerified, true)
  assert.equal(f.hut.snapshot().inside, true)
  assert.equal(f.check(), true)
  assert.equal(f.food.preview().ready, false)
  assert.equal(f.food.preview({ allowEmergencyRotten: true }).ready, true)
  const decision = f.planSafety(f.state)
  assert.equal(decision.type, 'eat')
  assert.equal(decision.allowEmergencyRotten, true)
  assert.equal(decision.slot, 0)
  assert.equal(f.state.health, 13)
})

test('missing, unknown or pending hut blocks and receipts cannot authorize emergency food', () => {
  for (const damage of ['open_door', 'unknown_wall', 'pending_receipt', 'memo_only']) {
    const f = fixture()
    if (damage === 'open_door') f.cells.set('0,65,1', block('air'))
    if (damage === 'unknown_wall') f.cells.set('-1,65,0', { known: false })
    if (damage === 'pending_receipt') f.hut.restoreMemo({ ...f.memo, pendingPlacement: { position: { x: 0, y: 65, z: 1 }, requiresReconciliation: true } })
    if (damage === 'memo_only') f.cells.clear()
    assert.equal(f.check(), false, damage)
    assert.equal(f.food.preview({ allowEmergencyRotten: true }).ready, false, damage)
  }
})

test('outside food retains the same observed-threat and eight-block extra margin', () => {
  const f = fixture()
  f.state.position = { x: 6.5, y: 65.62, z: 0.5 }
  f.state.entities = []
  assert.equal(f.check(), true)
  f.state.entities = [{ runtimeId: '9', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 16.5, y: 65.62, z: 0.5 } }]
  assert.equal(f.check(), false)
  f.state.entities[0].position.x = 23.5
  assert.equal(f.check(), true)
  f.host.entities.stats = () => ({ unknownPositions: 1 })
  assert.equal(f.check(), false)
})

function coveredAgent (t, f, { decision = null } = {}) {
  const calls = { resource: 0, safety: 0, eat: 0, move: 0 }
  const agent = createAutonomy({ getState: () => ({ ...structuredClone(f.state), idleProtection: { wanted: true, running: true, busy: false, phase: 'covered' }, shelter: f.hut.snapshot(), entityStats: f.host.entities.stats() }), observe: () => { calls.resource++; return {} }, observeSafety: () => { calls.safety++; return {} }, planSafety: decision ? () => decision : f.planSafety, actions: { eat: planned => { assert.equal(planned.allowEmergencyRotten, true); calls.eat++; return { phase: 'completed' } }, move_to: () => { calls.move++; return { phase: 'completed' } } }, intervalMs: 60000 })
  t.after(() => agent.stop())
  agent.start({ objective: 'diamond' })
  return { agent, calls }
}

test('verified covered mode reaches the safe-food decision despite an outside zombie', async t => {
  const f = fixture(), goal = coveredAgent(t, f)
  await goal.agent.tick()
  assert.deepEqual(goal.calls, { resource: 0, safety: 1, eat: 1, move: 0 })
  assert.equal(goal.agent.snapshot().lastDecision.type, 'eat')
  assert.equal(goal.agent.snapshot().actionActive, false)
  assert.equal(f.state.health, 13)
  assert.equal(evaluateThreats(f.state, f.state.entities).threats.length, 1, 'Room context must not remove world threats')
})

test('inside actors, unknown actors, primed creepers and open or damaged cover continue yielding', async t => {
  for (const danger of ['inside_zombie', 'inside_npc', 'unknown', 'primed', 'open', 'damaged']) {
    const f = fixture()
    if (danger === 'inside_zombie') f.state.entities[0].position = { x: 0.5, y: 65, z: 0.5 }
    if (danger === 'inside_npc') f.state.entities.push({ runtimeId: '90', entityType: 'minecraft:npc', kind: 'npc', alive: true, positionKnown: true, position: { x: 0.5, y: 65, z: 0.5 } })
    if (danger === 'unknown') f.state.entities[0].positionKnown = false
    if (danger === 'primed') { f.state.entities[0].entityType = 'minecraft:creeper'; f.state.entities[0].primed = true }
    if (danger === 'open') f.cells.set('0,65,1', block('air'))
    if (danger === 'damaged') f.cells.set('-1,65,0', block('air'))
    assert.equal(f.check(), false, `Food must use the same covered-room exclusions: ${danger}`)
    const goal = coveredAgent(t, f)
    await goal.agent.tick()
    assert.deepEqual(goal.calls, { resource: 0, safety: 0, eat: 0, move: 0 }, danger)
    assert.equal(goal.agent.snapshot().phase, 'waiting', danger)
    assert.equal(goal.agent.snapshot().progress.failures, 0, danger)
  }
})

test('the covered planning exception never authorizes an active move past outside threats', async t => {
  const f = fixture(), goal = coveredAgent(t, f, { decision: { type: 'move_to', target: { x: 5, y: 65, z: 0 }, reason: 'test refused exit' } })
  await goal.agent.tick()
  assert.deepEqual(goal.calls, { resource: 0, safety: 1, eat: 0, move: 0 })
  assert.equal(goal.agent.snapshot().phase, 'waiting')
  assert.equal(goal.agent.snapshot().progress.failures, 0)
})
