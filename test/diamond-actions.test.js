'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createDiamondActions } = require('../src/diamond-actions')
const { createRunner } = require('../src/runner')

const position = { x: 2, y: 65, z: 0 }
const blockKey = point => `${point.x},${point.y},${point.z}`
const emptySlot = slot => ({ slot, role: ['furnace_ingredient', 'furnace_fuel', 'furnace_output'][slot], known: true, name: null, count: 0, stackId: null })
function fixture (handler = () => undefined, options = {}) {
  const calls = []
  const baseCalls = []
  const progress = []
  const blocks = new Map()
  let transferId = -1
  const state = {
    phase: 'spawned', startedAt: 'same-session', connectionId: 'same-connection',
    dimension: 'overworld', gameMode: 'survival', health: 20, dead: false,
    position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, rawSelectedSlot: 0,
    inventory: { known: true, items: [{ name: 'minecraft:stone_pickaxe', slot: 0, count: 1 }] },
    heldItem: { name: 'minecraft:stone_pickaxe', slot: 0, count: 1 }, equipmentServerConfirmed: true,
    hostiles: [], mining: { phase: 'idle' }, movement: { phase: 'idle' },
    crafting: { authority: true, openContainer: { id: 1, type: 'furnace' } },
    furnace: { window: { id: 1, type: 'furnace', coordinates: { ...position } }, contentsKnown: true, needsOpen: false, busy: false, inventoryUncertain: false, slots: [0, 1, 2].map(emptySlot), progress: null, lastTransfer: null },
    prospecting: { phase: 'idle', ores: { coal: [], iron: [], diamond: [] } }
  }
  const setBlock = (point, name, extra = {}) => blocks.set(blockKey(point), { known: true, name, position: { ...point }, boundingBox: name === 'minecraft:air' ? 'empty' : 'block', extra: [], ...extra })
  setBlock(position, 'minecraft:furnace')
  const setSlot = (slot, name, count, metadata = {}) => { state.furnace.slots[slot] = { ...emptySlot(slot), name: count ? name : null, count, stackId: count ? 100 + slot : null, ...metadata } }
  function items (values) { state.inventory.items = values.map(([name, count, slot], index) => ({ name: `minecraft:${name}`, count, slot: slot ?? index })) }
  const request = async (method, path, body, { signal } = {}) => {
    if (signal?.aborted) throw signal.reason
    calls.push({ method, path, body: structuredClone(body) })
    const custom = await handler({ method, path, body, state, calls, signal, setBlock, setSlot })
    if (custom !== undefined) return structuredClone(custom)
    if (path === '/status') return structuredClone(state)
    if (path.startsWith('/blocks?')) {
      const query = new URL(path, 'http://127.0.0.1').searchParams
      const point = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Number(query.get(axis))]))
      return { blocks: [structuredClone(blocks.get(blockKey(point)) ?? { known: true, name: 'minecraft:air', position: point })] }
    }
    if (path === '/mining/preview') return { ready: true, targets: body.targets.map(point => structuredClone(blocks.get(blockKey(point)))) }
    if (path === '/mining/start') { for (const point of body.targets) setBlock(point, 'minecraft:air'); state.mining.phase = 'completed'; return structuredClone(state.mining) }
    if (path === '/mining/stop') { state.mining.phase = 'stopped'; return { phase: 'stopped' } }
    if (path === '/craft/close') { state.crafting.openContainer = null; state.furnace.window = null; state.furnace.contentsKnown = false; return { phase: 'closed' } }
    if (path !== '/action') throw new Error(`Unexpected fake HTTP path: ${path}`)
    const { group, method: action, args } = body
    if (group === 'prospecting' && action === 'start') { state.prospecting.phase = 'requesting'; return { phase: 'requesting' } }
    if (group === 'prospecting' && action === 'stop') { state.prospecting.phase = 'stopped'; return { phase: 'stopped' } }
    if (group === 'interactions' && action === 'previewPlace') return { ready: true, expectedBlock: 'minecraft:furnace', position: args[0].position, slot: args[0].slot }
    if (group === 'interactions' && action === 'placeBlock') {
      const item = state.inventory.items.find(item => item.slot === args[0].slot)
      item.count--
      setBlock(args[0].position, 'minecraft:furnace')
      return { phase: 'completed', confirmedBy: 'server_block_and_inventory' }
    }
    if (group === 'interactions' && action === 'openFurnace') {
      state.furnace.window = { id: 2, type: 'furnace', coordinates: args[0] }
      state.furnace.contentsKnown = true; state.furnace.needsOpen = false
      state.crafting.openContainer = { id: 2, type: 'furnace' }
      return { phase: 'completed', windowId: 2, windowType: 'furnace' }
    }
    if (group === 'interactions' && action === 'cancel') return { phase: 'stopped' }
    if (group === 'furnace' && ['stop', 'cancel'].includes(action)) return { phase: 'stopped' }
    if (group === 'furnace' && ['putInput', 'putFuel', 'takeOutput'].includes(action)) {
      const kind = action === 'putInput' ? 'input' : action === 'putFuel' ? 'fuel' : 'take'
      const furnaceSlot = kind === 'input' ? 0 : kind === 'fuel' ? 1 : 2
      const count = kind === 'take' ? args[0].count : args[1]
      const existing = state.furnace.slots[furnaceSlot]
      let item
      if (kind === 'take') {
        item = state.inventory.items.find(item => item.name === existing.name)
        if (!item) { item = { name: existing.name, count: 0, slot: 8 }; state.inventory.items.push(item) }
        item.count += count
      } else { item = state.inventory.items.find(item => item.slot === args[0]); item.count -= count }
      const name = kind === 'take' ? existing.name : item.name
      setSlot(furnaceSlot, name, existing.count + (kind === 'take' ? -count : count))
      const response = { phase: 'completed', serverConfirmed: true, requestId: transferId, operation: kind, count, item: name, playerSlot: item.slot, furnaceSlot, windowId: state.furnace.window.id, confirmedBy: 'server_stack_response' }
      transferId -= 2
      state.furnace.lastTransfer = structuredClone(response)
      return response
    }
    throw new Error(`Unexpected fake action: ${group}.${action}`)
  }
  const refreshState = ({ signal } = {}) => request('GET', '/status', undefined, { signal })
  const getState = () => structuredClone(state)
  const baseActions = {
    mine_stone: async (decision, context) => { baseCalls.push(structuredClone(decision)); if (context.signal.aborted) throw context.signal.reason; setBlock(decision.target, 'minecraft:air'); return { ok: true, phase: 'completed', serverConfirmed: true, blocksBroken: 1 } },
    equip: async decision => {
      const source = state.inventory.items.find(item => item.slot === decision.slot)
      const old = state.inventory.items.find(item => item.slot === 0)
      if (old) old.slot = decision.slot
      source.slot = 0; state.heldItem = structuredClone(source)
      return { ok: true, phase: 'completed', serverConfirmed: true }
    }
  }
  const actions = createDiamondActions({ request, refreshState, getState, baseActions, onProgress: event => progress.push(event), timeoutMs: 150, pollIntervalMs: 2, ...options })
  return { state, calls, baseCalls, progress, blocks, setBlock, setSlot, items, request, refreshState, getState, baseActions, actions }
}
const actionCalls = f => f.calls.filter(call => call.path === '/action').map(call => `${call.body.group}.${call.body.method}`)
const ironDecision = { type: 'mine_ore', resource: 'iron', target: { x: 1, y: 65, z: 0 }, block: 'minecraft:iron_ore', requiredToolTier: 2 }

