'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createRunner } = require('../src/runner')
const { createInteractions } = require('../src/interactions')
const { createPhysics } = require('../src/physics')
const { createMovement } = require('../src/movement')
const { planStationAccess, treeAccessScope } = require('../src/action-access')
const { nextDiamondAction } = require('../src/diamond-planner')
const capture = require('./fixtures/table-access-lower-stance.json')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
let prepared = null

function fixture (t, { factory = createRunner, unknownFloor = false, changeAtStance = null } = {}) {
  const state = copy(capture.state), pages = capture.pages.map(page => copy(page.data.blocks))
  state.entities = [] // Actor policy is independent; the actual watch had no threats.
  if (unknownFloor) pages[1] = pages[1].map(b => key(b.position) === '-33,65,52' ? { known: false, position: b.position } : b)
  const blocks = new Map(pages.flat().map(b => [key(b.position), b]))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } } }
  prepared ??= createPhysics({ world, version: '1.26.60' })
  const physics = prepared.withWorld(world)
  const wire = [], equipment = [], uses = [], calls = [], previews = []; let running = false, now = Date.parse(capture.capturedAt)
  const rawItem = slot => { const item = state.inventory.items.find(item => item.slot === slot), desc = state.crafting.inventory.find(item => item.slot === slot); return item ? { ...empty(), network_id: item.networkId, count: item.count, metadata: item.metadata, has_stack_id: true, stack_id: desc.stackId } : empty() }
  const crafting = { rawItem, snapshot: () => ({ ...copy(state.crafting), authority: true, inventoryKnown: true }), applyPacket () {} }
  const input = { stats: () => ({ running, target: null }), start: () => { running = true }, stop: () => { running = false }, lookAt () {}, sendTransaction: (packet, options) => { wire.push(copy(packet)); options?.onSent?.() } }
  const interactions = createInteractions({ client: { queue: (name, packet) => equipment.push({ name, packet }) }, getState: () => state, world, crafting, getInput: () => input, timeoutMs: 1000 })
  const movement = createMovement({ client: { queue () { assert.fail('No movement inputs are needed or permitted') } }, getState: () => state, world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => 0 })
  t.after(() => interactions.cancel('Fixture cleanup'))
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body: copy(body) })
    if (endpoint === '/status') return copy(state)
    if (endpoint.startsWith('/blocks?')) {
      const url = new URL(endpoint, 'http://offline')
      assert.equal(url.searchParams.get('radius'), '3')
      const center = ['x', 'y', 'z'].map(k => Number(url.searchParams.get(k)))
      if (center.join(',') === key(capture.target)) return { blocks: copy(pages[0]) }
      assert.deepEqual(center, [-33, 66, 52])
      if (changeAtStance === 'life') state.lifecycle.deathId++
      if (changeAtStance === 'health') state.health--
      return { blocks: copy(pages[1]) }
    }
    if (endpoint === '/move/preview') { const preview = movement.preview(body.target, body.options); previews.push({ target: body.target, preview }); return preview }
    if (endpoint === '/move/start') assert.fail('Existing valid current interaction stance must not move')
    if (endpoint === '/action' && body.group === 'movement' && body.method === 'settle') return movement.settle(...body.args)
    if (endpoint === '/move/stop' || endpoint === '/mining/stop' || endpoint === '/craft/close') return {}
    if (endpoint === '/blocks/use') {
      uses.push(copy(body))
      const pending = interactions.openCraftingTable(body.position)
      setImmediate(() => { state.crafting.openContainer = { id: 19, type: 'workbench' }; interactions.applyPacket('container_open', { window_id: 19, window_type: 'workbench', coordinates: capture.target }) })
      return pending
    }
    throw Error('Unexpected fixture request: ' + endpoint)
  }
  const runner = factory({ request, now: () => now, delay: async ms => { now += ms }, timeoutMs: 1000 })
  return { state, pages, blocks, world, interactions, movement, runner, calls, uses, wire, previews }
}

test('actual lower stance is already usable; missing table-page floor alone caused the old Native NO_ROUTE', async t => {
  const f = fixture(t), rawBefore = copy(f.state.rawServerPosition)
  const oldAccess = planStationAccess({ state: f.state, target: capture.target, blocks: f.pages[0] })
  assert.equal(oldAccess.ready, false)
  assert.deepEqual(oldAccess.standpoint, { x: -32.5, y: 68, z: 51.5 })
  const oldPreview = f.movement.preview(oldAccess.standpoint)
  assert.equal(oldPreview.ready, false); assert.equal(oldPreview.reason, 'No safe route found')
  assert.equal(f.interactions.previewOpenCraftingTable(capture.target).ready, true)
  assert.equal(planStationAccess({ state: f.state, target: capture.target, blocks: [...f.blocks.values()] }).ready, true)
  const opened = await f.runner.actions.open_crafting_table({ target: capture.target, interactionScope: treeAccessScope(f.state) }, {})
  assert.equal(opened.confirmedBy, 'server_container_open')
  assert.equal(f.calls.filter(c => c.endpoint.startsWith('/blocks?')).length, 2)
  assert.equal(f.previews.length, 0, 'merged actual stance avoids the unnecessary uphill approach')
  assert.equal(f.uses.length, 1); assert.equal(f.wire.length, 1)
  assert.equal(f.wire[0].data.face, 4)
  assert.equal(f.wire[0].data.block_runtime_id, 1752181952)
  assert.deepEqual(f.state.rawServerPosition, rawBefore)
  const next = nextDiamondAction(f.state, { blocks: [...f.blocks.values()], crafting: { previews: {} }, capabilities: { craft: true } })
  assert.equal(next.type, 'preview_craft'); assert.equal(next.output, 'minecraft:furnace')
  assert.equal(next.serverConfirmed, undefined, 'the furnace itself is still uncrafted')
  if (process.env.RUNNER_BASELINE_SOURCE) {
    const file = path.resolve(__dirname, '../src/runner.js'), old = new Module(file, module)
    old.filename = file; old.paths = Module._nodeModulePaths(path.dirname(file)); old._compile(fs.readFileSync(process.env.RUNNER_BASELINE_SOURCE, 'utf8'), file)
    const negative = fixture(t, { factory: old.exports.createRunner })
    await assert.rejects(negative.runner.actions.open_crafting_table({ target: capture.target }, {}), error => error.code === 'NO_SAFE_ROUTE' && /No known safe standing/.test(error.message))
    assert.equal(negative.uses.length, 0); assert.equal(negative.wire.length, 0)
    assert.equal(negative.calls.filter(c => c.endpoint.startsWith('/blocks?')).length, 1)
  }
})

test('a genuinely unknown current support is never filled in or treated as a ready interaction stance', async t => {
  const f = fixture(t, { unknownFloor: true })
  assert.equal(planStationAccess({ state: f.state, target: capture.target, blocks: [...f.blocks.values()] }).ready, false)
  await assert.rejects(f.runner.actions.open_crafting_table({ target: capture.target }, {}))
  assert.equal(f.uses.length, 0); assert.equal(f.wire.length, 0)
  assert.equal(f.world.getBlock(-33, 65, 52).known, false)
})

test('extra received stance coverage cannot cross a changed life or received damage', async t => {
  for (const [mode, code] of [['life', 'STALE_SESSION'], ['health', 'TOOK_DAMAGE']]) {
    const f = fixture(t, { changeAtStance: mode })
    await assert.rejects(f.runner.actions.open_crafting_table({ target: capture.target }, {}), error => error.code === code)
    assert.equal(f.uses.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.previews.length, 0)
  }
})
