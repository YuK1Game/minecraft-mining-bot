'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRunner } = require('../src/runner')

// Fake worker only: no actual HTTP, game connection, authentication or cache.
function fixture (handler = () => undefined) {
  let clock = 0
  const calls = []
  const state = { phase: 'spawned', startedAt: 'session', connectionId: 'connection', gameMode: 'survival', health: 20, dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: 'stamp', inventory: { known: true, items: [] }, crafting: { authority: true }, movement: { phase: 'idle' }, mining: { phase: 'idle' }, lifecycle: { dead: false }, selectedSlot: 0, heldItem: null }
  const block = (position, name = 'minecraft:air') => ({ known: true, name, position: structuredClone(position), extra: [] })
  const request = async (method, path, body, { signal } = {}) => {
    if (signal?.aborted) throw signal.reason
    calls.push({ method, path, body: structuredClone(body) })
    const custom = await handler({ method, path, body, state, calls, block, signal })
    if (custom !== undefined) return structuredClone(custom)
    if (path === '/status') return structuredClone(state)
    if (path.startsWith('/blocks?')) {
      const q = new URL(path, 'http://127.0.0.1').searchParams
      return { blocks: [block({ x: Number(q.get('x')), y: Number(q.get('y')), z: Number(q.get('z')) })] }
    }
    if (path === '/craft/preview') return { ready: true, output: { name: body.output, count: 4 * body.times } }
    if (path === '/craft/open') return { type: 'inventory' }
    if (path === '/craft/close') return null
    if (path === '/move/stop') { state.movement.phase = 'stopped'; return state.movement }
    if (path === '/mining/stop') { state.mining.phase = 'stopped'; return state.mining }
    return {}
  }
  const runner = createRunner({ request, timeoutMs: 100, pollIntervalMs: 20, delay: async milliseconds => { clock += milliseconds }, now: () => clock })
  return { runner, state, calls, block }
}

function land (state) {
  state.position = { x: state.position.x, y: 66.62, z: state.position.z }
  state.positionSource = 'client_prediction'
  state.predicted = { position: structuredClone(state.position), physicsState: { position: { x: state.position.x, y: 65, z: state.position.z }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true } }
  state.movement = { phase: 'awaiting_server_confirmation', onGround: true, settled: true }
}

test('new host-owned physics predictions replace the legacy local fallback without a raw position update', async () => {
  const { runner, state } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: 2.5, y: 66.62, z: 0.5 } }; return state.movement }
  })
  await runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 } })
  assert.equal(runner.getState().position.x, 2.5)
  state.rawServerPosition = { x: 0.5, y: 66.62, z: 0.5 }
  state.rawServerPositionUpdatedAt = 'stamp'
  state.position = { x: 2.7, y: 67.098686, z: 0.5 }
  state.positionSource = 'client_prediction'
  state.predicted = { position: structuredClone(state.position), physicsState: { onGround: false, velocity: { x: 0, y: -0.2, z: 0 } } }
  await runner.refreshState()
  assert.equal(runner.getState().position.x, 2.7)
  assert.equal(runner.getState().predicted.physicsState.onGround, false)
  land(state)
  await runner.refreshState()
  assert.equal(runner.getState().position.y, 66.62)
  assert.equal(runner.getState().predicted.physicsState.onGround, true)
  assert.equal(runner.getState().rawServerPosition.x, 0.5)
})

test('mining waits for land settling after a raw fractional correction, then repeats the live preview at the fresh pose', async () => {
  const target = { x: 1, y: 65, z: 0 }
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/action') { land(state); return state.movement }
    if (path === '/mining/preview') { assert.equal(state.position.y, 66.62); return { ready: true, targets: [{ position: target, name: 'minecraft:acacia_log' }] } }
    if (path === '/mining/start') { state.mining.phase = 'completed'; return state.mining }
  })
  state.position.y = 67.098686
  state.positionSource = 'correct_player_move_prediction'
  state.rawServerPosition = structuredClone(state.position)
  const result = await runner.actions.gather_logs({ target })
  assert.equal(result.serverConfirmed, true)
  assert.ok(calls.findIndex(call => call.path === '/action') < calls.findIndex(call => call.path === '/mining/preview'))
  assert.equal(calls.filter(call => call.path === '/action').length, 1)
  assert.equal(runner.getState().predicted.physicsState.onGround, true)
  assert.equal(state.rawServerPosition.y, 67.098686)
})