test('construction is passive and only exposes action handlers', () => {
  const f = fixture()
  assert.equal(f.calls.length, 0)
  assert.equal(f.baseCalls.length, 0)
  assert.deepEqual(Object.keys(f.actions).sort(), ['mine_ore', 'open_furnace', 'place_furnace', 'prospect', 'put_furnace_fuel', 'put_furnace_input', 'take_furnace_output', 'tunnel'])
})

test('prospect starts a short request then polls genuine known ores without inventing an unknown result', async () => {
  let polls = 0
  const f = fixture(({ path, state }) => {
    if (path === '/status' && state.prospecting.phase === 'requesting' && ++polls === 2) state.prospecting = { phase: 'ready', known: 100, unknown: 12, ores: { coal: [{ known: true, name: 'minecraft:coal_ore', position }], iron: [{ known: false, name: 'minecraft:iron_ore', position }], diamond: [{ known: true, name: 'minecraft:stone', position }] } }
  })
  const result = await f.actions.prospect({ resource: 'coal' })
  assert.equal(polls, 2)
  assert.equal(result.phase, 'completed')
  assert.equal(result.ores.coal.length, 1)
  assert.equal(result.ores.iron.length, 0)
  assert.equal(result.ores.diamond.length, 0)
  assert.equal(result.collected, false)
  assert.deepEqual(actionCalls(f), ['prospecting.start'])
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:coal'), false)
})

