'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextBootstrapAction } = require('../src/survival/planner')
const { makeActions } = require('../src/survival/runner')
const { planTreeAccess } = require('../src/actions/action-access')
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
  const decision = () => nextBootstrapAction(current, observation(), { allowLogs: true, logCount: 3 })
  return { state: current, map, set, observation, decision, plant: { x: 2, y: 65, z: 0 }, tree: { x: 3, y: 65, z: 0 } }
}

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

// Leaves and leaf litter are never taken (2026-11-12), also during the long-trip
// log allowance (2026-11-14). The planner used to propose clearing a dry plant
// in front of a tree, an action the runner always refuses; it now looks for
// another tree instead, and the runner's refusal is kept as the second guard.
test('a tree behind leaf litter or a vine is not approached by clearing the plant, even with the log allowance', () => {
  for (const name of ['minecraft:leaf_litter', 'minecraft:vine']) {
    const action = fixture(name).decision()
    assert.equal(action.accessPreparation, undefined, name)
    assert.equal(action.type, 'scan_blocks', name)
  }
})

test('the runner refuses a clearing action before any request, with or without the log allowance', async () => {
  for (const logAllowance of [() => true, () => false]) {
    const f = fixture(), calls = []
    const actions = makeActions({ request: async (method, path) => { calls.push(path); return {} }, refreshState: async () => structuredClone(f.state), getState: () => structuredClone(f.state), observe: async () => f.observation(), logAllowance, timeoutMs: 100, pollIntervalMs: 20 })
    const decision = { type: 'move_to', resource: 'logs', block: 'minecraft:oak_log', target: { x: 0.5, y: 65, z: 0.5 }, resourceTarget: f.tree, accessPreparation: { kind: 'clear_tree_access', target: f.plant, block: 'minecraft:leaf_litter' } }
    await assert.rejects(() => actions.move_to(decision), error => error.code === 'WOOD_LEAF_HARVEST_DISABLED')
    assert.deepEqual(calls, [])
  }
})
