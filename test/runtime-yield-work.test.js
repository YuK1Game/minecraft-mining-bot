'use strict'

// Real Runtime/public operations, Input, Native physics and input history.
// The logical scheduler/disabled Parent are DI sentinels, not live actions.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), vm = require('node:vm')
const { setImmediate: turn } = require('node:timers/promises')
const { createInput } = require('../src/input')
const { createInputHistory } = require('../src/input-history')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const copy = value => structuredClone(value)
const flat = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, boundingBox: y < 65 ? 'block' : 'empty', properties: {}, extra: [] }) }
const prepared = createPhysics({ world: flat, version: '1.26.60', allowWater: true })
const filename = path.join(__dirname, 'runtime-user-behaviors.test.js')
let source = 'let hooks;\n' + fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('  const overrides = {', "  const overrides = {\n    './depot-mission': { createDepotMission: () => hooks.parent },")
source = source.replace(/^  const mockAutonomy = .+$/m, '  const mockAutonomy = hooks.autonomy')
source = source.replace(/^    '\.\/physics': .+$/m, "    './physics': { createPhysics: options => hooks.physics(options) }, './navigation': { createNavigator: options => hooks.navigator(options) }, './movement': { createMovement: options => { wireMovementOptions.push(options); return mockMovement } },")
source = source.replace(/^    '\.\/input': .+$/m, "    './input': { createInput: options => { wireInputOptions.push(options); return hooks.input(options) } },")
source = source.replace(/^    '\.\/input-history': .+$/m, "    './input-history': { createInputHistory },")
source = source.replace("loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", "loaded._compile(hooks.instrument(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')), filename)")
source = source.replace("    './input-history': { createInputHistory },", "    './input-history': { createInputHistory: hooks.history },")
source += '\nmodule.exports={scene,setHooks:value=>{hooks=value}}'
const loaded = { exports: {} }
new vm.Script(Module.wrap(source), { filename }).runInThisContext()(loaded.exports, Module.createRequire(filename), loaded, filename, path.dirname(filename))

function fixture (t) {
  let elapsed = 0, running = false, stream, f, parentEnabled = false
  const epoch = Date.parse('2026-11-02T02:00:00Z'), starts = [], frames = []
  t.mock.method(Date, 'now', () => epoch + elapsed); t.mock.method(performance, 'now', () => elapsed)
  const snapshot = () => ({ running, busy: false, actionActive: false, progress: copy(f?.shared.autonomyProgress ?? {}) })
  const parent = { snapshot: () => ({ enabled: parentEnabled, busy: false }), isEnabled: () => parentEnabled, isBusy: () => false, resume: async () => parent.snapshot(), start: async () => { parentEnabled = true; return parent.snapshot() }, stop: async () => { parentEnabled = false }, tick: async () => parent.snapshot(), close: async () => {}, interrupt: async () => {}, extra: () => ({}), protectedCells: () => [], isProtected: () => false }
  loaded.exports.setHooks({ parent, history: createInputHistory,
    autonomy: { snapshot, start: options => { starts.push(copy(options)); running = true; return snapshot() }, stop: () => { running = false; return snapshot() }, tick: async () => snapshot() },
    physics: options => prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }), navigator: options => createNavigator({ ...options, physics: options.physics ?? prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }) }),
    input: options => { stream = createInput({ ...options, clock: () => elapsed, startGameReceivedAt: 0, onQueuedFrame: frame => { frames.push(copy(frame)); options.onQueuedFrame?.(frame) } }); return stream },
    instrument: runtimeSource => {
      assert.ok(runtimeSource.includes('yieldWork: async reason =>'))
      const marker = '  const operations = {'
      assert.ok(runtimeSource.includes(marker))
      // Test-only access verifies the REAL Parent dispatcher hold, not a stub.
      return runtimeSource.replace(marker, marker + '\n    __testDispatchDepot: dispatchDepotIntent,')
    }
  })
  f = loaded.exports.scene(t)
  f.shared.autoWanted = true; f.shared.safetyWanted = true; f.shared.userBehaviorsEnabled = true
  f.shared.autonomyProgress = { explorationAttempts: 7, explorationLifeBudget: { deathId: 0, attempts: 7 }, excludedResources: [{ resource: 'logs', position: { x: 4, y: 65, z: 4 } }] }
  f.raw.positionUpdatedAt = new Date(epoch).toISOString()
  f.host.setPrediction = prediction => { f.shared.prediction = { ...copy(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date(Date.now()).toISOString() } }
  f.host.getState = () => ({ ...copy(f.raw), rawServerPosition: copy(f.raw.position), rawServerPositionUpdatedAt: f.raw.positionUpdatedAt, ...(f.shared.prediction ? { position: copy(f.shared.prediction.position), predicted: copy(f.shared.prediction), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: f.shared.prediction.updatedAt } : {}) })
  const advance = async ms => { for (let left = ms; left > 0;) { const step = Math.min(25, left); elapsed += step; f.advance(step); left -= step; await turn() } }
  t.after(() => stream?.stop(false))
  return { ...f, starts, frames, advance, parent }
}