test('prospecting never turns elapsed time into success and cancels an unconfirmed scan', async () => {
  const f = fixture(undefined, { timeoutMs: 25 })
  await assert.rejects(f.actions.prospect({ resource: 'diamond' }), error => error.code === 'UNCONFIRMED_TIMEOUT')
  assert.ok(actionCalls(f).includes('prospecting.stop'))
  assert.equal(f.state.inventory.items.length, 1)
})

test('ore mining reuses the actual Runner ground preparation, second live preview and air confirmation', async () => {
  const f = fixture()
  f.setBlock(ironDecision.target, 'minecraft:iron_ore')
  const runner = createRunner({ request: f.request, pollIntervalMs: 2, timeoutMs: 100 })
  const actions = createDiamondActions({ request: f.request, refreshState: runner.refreshState, getState: runner.getState, baseActions: runner.actions, timeoutMs: 150, pollIntervalMs: 2 })
  const result = await actions.mine_ore(ironDecision)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.collected, false, 'block acknowledgement is not material collection')
  assert.equal(f.calls.filter(call => call.path === '/mining/preview').length, 2)
  assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 1)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:raw_iron'), false)
})

test('a changed ore on the Runner second preview cannot be dug as arbitrary stone', async () => {
  let previews = 0
  const f = fixture(({ path, setBlock }) => { if (path === '/mining/preview' && ++previews === 2) setBlock(ironDecision.target, 'minecraft:stone') })
  f.setBlock(ironDecision.target, 'minecraft:iron_ore')
  const runner = createRunner({ request: f.request, pollIntervalMs: 2, timeoutMs: 100 })
  const actions = createDiamondActions({ request: f.request, refreshState: runner.refreshState, getState: runner.getState, baseActions: runner.actions, timeoutMs: 150, pollIntervalMs: 2 })
  await assert.rejects(actions.mine_ore(ironDecision), error => error.code === 'RESOURCE_CHANGED')
  assert.equal(f.calls.some(call => call.path === '/mining/start'), false)
})

test('unconfirmed tools, changed previews and fake local mining completion cannot claim an ore was harvested', async () => {
  const f = fixture()
  f.setBlock(ironDecision.target, 'minecraft:iron_ore')
  f.state.equipmentServerConfirmed = false
  await assert.rejects(f.actions.mine_ore(ironDecision), error => error.code === 'TOOL_NOT_CONFIRMED')
  assert.equal(f.baseCalls.length, 0)
  f.state.equipmentServerConfirmed = true
  f.setBlock(ironDecision.target, 'minecraft:stone')
  await assert.rejects(f.actions.mine_ore(ironDecision), error => error.code === 'RESOURCE_CHANGED')
  f.setBlock(ironDecision.target, 'minecraft:iron_ore')
  f.baseActions.mine_stone = async () => ({ phase: 'completed', serverConfirmed: true })
  await assert.rejects(f.actions.mine_ore(ironDecision), error => error.code === 'BLOCK_NOT_CONFIRMED')
})

