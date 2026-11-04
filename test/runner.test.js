'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRunner, createHttpClient } = require('../src/runner')

function fixture (handler = () => undefined, options = {}) {
  let clock = 0
  const calls = []
  const state = {
    phase: 'spawned', startedAt: 'session-1', profile: 'bot', playerName: 'HouchiChan',
    gameMode: 'survival', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game',
    positionUpdatedAt: 'server-1', health: 20, selectedSlot: 0, heldItem: null,
    inventory: { known: true, items: [] }, capabilities: { movement: true, mining: true },
    world: { initialized: true, loadedSections: 27, blockUpdates: 0 },
    crafting: { authority: true, recipes: 50, openContainer: null, availableRecipes: [] },
    interactions: { equipment: {} }, droppedItems: [], hostiles: [],
    movement: { phase: 'idle', sent: 0 }, mining: { phase: 'idle' }, lifecycle: { dead: false, phase: 'alive' }
  }
  const block = (x, y, z, name = 'minecraft:air') => ({ known: true, position: { x, y, z }, name, properties: {}, extra: [], boundingBox: name === 'minecraft:air' ? 'empty' : 'block' })
  const request = async (method, path, body, { signal } = {}) => {
    if (signal?.aborted) throw signal.reason
    calls.push({ method, path, body: structuredClone(body) })
    const result = await handler({ method, path, body, state, calls, signal, block })
    if (result !== undefined) return structuredClone(result)
    if (path === '/status') return structuredClone(state)
    if (path.startsWith('/blocks?')) {
      const query = new URL(path, 'http://127.0.0.1').searchParams
      const x = Number(query.get('x')); const y = Number(query.get('y')); const z = Number(query.get('z')); const radius = Number(query.get('radius'))
      const blocks = []
      for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) blocks.push(block(x + dx, y + dy, z + dz))
      return { blocks }
    }
    if (path === '/craft/preview') return { ready: true, output: { name: body.output, count: body.output.endsWith('_planks') ? 4 * body.times : body.times }, times: body.times }
    if (path === '/craft/open') { state.crafting.openContainer = { type: 'inventory' }; return { type: 'inventory' } }
    if (path === '/craft/close') { state.crafting.openContainer = null; return null }
    if (path === '/move/stop') { state.movement.phase = 'stopped'; return { phase: 'stopped' } }
    if (path === '/mining/stop') { state.mining.phase = 'stopped'; return { phase: 'stopped' } }
    return {}
  }
  const runner = createRunner({ request, scanRadius: 1, below: 1, above: 3, pollIntervalMs: 20, timeoutMs: 100, delay: async milliseconds => { clock += milliseconds }, now: () => clock, ...options })
  return { runner, state, calls, block }
}

test('online learning HP1 Runner resource work still requires inventory gain and interrupts actual damage', async () => {
  let mutation = 'none'
  const f = fixture(({ path, state }) => {
    if (path === '/craft/start') {
      if (mutation === 'inventory') state.inventory.items = [{ slot: 1, name: 'minecraft:acacia_planks', count: 4 }]
      if (mutation === 'damage') state.health = 0.5
      return { phase: 'completed' }
    }
  })
  f.state.health = 1; f.state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 1 }]
  await assert.rejects(f.runner.actions.craft({ output: 'minecraft:acacia_planks' }), error => error.code === 'LOW_HEALTH')
  f.state.threatPolicy = 'online_learning'
  await assert.rejects(f.runner.actions.craft({ output: 'minecraft:acacia_planks' }), error => error.code === 'UNCONFIRMED_TIMEOUT')
  mutation = 'inventory'
  const result = await f.runner.actions.craft({ output: 'minecraft:acacia_planks' })
  assert.equal(result.serverConfirmed, true); assert.equal(result.output.count, 4)
  mutation = 'damage'; f.state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 1 }]
  await assert.rejects(f.runner.actions.craft({ output: 'minecraft:acacia_planks' }), error => error.code === 'TOOK_DAMAGE')
})

test('local HTTP adapter sends JSON only to its worker and reports rejected responses', async () => {
  const calls = []
  const request = createHttpClient({ fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, text: async () => '{"phase":"spawned"}' } } })
  assert.equal((await request('GET', '/status')).phase, 'spawned')
  await request('POST', '/craft/preview', { output: 'minecraft:stick' })
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json')
  assert.equal(JSON.parse(calls[1].options.body).output, 'minecraft:stick')
  assert.throws(() => createHttpClient({ baseUrl: 'https://outside.example' }), /local HTTP/)
  await assert.rejects(request('GET', '//outside.example/status'), /Invalid/)
  const rejected = createHttpClient({ fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"error":"not ready"}' }) })
  await assert.rejects(rejected('POST', '/move/start', {}), /not ready/)
})

test('observation batches bounded block scans, keeps unknown blocks distinct, and supplies matching craft previews', async () => {
  const { runner, state, calls } = fixture(({ path, block }) => {
    if (path.startsWith('/blocks?')) return { blocks: [block(1, 65, 0, 'minecraft:acacia_log'), block(1, 66, 0, 'minecraft:acacia_log'), block(1, 68, 0, 'minecraft:acacia_leaves'), block(0, 64, 0, 'minecraft:stone'), block(0, 65, 1, 'minecraft:crafting_table'), { known: false, position: { x: -1, y: 65, z: 0 }, name: null, reason: 'not received' }] }
  })
  state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 3 }]
  state.hostiles = [{ name: 'minecraft:zombie', hostile: true, alive: true, position: { x: 10, y: 65, z: 0 } }]
  state.droppedItems = [{ runtimeId: '5', name: 'minecraft:acacia_log', count: 1, position: { x: 1, y: 65.2, z: 0 } }]
  await runner.refreshState()
  const observation = await runner.observe()
  assert.equal(observation.logs.length, 2)
  assert.equal(observation.coverage.unknown, 1)
  assert.equal(observation.drops[0].known, true)
  assert.equal(observation.threats[0].hostile, true)
  assert.equal(observation.craftingTable.known, true)
  assert.equal(observation.capabilities.explore, true)
  state.hostiles = []
  await runner.actions.preview_craft({ output: 'minecraft:acacia_planks', times: 3 })
  const second = await runner.observe()
  assert.equal(second.crafting.previews['minecraft:acacia_planks'].times, 3)
  assert.equal(second.crafting.previews['minecraft:acacia_planks'].output.count, 12)
  assert.ok(calls.filter(call => call.path.startsWith('/blocks?')).length <= 2)
})

