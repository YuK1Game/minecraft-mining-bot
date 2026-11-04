'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planStationAccess, treeAccessScope } = require('../src/action-access')
const { nextSurvivalAction } = require('../src/survival-planner')
const { createInteractions } = require('../src/interactions')
const { createRunner } = require('../src/runner')
const captured = require('./fixtures/station-access-forest.json')
const copy = value => structuredClone(value)
const table = { x: -41, y: 70, z: 21 }
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function fixture (t, wall = false) {
  const state = copy(captured.state), blocks = new Map(captured.blocks.map(block => [Object.values(block.position).join(','), copy(block)]))
  state.movement = { phase: 'idle', sent: 0 }; state.mining = { phase: 'idle' }
  if (wall) for (let y = 70; y <= 72; y++) for (let z = 19; z <= 23; z++) blocks.set(`-42,${y},${z}`, { known: true, position: { x: -42, y, z }, name: 'minecraft:stone', runtimeId: 1, boundingBox: 'block', extra: [] })
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const raw = Array.from({ length: 36 }, empty)
  for (const item of state.inventory.items) raw[item.slot] = { ...empty(), network_id: item.networkId, count: item.count, has_stack_id: true, stack_id: item.slot === 0 ? 3 : 2 }
  const crafting = { rawItem: slot => copy(raw[slot]), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: state.inventory.items.map(item => ({ ...item, stackId: item.slot === 0 ? 3 : 2 })), openContainer: state.crafting.openContainer }), applyPacket () {} }
  const packets = [], transactions = [], calls = []; let running = false, time = Date.parse(captured.observedAt)
  const input = { stats: () => ({ running, target: null }), start: () => { running = true }, stop: () => { running = false }, lookAt () {}, sendTransaction: (packet, options) => { transactions.push(copy(packet)); options?.onSent?.() } }
  const interactions = createInteractions({ client: { queue: (name, packet) => packets.push({ name, packet }) }, getState: () => state, world, crafting, getInput: () => input, timeoutMs: 1000 })
  t.after(() => interactions.cancel('Test cleanup'))
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body: copy(body) })
    if (endpoint === '/status') return copy(state)
    if (endpoint.startsWith('/blocks?')) { assert.equal(new URL(endpoint, 'http://offline').searchParams.get('radius'), '3'); return { blocks: [...blocks.values()].map(copy) } }
    if (endpoint === '/move/preview') return { ready: true, waypoints: [{ position: body.target, medium: 'land', action: 'walk' }] }
    if (endpoint === '/move/start') {
      state.position = { ...body.target, y: body.target.y + 1.62 }; state.rawServerPosition = copy(state.position); state.predicted = null; state.positionSource = 'server_post_move'; state.positionUpdatedAt = ++time; state.rawServerPositionUpdatedAt = time; state.movement = { phase: 'awaiting_server_confirmation', sent: 1, predictedPosition: copy(state.position) }
      return copy(state.movement)
    }
    if (endpoint === '/move/stop') return { phase: 'stopped' }
    if (endpoint === '/blocks/use') {
      const opened = interactions.openCraftingTable(body.position)
      setImmediate(() => { state.crafting.openContainer = { type: 'workbench' }; interactions.applyPacket('container_open', { window_id: 7, window_type: 'workbench', coordinates: table }) })
      return opened
    }
    if (endpoint === '/craft/open') { state.crafting.openContainer ??= { type: 'inventory' }; return state.crafting.openContainer }
    if (endpoint === '/craft/close') { state.crafting.openContainer = null; return {} }
    if (endpoint === '/craft/preview') return { ready: state.crafting.openContainer?.type === 'workbench', needsCraftingTable: state.crafting.openContainer?.type !== 'workbench', output: { name: 'minecraft:wooden_sword', count: 1 } }
    if (endpoint === '/craft/start') { state.inventory.items = [{ slot: 0, name: 'minecraft:stick', count: 3 }, { slot: 1, name: 'minecraft:wooden_sword', count: 1 }]; return { phase: 'completed' } }
    throw new Error('Unexpected fixture request: ' + endpoint)
  }
  const runner = createRunner({ request, now: () => time, delay: async ms => { time += ms }, pollIntervalMs: 20, timeoutMs: 1000 })
  return { state, blocks, world, interactions, transactions, packets, calls, request, runner, access: () => planStationAccess({ state, target: table, blocks: [...blocks.values()] }) }
}

