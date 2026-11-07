'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')

function fixture ({ ready = () => false } = {}) {
  const state = { position: { x: 0.5, y: 1.62, z: 0.5 } }
  const movement = { phase: 'idle', running: false }; const mining = { phase: 'idle' }
  const probes = []; const actions = []
  const adapter = createQuarryRuntimeAdapter({ getState: () => structuredClone(state), getBlock: () => ({ known: true }), entities: () => [],
    movement: { preview: () => { actions.push('legacy-preview'); return { ready: false } }, start: () => actions.push('start'), stop: () => actions.push('stop') }, getMovement: () => structuredClone(movement),
    previewStorageRoute: async (target, options) => { probes.push({ target, options }); return { ready: ready(target), reason: 'NO_ROUTE' } },
    mining: {}, getMining: () => structuredClone(mining), equip: () => actions.push('equip'), placeQuarry: () => actions.push('place'), eat: () => actions.push('eat'), chest: {}, stopAll: () => actions.push('stop-all'), combatActive: () => false })
  const path = Array.from({ length: 9 }, (_, x) => ({ x, y: 0, z: 0 }))
  const storage = { position: { x: 9, y: 0, z: 0 }, stand: { x: 8, y: 0, z: 0 } }
  return { adapter, state, movement, mining, probes, actions, path, storage }
}

test('an unavailable native first segment is bounded6/3/1 and never acquires or changes an action owner', async () => {
  const f = fixture(); const before = structuredClone({ state: f.state, movement: f.movement, mining: f.mining })
  const r = await f.adapter.previewStorage(f.storage, { path: f.path, travel: () => true })
  assert.equal(r.ready, false)
  assert.equal(r.reason, 'NO_ROUTE')
  assert.deepEqual(f.probes.map(p => p.target.x), [6.5, 3.5, 1.5])
  assert.ok(f.probes.every(p => p.options.allowWater === false))
  assert.deepEqual(f.actions, [], 'the normal preview wrapper and all game actions stay untouched')
  assert.deepEqual({ state: f.state, movement: f.movement, mining: f.mining }, before)
})

test('a ready shorter segment is only a prediction, with actual movement left for the later revalidation', async () => {
  const f = fixture({ ready: target => target.x === 3.5 })
  const r = await f.adapter.previewStorage(f.storage, { path: f.path, travel: () => true })
  assert.equal(r.ready, true)
  assert.equal(r.serverConfirmed, false)
  assert.equal(r.predictionOnly, true)
  assert.equal(r.segmentCells, 3)
  assert.deepEqual(f.probes.map(p => p.target.x), [6.5, 3.5])
  assert.deepEqual(f.actions, [])
})

test('unpermitted, wrong-goal or excessive paths are rejected without a native preview', async () => {
  for (const mode of ['unpermitted', 'wrong_goal', 'excessive']) {
    const f = fixture()
    const path = mode === 'wrong_goal' ? f.path.slice(0, -1) : mode === 'excessive' ? Array.from({ length: 24001 }, () => f.storage.stand) : f.path
    const r = await f.adapter.previewStorage(f.storage, { path, travel: p => mode !== 'unpermitted' || p.x !== 3 })
    assert.equal(r.ready, false)
    assert.equal(r.reason, 'STORAGE_PATH_NOT_PERMITTED')
    assert.equal(f.probes.length, 0)
    assert.deepEqual(f.actions, [])
  }
})

test('an active mining or movement owner returns typed BUSY without stopping it', async () => {
  for (const mode of ['movement', 'mining']) {
    const f = fixture()
    if (mode === 'movement') { f.movement.phase = 'moving'; f.movement.running = true } else f.mining.phase = 'mining'
    await assert.rejects(f.adapter.previewStorage(f.storage, { path: f.path }), e => e.code === 'BUSY')
    assert.equal(f.probes.length, 0)
    assert.deepEqual(f.actions, [])
    assert.equal(mode === 'movement' ? f.movement.phase : f.mining.phase, mode === 'movement' ? 'moving' : 'mining')
  }
})

test('a changed origin during a pure preview is transient BUSY, not an unreachable chest result', async () => {
  let f
  f = fixture({ ready: () => { f.state.position.x += 1; return true } })
  await assert.rejects(f.adapter.previewStorage(f.storage, { path: f.path }), e => e.code === 'BUSY')
  assert.deepEqual(f.actions, [])
})

test('an already-reached permitted storage stance needs no native preview and sends nothing', async () => {
  const f = fixture(); f.state.position = { x: 8.5, y: 1.62, z: 0.5 }
  const r = await f.adapter.previewStorage(f.storage, { path: [f.storage.stand], travel: () => true })
  assert.equal(r.ready, true)
  assert.equal(r.serverConfirmed, false)
  assert.equal(f.probes.length, 0)
  assert.deepEqual(f.actions, [])
})