test('movement can finish locally without pretending the server acknowledged it, preserving a labelled working position', async () => {
  let polls = 0
  const { runner, state } = fixture(({ method, path, state }) => {
    if (path === '/move/preview') return { ready: true, waypoints: [] }
    if (path === '/move/start') { state.movement = { phase: 'moving', predictedPosition: { x: 2.5, y: 66.62, z: 0.5 } }; polls = 0; return state.movement }
    if (method === 'GET' && path === '/status' && state.movement.phase === 'moving' && ++polls >= 2) state.movement.phase = 'awaiting_server_confirmation'
  })
  const result = await runner.actions.move_to({ target: { x: 2.5, z: 0.5 } }, { progress: { actionsReturned: 0 } })
  assert.equal(result.phase, 'completed')
  assert.equal(result.outcome, 'predicted')
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.verificationPending, true)
  assert.equal(state.position.x, 0.5)
  assert.equal(runner.getState().position.x, 2.5)
  assert.equal(runner.getState().rawServerPosition.x, 0.5)
  assert.equal(runner.getState().positionSource, 'client_prediction')
  state.positionUpdatedAt = 'server-2'
  await runner.refreshState()
  assert.equal(runner.getState().position.x, 0.5)
  assert.equal(runner.getState().positionSource, 'start_game')
})

test('rejected movement verification stops the worker rather than returning an unearned arrival', async () => {
  const { runner, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: 2.5, y: 66.62, z: 0.5 } }; return state.movement }
  }, { verifyPosition: async () => ({ accepted: false, reason: 'server rejected' }) })
  await assert.rejects(runner.actions.move_to({ target: { x: 2.5, z: 0.5 } }), /server rejected/)
  assert.ok(calls.some(call => call.path === '/move/stop'))
})

test('mining needs both live resource identity and an observed air block, independently of a completed status', async () => {
  const target = { x: 1, y: 65, z: 0 }
  let air = false
  const { runner } = fixture(({ path, state, block }) => {
    if (path === '/mining/preview') return { ready: true, targets: [{ position: target, name: 'minecraft:acacia_log' }] }
    if (path === '/mining/start') { state.mining.phase = 'completed'; return state.mining }
    if (path.startsWith('/blocks?')) return { blocks: [block(1, 65, 0, air ? 'minecraft:air' : 'minecraft:acacia_log')] }
  })
  await assert.rejects(runner.actions.gather_logs({ target }), /did not become known air/)
  air = true
  const result = await runner.actions.gather_logs({ target })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.blocksBroken, 1)
  assert.equal(result.collected, false)
})

test('drop disappearance is not collection unless the server inventory actually increases', async () => {
  let giveItem = false
  let reads = 0
  const { runner, state } = fixture(({ path, state }) => {
    if (path === '/status' && giveItem && ++reads >= 2) state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 3 }]
  })
  state.droppedItems = []
  const decision = { targets: [{ name: 'minecraft:acacia_log', count: 3, position: { x: 0.5, y: 65.2, z: 0.5 } }], count: 3 }
  await assert.rejects(runner.actions.collect_drops(decision), /did not produce an inventory increase/)
  giveItem = true
  const result = await runner.actions.collect_drops(decision)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.count, 3)
})

test('craft opens and closes its container, validates the preview, and requires an inventory increase', async () => {
  let mutate = false
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/craft/start') {
      if (mutate) state.inventory.items = [{ slot: 1, name: 'minecraft:acacia_planks', count: 12 }]
      return { phase: 'completed' }
    }
  })
  state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 3 }]
  await assert.rejects(runner.actions.craft({ output: 'minecraft:acacia_planks', times: 3 }), /not observed before timeout/)
  assert.equal(state.crafting.openContainer, null)
  mutate = true
  const result = await runner.actions.craft({ output: 'minecraft:acacia_planks', times: 3 })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.output.count, 12)
  assert.equal(state.crafting.openContainer, null)
  assert.ok(calls.some(call => call.path === '/craft/open'))
  assert.ok(calls.filter(call => call.path === '/craft/preview').length >= 4)
})

test('equipment selection remains a request and a broken tool cannot survive in the working cache', async () => {
  const { runner, state } = fixture()
  state.inventory.items = [{ slot: 4, name: 'minecraft:wooden_pickaxe', count: 1 }]
  const result = await runner.actions.equip({ item: 'minecraft:wooden_pickaxe', slot: 4 })
  assert.equal(result.outcome, 'requested')
  assert.equal(result.serverConfirmed, false)
  assert.equal(runner.getState().selectedSlot, 4)
  assert.equal(runner.getState().rawSelectedSlot, 0)
  state.inventory.items = []
  await runner.refreshState()
  assert.equal(runner.getState().heldItem, null)
  assert.equal(runner.getState().selectedSlot, 0)
})

test('authoritative equipment swap is verified in the raw selected inventory slot and does not fabricate a gear request', async () => {
  const { runner, state } = fixture(({ path, body, state }) => {
    if (path === '/equipment/select') {
      state.inventory.items = [{ slot: 0, name: 'minecraft:wooden_pickaxe', count: 1 }, { slot: 14, name: 'minecraft:acacia_planks', count: 2 }]
      state.rawSelectedSlot = 0
      state.selectedSlot = 0
      return { phase: 'completed', slot: 0, requestedSlot: body.slot, serverConfirmed: true, confirmedBy: 'item_stack_response' }
    }
  })
  state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_planks', count: 2 }, { slot: 14, name: 'minecraft:wooden_pickaxe', count: 1 }]
  const result = await runner.actions.equip({ item: 'minecraft:wooden_pickaxe', slot: 14 })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.slot, 0)
  assert.equal(result.requestedSlot, 14)
  assert.equal(runner.getState().rawSelectedSlot, 0)
  assert.equal(runner.getState().equipmentSource, 'server_inventory_swap')
  assert.equal(runner.getState().equipmentServerConfirmed, true)
  assert.equal(runner.getState().heldItem.name, 'minecraft:wooden_pickaxe')
})

test('a serverConfirmed flag without the actual selected-slot inventory update cannot pass equipment verification', async () => {
  const { runner, state } = fixture(({ path }) => path === '/equipment/select' ? { phase: 'completed', slot: 0, serverConfirmed: true, confirmedBy: 'item_stack_response' } : undefined)
  state.inventory.items = [{ slot: 4, name: 'minecraft:wooden_pickaxe', count: 1 }]
  await assert.rejects(runner.actions.equip({ item: 'minecraft:wooden_pickaxe', slot: 4 }), /did not place the tool/)
  assert.equal(runner.getState().selectedSlot, 0)
  assert.equal(runner.getState().heldItem, null)
})

test('aborting an in-flight move releases the worker input stream', async () => {
  let announce
  const entered = new Promise(resolve => { announce = resolve })
  const { runner, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement.phase = 'moving'; return state.movement }
  }, { delay: async (milliseconds, signal) => { announce(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } })
  const controller = new AbortController()
  const action = runner.actions.move_to({ target: { x: 2.5, z: 0.5 } }, { signal: controller.signal })
  await entered
  controller.abort(new Error('test cancellation'))
  await assert.rejects(action, /test cancellation/)
  assert.ok(calls.some(call => call.path === '/move/stop'))
})