test('furnace placement requires a live plan and both block and inventory confirmations', async () => {
  const f = fixture()
  f.items([['stone_pickaxe', 1], ['furnace', 1]])
  f.setBlock(position, 'minecraft:air')
  const result = await f.actions.place_furnace({ target: position, slot: 1 })
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
  assert.equal(f.state.inventory.items[1].count, 0)
  assert.deepEqual(actionCalls(f), ['interactions.previewPlace', 'interactions.placeBlock'])
  assert.equal(f.calls.find(call => call.body?.method === 'placeBlock').body.args[0].slot, 0, 'a different hotbar slot must be swapped into the actual selected slot too')
  const g = fixture(({ path, body }) => path === '/action' && body.method === 'placeBlock' ? { phase: 'completed' } : undefined, { timeoutMs: 25 })
  g.items([['stone_pickaxe', 1], ['furnace', 1]])
  g.setBlock(position, 'minecraft:air')
  await assert.rejects(g.actions.place_furnace({ target: position, slot: 1 }), error => error.code === 'UNCONFIRMED_TIMEOUT')
  assert.ok(actionCalls(g).includes('interactions.cancel'))
})

test('placing a furnace outside the hotbar first requires a real inventory swap', async () => {
  const f = fixture()
  f.items([['stone_pickaxe', 1], ['furnace', 1, 20]])
  f.setBlock(position, 'minecraft:air')
  await f.actions.place_furnace({ target: position, slot: 20 })
  const placed = f.calls.find(call => call.path === '/action' && call.body.method === 'placeBlock')
  assert.equal(placed.body.args[0].slot, 0)
  const g = fixture()
  g.items([['stone_pickaxe', 1], ['furnace', 1, 20]])
  g.baseActions.equip = async () => ({ phase: 'completed', serverConfirmed: false })
  await assert.rejects(g.actions.place_furnace({ target: position, slot: 20 }), error => error.code === 'INVENTORY_SWAP_REQUIRED')
  assert.equal(actionCalls(g).includes('interactions.placeBlock'), false)
  const h = fixture()
  h.items([['stone_pickaxe', 1], ['furnace', 1]])
  h.baseActions.equip = async () => ({ phase: 'completed', serverConfirmed: false })
  await assert.rejects(h.actions.place_furnace({ target: position, slot: 1 }), error => error.code === 'INVENTORY_SWAP_REQUIRED')
  assert.equal(actionCalls(h).length, 0, 'a client-only request for another hotbar slot cannot authorize placement')
})

test('opening a furnace closes the prior GUI and waits for its same window and all three real slots', async () => {
  let polls = 0
  const f = fixture(({ path, body, state }) => {
    if (path === '/action' && body.method === 'openFurnace') {
      state.furnace.window = { id: 2, type: 'furnace', coordinates: { ...position } }
      state.crafting.openContainer = { id: 2, type: 'furnace' }
      state.furnace.contentsKnown = false
      return { phase: 'completed', windowId: 2 }
    }
    if (path === '/status' && state.furnace.window?.id === 2 && ++polls === 2) state.furnace.contentsKnown = true
  })
  f.state.crafting.openContainer = { id: 1, type: 'workbench' }
  const result = await f.actions.open_furnace({ target: position })
  assert.equal(result.window.id, 2)
  assert.equal(polls, 2)
  assert.ok(f.calls.findIndex(call => call.path === '/craft/close') < f.calls.findIndex(call => call.body?.method === 'openFurnace'))
  const calls = f.calls.length
  assert.equal((await f.actions.open_furnace({ target: position })).alreadyOpen, true)
  assert.equal(f.calls.slice(calls).some(call => call.path === '/action'), false)
})

