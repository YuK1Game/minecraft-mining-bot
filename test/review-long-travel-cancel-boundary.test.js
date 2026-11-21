'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLongTravel } = require('../src/travel/long-travel')
const { createLongTravelRuntime } = require('../src/runtime/long-travel-runtime')

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const state = () => ({ phase: 'spawned', health: 20, position: { x: 0.5, y: 65.62, z: 0.5 } })

for (const found of [null, { x: 10.5, y: 64, z: 0.5 }]) test(`cancelling a pending relay search starts no later walk or chunk (${found ? 'found' : 'no point'})`, async () => {
  const entered = deferred(), point = deferred(), starts = []
  const travel = createLongTravel({
    getState: state,
    chunkTravel: { start: async () => { starts.push('chunk') }, status: () => ({ busy: false }), cancel: async () => {} },
    findPoint: async () => { entered.resolve(); return point.promise },
    walkTo: async () => { starts.push('walk'); return { ok: true } }, sleep: async () => {}
  })
  travel.start({ destination: { x: 100, z: 0 } })
  await entered.promise
  const stopping = travel.cancel()
  point.resolve(found)
  await stopping
  assert.deepEqual(starts, [])
  assert.equal(travel.status().phase, 'cancelled')
})

test('cancelling a pending terrain request does not start the next chunk leg', async () => {
  const entered = deferred(), terrain = deferred(), starts = []
  const travel = createLongTravel({ getState: state,
    requestTerrain: async () => { entered.resolve(); return terrain.promise },
    chunkTravel: { start: async () => { starts.push('chunk') }, status: () => ({ busy: false }), cancel: async () => {} }
  })
  travel.start({ destination: { x: 100, z: 0 } })
  await entered.promise
  const stopping = travel.cancel(); terrain.resolve()
  await stopping
  assert.deepEqual(starts, [])
})

function runtimeScene () {
  let ports
  const starts = [], equip = deferred(), entered = deferred()
  const current = { ...state(), inventory: { items: [{ name: 'minecraft:stone_pickaxe', slot: 0, count: 1 }] } }
  const rt = {
    host: { shared: {}, world: { getBlock: () => ({ known: true, name: 'minecraft:stone', boundingBox: 'block' }) }, log: () => {} },
    require: name => name === './travel/long-travel' ? { createLongTravel: options => { ports = options; return { status: () => ({ busy: false }) } } } : name.startsWith('node:') ? require(name) : require('../src/' + name.replace(/^\.\//, '')), working: () => current, raw: () => current,
    createChunkTravel: () => ({}), requireIdle: () => {}, startMotion: () => starts.push('move'),
    inventory: { equipForMining: async () => { entered.resolve(); await equip.promise } },
    operations: { mining: { start: () => starts.push('mine') } }
  }
  createLongTravelRuntime(rt).ensureLongTravel()
  return { ports, starts, equip, entered }
}

test('the runtime relay executor rejects cancellation before mining or movement starts', async () => {
  const f = runtimeScene(), controller = new AbortController(); controller.abort()
  for (const dig of [undefined, [{ x: 1, y: 64, z: 0, name: 'minecraft:stone' }]]) {
    const result = await f.ports.walkTo({ x: 1.5, y: 64, z: 0.5, dig }, { signal: controller.signal })
    assert.equal(result.code, 'LONG_TRAVEL_CANCELLED')
  }
  assert.deepEqual(f.starts, [])
})

test('the runtime relay executor rechecks cancellation after equipping and before mining', async () => {
  const f = runtimeScene(), controller = new AbortController()
  const moving = f.ports.walkTo({ x: 1.5, y: 64, z: 0.5, dig: [{ x: 1, y: 64, z: 0, name: 'minecraft:stone' }] }, { signal: controller.signal })
  await f.entered.promise; controller.abort(); f.equip.resolve()
  assert.equal((await moving).code, 'LONG_TRAVEL_CANCELLED')
  assert.deepEqual(f.starts, [])
})