test('explicit airborne metadata triggers settling before crafting even when its coordinates lie on the half-block grid', async () => {
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/action') { land(state); return state.movement }
    if (path === '/craft/start') { state.inventory.items = [{ slot: 1, name: 'minecraft:acacia_planks', count: 4 }]; return { phase: 'completed' } }
  })
  state.positionSource = 'client_prediction'
  state.predicted = { position: structuredClone(state.position), physicsState: { onGround: false, velocity: { x: 0, y: -0.1, z: 0 } } }
  state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 1 }]
  const result = await runner.actions.craft({ output: 'minecraft:acacia_planks', times: 1 })
  assert.equal(result.serverConfirmed, true)
  assert.ok(calls.findIndex(call => call.path === '/action') < calls.findIndex(call => call.path === '/craft/open'))
})

test('table placement stabilises before consuming its server-confirmed inventory item', async () => {
  const target = { x: 2, y: 65, z: 0 }
  let placed = false
  const { runner, state, calls } = fixture(({ path, state, block }) => {
    if (path === '/action') { land(state); return state.movement }
    if (path === '/blocks/place') { placed = true; state.inventory.items = []; return { phase: 'completed' } }
    if (placed && path.startsWith('/blocks?')) return { blocks: [block(target, 'minecraft:crafting_table')] }
  })
  state.position.y = 67.098686
  state.inventory.items = [{ slot: 0, name: 'minecraft:crafting_table', count: 1 }]
  const result = await runner.actions.place_crafting_table({ target })
  assert.equal(result.serverConfirmed, true)
  assert.ok(calls.findIndex(call => call.path === '/action') < calls.findIndex(call => call.path === '/blocks/place'))
})

test('water metadata and observed water cells never trigger the land-settling action', async () => {
  for (const explicit of [true, false]) {
    const { runner, state, calls } = fixture(({ path, state, block }) => {
      if (path.startsWith('/blocks?')) return { blocks: [block({ x: 0, y: 65, z: 0 }, 'minecraft:water')] }
      if (path === '/craft/start') { state.inventory.items = [{ slot: 1, name: 'minecraft:acacia_planks', count: 4 }]; return { phase: 'completed' } }
    })
    state.position.y = 67.098686
    if (explicit) {
      state.positionSource = 'client_prediction'
      state.predicted = { position: structuredClone(state.position), physicsState: { onGround: false, isInWater: true } }
    }
    state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 1 }]
    assert.equal((await runner.actions.craft({ output: 'minecraft:acacia_planks', times: 1 })).serverConfirmed, true)
    assert.equal(calls.filter(call => call.path === '/action').length, 0)
  }
})

test('a stale working pose cannot fake item-work stability and is limited to three settling attempts', async () => {
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/action') { state.movement = { phase: 'awaiting_server_confirmation', settled: true, onGround: true }; return state.movement }
  })
  state.position.y = 67.098686
  await assert.rejects(runner.actions.gather_logs({ target: { x: 1, y: 65, z: 0 } }), /three settling attempts/)
  assert.equal(calls.filter(call => call.path === '/action').length, 3)
  assert.equal(calls.filter(call => call.path === '/mining/preview').length, 0)
  assert.ok(calls.some(call => call.path === '/move/stop'))
})

test('unknown support or cancellation during settling prevents all subsequent item work', async () => {
  const unknown = fixture(({ path }) => path.startsWith('/blocks?') ? { blocks: [{ known: false, position: { x: 0, y: 65, z: 0 }, reason: 'not received' }] } : undefined)
  unknown.state.position.y = 67.098686
  await assert.rejects(unknown.runner.actions.gather_logs({ target: { x: 1, y: 65, z: 0 } }), /Unknown foot terrain/)
  assert.equal(unknown.calls.filter(call => call.path === '/action').length, 0)
  const controller = new AbortController()
  const cancelled = fixture(({ path, state }) => {
    if (path === '/action') { land(state); controller.abort(new Error('cancel settling')); return state.movement }
  })
  cancelled.state.position.y = 67.098686
  await assert.rejects(cancelled.runner.actions.gather_logs({ target: { x: 1, y: 65, z: 0 } }, { signal: controller.signal }), /cancel settling/)
  assert.equal(cancelled.calls.filter(call => call.path === '/mining/preview').length, 0)
})
