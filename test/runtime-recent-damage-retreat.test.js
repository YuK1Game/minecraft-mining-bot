'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), vm = require('node:vm')
const { setImmediate: turn } = require('node:timers/promises')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { createInput } = require('../src/input')
const { createInputHistory } = require('../src/input-history')
const { continuationScope } = require('../src/base-continuation')
const capture = require('./fixtures/recent-damage-retreat.json')
const copy = value => structuredClone(value)
const cells = new Map(capture.blocks.map(block => [Object.values(block.position).join(','), block]))
const read = (x, y, z) => cells.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? { known: false }
const prepared = createPhysics({ world: { getBlock: read }, version: '1.26.60', allowWater: true })

const filename = path.join(__dirname, 'runtime-user-behaviors.test.js')
let source = 'let testHooks;\n' + fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('  const actors = []', '  Object.assign(raw, structuredClone(testHooks.initialRaw));\n  const actors = structuredClone(testHooks.actors)')
source = source.replace('  const facadeState =', '  shared.deathRespawn = { deathId: 51 }; shared.prediction = structuredClone(testHooks.prediction);\n  const facadeState =')
source = source.replace('  const overrides = {', "  const overrides = {\n    'node:timers/promises': { ...require('node:timers/promises'), setTimeout: (ms, value, options) => testHooks.wait(ms, options?.signal) },")
source = source.replace(/^    '\.\/physics': .+$/m, "    './physics': { createPhysics: options => testHooks.physics(options) }, './navigation': { createNavigator: options => testHooks.navigator(options) }, './movement': { createMovement: options => { wireMovementOptions.push(options); Object.assign(mockMovement, testHooks.movement(options)); return mockMovement } },")
source = source.replace(/^    '\.\/input-history': .+$/m, "    './input-history': { createInputHistory: options => testHooks.history(options) },")
source = source.replace(/^    '\.\/input': .+$/m, "    './input': { createInput: options => { wireInputOptions.push(options); return testHooks.input(options) } },")
source = source.replace(/^    '\.\/idle-safety': .+$/m, "    './idle-safety': { createIdleSafety: options => { testHooks.safetyOptions = options; return { snapshot: () => structuredClone(testHooks.safety), start: () => { testHooks.safety.running = true }, stop: async () => { testHooks.safety.running = false }, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) } } },")
source = source.replace('runtime_entity_id: 1n, player_position:', 'runtime_entity_id: BigInt(raw.runtimeEntityId), player_position:')
source = source.replace("positionSource: 'client_prediction' } : {})", "positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: shared.prediction.updatedAt } : {})")
source = source.replace('setPrediction: p => { shared.prediction = structuredClone(p) }', "setPrediction: p => { shared.prediction = { ...structuredClone(p), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date(Date.now()).toISOString() } }")
source = source.replace("  const filename = path.resolve(__dirname, '../src/runtime.js'), loaded = new Module(filename, module)", "  host.world.getBlock = testHooks.read;\n  const filename = path.resolve(__dirname, '../src/runtime.js'), loaded = new Module(filename, module)")
source = source.replace("loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", "loaded._compile(testHooks.instrument(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')), filename)")
source += '\nmodule.exports = { scene, setHooks: value => { testHooks = value } }'
const loaded = { exports: {} }
new vm.Script(Module.wrap(source), { filename }).runInThisContext()(loaded.exports, Module.createRequire(filename), loaded, filename, path.dirname(filename))