test('opening the wrong window cannot be counted as a furnace opening', async () => {
  const f = fixture(({ path, body, state }) => {
    if (path === '/action' && body.method === 'openFurnace') { state.furnace.window = { id: 8, type: 'furnace', coordinates: { ...position } }; state.furnace.contentsKnown = true; state.crafting.openContainer = { id: 8, type: 'furnace' }; return { phase: 'completed', windowId: 2 } }
  }, { timeoutMs: 25 })
  f.state.furnace.contentsKnown = false
  await assert.rejects(f.actions.open_furnace({ target: position }), error => error.code === 'UNCONFIRMED_TIMEOUT')
})

test('input and fuel need matching request, real furnace snapshots and actual player inventory decrease', async () => {
  const f = fixture()
  f.items([['stone_pickaxe', 1], ['raw_iron', 3], ['coal', 1]])
  const input = await f.actions.put_furnace_input({ sourceSlot: 1, count: 3 })
  assert.equal(input.inventoryDelta, -3)
  assert.equal(input.furnaceSlot, 0)
  const fuel = await f.actions.put_furnace_fuel({ sourceSlot: 2, count: 1 })
  assert.equal(fuel.inventoryDelta, -1)
  assert.equal(fuel.furnaceSlot, 1)
  assert.equal(f.state.furnace.slots[0].count, 3)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:iron_ingot'), false)
  assert.deepEqual(actionCalls(f), ['furnace.putInput', 'furnace.putFuel'])
})

test('a consumed fuel slot is valid only alongside the matching core response and inventory decrease', async () => {
  const f = fixture(({ path, state, setSlot }) => { if (path === '/status' && state.furnace.lastTransfer?.operation === 'fuel') setSlot(1, null, 0) })
  f.items([['stone_pickaxe', 1], ['coal', 1]])
  const result = await f.actions.put_furnace_fuel({ sourceSlot: 1, count: 1 })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.inventoryDelta, -1)
})

test('wood-plank fuel requires a matching real furnace transfer and inventory decrease', async () => {
  const f = fixture(); f.items([['stone_pickaxe', 1], ['oak_planks', 3]])
  const result = await f.actions.put_furnace_fuel({ sourceSlot: 1, count: 3 })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.inventoryDelta, -3)
  assert.equal(f.state.furnace.slots[1].name, 'minecraft:oak_planks')
  assert.equal(f.state.furnace.slots[1].count, 3)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:iron_ingot'), false)
  const rejected = fixture(); rejected.items([['stone_pickaxe', 1], ['crimson_planks', 3]])
  await assert.rejects(rejected.actions.put_furnace_fuel({ sourceSlot: 1, count: 3 }))
  assert.equal(actionCalls(rejected).includes('furnace.putFuel'), false)
})

test('only actual slot-two iron plus a matching take and player inventory gain confirms collection', async () => {
  const f = fixture()
  f.setSlot(2, 'minecraft:iron_ingot', 3)
  const result = await f.actions.take_furnace_output({ count: 3, expectedName: 'minecraft:iron_ingot' })
  assert.equal(result.furnaceSlot, 2)
  assert.equal(result.inventoryDelta, 3)
  assert.equal(result.collected, true)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.state.furnace.slots[2].count, 0)
  assert.equal(f.state.inventory.items.find(item => item.name === 'minecraft:iron_ingot').count, 3)
  const empty = fixture()
  empty.state.furnace.progress = { cookTicks: 200, burnTicksRemaining: 100 }
  await assert.rejects(empty.actions.take_furnace_output({ count: 1 }), error => error.code === 'FURNACE_RESOURCE_CHANGED')
  assert.equal(actionCalls(empty).length, 0, 'elapsed cooking progress alone cannot authorize taking an ingot')
})