test('fresh near-goal server correction is confirmed arrival without downgrading it through the prediction callback', async () => {
  let callbackCalls = 0
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      state.position = { x: -19.3163681, y: 72.62001037597656, z: 18.5 }
      state.rawServerPosition = structuredClone(state.position)
      state.positionUpdatedAt = state.rawServerPositionUpdatedAt = new Date(0).toISOString()
      state.positionSource = 'correct_player_move_prediction'
      state.movement = { phase: 'replan_required', predictedPosition: { x: -19.551968, y: 72.62, z: 18.5 }, reason: 'server correction' }
      return state.movement
    }
  }, { verifyPosition: async () => { callbackCalls++; return { serverConfirmed: false } } })
  state.position = { x: -20.5, y: 72.62001037597656, z: 18.5 }
  state.rawServerPosition = structuredClone(state.position)
  state.rawServerPositionUpdatedAt = new Date(-1000).toISOString()
  const result = await runner.actions.move_to({ target: { x: -19.5, y: 71, z: 18.5 } })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.outcome, 'confirmed')
  assert.equal(result.confirmedBy, 'fresh_server_position')
  assert.equal(result.position.x, -19.3163681)
  assert.equal(callbackCalls, 0)
  assert.equal(runner.getState().positionSource, 'correct_player_move_prediction')
  assert.equal(calls.filter(call => call.path === '/move/stop').length, 1)
})

test('authoritative partial progress replans the same goal and reaches it after a later correction', async () => {
  let attempts = 0
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      attempts++
      state.position = { x: attempts === 1 ? 1.3 : 2.4, y: 66.62, z: 0.5 }
      state.rawServerPosition = structuredClone(state.position)
      state.rawServerPositionUpdatedAt = state.positionUpdatedAt = new Date(attempts).toISOString()
      state.positionSource = 'correct_player_move_prediction'
      state.movement = { phase: 'replan_required', reason: 'server correction' }
      return state.movement
    }
  })
  const result = await runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 } })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.attempts, 2)
  assert.equal(state.position.x, 2.4)
  assert.deepEqual(calls.filter(call => call.path === '/move/preview').map(call => call.body.target), [{ x: 2.5, y: 65, z: 0.5 }, { x: 2.5, y: 65, z: 0.5 }])
})

test('stale timestamps and zero authoritative displacement cannot masquerade as progress', async () => {
  const stale = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      state.rawServerPosition = { x: 2.4, y: 66.62, z: 0.5 }
      state.rawServerPositionUpdatedAt = 'server-1'
      state.movement = { phase: 'replan_required' }
      return state.movement
    }
  })
  await assert.rejects(stale.runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 } }), /did not show authoritative movement progress/)
  const stationary = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      state.rawServerPosition = structuredClone(state.position)
      state.rawServerPositionUpdatedAt = new Date(0).toISOString()
      state.movement = { phase: 'replan_required' }
      return state.movement
    }
  })
  await assert.rejects(stationary.runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 } }), /did not show authoritative movement progress/)
  assert.equal(stationary.calls.filter(call => call.path === '/move/start').length, 1)
})

test('partial progress is bounded to six cycles rather than resetting the retry budget', async () => {
  let attempts = 0
  const { runner, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      attempts++
      state.position = { x: 0.5 + attempts * 0.2, y: 66.62, z: 0.5 }
      state.rawServerPosition = structuredClone(state.position)
      state.rawServerPositionUpdatedAt = state.positionUpdatedAt = new Date(attempts).toISOString()
      state.positionSource = 'correct_player_move_prediction'
      state.movement = { phase: 'replan_required' }
      return state.movement
    }
  })
  await assert.rejects(runner.actions.move_to({ target: { x: 8.5, y: 65, z: 0.5 } }), /six-cycle/)
  assert.equal(calls.filter(call => call.path === '/move/start').length, 6)
})

function rejectedMoveStart () { const error = new Error('The current footprint has no known safe support'); error.code = 'HTTP_ERROR'; error.status = 400; return error }

test('a start validation race replans the unchanged goal only after fresh working position changed', async () => {
  let attempts = 0
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      if (++attempts === 1) {
        state.position.y -= 1
        state.positionUpdatedAt = new Date(1).toISOString()
        state.positionSource = 'client_prediction'
        state.predicted = { position: structuredClone(state.position), physicsState: { onGround: true } }
        throw rejectedMoveStart()
      }
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...body.target, y: body.target.y + 1.62 } }
      return state.movement
    }
  })
  const target = { x: 4.5, y: 65, z: 0.5 }
  const result = await f.runner.actions.move_to({ target })
  assert.equal(result.attempts, 2)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.verificationPending, true)
  assert.deepEqual(f.calls.filter(call => call.path === '/move/preview').map(call => call.body.target), [target, target])
  assert.equal(f.state.inventory.items.length, 0)
})

test('pose changes between a successful preview and the pre-start status read can also justify a bounded replan', async () => {
  let previews = 0
  let starts = 0
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') {
      if (++previews === 1) { state.position.y -= 1; state.positionUpdatedAt = new Date(1).toISOString() }
      return { ready: true }
    }
    if (path === '/move/start') {
      if (++starts === 1) throw rejectedMoveStart()
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...body.target, y: body.target.y + 1.62 } }
      return state.movement
    }
  })
  const result = await f.runner.actions.move_to({ target: { x: 4.5, y: 65, z: 0.5 } })
  assert.equal(result.attempts, 2)
  assert.equal(previews, 2)
})

test('a fresh raw pose change can replan while an unchanged labelled working pose remains separate', async () => {
  let attempts = 0
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      if (++attempts === 1) { state.rawServerPosition.x += 0.3; state.rawServerPositionUpdatedAt = new Date(1).toISOString(); throw rejectedMoveStart() }
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...body.target, y: body.target.y + 1.62 } }
      return state.movement
    }
  })
  f.state.rawServerPosition = structuredClone(f.state.position)
  f.state.rawServerPositionUpdatedAt = new Date(0).toISOString()
  f.state.positionSource = 'client_prediction'
  f.state.predicted = { position: structuredClone(f.state.position), physicsState: { onGround: true } }
  const result = await f.runner.actions.move_to({ target: { x: 4.5, y: 65, z: 0.5 } })
  assert.equal(result.attempts, 2)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.state.rawServerPosition.x, 0.8)
})

test('unchanged poses, timestamps alone, stale timestamps and non-HTTP errors do not authorize start retries', async () => {
  for (const kind of ['unchanged', 'timestamp', 'position', 'old_timestamp', 'non_http']) {
    const original = rejectedMoveStart()
    if (kind === 'non_http') original.code = 'ACTION_FAILED'
    const f = fixture(({ path, state }) => {
      if (path === '/move/preview') return { ready: true }
      if (path === '/move/start') {
        if (['position', 'old_timestamp', 'non_http'].includes(kind)) state.position.x += 0.3
        if (['timestamp', 'old_timestamp', 'non_http'].includes(kind)) state.positionUpdatedAt = new Date(1).toISOString()
        throw original
      }
    })
    f.state.positionUpdatedAt = new Date(10).toISOString()
    await assert.rejects(f.runner.actions.move_to({ target: { x: 4.5, y: 65, z: 0.5 } }), error => error === original, kind)
    assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
  }
})