async function fixture (t, { legacy = false } = {}) {
  let elapsed = 0, actualMovement, actualInput
  const epoch = Date.parse(capture.provenance.capturedAt), frames = [], starts = []
  t.mock.method(Date, 'now', () => epoch + elapsed)
  t.mock.method(performance, 'now', () => elapsed)
  const initialRaw = { ...copy(capture.state), position: copy(capture.state.rawServerPosition), positionSource: 'server_post_move', positionUpdatedAt: new Date(epoch - 20000).toISOString(), selectedSlot: 2, rawSelectedSlot: 2, rawServerSelectedSlot: 2 }
  delete initialRaw.predicted
  const hooks = { initialRaw, actors: copy(capture.state.entities), prediction: copy(capture.state.predicted), read,
    history: createInputHistory,
    safety: { running: true, busy: false, active: null, phase: 'observing' },
    physics: options => prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }),
    navigator: options => createNavigator({ ...options, physics: options.physics ?? prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }) }),
    movement: options => {
      actualMovement = createMovement({ ...options, clock: () => elapsed, startGameReceivedAt: 0, onQueuedFrame: frame => { frames.push(copy(frame)); options.onQueuedFrame?.(frame) } })
      return { ...actualMovement, start: (target, options) => { starts.push({ target: copy(target), options }); return actualMovement.start(target, options) } }
    },
    input: options => { actualInput = createInput({ ...options, clock: () => elapsed, startGameReceivedAt: 0 }); return actualInput },
    wait: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason ?? Error('Cancelled')
      await turn()
      elapsed += ms; t.mock.timers.tick(ms)
      await turn()
      if (signal?.aborted) throw signal.reason ?? Error('Cancelled')
    },
    instrument: runtimeSource => {
      const marker = '            if (!primary && fullOrigin && !alreadyShallow) {'
      const start = runtimeSource.indexOf(marker), end = runtimeSource.indexOf('            if (!primary || !alreadyShallow && !fullOrigin && !partialOrigin)', start)
      assert.ok(start >= 0 && end > start)
      // The old behavior control removes only the newly added dispatch branch;
      // all real Runtime ownership, terrain and sender code remains identical.
      return legacy ? runtimeSource.slice(0, start) + runtimeSource.slice(end) : runtimeSource
    }
  }
  loaded.exports.setHooks(hooks)
  const f = loaded.exports.scene(t)
  f.shared.autoWanted = true
  f.shared.safetyWanted = true
  f.raw.health = 17
  // CONTROLLED Host-semantic received-health record, not a historical damage
  // event. Public Runtime stopActions must perform the actual scoped binding.
  f.raw.safety = { reason: 'damage_detected', previousHealth: 20, health: 17, at: Date.now() }
  await f.runtime.stopActions('ダメージを検知しました。')
  assert.equal(f.shared.recentDamageNoPrimary?.source, 'host_received_health_drop')
  assert.deepEqual(f.shared.recentDamageNoPrimary.scope, continuationScope(f.facadeOptions.getState()))
  assert.equal(hooks.safety.running, true)
  assert.equal(f.frames?.length ?? frames.length, 0)
  t.after(() => { actualMovement?.stop('Test cleanup'); actualInput?.stop(false) })
  const controller = new AbortController()
  return { ...f, hooks, frames, starts, movement: actualMovement, controller, escape: () => hooks.safetyOptions.escape({ operationId: 'controlled-recent-damage', signal: controller.signal, threats: [], retainedActors: [] }) }
}

test('real Runtime binds received damage and queues the proven no-primary retreat through owned Movement and InputHistory', async t => {
  const f = await fixture(t), inventory = copy(f.facadeOptions.getState().inventory)
  const result = await f.escape()
  const snapshot = f.runtime.snapshot(), modeled = f.frames.filter(frame => frame.producer !== 'input' && frame.modeled)
  assert.equal(result.code, 'RECENT_DAMAGE_RETREAT', JSON.stringify({ result, diagnostic: snapshot.recentDamageRetreat }))
  assert.equal(result.supported, true)
  assert.equal(result.arrived, true)
  assert.equal(result.escaped, false)
  assert.equal(result.safe, false)
  assert.equal(result.safetyConfirmed, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.starts.length, 1)
  assert.equal(modeled.length, 15)
  assert.ok(modeled.every(frame => frame.receiptConfirmed === true))
  assert.equal(snapshot.queuedPrediction.navigationQueued, 15)
  assert.equal(snapshot.recentDamageRetreat.phase, 'model_landing')
  assert.equal(snapshot.recentDamageRetreat.actualSent, 15)
  assert.equal(snapshot.recentDamageRetreat.riskAccepted, false)
  assert.equal(snapshot.recentDamageRetreat.attackerAttributed, false)
  const last = modeled.at(-1), nav = createNavigator({ world: { getBlock: read }, physics: prepared })
  assert.equal(nav.verifyOrigin(last.predictedState), true)
  assert.equal(last.predictedState.isInWater, false)
  assert.equal(last.predictedState.isInLava, false)
  assert.deepEqual(f.facadeOptions.getState().inventory, inventory)
  assert.ok(f.wire.every(packet => packet.name === 'player_auth_input'), 'No attack, mining, inventory, or observation packets are generated')
})

test('the old real Runtime no-primary branch queues no route on the same bound damage and captured geometry', async t => {
  const f = await fixture(t, { legacy: true }), result = await f.escape()
  assert.equal(result.supported, false)
  assert.equal(result.reason, 'no_known_escape_origin')
  assert.equal(f.starts.length, 0)
  assert.equal(f.frames.filter(frame => frame.producer !== 'input' && frame.modeled).length, 0)
  assert.equal(f.runtime.snapshot().queuedPrediction.navigationQueued, 0)
  assert.equal(f.shared.recentDamageRetreatDiagnostic, undefined)
})
