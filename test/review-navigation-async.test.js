'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setImmediate: turn } = require('node:timers/promises')
const { createNavigator } = require('../src/navigation')
const block = name => ({ known: true, name: `minecraft:${name}`, properties: {}, extra: [] })
function fixture ({ trusted = true, override = () => null } = {}) {
  let revision = 0, reads = 0
  const world = { revision: () => revision, getBlock: (x, y, z) => { reads++; return override(x, y, z) ?? block(y < 65 ? 'stone' : 'air') } }
  const navigator = createNavigator({ world, planningDistanceLimit: trusted ? 48 : 24 })
  const initial = navigator.physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' })
  return { navigator, initial, world, changed: () => { revision++ }, reads: () => reads }
}
const detour = (x, y, z) => x === 20 && Math.abs(z) <= 12 && y >= 65 && y < 68 ? block('stone') : null

test('async and synchronous plans drain the same terrain, jump and avoidance checks', async () => {
  for (const override of [() => null, (x, y, z) => x === 2 && z === 0 && y >= 65 && y < 68 ? block('stone') : null,
    x => x >= 1 ? { known: false } : null, (x, y, z) => x === 1 && z === 0 && y === 65 ? block('lava') : null]) {
    const f = fixture({ override }), target = { x: 4.5, y: 65, z: 0.5 }, options = { maxDistance: 8, maxExpanded: 200 }
    assert.deepEqual(await f.navigator.planAsync(f.initial, target, options), f.navigator.plan(f.initial, target, options))
  }
  const f = fixture(), target = { x: 4.5, y: 65, z: 0.5 }, options = { maxDistance: 8, avoidance: [{ id: 'enemy', position: { x: 2.5, y: 66.62, z: 0.5 }, minDistance: 1.5 }] }
  assert.deepEqual(await f.navigator.planAsync(f.initial, target, options), f.navigator.plan(f.initial, target, options))
})

test('the ordinary navigator cannot opt into trusted async planning or larger bounds', async () => {
  const f = fixture({ trusted: false })
  await assert.rejects(f.navigator.planAsync(f.initial, { x: 30.5, y: 65, z: 0.5 }, { maxDistance: 48 }), /trusted 48/)
  assert.equal(f.navigator.plan(f.initial, { x: 30.5, z: 0.5 }, { maxDistance: 48 }).ready, false)
  const trusted = fixture()
  for (const options of [{ maxDistance: 49 }, { maxExpanded: 5001 }]) assert.equal((await trusted.navigator.planAsync(trusted.initial, { x: 2.5, z: 0.5 }, options)).ready, false)
})

test('long trusted plans yield to macrotasks and remain planning-only', async () => {
  const f = fixture({ override: detour }), controller = new AbortController(); let turns = 0, running = true
  const pulse = () => { if (running) { turns++; setImmediate(pulse) } }
  setImmediate(pulse)
  try {
    const result = await f.navigator.planAsync(f.initial, { x: 40.5, y: 65, z: 0.5 }, { maxDistance: 48, maxExpanded: 5000, signal: controller.signal })
    assert.equal(result.ready, true, result.reason); assert.ok(turns > 0)
    assert.equal(result.planningOnly, true); assert.equal(result.serverConfirmed, false)
    assert.throws(() => f.navigator.createStepper(result, f.initial), /planning-only/)
  } finally { running = false }
})

test('trusted async planning cannot retain geometry across turns without a world revision', async () => {
  const f = fixture(); delete f.world.revision
  await assert.rejects(f.navigator.planAsync(f.initial, { x: 4.5, y: 65, z: 0.5 }), /revisioned trusted world/)
  assert.equal(f.navigator.plan(f.initial, { x: 4.5, y: 65, z: 0.5 }).ready, true)
})

test('cancel between slices rejects without reading additional terrain or publishing a late route', async () => {
  const f = fixture({ override: detour }), controller = new AbortController()
  const pending = f.navigator.planAsync(f.initial, { x: 40.5, y: 65, z: 0.5 }, { maxDistance: 48, signal: controller.signal })
  await turn()
  controller.abort(new Error('cancelled by owner'))
  await assert.rejects(pending, /cancelled by owner/)
  const reads = f.reads(); await turn(); assert.equal(f.reads(), reads)
})

