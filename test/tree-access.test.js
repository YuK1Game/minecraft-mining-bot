'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextBootstrapAction, inventoryCounts } = require('../src/planner')
const { makeActions } = require('../src/runner')
const { treeAccessScope, planTreeAccess } = require('../src/action-access')
const received = require('./fixtures/received-tree-access.json')
const key = p => `${p.x},${p.y},${p.z}`

function state () {
  return { phase: 'spawned', gameMode: 'survival', health: 20, profile: 'bot', realm: { id: 'test-realm' }, dimension: 'overworld', connectionId: 'connection', startedAt: 'session', runtimeEntityId: '1', lifecycle: { dead: false, deathId: 0 }, inventory: { known: true, items: [] }, position: { x: -1.5, y: 66.62, z: 0.5 }, capabilities: { movement: true, mining: true }, world: { initialized: true, loadedSections: 1 }, mining: { phase: 'idle' }, movement: { phase: 'idle' }, hostiles: [] }
}

function fixture (name = 'minecraft:leaf_litter') {
  const current = state()
  const map = new Map()
  const set = (x, y, z, name, extra = {}) => {
    const block = { position: { x, y, z }, name, known: true, boundingBox: name === 'minecraft:air' || /leaf_litter|vine/.test(name) ? 'empty' : 'block', properties: {}, extra: [], ...extra }
    map.set(key(block.position), block)
    return block
  }
  for (let x = -3; x <= 5; x++) for (let y = 63; y <= 70; y++) for (let z = -2; z <= 2; z++) set(x, y, z, 'minecraft:air')
  for (const x of [-2, 0, 2, 3]) set(x, 64, 0, 'minecraft:stone')
  for (let y = 65; y <= 68; y++) set(3, y, 0, 'minecraft:oak_log')
  set(3, 69, 0, 'minecraft:oak_leaves')
  set(2, 65, 0, name)
  const observation = () => ({ state: structuredClone(current), radius: 12, blocks: structuredClone([...map.values()]), capabilities: { move: true, mining: true, scan_blocks: true }, crafting: { previews: {} } })
  const decision = () => nextBootstrapAction(current, observation())
  return { state: current, map, set, observation, decision, plant: { x: 2, y: 65, z: 0 }, tree: { x: 3, y: 65, z: 0 } }
}

test('received oak evidence selects explicit litter preparation without claiming logs or accessible wood', () => {
  const current = state()
  current.position = structuredClone(received.source.position)
  const blocks = received.cells.map(([x, y, z, index]) => ({ known: true, position: { x, y, z }, ...structuredClone(received.palette[index]) }))
  const action = nextBootstrapAction(current, { blocks, radius: 12, capabilities: { scan_blocks: true } })
  assert.equal(action.type, 'move_to')
  assert.equal(action.accessPreparation.kind, 'clear_tree_access')
  assert.equal(action.accessPreparation.block, 'minecraft:leaf_litter')
  assert.deepEqual(action.resourceTarget, { x: -20, y: 69, z: 51 })
  assert.equal(action.treeEvidence.detection, 'connected_logs')
  assert.equal(action.accessPreparation.scope, treeAccessScope(current))
  assert.equal(action.accessPreparation.maxPlants, 4)
  assert.equal(action.counts.logs, 0)
  assert.equal(action.resourceReady, undefined)
  current.health = received.source.captureHealth
  assert.equal(nextBootstrapAction(current, { blocks }).code, 'low_health')
})

test('both named dry plants require a fresh clearing action before normal wood selection resumes', () => {
  for (const name of ['minecraft:leaf_litter', 'minecraft:vine']) {
    const f = fixture(name)
    const action = f.decision()
    assert.equal(action.accessPreparation?.block, name)
    assert.deepEqual(action.accessPreparation.target, f.plant)
    assert.equal(action.counts.logs, 0)
    f.set(2, 65, 0, 'minecraft:air')
    const next = f.decision()
    assert.equal(next.accessPreparation, undefined)
    assert.ok(['move_to', 'gather_logs'].includes(next.type))
    assert.equal(next.counts.logs, 0)
  }
})