test('a take acknowledgement and container mutation without new player ingots cannot claim collection', async () => {
  const f = fixture(({ path, body, state, setSlot }) => {
    if (path === '/action' && body.method === 'takeOutput') {
      setSlot(2, null, 0)
      const response = { phase: 'completed', serverConfirmed: true, requestId: -21, operation: 'take', count: 1, item: 'minecraft:iron_ingot', furnaceSlot: 2, windowId: 1 }
      state.furnace.lastTransfer = response
      return response
    }
  }, { timeoutMs: 25 })
  f.setSlot(2, 'minecraft:iron_ingot', 1)
  await assert.rejects(f.actions.take_furnace_output({ count: 1 }), error => error.code === 'UNCONFIRMED_TIMEOUT')
  assert.ok(actionCalls(f).includes('furnace.stop'))
})

test('unknown slots, conflicting input and uncertain inventory block transfers before any spend', async () => {
  const f = fixture()
  f.items([['stone_pickaxe', 1], ['raw_iron', 3]])
  f.state.furnace.slots[1].known = false
  await assert.rejects(f.actions.put_furnace_input({ slot: 1, count: 3 }), error => error.code === 'FURNACE_NOT_KNOWN')
  f.state.furnace.slots[1].known = true
  f.setSlot(0, 'minecraft:raw_beef', 1)
  await assert.rejects(f.actions.put_furnace_input({ slot: 1, count: 3 }), error => error.code === 'FURNACE_CONTENT_CONFLICT')
  f.state.inventory.uncertain = true
  await assert.rejects(f.actions.put_furnace_input({ slot: 1, count: 3 }), error => error.code === 'INVENTORY_UNKNOWN')
  assert.equal(actionCalls(f).length, 0)
  const closed = fixture()
  closed.items([['stone_pickaxe', 1], ['raw_iron', 3]])
  closed.state.crafting.openContainer = null
  await assert.rejects(closed.actions.put_furnace_input({ slot: 1, count: 3 }), error => error.code === 'FURNACE_NOT_KNOWN')
  assert.equal(actionCalls(closed).length, 0, 'cached furnace slots cannot authorize transfer after the active GUI closed')
  assert.equal((await closed.actions.open_furnace({ target: position })).window.id, 2)
})

test('mid-action damage and species-radius threats interrupt spending without dropping safety codes', async () => {
  const f = fixture(({ path, body, state }) => { if (path === '/action' && body.method === 'previewPlace') state.health = 19 })
  f.items([['stone_pickaxe', 1], ['furnace', 1]])
  await assert.rejects(f.actions.place_furnace({ target: position, slot: 1 }), error => error.code === 'TOOK_DAMAGE')
  assert.equal(actionCalls(f).includes('interactions.placeBlock'), false)
  const g = fixture()
  g.state.hostiles = [{ kind: 'mob', entityType: 'minecraft:skeleton', alive: true, positionKnown: true, dimension: 'overworld', runtimeId: '9', position: { x: 20.5, y: 66.62, z: 0.5 } }]
  await assert.rejects(g.actions.prospect({ resource: 'iron' }), error => error.code === 'NEARBY_THREAT')
  assert.equal(actionCalls(g).length, 0)
})

test('a parent abort releases the action lock and explicitly stops a pending remote operation', async () => {
  let started = false
  const f = fixture(({ path, body }) => { if (path === '/action' && body.method === 'start') { started = true; return new Promise(() => {}) } })
  const controller = new AbortController()
  const pending = f.actions.prospect({ resource: 'iron' }, { signal: controller.signal })
  while (!started) await delay(1)
  await assert.rejects(f.actions.open_furnace({ target: position }), error => error.code === 'ACTION_BUSY')
  const reason = new Error('test abort')
  controller.abort(reason)
  await assert.rejects(pending, reason)
  assert.ok(actionCalls(f).includes('prospecting.stop'))
  assert.equal((await f.actions.open_furnace({ target: position })).alreadyOpen, true)
  assert.equal(f.calls.some(call => call.path === '/disconnect'), false)
})