test('damage, death, session and dimension changes stop a start-validation retry even if its pose moved', async () => {
  for (const [change, code] of [
    [state => { state.health = 19 }, 'TOOK_DAMAGE'],
    [state => { state.health = 0; state.dead = true }, 'DEAD'],
    [state => { state.startedAt = 'other-session' }, 'STALE_SESSION'],
    [state => { state.dimension = 'nether' }, 'STALE_SESSION'],
    [state => { state.connectionId = 'other-socket' }, 'STALE_SESSION']
  ]) {
    const f = fixture(({ path, state }) => {
      if (path === '/move/preview') return { ready: true }
      if (path === '/move/start') { state.position.x += 0.3; state.positionUpdatedAt = new Date(1).toISOString(); change(state); throw rejectedMoveStart() }
    })
    f.state.connectionId = 'socket'
    await assert.rejects(f.runner.actions.move_to({ target: { x: 4.5, y: 65, z: 0.5 } }), error => error.code === code)
    assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
    assert.ok(f.calls.some(call => call.path === '/move/stop'))
  }
})

test('start-validation replans share the six-cycle budget and cancellation prevents a fresh retry', async () => {
  let attempts = 0
  const f = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.position.x += 0.2; state.positionUpdatedAt = new Date(++attempts).toISOString(); throw rejectedMoveStart() }
  })
  await assert.rejects(f.runner.actions.move_to({ target: { x: 8.5, y: 65, z: 0.5 } }), error => error.code === 'MOVEMENT_REPLAN_LIMIT')
  assert.equal(attempts, 6)
  const controller = new AbortController()
  const cancelled = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.position.x += 0.2; state.positionUpdatedAt = new Date(1).toISOString(); controller.abort(new Error('cancel start race')); throw rejectedMoveStart() }
  })
  await assert.rejects(cancelled.runner.actions.move_to({ target: { x: 4.5, y: 65, z: 0.5 } }, { signal: controller.signal }), /cancel start race/)
  assert.equal(cancelled.calls.filter(call => call.path === '/move/start').length, 1)
})

test('an airborne correction is settled through the generic action before replanning the unchanged goal', async () => {
  let attempts = 0
  const { runner, calls } = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      attempts++
      state.position = { x: attempts === 1 ? 1.0 : 2.4, y: attempts === 1 ? 67.098686 : 66.62, z: 0.5 }
      state.rawServerPosition = structuredClone(state.position)
      state.rawServerPositionUpdatedAt = state.positionUpdatedAt = new Date(attempts).toISOString()
      state.positionSource = 'correct_player_move_prediction'
      delete state.predicted
      state.movement = { phase: 'replan_required' }
      return state.movement
    }
    if (path === '/action' && body.method === 'settle') {
      state.position = { x: 1.0, y: 66.62, z: 0.5 }
      state.positionSource = 'client_prediction'
      state.predicted = { position: structuredClone(state.position), physicsState: { onGround: true, isInWater: false } }
      state.movement = { phase: 'awaiting_server_confirmation', onGround: true, settled: true, predictedPosition: structuredClone(state.position) }
      return state.movement
    }
  })
  const result = await runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 } })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.attempts, 2)
  const settles = calls.filter(call => call.path === '/action')
  assert.equal(settles.length, 1)
  assert.equal(settles[0].body.group, 'movement')
  assert.equal(settles[0].body.method, 'settle')
})

test('cancelling between correction and replan never starts another movement attempt', async () => {
  const controller = new AbortController()
  let corrected = false
  const { runner, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      corrected = true
      state.position = { x: 1.1, y: 66.62, z: 0.5 }
      state.rawServerPosition = structuredClone(state.position)
      state.rawServerPositionUpdatedAt = new Date(0).toISOString()
      state.positionSource = 'correct_player_move_prediction'
      state.movement = { phase: 'replan_required' }
      return state.movement
    }
    if (path === '/move/stop' && corrected) controller.abort(new Error('cancel between replans'))
  })
  await assert.rejects(runner.actions.move_to({ target: { x: 4.5, y: 65, z: 0.5 } }, { signal: controller.signal }), /cancel between replans/)
  assert.equal(calls.filter(call => call.path === '/move/start').length, 1)
})

function explorationObservation (height = () => 64) {
  const blocks = []
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) {
    const ground = height(x, z)
    for (let dy = 0; dy <= 2; dy++) blocks.push({ known: true, position: { x, y: ground + dy, z }, name: dy === 0 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: dy === 0 ? 'block' : 'empty', extra: [] })
  }
  return { center: { x: 0, y: 65, z: 0 }, radius: 12, blocks }
}

test('exploration tries another known endpoint after a read-only route failure and preserves movement confidence labels', async () => {
  let previews = 0
  const { runner, state, calls } = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: ++previews > 1 }
    if (path === '/move/start') {
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }
      return state.movement
    }
  })
  const result = await runner.actions.explore({ resource: 'logs', attempt: 1 }, { observations: explorationObservation() })
  assert.equal(result.explored, true)
  assert.equal(result.resource, 'logs')
  assert.equal(result.candidateAttempts, 2)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.outcome, 'predicted')
  assert.equal(state.inventory.items.length, 0)
  assert.equal(calls.filter(call => call.path === '/mining/preview').length, 0)
  const targets = calls.filter(call => call.path === '/move/preview').map(call => call.body.target)
  assert.equal(targets.length, 2)
  assert.ok(Math.hypot(targets[0].x - targets[1].x, targets[0].z - targets[1].z) >= 1.5)
  const history = runner.getExplorationSnapshot().history
  assert.ok(history.some(point => point.kind === 'blocked'))
  assert.ok(history.some(point => point.kind === 'visited' && point.serverConfirmed === false))
})

test('exploration route sampling is bounded and does not repeatedly issue physical moves after a movement failure', async () => {
  const blocked = fixture(({ path }) => path === '/move/preview' ? { ready: false } : undefined)
  await assert.rejects(blocked.runner.actions.explore({ resource: 'logs' }, { observations: explorationObservation() }), /bounded candidates/)
  const previews = blocked.calls.filter(call => call.path === '/move/preview')
  assert.ok(previews.length > 1 && previews.length <= 20)
  assert.equal(new Set(previews.map(call => JSON.stringify(call.body.target))).size, previews.length)
  assert.equal(blocked.calls.filter(call => call.path === '/move/start').length, 0)
  const failed = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement = { phase: 'replan_required' }; return state.movement }
  })
  await assert.rejects(failed.runner.actions.explore({ resource: 'logs' }, { observations: explorationObservation() }), /did not show authoritative movement progress/)
  assert.equal(failed.calls.filter(call => call.path === '/move/start').length, 1)
})