test('access preparation rejects opaque, unknown, protected, wet and non-natural obstructions', () => {
  for (const replacement of [
    { name: 'minecraft:stone' }, { name: 'minecraft:oak_leaves' }, { known: false },
    { protected: true }, { protectionSource: 'bot_base' }, { natural: false },
    { extra: [{ name: 'minecraft:water' }] }, { name: 'minecraft:short_grass', boundingBox: 'empty' }
  ]) {
    const f = fixture()
    Object.assign(f.map.get(key(f.plant)), replacement)
    assert.equal(f.decision().accessPreparation, undefined, JSON.stringify(replacement))
  }
  const wetNeighbour = fixture()
  wetNeighbour.set(2, 65, 1, 'minecraft:water')
  assert.equal(wetNeighbour.decision().accessPreparation, undefined)
  const unscoped = fixture()
  delete unscoped.state.connectionId
  assert.equal(unscoped.decision().accessPreparation, undefined)
})

test('missing internal lifecycle is bound only by matching full observation identity', () => {
  const f = fixture()
  const observations = f.observation()
  delete f.state.lifecycle
  const action = nextBootstrapAction(f.state, observations)
  assert.equal(action.accessPreparation?.scope, treeAccessScope(observations.state))
  assert.equal(JSON.parse(action.accessPreparation.scope).at(-1), 0)
  assert.equal(f.state.lifecycle, undefined)
  assert.equal(treeAccessScope(f.state), null, 'missing life is never equivalent to life zero')
  for (const mutate of [
    s => { s.profile = 'other' }, s => { s.realm.id = 'other' }, s => { s.dimension = 'nether' },
    s => { s.connectionId = 'other' }, s => { s.startedAt = 'other' }, s => { s.runtimeEntityId = 'other' },
    s => { delete s.lifecycle }, s => { s.lifecycle.deathId = -1 }
  ]) {
    const changed = structuredClone(observations)
    mutate(changed.state)
    assert.equal(nextBootstrapAction(f.state, changed).accessPreparation, undefined)
  }
  f.state.lifecycle = { dead: false, deathId: 1 }
  assert.equal(nextBootstrapAction(f.state, observations).accessPreparation, undefined, 'new internal life cannot inherit old observation geometry')
})

test('more than four intervening plants cannot authorize a clearing sequence', () => {
  const f = fixture()
  const getBlock = p => f.map.get(key(p))
  for (let x = -2; x <= 6; x++) for (let y = 63; y <= 70; y++) for (let z = -2; z <= 5; z++) f.set(x, y, z, 'minecraft:air')
  // Every centre/tolerance ray stays in reach and crosses only known dry vines,
  // but their union contains more than the four plants allowed for one tree.
  for (let x = 0; x <= 3; x++) for (let y = 65; y <= 66; y++) for (let z = 0; z <= 2; z++) if (x || z) f.set(x, y, z, 'minecraft:vine')
  const tree = f.set(3, 66, 2, 'minecraft:oak_log')
  assert.equal(planTreeAccess({ state: f.state, tree, standpoint: { x: 0.5, y: 65, z: 0.5 }, getBlock }), null)
})

function executor (options = {}) {
  const f = fixture(options.name)
  const decision = f.decision()
  const calls = []
  const observations = []
  let clock = 0
  let observationCount = 0
  const actions = makeActions({
    request: async (method, path, body) => {
      calls.push({ method, path, body: structuredClone(body) })
      if (path === '/move/preview') return { ready: options.routeReady !== false }
      if (path === '/move/start') {
        f.state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...body.target, y: body.target.y + 1.62 } }
        return structuredClone(f.state.movement)
      }
      if (path === '/move/stop') return {}
      if (path === '/mining/preview') return { ready: options.previewReady !== false, targets: [{ position: structuredClone(f.plant), name: options.previewName ?? f.map.get(key(f.plant)).name }], errors: ['rejected fixture preview'] }
      if (path === '/mining/start') {
        f.state.mining.phase = 'completed'
        if (options.air !== false) f.set(2, 65, 0, 'minecraft:air')
        return structuredClone(f.state.mining)
      }
      if (path === '/mining/stop') return {}
      if (path.startsWith('/blocks?')) return { blocks: [structuredClone(f.map.get(key(f.plant)))] }
      throw new Error(`Unexpected fixture request ${method} ${path}`)
    },
    refreshState: async () => structuredClone(f.state), getState: () => structuredClone(f.state),
    observe: async args => {
      observations.push(args)
      observationCount++
      options.onObserve?.(f, observationCount)
      return f.observation()
    },
    recordWorkingPosition: value => {
      if (options.rejectArrival) return
      f.state.position = structuredClone(value.position)
      f.state.predicted = { physicsState: { onGround: true, isInWater: false } }
      f.state.positionSource = 'client_prediction'
    },
    timeoutMs: 100, pollIntervalMs: 20, now: () => clock, delay: async ms => { clock += ms }
  })
  return { ...f, decision, actions, calls, observations }
}