test('tunnel needs an explicit callback and preserves predicted movement without inventing collected ore', async () => {
  const decision = { ...ironDecision, targetOre: { name: ironDecision.block, position: ironDecision.target } }
  const f = fixture()
  await assert.rejects(f.actions.tunnel(decision), error => error.code === 'CAPABILITY_REQUIRED' && error.capability === 'tunnel')
  assert.equal(f.calls.length, 0)
  let signal
  const g = fixture(undefined, { tunnel: async (received, context) => { assert.deepEqual(received, decision); signal = context.signal; return { ok: true, phase: 'completed', outcome: 'predicted', serverConfirmed: false, verificationPending: true } } })
  const result = await g.actions.tunnel(decision)
  assert.equal(signal.aborted, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.verificationPending, true)
  assert.equal(result.collected, false)
  assert.equal(g.state.inventory.items.length, 1)
})

for (const health of [1, 4, 6]) test(`online learning dispatches a confirmed-tool tunnel at positive health ${health}`, async () => {
  let dispatched = 0
  const f = fixture(undefined, { tunnel: async () => { dispatched++; return { ok: true, phase: 'predicted', serverConfirmed: false } } })
  Object.assign(f.state, { health, threatPolicy: 'online_learning' })
  const result = await f.actions.tunnel(ironDecision)
  assert.equal(dispatched, 1)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.collected, false)
  assert.equal(f.state.health, health)
})

test('balanced and unspecified policies retain the low health restriction', async () => {
  for (const threatPolicy of ['balanced', undefined]) {
    let dispatched = 0
    const f = fixture(undefined, { tunnel: async () => { dispatched++ } })
    Object.assign(f.state, { health: 4, threatPolicy })
    await assert.rejects(f.actions.tunnel(ironDecision), error => error.code === 'LOW_HEALTH')
    assert.equal(dispatched, 0)
  }
})

test('online learning rejects dead, unknown and nonpositive health before dispatch', async () => {
  for (const patch of [{ health: 0 }, { health: -1 }, { health: NaN }, { health: null }, { health: 4, dead: true }, { health: 4, isDead: true }, { health: 4, lifecycle: { dead: true } }, { health: 4, spawnPending: true }]) {
    let dispatched = 0
    const f = fixture(undefined, { tunnel: async () => { dispatched++ } })
    Object.assign(f.state, { threatPolicy: 'online_learning' }, patch)
    await assert.rejects(f.actions.tunnel(ironDecision), error => ['DEAD', 'LOW_HEALTH'].includes(error.code))
    assert.equal(dispatched, 0)
  }
})

test('low health learning still interrupts fresh damage and session changes after tunnel', async () => {
  for (const [patch, code] of [[{ health: 3 }, 'TOOK_DAMAGE'], [{ connectionId: 'other-connection' }, 'STALE_SESSION']]) {
    let f
    f = fixture(undefined, { tunnel: async () => { Object.assign(f.state, patch); return { ok: true, phase: 'predicted' } } })
    Object.assign(f.state, { health: 4, threatPolicy: 'online_learning' })
    await assert.rejects(f.actions.tunnel(ironDecision), error => error.code === code)
  }
})

test('low health learning still denies unknown inventory and unusable tool tiers', async () => {
  for (const [change, code] of [[state => { state.inventory.known = false }, 'INVENTORY_UNKNOWN'], [state => { state.heldItem.name = 'minecraft:wooden_pickaxe'; state.inventory.items[0].name = 'minecraft:wooden_pickaxe' }, 'TOOL_NOT_CONFIRMED']]) {
    let dispatched = 0
    const f = fixture(undefined, { tunnel: async () => { dispatched++ } })
    Object.assign(f.state, { health: 4, threatPolicy: 'online_learning' })
    change(f.state)
    await assert.rejects(f.actions.tunnel(ironDecision), error => error.code === code)
    assert.equal(dispatched, 0)
  }
})