test('read-only scanning does not move, and cancelling exploration prevents a movement start', async () => {
  const scanning = fixture()
  await scanning.runner.actions.scan_blocks({ resource: 'logs' })
  assert.equal(scanning.calls.filter(call => call.path.startsWith('/move/')).length, 0)
  const controller = new AbortController()
  const cancelled = fixture(({ path }) => {
    if (path === '/move/preview') { controller.abort(new Error('cancel exploration')); return { ready: false } }
  })
  await assert.rejects(cancelled.runner.actions.explore({ resource: 'logs' }, { signal: controller.signal, observations: explorationObservation() }), /cancel exploration/)
  assert.equal(cancelled.calls.filter(call => call.path === '/move/start').length, 0)
})

test('retreat uses observed hillside heights rather than a fixed current-height ring', async () => {
  const { runner, state, calls } = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true, waypoints: [{ position: body.target, medium: 'land', action: 'walk' }] }
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
  })
  const threat = { hostile: true, alive: true, name: 'minecraft:zombie', position: { x: 2.5, y: 65, z: 0.5 } }
  state.hostiles = [threat]
  const result = await runner.actions.avoid_threat({ threat }, { observations: { ...explorationObservation(x => x <= -3 ? 65 : 64), threats: [threat] } })
  assert.equal(result.serverConfirmed, false)
  const target = calls.find(call => call.path === '/move/start').body.target
  assert.ok(target.x < state.position.x)
  assert.equal(target.y, 66)
  const noTerrain = fixture()
  noTerrain.state.hostiles = [threat]
  await assert.rejects(noTerrain.runner.actions.avoid_threat({ threat }, { observations: { blocks: [], threats: [threat] } }), /No known safe retreat/)
  assert.equal(noTerrain.calls.filter(call => call.path === '/move/start').length, 0)
})

function retreatThreat () { return { entityId: '55', hostile: true, alive: true, name: 'minecraft:zombie', position: { x: 2.5, y: 65, z: 0.5 } } }
function landRoute (target, before = []) { return { ready: true, waypoints: [...before, { position: target, medium: 'land', action: 'walk' }] } }
function retreatFixture (extra = () => undefined) {
  const f = fixture(async input => {
    const result = await extra(input)
    if (result !== undefined) return result
    if (input.path === '/move/preview') return landRoute(input.body.target)
    if (input.path === '/move/start') { input.state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...input.body.target, y: input.body.target.y + 1.62 } }; return input.state.movement }
  })
  const threat = retreatThreat()
  f.state.hostiles = [threat]
  f.state.health = 4
  return { ...f, threat, context: { observations: { ...explorationObservation(), threats: [threat] } } }
}

test('low-health retreat needs strict emergency authorization and passes it through movement without weakening resource guards', async () => {
  const f = retreatFixture()
  await assert.rejects(f.runner.actions.avoid_threat({ threat: f.threat }, f.context), error => error.code === 'LOW_HEALTH')
  await assert.rejects(f.runner.actions.avoid_threat({ threat: f.threat, emergency: 'true' }, f.context), error => error.code === 'LOW_HEALTH')
  const result = await f.runner.actions.avoid_threat({ threat: f.threat, emergency: true, allowWater: true }, f.context)
  assert.equal(result.serverConfirmed, false)
  for (const call of f.calls.filter(call => call.path === '/move/preview' || call.path === '/move/start')) {
    assert.equal(call.body.options.emergency, true)
    assert.equal(call.body.options.allowWater, false)
    assert.equal(call.body.options.sprint, true)
  }
  f.state.hostiles = []
  for (const [type, decision] of [
    ['move_to', { target: { x: 3.5, y: 65, z: 0.5 } }], ['gather_logs', { targets: [{ x: 1, y: 65, z: 0 }] }],
    ['mine_stone', { target: { x: 1, y: 65, z: 0 } }], ['collect_drops', { targets: [] }],
    ['craft', { output: 'minecraft:stick', times: 1 }], ['equip', { slot: 0 }]
  ]) await assert.rejects(f.runner.actions[type]({ ...decision, emergency: true }), error => error.code === 'LOW_HEALTH')
  assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
})

test('damage or death during emergency retreat stops the move and returns to the safety decision without internal retry', async () => {
  for (const died of [false, true]) {
    const f = retreatFixture(({ path, state }) => {
      if (path === '/move/start') {
        state.health = died ? 0 : 3.5
        state.dead = died
        state.movement.phase = 'moving'
        return state.movement
      }
    })
    await assert.rejects(f.runner.actions.avoid_threat({ threat: f.threat, emergency: true }, f.context), error => error.code === (died ? 'DEAD' : 'TOOK_DAMAGE'))
    assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
    assert.ok(f.calls.some(call => call.path === '/move/stop'))
  }
})

test('retreat rejects an approaching detour before movement and selects another route, allowing only a small initial turn', async () => {
  let previews = 0
  const f = retreatFixture(({ path, body }) => {
    if (path === '/move/preview') return landRoute(body.target, [{ position: { x: ++previews === 1 ? 1.5 : 0.6, y: 65, z: 0.5 }, medium: 'land', action: 'walk' }])
  })
  await f.runner.actions.avoid_threat({ threat: f.threat, emergency: true }, f.context)
  assert.equal(previews, 2)
  assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
})

test('whole retreat segments cannot pass close to an enemy even when both endpoints are far enough', async () => {
  const f = retreatFixture(({ path, body }) => path === '/move/preview' ? landRoute(body.target, [{ position: { x: 4.5, y: 65, z: 0.5 }, medium: 'land', action: 'walk' }]) : undefined)
  await assert.rejects(f.runner.actions.avoid_threat({ threat: f.threat, emergency: true }, f.context), error => error.code === 'NO_SAFE_RETREAT')
  assert.equal(f.calls.filter(call => call.path === '/move/start').length, 0)
  assert.ok(f.calls.filter(call => call.path === '/move/preview').length <= 20)
})

test('missing, unknown or water retreat route geometry never becomes an emergency land move', async () => {
  for (const kind of ['missing', 'water', 'unknown']) {
    const f = retreatFixture(({ path, body }) => path === '/move/preview' ? kind === 'missing' ? { ready: true } : { ready: true, waypoints: [{ position: body.target, medium: kind === 'water' ? 'water' : 'land', action: kind === 'water' ? 'swim' : 'walk', ...(kind === 'unknown' ? { known: false } : {}) }] } : undefined)
    await assert.rejects(f.runner.actions.avoid_threat({ threat: f.threat, emergency: true }, f.context), error => error.code === 'NO_SAFE_RETREAT')
    assert.equal(f.calls.filter(call => call.path === '/move/start').length, 0)
  }
})

