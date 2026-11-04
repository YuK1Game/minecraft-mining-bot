'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeActions } = require('../src/runner')
const { soilCandidates } = require('../src/soil-gathering')
const copy = value => structuredClone(value)
const key = point => `${point.x},${point.y},${point.z}`
const block = (x, y, z, name) => ({ known: true, position: { x, y, z }, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })

function fixture (mode = 'drop') {
  let time = 0; let stamp = 0; let scans = 0
  const calls = []
  const state = { phase: 'spawned', profile: 'bot', realm: { id: 'offline' }, connectionId: 'session', startedAt: 'session', dimension: 'overworld', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 0, inventory: { known: true, items: [] }, entities: [], droppedItems: [], mining: { phase: 'idle' }, movement: { phase: 'idle' } }
  const map = new Map()
  for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) for (let y = 62; y <= 68; y++) map.set(key({ x, y, z }), block(x, y, z, y === 64 ? 'grass_block' : y < 64 ? 'stone' : 'air'))
  if (mode === 'far') for (const value of map.values()) if (value.position.y === 64 && !(value.position.x >= 4 && value.position.x <= 6 && Math.abs(value.position.z) <= 1)) value.name = 'minecraft:stone'
  const addDirt = () => { const dirt = state.inventory.items.find(item => item.name === 'minecraft:dirt'); if (dirt) dirt.count++; else state.inventory.items.push({ slot: 0, name: 'minecraft:dirt', count: 1 }) }
  const request = async (method, path, body, { signal } = {}) => {
    if (signal?.aborted) throw signal.reason
    calls.push({ method, path, body: copy(body) })
    if (path === '/mining/preview') return { ready: true, targets: body.targets.map(target => copy(map.get(key(target)))) }
    if (path === '/mining/start') {
      const target = body.targets[0]
      state.mining = { phase: 'completed' }
      if (mode !== 'keep_block') map.set(key(target), block(target.x, target.y, target.z, 'air'))
      if (mode === 'auto' || mode === 'keep_block') addDirt()
      else if (mode !== 'no_drop' && mode !== 'uncertain') state.droppedItems.push({ entityId: `drop-${calls.length}`, known: true, name: 'minecraft:dirt', count: 1, position: { x: target.x + 0.5, y: target.y + 0.125, z: target.z + 0.5 } })
      if (mode === 'uncertain') state.inventory.known = false
      if (mode === 'session') state.realm.id = 'other_world'
      if (mode === 'damage') state.health = 19
      return state.mining
    }
    if (path.startsWith('/blocks?')) {
      const query = new URL(path, 'http://offline').searchParams
      return { blocks: [copy(map.get(`${query.get('x')},${query.get('y')},${query.get('z')}`))] }
    }
    if (path === '/move/preview') return { ready: true, waypoints: [{ position: copy(body.target), medium: 'land', action: 'walk' }] }
    if (path === '/move/start') {
      state.position = { ...copy(body.target), y: body.target.y + 1.62 }; state.positionSource = 'client_prediction'; state.positionUpdatedAt = ++stamp
      state.predicted = { physicsState: { position: copy(body.target), onGround: true, velocity: { x: 0, y: -0.0784, z: 0 } } }
      state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: copy(state.position), onGround: true }
      if (state.droppedItems.length) { state.droppedItems = []; if (mode !== 'vanish') addDirt() }
      return state.movement
    }
    if (path === '/move/stop') { state.movement.phase = 'stopped'; return state.movement }
    if (path === '/mining/stop') { state.mining.phase = 'stopped'; return state.mining }
    throw new Error(`Unexpected offline request ${path}`)
  }
  const observe = async () => { scans++; if (mode === 'already_picked_up' && scans === 1) { addDirt(); addDirt() }; return copy({ state, blocks: [...map.values()], drops: state.droppedItems }) }
  const actions = makeActions({ request, refreshState: async () => copy(state), getState: () => copy(state), observe, timeoutMs: 100, pollIntervalMs: 10, now: () => time, delay: async ms => { time += ms } })
  return { actions, state, map, calls, scans: () => scans }
}

test('one safe soil break uses received air, a received drop, safe pickup movement and actual dirt inventory', async () => {
  const f = fixture()
  const result = await f.actions.gather_dirt({ count: 1 })
  assert.equal(result.collected, true)
  assert.equal(result.count, 1)
  assert.equal(result.blocksBroken, 1)
  assert.equal(result.confirmedBy, 'server_inventory_and_block_update')
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.requiresObservation, true)
  assert.equal(f.state.inventory.items.find(item => item.name === 'minecraft:dirt').count, 1)
  assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 1)
  assert.ok(f.calls.some(call => call.path === '/move/start'), 'the received dirt below the bank is reached using the existing pickup planner')
  assert.ok(f.scans() >= 4)
})

