'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vm = require('node:vm')
const { setImmediate: turn } = require('node:timers/promises')
const { createInput } = require('../src/input')
const { createInputHistory } = require('../src/input-history')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMeleeCombat } = require('../src/melee-combat')
const copy = value => structuredClone(value)
const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }) }
const prepared = createPhysics({ world, version: '1.26.60', allowWater: true })

const filename = path.join(__dirname, 'runtime-user-behaviors.test.js')
let source = 'let testHooks;\n' + fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace(/^    '\.\/physics': .+$/m, "    './physics': { createPhysics: options => testHooks.physics(options) }, './navigation': { createNavigator: options => testHooks.navigator(options) }, './movement': { createMovement: options => { wireMovementOptions.push(options); return mockMovement } },")
source = source.replace(/^    '\.\/input': .+$/m, "    './input': { createInput: options => { wireInputOptions.push(options); return testHooks.input(options) } },")
source = source.replace(/^    '\.\/input-history': .+$/m, "    './input-history': { createInputHistory: options => testHooks.history(options) },")
source = source.replace("loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", "loaded._compile(testHooks.instrument(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')), filename)")
source += '\nmodule.exports = { scene, setHooks: value => { testHooks = value } }'
const loaded = { exports: {} }
new vm.Script(Module.wrap(source), { filename }).runInThisContext()(loaded.exports, Module.createRequire(filename), loaded, filename, path.dirname(filename))

function fixture (t, { legacy = false } = {}) {
  let elapsed = 0, actualInput
  const epoch = Date.parse('2026-11-02T00:00:00Z'), frames = []
  t.mock.method(Date, 'now', () => epoch + elapsed)
  t.mock.method(performance, 'now', () => elapsed)
  const hooks = {
    physics: options => prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }),
    navigator: options => createNavigator({ ...options, physics: options.physics ?? prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }) }),
    history: createInputHistory,
    input: options => {
      actualInput = createInput({ ...options, clock: () => elapsed, startGameReceivedAt: 0, onQueuedFrame: frame => { frames.push(copy(frame)); options.onQueuedFrame?.(frame) } })
      return actualInput
    },
    instrument: runtimeSource => {
      const line = "      if (lease.kind === 'combat') startIdle()"
      assert.ok(runtimeSource.includes(line), 'Run against the staged combat-neutral Runtime')
      // The old control removes exactly the proposed timer-start statement.
      return legacy ? runtimeSource.replace(line, '') : runtimeSource
    }
  }
  loaded.exports.setHooks(hooks)
  const f = loaded.exports.scene(t)
  f.raw.positionUpdatedAt = new Date(epoch).toISOString()
  f.host.setPrediction = prediction => { f.shared.prediction = { ...copy(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date(Date.now()).toISOString() } }
  f.host.getState = () => ({ ...copy(f.raw), rawServerPosition: copy(f.raw.position), rawServerPositionUpdatedAt: f.raw.positionUpdatedAt, ...(f.shared.prediction ? { position: copy(f.shared.prediction.position), predicted: copy(f.shared.prediction), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: f.shared.prediction.updatedAt } : {}) })
  const advance = async ms => {
    for (let remaining = ms; remaining > 0;) { const step = Math.min(25, remaining); elapsed += step; f.advance(step); remaining -= step; await turn() }
  }
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, positionSource: 'move_entity', dimension: 'overworld', position: { x: 2.2, y: 65, z: 0.5 } }
  f.actors.push(target)
  // Controlled in-memory received inventory, not a Realm inventory receipt.
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  const slots = Array.from({ length: 36 }, empty)
  const sword = { ...empty(), network_id: 301, count: 1, has_stack_id: true, stack_id: 40 }
  slots[14] = sword
  f.runtime.applyPacket('item_registry', { itemstates: [{ runtime_id: 301, name: 'minecraft:wooden_sword' }] })
  f.runtime.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  const publishInventory = () => { f.raw.inventory = { known: true, items: copy(f.facadeOptions.crafting.snapshot().inventory) } }
  publishInventory()
  const context = kind => ({ kind, claimId: `${kind}:neutral-clock`, scope: f.scope(), ...(kind === 'combat' ? { target: copy(target) } : {}) })
  let equipCalls = 0
  const melee = createMeleeCombat({ client: f.host.client, world: f.host.world, entities: f.host.entities, crafting: f.facadeOptions.crafting,
    getState: f.facadeOptions.getState, getRawState: f.facadeOptions.getRawState, getInput: f.facadeOptions.getInput,
    equip: async slot => {
      equipCalls++
      assert.equal(slot, 14)
      await advance(350)
      // A controlled normal server inventory response after the equip delay.
      f.runtime.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: sword })
      f.runtime.applyPacket('inventory_slot', { window_id: 'inventory', slot: 14, item: empty() })
      publishInventory()
      return { serverConfirmed: true }
    }, isBusy: () => false, now: () => elapsed, wallNow: Date.now, sleep: advance })
  const passive = createMeleeCombat({ client: f.host.client, world: f.host.world, entities: f.host.entities, crafting: f.facadeOptions.crafting, getState: f.facadeOptions.getState, getRawState: f.facadeOptions.getRawState, getInput: f.facadeOptions.getInput, equip: async () => assert.fail('Passive preview cannot equip'), isBusy: () => false, now: () => elapsed, wallNow: Date.now })
  t.after(() => actualInput.stop(false))
  return { ...f, frames, melee, passive, advance, context, elapsed: () => elapsed, equipCalls: () => equipCalls, actualInput: () => actualInput, seedQueuedModel: () => { f.facadeOptions.getInput().start(); assert.equal(frames.length, 1); assert.equal(frames[0].modeled, true); assert.equal(frames[0].receiptConfirmed, true) } }
}