test('emergency retreat carries low-health authorization through bounded land settling', async () => {
  const f = retreatFixture(({ path, body, state }) => {
    if (path === '/action' && body.method === 'settle') {
      state.position.y = 66.62
      state.movement = { phase: 'awaiting_server_confirmation', settled: true, onGround: true }
      return state.movement
    }
  })
  f.state.position.y += 0.2
  await f.runner.actions.avoid_threat({ threat: f.threat, emergency: true }, f.context)
  const settle = f.calls.find(call => call.path === '/action' && call.body.method === 'settle')
  assert.equal(settle.body.args[0].emergency, true)
  assert.equal(f.calls.find(call => call.path === '/move/start').body.options.emergency, true)
})

test('low-health retreat obtains read-only terrain when the safety decision has no resource observations', async () => {
  const f = fixture(({ path, body, state, block }) => {
    if (path.startsWith('/blocks?')) {
      const query = new URL(path, 'http://127.0.0.1').searchParams
      const center = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Number(query.get(axis))]))
      const radius = Number(query.get('radius'))
      const blocks = []
      for (let x = center.x - radius; x <= center.x + radius; x++) for (let y = center.y - radius; y <= center.y + radius; y++) for (let z = center.z - radius; z <= center.z + radius; z++) blocks.push(block(x, y, z, y <= 64 ? 'minecraft:grass_block' : 'minecraft:air'))
      return { blocks }
    }
    if (path === '/move/preview') return landRoute(body.target)
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...body.target, y: body.target.y + 1.62 } }; return state.movement }
  }, { scanRadius: 6 })
  const threat = retreatThreat()
  f.state.health = 4
  f.state.hostiles = [threat]
  const result = await f.runner.actions.avoid_threat({ threat, emergency: true }, { observations: {} })
  assert.equal(result.serverConfirmed, false)
  assert.ok(f.calls.some(call => call.path.startsWith('/blocks?')))
  assert.equal(f.calls.filter(call => call.path === '/move/start').length, 1)
  assert.equal(f.calls.filter(call => call.path === '/craft/start' || call.path === '/mining/start').length, 0)
})

test('retreat does not approach a second known enemy outside its current danger radius', async () => {
  const f = retreatFixture(({ path, body }) => path === '/move/preview' ? landRoute(body.target, [{ position: { x: -10, y: 65, z: 0.5 }, medium: 'land', action: 'walk' }]) : undefined)
  f.state.hostiles.push({ ...retreatThreat(), entityId: '66', position: { x: -16, y: 65, z: 0.5 } })
  await assert.rejects(f.runner.actions.avoid_threat({ threat: f.threat, emergency: true }, f.context), error => error.code === 'NO_SAFE_RETREAT')
  assert.equal(f.calls.filter(call => call.path === '/move/start').length, 0)
})

test('Runner keeps sprint opt-in for ordinary movement and short retreat requests do not grant emergency health permissions', async () => {
  const f = retreatFixture()
  f.state.health = 20
  await f.runner.actions.avoid_threat({ threat: f.threat }, f.context)
  const retreat = f.calls.find(call => call.path === '/move/start')
  assert.equal(retreat.body.options.sprint, true)
  assert.equal(retreat.body.options.emergency, undefined)
  const normal = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { ...body.target, y: body.target.y + 1.62 } }; return state.movement }
  })
  const target = { x: 3.5, y: 65, z: 0.5 }
  await normal.runner.actions.move_to({ target })
  assert.equal(normal.calls.find(call => call.path === '/move/start').body.options.sprint, undefined)
  await assert.rejects(normal.runner.actions.move_to({ target, sprint: 'true' }), error => error.code === 'INVALID_MOVEMENT_OPTIONS')
})

function treePickupObservation () {
  const observations = explorationObservation()
  const remainingLog = observations.blocks.find(block => block.position.x === 2 && block.position.y === 66 && block.position.z === 0)
  remainingLog.name = 'minecraft:acacia_log'
  remainingLog.boundingBox = 'block'
  return observations
}

test('an adjacent one-block pickup stance remains usable when an upper tree log blocks standing in the item cell', async () => {
  let reads = 0
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/status' && ++reads >= 3) state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 3 }]
  })
  state.position.x = 1.5
  const result = await runner.actions.collect_drops({ count: 3, targets: [{ entityId: 'tree-drop', name: 'minecraft:acacia_log', count: 3, position: { x: 2.5, y: 65.2, z: 0.5 } }] }, { observations: treePickupObservation() })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.count, 3)
  assert.equal(calls.filter(call => call.path.startsWith('/move/')).length, 0)
})

test('pickup approaches a known adjacent body-clear cell rather than routing into the blocked tree column', async () => {
  let moved = false
  let pickupReads = 0
  const { runner, calls } = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: body.target.x !== 2.5 || body.target.z !== 0.5 }
    if (path === '/move/start') {
      moved = true
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }
      return state.movement
    }
    if (path === '/status' && moved && ++pickupReads >= 2) state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 3 }]
  })
  const result = await runner.actions.collect_drops({ count: 3, targets: [{ entityId: 'tree-drop', name: 'minecraft:acacia_log', count: 3, position: { x: 2.5, y: 65.2, z: 0.5 } }] }, { observations: treePickupObservation() })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.count, 3)
  const edge = calls.find(call => call.path === '/move/start').body.target
  assert.ok(Math.abs(edge.x - 1.68) < 1e-8)
  assert.equal(edge.y, 65)
  assert.equal(edge.z, 0.5)
  assert.ok(edge.x + 0.3 < 2, 'the whole player head stays outside the remaining upper log')
})

function savedOakPickupScene () {
  const eye = { x: -17.502597, y: 68.62, z: 43.57397 }
  const drop = { entityId: '1888', runtimeId: '1888', name: 'minecraft:oak_log', count: 1, position: { x: -18.553667, y: 67.125, z: 43.797428 } }
  const observations = { blocks: [] }
  for (let x = -23; x <= -14; x++) for (let z = 39; z <= 48; z++) for (let y = 66; y <= 69; y++) {
    observations.blocks.push({ known: true, name: y === 66 ? 'minecraft:grass_block' : 'minecraft:air', position: { x, y, z }, boundingBox: y === 66 ? 'block' : 'empty', extra: [] })
  }
  return { eye, drop, observations }
}