test('runner uses normal movement, mines one exact plant, confirms server air and leaves log inventory at zero', async () => {
  for (const name of ['minecraft:leaf_litter', 'minecraft:vine']) {
    const f = executor({ name })
    const result = await f.actions.move_to(f.decision)
    assert.equal(result.kind, 'clear_tree_access')
    assert.equal(result.serverConfirmed, true)
    assert.equal(result.confirmedBy, 'server_block_update')
    assert.equal(result.blocksBroken, 1)
    assert.equal(result.resourceReady, false)
    assert.equal(result.collected, false)
    assert.equal(inventoryCounts(f.state.inventory.items).logs, 0)
    assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
    const mining = f.calls.find(call => call.path === '/mining/start')
    assert.deepEqual(mining.body.targets, [{ ...f.plant, accessPreparation: 'tree_access', expectedName: name }])
    assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 1)
    assert.equal(f.observations.length, 3)
    assert.ok(f.observations.every(args => args.fresh === true))
    assert.equal(f.map.get(key(f.tree)).name, 'minecraft:oak_log')
  }
})

test('completed mining status cannot confirm preparation while the plant remains', async () => {
  const f = executor({ air: false })
  await assert.rejects(f.actions.move_to(f.decision), error => error.code === 'BLOCK_NOT_CONFIRMED')
  assert.equal(inventoryCounts(f.state.inventory.items).logs, 0)
  assert.ok(f.calls.some(call => call.path === '/mining/stop'))
})

test('runner rechecks plant, natural tree, scope and actual arrival before mining', async () => {
  for (const mutate of [
    f => { f.map.get(key(f.plant)).name = 'minecraft:stone' },
    f => { f.map.get(key(f.plant)).known = false },
    f => { f.map.get(key(f.plant)).protected = true },
    f => { f.map.get(key(f.plant)).extra = [{ name: 'minecraft:water' }] },
    f => { f.map.get(key(f.tree)).name = 'minecraft:air' },
    f => { f.state.connectionId = 'other' },
    f => { f.state.lifecycle.deathId++ }
  ]) {
    const f = executor({ onObserve: (f, count) => { if (count === 2) mutate(f) } })
    await assert.rejects(f.actions.move_to(f.decision))
    assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 0)
  }
  const arrival = executor({ rejectArrival: true })
  await assert.rejects(arrival.actions.move_to(arrival.decision), error => error.code === 'ACCESS_STANCE_NOT_REACHED')
  assert.equal(arrival.calls.filter(call => call.path === '/mining/start').length, 0)
  const route = executor({ routeReady: false })
  await assert.rejects(route.actions.move_to(route.decision), error => error.code === 'NO_SAFE_ROUTE')
  assert.equal(route.calls.filter(call => call.path === '/mining/start').length, 0)
})

test('a stale initial preparation scope yields before movement or mining', async () => {
  for (const mutate of [f => { f.state.lifecycle.deathId++ }, f => { f.state.connectionId = 'other' }]) {
    const f = executor()
    mutate(f)
    await assert.rejects(f.actions.move_to(f.decision), error => error.code === 'STALE_OBSERVATION')
    assert.equal(f.calls.length, 0)
    assert.equal(f.observations.length, 0)
    assert.equal(inventoryCounts(f.state.inventory.items).logs, 0)
  }
})

test('one tree is limited to four preparation attempts and a changed live mining name is refused', async () => {
  const changed = executor({ previewName: 'minecraft:stone' })
  await assert.rejects(changed.actions.move_to(changed.decision), error => error.code === 'RESOURCE_CHANGED')
  assert.equal(changed.calls.filter(call => call.path === '/mining/start').length, 0)
  const f = executor()
  for (let count = 0; count < 4; count++) {
    await f.actions.move_to(f.decision)
    f.set(2, 65, 0, 'minecraft:leaf_litter')
  }
  await assert.rejects(f.actions.move_to(f.decision), error => error.code === 'ACCESS_PREPARATION_LIMIT')
  assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 4)
})