async function delayedCombat (f, { resumedFirst = false } = {}) {
  f.seedQueuedModel()
  if (resumedFirst) await f.runtime.resumeRequested()
  const ctx = f.context('combat'), token = await f.facadeOptions.acquireControl(ctx)
  assert.notEqual(token.acquired, false)
  // Reproduce resumeRequested returning early while this actual Root lease is held.
  await f.runtime.resumeRequested()
  const before = f.frames.length
  const result = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  return { ctx, token, before, result, preview: f.passive.preview('70'), snapshot: f.runtime.snapshot() }
}

test('old Runtime with an already started idle timer keeps actual neutral input and a fresh pose during350ms equip', async t => {
  const f = fixture(t, { legacy: true }), r = await delayedCombat(f, { resumedFirst: true })
  assert.equal(f.equipCalls(), 1)
  assert.equal(r.snapshot.idle.enabled, true)
  assert.ok(f.frames.length - r.before >= 7)
  assert.equal(r.result.hitsRequested, 1, JSON.stringify(r.result))
  assert.equal(r.result.serverConfirmed, false)
  assert.equal(r.preview.ready, true, JSON.stringify(r.preview))
  assert.ok(r.preview.currentPose.ageMs <= 50)
  await f.facadeOptions.resumeControl({ ...r.ctx, token: r.token })
})

test('old early combat acquisition before first resume leaves the model stale and rejects after actual equip delay', async t => {
  const f = fixture(t, { legacy: true }), r = await delayedCombat(f)
  assert.equal(f.equipCalls(), 1)
  assert.equal(r.snapshot.idle.enabled, false)
  assert.equal(f.frames.length, r.before)
  assert.equal(r.result.code, 'POSE_UNTRUSTED')
  assert.equal(r.result.hitsRequested, 0)
  assert.equal(r.preview.code, 'POSE_UNTRUSTED')
  assert.equal(f.wire.filter(p => p.name === 'inventory_transaction').length, 0)
  await f.facadeOptions.resumeControl({ ...r.ctx, token: r.token })
})

test('combat acquisition starts the missing idle timer and maintains real queued Native poses through delayed equip', async t => {
  const f = fixture(t), r = await delayedCombat(f)
  assert.equal(f.equipCalls(), 1)
  assert.equal(r.snapshot.idle.enabled, true)
  assert.ok(f.frames.length - r.before >= 7)
  assert.equal(r.result.hitsRequested, 1, JSON.stringify(r.result))
  assert.equal(r.preview.ready, true, JSON.stringify(r.preview))
  assert.ok(r.preview.currentPose.ageMs <= 50)
  const ticks = f.wire.filter(p => p.name === 'player_auth_input').map(p => BigInt(p.p.tick))
  assert.ok(ticks.length >= 8)
  for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i], ticks[i - 1] + 1n)
  assert.ok(f.frames.every(frame => frame.modeled && frame.receiptConfirmed))
  assert.equal(r.result.serverConfirmed, false)
  assert.equal(r.result.attempts[0].hitConfirmed, false)
  assert.equal(r.snapshot.input.running, false, 'The idle wrapper does not pretend to own an active task')
  assert.equal(r.snapshot.input.streamRunning, true, 'The actual neutral sender remains running')
  await f.facadeOptions.resumeControl({ ...r.ctx, token: r.token })
})

test('the combat-only timer start does not start an early bed lease, and actual sleep stops a running stream', async t => {
  const f = fixture(t)
  f.seedQueuedModel()
  const ctx = f.context('bed'), token = await f.facadeOptions.acquireControl(ctx)
  assert.notEqual(token.acquired, false)
  await f.runtime.resumeRequested()
  const before = f.frames.length
  await f.advance(350)
  assert.equal(f.runtime.snapshot().idle.enabled, false)
  assert.equal(f.frames.length, before)
  await f.facadeOptions.resumeControl({ ...ctx, token })
  await f.runtime.resumeRequested()
  await f.advance(100)
  assert.equal(f.runtime.snapshot().input.streamRunning, true)
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'player_flags', value: 2 }] })
  const sleepingFrames = f.frames.length
  await f.advance(350)
  assert.equal(f.runtime.snapshot().input.streamRunning, false)
  assert.equal(f.frames.length, sleepingFrames)
})