test('public yieldWork holds automatic and Parent restarts while actual neutral input and all protection flags continue', async t => {
  const f = fixture(t)
  await f.runtime.resumeRequested(); await f.advance(100)
  assert.equal(f.starts.length, 1); assert.equal(f.parent.isEnabled(), false)
  const before = f.runtime.snapshot(), flags = [f.shared.autoWanted, f.shared.safetyWanted, f.shared.userBehaviorsEnabled]
  const result = await f.runtime.operations.agent.yieldWork('Controlled operator handoff')
  assert.equal(result.held, true); assert.equal(result.policyUnchanged, true)
  const held = f.shared.legacyWorkHoldScope, startCount = f.starts.length, oldTick = BigInt(before.queuedWireClock.tick)
  await f.runtime.resumeRequested(); await f.advance(125)
  await f.runtime.resumeRequested(); await f.advance(125)
  assert.equal(f.starts.length, startCount); assert.equal(f.shared.legacyWorkHoldScope, held)
  assert.deepEqual([f.shared.autoWanted, f.shared.safetyWanted, f.shared.userBehaviorsEnabled], flags)
  const parentResult = await f.runtime.operations.__testDispatchDepot({ kind: 'observe_inventory' }, { signal: new AbortController().signal, extra: {} })
  assert.deepEqual(parentResult, { phase: 'yielding', owner: 'manual_work_hold' })
  const after = f.runtime.snapshot()
  assert.equal(after.input.streamRunning, true); assert.equal(after.input.owner, 'idle'); assert.equal(after.safety.running, true)
  assert.ok(BigInt(after.queuedWireClock.tick) > oldTick)
  assert.ok(Date.now() - after.queuedWireClock.queuedAt <= 50)
  assert.ok(f.frames.length >= 6 && f.frames.every(frame => frame.modeled && frame.receiptConfirmed))
})

test('explicit agent start clears the work hold and starts the same objective with retained actual progress', async t => {
  const f = fixture(t); await f.runtime.resumeRequested()
  await f.runtime.operations.agent.yieldWork('Controlled operator handoff')
  const progress = copy(f.shared.autonomyProgress), count = f.starts.length
  await f.runtime.operations.agent.start({ objective: 'diamond', diamondCount: 1 })
  assert.equal(f.shared.legacyWorkHoldScope, null); assert.equal(f.starts.length, count + 1)
  assert.deepEqual(f.starts.at(-1).progress, progress); assert.deepEqual(f.shared.autonomyProgress, progress)
  assert.equal(f.shared.autoWanted, true)
  await f.runtime.operations.agent.yieldWork('Second controlled hold')
  await f.runtime.operations.depotMission.start()
  assert.equal(f.shared.legacyWorkHoldScope, null, 'Explicit Parent start also clears the current hold')
})

test('a previous-life hold does not suppress normal confirmed-respawn initialization and automatic work resumption', async t => {
  const f = fixture(t); await f.runtime.resumeRequested(); await f.advance(100)
  await f.runtime.operations.agent.yieldWork('Life0 operator handoff')
  const held = f.shared.legacyWorkHoldScope, count = f.starts.length
  // Controlled normal lifecycle receipt, no network/client or gameplay action.
  f.shared.deathRespawn.deathId = 1; f.raw.positionSource = 'respawn'; f.raw.positionUpdatedAt = new Date(Date.now()).toISOString()
  await f.runtime.onRespawn({ serverConfirmed: true, health: f.raw.health, position: copy(f.raw.position) })
  await f.runtime.onSpawn(); await f.runtime.resumeRequested(); await f.advance(100)
  assert.equal(f.shared.legacyWorkHoldScope, held, 'Historical hold remains honestly scoped instead of being silently deleted')
  assert.equal(f.starts.length, count + 1, 'New actual life differs from the held scope')
  assert.equal(f.runtime.snapshot().input.streamRunning, true)
  assert.equal(f.shared.autoWanted, true); assert.equal(f.shared.safetyWanted, true); assert.equal(f.shared.userBehaviorsEnabled, true)
})