test('actual forest table has a real visible top corner despite its blocked center ray; normal open waits for the server', async t => {
  const f = fixture(t), before = copy(f.state.inventory)
  const preview = f.interactions.previewOpenCraftingTable(table)
  assert.equal(preview.ready, true, preview.errors)
  assert.equal(preview.face, 1)
  assert.equal(f.transactions.length, 0)
  assert.equal(f.access().ready, true)
  const opened = f.interactions.openCraftingTable(table)
  assert.equal(f.interactions.snapshot().pendingOperation, 'open')
  assert.equal(f.transactions[0].data.block_runtime_id, 1752181952)
  assert.equal(f.transactions[0].data.face, 1)
  f.interactions.applyPacket('container_open', { window_id: 7, window_type: 'workbench', coordinates: table })
  assert.equal((await opened).confirmedBy, 'server_container_open')
  assert.deepEqual(f.state.inventory, before)
})

test('blocked all-face access selects a full safe stance, Runner uses normal live movement then reobserves, opens and crafts', async t => {
  const f = fixture(t, true), access = f.access()
  assert.equal(f.interactions.previewOpenCraftingTable(table).ready, false)
  assert.equal(access.ready, false)
  assert.deepEqual(access.standpoint, { x: -40.5, y: 70, z: 20.5 })
  const observations = { state: copy(f.state), blocks: [...f.blocks.values()], capabilities: { move: true, movement: true, craft: true, use_table: true, scan_blocks: true }, crafting: { previews: { 'minecraft:wooden_sword': { ready: false, needsCraftingTable: true } } } }
  const planned = nextSurvivalAction(f.state, observations, { firstWoodenSwordOnly: true })
  assert.equal(planned.type, 'move_to')
  assert.deepEqual(planned.interactionTarget, table)
  await f.runner.refreshState()
  const opened = await f.runner.actions.open_crafting_table({ target: table, interactionScope: treeAccessScope(f.state) }, { observations })
  assert.equal(opened.confirmedBy, 'server_container_open')
  assert.equal(f.calls.filter(call => call.endpoint === '/move/start').length, 1)
  assert.equal(f.calls.filter(call => call.endpoint === '/blocks/use').length, 1)
  assert.ok(f.calls.filter(call => call.endpoint.startsWith('/blocks?')).length >= 2)
  const crafted = await f.runner.actions.craft({ output: 'minecraft:wooden_sword', times: 1 }, { observations })
  assert.equal(crafted.confirmedBy, 'server_inventory')
  assert.equal(f.state.inventory.items.find(item => item.name === 'minecraft:wooden_sword').count, 1)
})

test('unknown or non-table target and a reused life cannot authorize an open or a successful old acknowledgement', async t => {
  for (const name of [null, 'minecraft:stone']) {
    const f = fixture(t); f.blocks.set('-41,70,21', name ? { ...f.blocks.get('-41,70,21'), name } : { known: false, position: table })
    assert.equal(f.access().ready, false)
    assert.equal(f.interactions.previewOpenCraftingTable(table).ready, false)
    assert.throws(() => f.interactions.openCraftingTable(table))
    assert.equal(f.transactions.length, 0)
  }
  const f = fixture(t), scope = treeAccessScope(f.state), oldState = copy(f.state)
  f.state.lifecycle.deathId++
  assert.equal(planStationAccess({ state: f.state, observedState: oldState, target: table, blocks: [...f.blocks.values()], expectedScope: scope }).reason, 'station_scope_changed')
  await f.runner.refreshState()
  await assert.rejects(f.runner.actions.open_crafting_table({ target: table, interactionScope: scope }, {}), error => error.code === 'STALE_SESSION')
  assert.equal(f.transactions.length, 0)
  const g = fixture(t), pending = g.interactions.openCraftingTable(table)
  g.state.lifecycle.deathId++
  g.interactions.applyPacket('container_open', { window_id: 7, window_type: 'workbench', coordinates: table })
  await assert.rejects(pending, /life/)
  assert.equal(g.interactions.snapshot().lastResult.phase, 'failed')
})