test('two requested dirt items stop at two real mines and preserve fresh-observation semantics', async () => {
  const f = fixture('auto')
  const result = await f.actions.gather_soil({ count: 2 })
  assert.equal(result.count, 2)
  assert.equal(result.complete, true)
  assert.equal(result.blocksBroken, 2)
  assert.equal(result.collected, true)
  assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 2)
  assert.ok(f.scans() >= 7)
  const targets = f.calls.filter(call => call.path === '/mining/start').map(call => call.body.targets[0])
  assert.ok(targets.every(target => Math.max(Math.abs(target.x), Math.abs(target.z)) >= 3), 'current footprint and its support neighbourhood remain untouched')
  const prior = fixture('already_picked_up')
  const changed = await prior.actions.gather_dirt({ count: 2 })
  assert.equal(changed.count, 2)
  assert.equal(changed.collected, false, 'unrelated real inventory progress does not invent a break-and-pickup receipt')
  assert.equal(changed.blocksBroken, 0)
  assert.equal(changed.requiresObservation, true)
  assert.equal(prior.calls.filter(call => call.path === '/mining/start').length, 0)
})

test('completed mining, disappearing drops and uncertain inventory cannot fabricate collected dirt', async () => {
  for (const [mode, code] of [['keep_block', 'BLOCK_NOT_CONFIRMED'], ['no_drop', 'PICKUP_NOT_CONFIRMED'], ['vanish', 'PICKUP_NOT_CONFIRMED'], ['uncertain', 'INVENTORY_UNKNOWN'], ['session', 'STALE_SESSION'], ['damage', 'TOOK_DAMAGE']]) {
    const f = fixture(mode)
    await assert.rejects(f.actions.gather_dirt({ count: 1 }), error => error.code === code, mode)
    assert.equal(f.calls.filter(call => call.path === '/mining/start').length, 1, mode)
  }
  for (const count of [0, 3, 1.5]) {
    const f = fixture()
    await assert.rejects(f.actions.gather_dirt({ count }), error => error.code === 'INVALID_SOIL_REQUEST')
    assert.equal(f.calls.length, 0)
  }
  const aborted = fixture()
  const controller = new AbortController(); controller.abort(new Error('Cancelled dirt work'))
  await assert.rejects(aborted.actions.gather_dirt({ count: 1 }, { signal: controller.signal }), /Cancelled dirt work/)
  assert.equal(aborted.calls.length, 0)
})

test('an out-of-reach natural patch requires a known supported approach before live mining', async () => {
  const f = fixture('far')
  const result = await f.actions.gather_dirt({ count: 1 })
  assert.equal(result.count, 1)
  const firstMove = f.calls.findIndex(call => call.path === '/move/start')
  const firstMine = f.calls.findIndex(call => call.path === '/mining/start')
  assert.ok(firstMove >= 0 && firstMove < firstMine)
  assert.equal(f.calls[firstMove].body.options.allowWater, false)
  assert.equal(f.calls[firstMove].body.target.y, 65)
  assert.ok(f.calls[firstMine].body.targets[0].x >= 4)
})

test('soil selection excludes base geometry, protected cells, support, unknown neighbours, liquids and gravity overhead', () => {
  const target = { x: 3, y: 64, z: 0 }
  const state = { position: { x: 0.5, y: 66.62, z: 0.5 } }
  const patch = () => {
    const map = new Map()
    for (let x = 2; x <= 4; x++) for (let z = -1; z <= 1; z++) for (let y = 63; y <= 67; y++) map.set(key({ x, y, z }), block(x, y, z, y === 64 ? 'grass_block' : y < 64 ? 'stone' : 'air'))
    return map
  }
  assert.equal(soilCandidates(state, { blocks: [...patch().values()] }).length, 1)
  for (const mode of ['protected', 'owned', 'not_natural', 'coarse', 'waterlogged', 'unknown', 'water', 'gravity', 'head', 'explicit', 'hut', 'preserved', 'support']) {
    const map = patch(); const value = map.get(key(target)); let options = {}; let current = state
    if (mode === 'protected') value.protected = true
    if (mode === 'owned') value.owned = true
    if (mode === 'not_natural') value.natural = false
    if (mode === 'coarse') value.name = 'minecraft:coarse_dirt'
    if (mode === 'waterlogged') value.extra = [{ name: 'minecraft:water' }]
    if (mode === 'unknown') map.set('2,64,0', { known: false, position: { x: 2, y: 64, z: 0 } })
    if (mode === 'water') map.set('2,64,0', block(2, 64, 0, 'water'))
    if (mode === 'gravity') map.set('3,65,0', block(3, 65, 0, 'sand'))
    if (mode === 'head') map.set('3,67,0', block(3, 67, 0, 'stone'))
    if (mode === 'explicit') options = { excludedPositions: [target] }
    if (mode === 'hut') options = { sites: [{ type: 'soil_hut', center: { x: 3, y: 65, z: 0 } }] }
    if (mode === 'preserved') options = { sites: [{ preserved: { floor: [{ position: target }] } }] }
    if (mode === 'support') current = { position: { x: 3.5, y: 66.62, z: 0.5 } }
    assert.equal(soilCandidates(current, { blocks: [...map.values()] }, options).length, 0, mode)
  }
})