test('context and actual world revision changes between slices invalidate cached geometry', async () => {
  for (const mode of ['context', 'world']) {
    const f = fixture({ override: detour }); let valid = true
    const pending = f.navigator.planAsync(f.initial, { x: 40.5, y: 65, z: 0.5 }, { maxDistance: 48, check: () => valid })
    await turn()
    if (mode === 'world') f.changed(); else valid = false
    await assert.rejects(pending, { code: 'NAVIGATION_CONTEXT_CHANGED' })
  }
})

test('concurrent sync and async plans cannot replace one another geometry caches', async () => {
  const f = fixture(), east = { x: 40.5, y: 65, z: 0.5 }, north = { x: 0.5, y: 65, z: -30.5 }
  const first = f.navigator.planAsync(f.initial, east, { maxDistance: 48 })
  const sync = f.navigator.plan(f.initial, { x: 2.5, y: 65, z: 0.5 })
  const second = f.navigator.planAsync(f.initial, north, { maxDistance: 48 })
  const [a, b] = await Promise.all([first, second])
  assert.equal(sync.ready && a.ready && b.ready, true)
  assert.deepEqual(a.target, east); assert.deepEqual(b.target, north)
  assert.equal(f.navigator.verifyOrigin(f.initial), true)
})

test('callers cannot rewrite coordinates or avoidance while an async plan is yielded', async () => {
  const f = fixture(), target = { x: 40.5, y: 65, z: 0.5 }, options = { maxDistance: 48, avoidance: [] }
  const pending = f.navigator.planAsync(f.initial, target, options)
  target.x = -300; f.initial.position.x = -300; options.avoidance.push({ id: 'new', position: { x: 40.5, y: 66.62, z: 0.5 }, minDistance: 64 })
  const result = await pending
  assert.equal(result.ready, true, result.reason); assert.equal(result.target.x, 40.5); assert.deepEqual(result.avoidance, [])
})

test('sync retains its 120ms cap and async retains a separate bounded CPU budget', async t => {
  const f = fixture(); let clock = 0
  t.mock.method(performance, 'now', () => { clock += 121; return clock })
  const sync = f.navigator.plan(f.initial, { x: 40.5, y: 65, z: 0.5 }, { maxDistance: 48 })
  assert.equal(sync.ready, false); assert.match(sync.reason, /trusted planning time limit/)
  clock = 0
  const async = await f.navigator.planAsync(f.initial, { x: 40.5, y: 65, z: 0.5 }, { maxDistance: 48 })
  assert.equal(async.ready, false); assert.match(async.reason, /asynchronous planning time limit/)
  assert.equal(async.planningOnly, true)
})

const terrainFile = path.resolve(__dirname, '..', '.local', 'chunk-move', 'live-terrain.json')
const plansFile = path.resolve(__dirname, '..', '.local', 'chunk-move', 'offline-plans.json')
test('owned captured terrain can be inspected cooperatively without treating a route as game progress', { skip: !fs.existsSync(terrainFile) || !fs.existsSync(plansFile) }, async t => {
  const captured = JSON.parse(fs.readFileSync(terrainFile, 'utf8')), prior = JSON.parse(fs.readFileSync(plansFile, 'utf8'))
  const blocks = new Map(captured.blocks.map(row => [[row.position.x, row.position.y, row.position.z].join(','), row]))
  const world = { revision: () => 1, getBlock: (x, y, z) => blocks.get([x, y, z].join(',')) ?? { known: false } }
  const navigator = createNavigator({ world, allowWater: true, planningDistanceLimit: 48 }), initial = navigator.physics.fromServer(captured.state)
  const outcomes = []
  for (const record of prior.slice(0, 5)) {
    const began = performance.now(), result = await navigator.planAsync(initial, record.target, { maxDistance: 48, maxExpanded: 5000 })
    assert.equal(result.planningOnly, true); assert.equal(result.serverConfirmed, false)
    assert.notEqual(result.reason, 'The trusted planning time limit was reached')
    outcomes.push({ target: record.target, ready: result.ready, reason: result.reason ?? null, expanded: result.expanded ?? null, elapsedMs: Math.round(performance.now() - began) })
    if (result.ready) break
  }
  t.diagnostic(JSON.stringify({ capturedCells: blocks.size, outcomes, gameActions: 0 }))
})