test('the saved 1.07-block oak drop is physically approached within half a block before collection is confirmed', async () => {
  const scene = savedOakPickupScene()
  let closeReads = 0
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x + 0.18, y: body.target.y + 1.62, z: body.target.z } }
      return state.movement
    }
    const predicted = state.movement.predictedPosition
    if (path === '/status' && predicted && Math.hypot(predicted.x - scene.drop.position.x, predicted.z - scene.drop.position.z) <= 0.5 && ++closeReads >= 2) {
      state.inventory.items = [{ slot: 0, name: 'minecraft:oak_log', count: 1 }]
      state.droppedItems = []
    }
  })
  f.state.position = scene.eye
  f.state.droppedItems = [scene.drop]
  const result = await f.runner.actions.collect_drops({ count: 1, targets: [scene.drop] }, { observations: scene.observations })
  const moves = f.calls.filter(call => call.path === '/move/start')
  assert.equal(moves.length, 1, 'the old 1.2-block neighbourhood cannot skip the close approach')
  const target = moves[0].body.target
  assert.ok(Math.hypot(target.x - scene.drop.position.x, target.z - scene.drop.position.z) <= 0.5)
  assert.equal(target.y, 67, 'movement receives the supported feet height, not the dropped actor or eye height')
  assert.equal(result.confirmedBy, 'server_inventory')
  assert.equal(result.count, 1)
})

test('an uncollected nearby drop gets finite real close approaches before failure and never becomes a fake gain', async () => {
  const scene = savedOakPickupScene()
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }
      return state.movement
    }
  })
  f.state.position = scene.eye
  f.state.droppedItems = [scene.drop]
  await assert.rejects(f.runner.actions.collect_drops({ count: 1, targets: [scene.drop] }, { observations: scene.observations }), error => error.code === 'PICKUP_NOT_CONFIRMED')
  const moves = f.calls.filter(call => call.path === '/move/start')
  assert.ok(moves.length >= 1 && moves.length <= 3)
  assert.ok(moves.every(call => Math.hypot(call.body.target.x - scene.drop.position.x, call.body.target.z - scene.drop.position.z) <= 0.5), 'retry nudges stay close rather than walking away from an overlapping item')
  assert.equal(f.state.inventory.items.length, 0)
})

test('pickup edge targets keep the whole player footprint out of unknown neighbouring head cells', async () => {
  const observations = explorationObservation()
  const head = observations.blocks.find(block => block.position.x === 2 && block.position.y === 66 && block.position.z === 0)
  head.known = false; head.name = null; head.boundingBox = null
  let moved = false
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { moved = true; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
    if (path === '/status' && moved) state.inventory.items = [{ slot: 0, name: 'minecraft:oak_log', count: 1 }]
  })
  const drop = { entityId: 'edge', name: 'minecraft:oak_log', count: 1, position: { x: 1.95, y: 65.125, z: 0.5 } }
  const result = await f.runner.actions.collect_drops({ targets: [drop] }, { observations })
  const target = f.calls.find(call => call.path === '/move/start').body.target
  assert.ok(target.x + 0.3 < 2, 'placing only the player centre in known air is insufficient')
  assert.ok(Math.hypot(target.x - drop.position.x, target.z - drop.position.z) <= 0.5)
  assert.equal(result.serverConfirmed, true)
})

test('pickup follows the latest position of the same drop actor instead of a stale airborne decision', async () => {
  const stale = { entityId: 'falling-log', name: 'minecraft:oak_log', count: 1, position: { x: 2.5, y: 72.125, z: 0.5 } }
  const latest = { ...stale, position: { x: 1.75, y: 65.125, z: 0.5 } }
  let moved = false
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { moved = true; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
    if (path === '/status' && moved) state.inventory.items = [{ slot: 0, name: 'minecraft:oak_log', count: 1 }]
  })
  f.state.droppedItems = [latest]
  const result = await f.runner.actions.collect_drops({ targets: [stale] }, { observations: explorationObservation() })
  assert.deepEqual(f.calls.find(call => call.path === '/move/start').body.target, { x: latest.position.x, y: 65, z: latest.position.z })
  assert.equal(result.count, 1)
})

test('an adjacent uncollected trunk drop still gets a closer collision-safe edge approach', async () => {
  let moved = false
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { moved = true; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
    if (path === '/status' && moved) state.inventory.items = [{ slot: 0, name: 'minecraft:acacia_log', count: 1 }]
  })
  f.state.position.x = 1.5
  const result = await f.runner.actions.collect_drops({ targets: [{ entityId: 'under-log', name: 'minecraft:acacia_log', count: 1, position: { x: 2.5, y: 65.2, z: 0.5 } }] }, { observations: treePickupObservation() })
  const target = f.calls.find(call => call.path === '/move/start').body.target
  assert.ok(target.x > 1.65 && target.x + 0.3 < 2)
  assert.equal(result.count, 1)
})

test('cached inventory growth during an uncertain pickup cannot become collection evidence', async () => {
  let moved = false
  const f = fixture(({ path, body, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { moved = true; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
    if (path === '/status' && moved) { state.inventory.items = [{ slot: 0, name: 'minecraft:oak_log', count: 1 }]; state.inventory.uncertain = true }
  })
  await assert.rejects(f.runner.actions.collect_drops({ targets: [{ entityId: 'uncertain', name: 'minecraft:oak_log', count: 1, position: { x: 1.5, y: 65.125, z: 0.5 } }] }, { observations: explorationObservation() }), error => error.code === 'PICKUP_NOT_CONFIRMED')
})

test('high or wall-obstructed drops are never reported as collected without a reachable body-range stance and inventory gain', async () => {
  const high = fixture()
  await assert.rejects(high.runner.actions.collect_drops({ targets: [{ entityId: 'high', name: 'minecraft:acacia_log', count: 1, position: { x: 0.5, y: 68, z: 0.5 } }] }, { observations: explorationObservation() }), error => error.code === 'NO_SAFE_ROUTE' && error.targetEntityId === 'high')
  assert.equal(high.calls.filter(call => call.path === '/move/start').length, 0)
  const wall = fixture()
  const observations = explorationObservation()
  const solid = observations.blocks.find(block => block.position.x === 1 && block.position.y === 65 && block.position.z === 0)
  solid.name = 'minecraft:stone'; solid.boundingBox = 'block'
  await assert.rejects(wall.runner.actions.collect_drops({ targets: [{ entityId: 'wall', name: 'minecraft:acacia_log', count: 1, position: { x: 1.5, y: 65.2, z: 0.5 } }] }, { observations }), error => error.code === 'NO_SAFE_ROUTE')
  assert.equal(wall.state.inventory.items.length, 0)
})

test('species-specific threat policies stop work for a twenty-block skeleton and are recalculated after player movement', async () => {
  const { runner, state } = fixture()
  state.hostiles = [{ runtimeId: '5', kind: 'mob', entityType: 'minecraft:skeleton', alive: true, position: { x: 20.5, y: 66.62, z: 0.5 }, distance: 1 }]
  const observations = await runner.observe()
  assert.equal(observations.threats.length, 1)
  assert.equal(observations.threats[0].dangerRadius, 24)
  await assert.rejects(runner.actions.preview_craft({ output: 'minecraft:stick', times: 1 }), error => error.code === 'NEARBY_THREAT')
  state.position.x = -10
  const allowed = await runner.actions.preview_craft({ output: 'minecraft:stick', times: 1 })
  assert.equal(allowed.ok, true)
})

test('observations preserve raw primed flags and unknown actor positions instead of collapsing them into a safe empty threat list', async () => {
  const { runner, state } = fixture()
  state.hostiles = [{ runtimeId: '6', kind: 'mob', entityType: 'minecraft:creeper', primed: true, lastEvent: { event: 'creeper_prime_fuse' }, position: { x: 10.5, y: 66.62, z: 0.5 } }]
  const primed = await runner.observe()
  assert.equal(primed.entities[0].primed, true)
  assert.equal(primed.entities[0].lastEvent.event, 'creeper_prime_fuse')
  assert.equal(primed.threats[0].dangerRadius, 12)
  state.hostiles = [{ runtimeId: '7', kind: 'mob', entityType: 'minecraft:skeleton', position: null, positionKnown: false }]
  state.entityStats = { unknownPositions: 1 }
  const unknown = await runner.observe()
  assert.equal(unknown.threats.length, 0)
  assert.equal(unknown.threatEvaluation.requiresObservation, true)
  assert.equal(unknown.threatEvaluation.unknownPositions.length, 1)
  assert.equal(unknown.entities[0].position, null)
  await assert.rejects(runner.actions.preview_craft({ output: 'minecraft:stick', times: 1 }), error => error.code === 'THREAT_OBSERVATION_UNKNOWN')
})

test('reaching the planned approach point cannot repeatedly report completion when the resource mining preview still fails', async () => {
  const resourceTarget = { x: -8, y: 67, z: 33 }
  const target = { x: -10.5, y: 66, z: 30.5 }
  const { runner, state, calls } = fixture(({ path, state, block }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: -10.5158, y: 67.62, z: 30.5706 } }; return state.movement }
    if (path === '/mining/preview') return { ready: false, targets: [], errors: ['対象までの視線がブロックで遮られています。'] }
    if (path.startsWith('/blocks?')) return { blocks: [block(resourceTarget.x, resourceTarget.y, resourceTarget.z, 'minecraft:acacia_log')] }
  })
  state.position = { x: -11.5, y: 67.62, z: 29.5 }
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(runner.actions.move_to({ target, resourceTarget, resource: 'logs', block: 'minecraft:acacia_log' }), error => {
      assert.equal(error.code, 'NO_SAFE_ROUTE')
      assert.equal(error.reason, 'resource_access_not_ready')
      assert.deepEqual(error.resourceTarget, resourceTarget)
      assert.deepEqual(error.approachTarget, target)
      assert.equal(error.resourceAccessReady, false)
      assert.equal(error.movementAttempted, true)
      return true
    })
  }
  assert.equal(calls.filter(call => call.path === '/mining/preview').length, 3)
  assert.equal(calls.filter(call => call.path === '/mining/start').length, 0)
  assert.equal(state.inventory.items.length, 0)
})

test('a resource approach succeeds locally only after a live ready mining preview without fabricating acquired materials', async () => {
  const resourceTarget = { x: 4, y: 65, z: 0 }
  const { runner, state, calls } = fixture(({ path, state }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') { state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: 2.5, y: 66.62, z: 0.5 } }; return state.movement }
    if (path === '/mining/preview') return { ready: true, targets: [{ position: resourceTarget, name: 'minecraft:acacia_log' }], errors: [] }
  })
  const result = await runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 }, resourceTarget, resource: 'logs', block: 'minecraft:acacia_log' })
  assert.equal(result.phase, 'completed')
  assert.equal(result.resourceReady, true)
  assert.deepEqual(result.resourceTarget, resourceTarget)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.outcome, 'predicted')
  assert.equal(calls.filter(call => call.path === '/mining/preview').length, 1)
  assert.equal(calls.filter(call => call.path === '/mining/start').length, 0)
  assert.equal(state.inventory.items.length, 0)
})

test('fresh server arrival and the old near-in-range shortcut still require real resource access', async () => {
  const resourceTarget = { x: 4, y: 65, z: 0 }
  let callbacks = 0
  const confirmed = fixture(({ path, state, block }) => {
    if (path === '/move/preview') return { ready: true }
    if (path === '/move/start') {
      state.position = { x: 2.4, y: 66.62, z: 0.5 }
      state.rawServerPosition = structuredClone(state.position)
      state.positionSource = 'correct_player_move_prediction'
      state.rawServerPositionUpdatedAt = new Date(0).toISOString()
      state.movement = { phase: 'replan_required' }
      return state.movement
    }
    if (path === '/mining/preview') return { ready: false, errors: ['手の届く範囲外です。'] }
    if (path.startsWith('/blocks?')) return { blocks: [block(resourceTarget.x, resourceTarget.y, resourceTarget.z, 'minecraft:acacia_log')] }
  }, { verifyPosition: async () => { callbacks++; return { accepted: true } } })
  await assert.rejects(confirmed.runner.actions.move_to({ target: { x: 2.5, y: 65, z: 0.5 }, resourceTarget, resource: 'logs' }), error => error.code === 'NO_SAFE_ROUTE')
  assert.equal(callbacks, 0)
  const closeTarget = { x: 1, y: 65, z: 0 }
  const nearby = fixture(({ path, block }) => {
    if (path === '/mining/preview') return { ready: false, errors: ['視線が遮られています。'] }
    if (path.startsWith('/blocks?')) return { blocks: [block(1, 65, 0, 'minecraft:acacia_log')] }
  })
  await assert.rejects(nearby.runner.actions.move_to({ near: closeTarget, range: 3, resource: 'logs' }), error => error.code === 'NO_SAFE_ROUTE')
  assert.equal(nearby.calls.filter(call => call.path === '/move/start').length, 0)
})

test('resource disappearance, replacement, unknown state and missing tools have distinct approach failure reasons', async () => {
  const resourceTarget = { x: 1, y: 65, z: 0 }
  for (const scenario of [
    { name: 'minecraft:air', known: true, expected: 'RESOURCE_GONE', errors: ['対象外です。'] },
    { name: 'minecraft:crafting_table', known: true, expected: 'RESOURCE_CHANGED', errors: ['対象外です。'] },
    { name: null, known: false, expected: 'RESOURCE_UNKNOWN', errors: ['未取得です。'] },
    { name: 'minecraft:stone', known: true, expected: 'TOOL_REQUIRED', errors: ['適切なツルハシの装備を確認できません。'], resource: 'stone', block: 'minecraft:stone' }
  ]) {
    const { runner } = fixture(({ path }) => {
      if (path === '/mining/preview') return { ready: false, errors: scenario.errors }
      if (path.startsWith('/blocks?')) return { blocks: [{ position: resourceTarget, known: scenario.known, name: scenario.name }] }
    })
    await assert.rejects(runner.actions.move_to({ near: resourceTarget, range: 3, resource: scenario.resource ?? 'logs', block: scenario.block ?? 'minecraft:acacia_log' }), error => error.code === scenario.expected && error.resourceAccessReady === false)
  }
})
