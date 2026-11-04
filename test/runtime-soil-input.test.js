'use strict'

// Real timers and production senders: queued history is populated only by the
// Runtime's actual onQueuedFrame callbacks after an actual local queue receipt.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { evaluateThreats } = require('../src/threats')
const capture = require('./fixtures/queued-tail-soil.json')
const copy = value => structuredClone(value)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const obstacle = { x: -16, y: 68, z: 30 }
const key = point => `${point.x},${point.y},${point.z}`

const harnessFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
let source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('  const calls = [];', '  const streams = [], motions = [], miners = [], histories = [], queuedFrames = [];\n  const calls = [];')
source = source.replace('startGame: { current_tick: 1000n }', "startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: performance.now()")
source = source.replace('return { runtime, create, host, raw, shared,', 'return { streams, motions, miners, histories, queuedFrames, runtime, create, host, raw, shared,')
const inputStart = source.indexOf("    './input':")
const combatStart = source.indexOf("    './combat':", inputStart)
assert.ok(inputStart > 0 && combatStart > inputStart)
source = source.slice(0, inputStart) + `
    './input': { createInput: options => {
      const actor = nativeRequire('./input').createInput({ ...options, onQueuedFrame: frame => { queuedFrames.push(copy(frame)); options.onQueuedFrame?.(frame) } })
      streams.push(actor)
      return actor
    } },
    './movement': { createMovement: options => {
      const native = nativeRequire('./movement').createMovement({ ...options, onQueuedFrame: frame => { queuedFrames.push(copy(frame)); options.onQueuedFrame?.(frame) } })
      const actor = { native, starts: [], previews: [] }; motions.push(actor)
      return { ...native, start: (target, options) => { actor.starts.push({ target: copy(target), at: Date.now() }); return native.start(target, options) }, preview: (target, options) => { const result = native.preview(target, options); actor.previews.push({ target: copy(target), ready: result.ready }); return result } }
    } },
    './mining': { createMining: options => { const actor = nativeRequire('./mining').createMining(options); miners.push(actor); return actor } },
    './input-history': { createInputHistory: options => { const actor = nativeRequire('./input-history').createInputHistory(options); histories.push(actor); return actor } },
` + source.slice(combatStart)
const target = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: harnessFile }).runInThisContext()(target.exports, Module.createRequire(harnessFile), target, harnessFile, path.dirname(harnessFile))

function fixture (t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('The real-input fixture must remain offline'))
  const constructions = []
  const nativeLoad = Module._load
  t.mock.method(Module, '_load', function (request, ...args) {
    const loaded = Reflect.apply(nativeLoad, this, [request, ...args])
    if (request !== 'prismarine-registry') return loaded
    return (...parameters) => {
      const before = performance.now()
      const registry = loaded(...parameters)
      constructions.push({ at: Date.now(), ms: performance.now() - before })
      return registry
    }
  })
  const f = target.exports.fixture(t)
  f.shared.loadingScreenEnded = true
  const blocks = new Map(capture.blocks.map(block => [key(block.position), copy(block)]))
  f.host.world.getBlock = (x, y, z) => copy(blocks.get(`${x},${y},${z}`) ?? { known: false })
  Object.assign(f.raw, { startedAt: 'soil-input-life', health: capture.health, position: copy(capture.rawServerPosition), positionUpdatedAt: Date.now(), positionSource: 'server_move', rotation: { yaw: 0, pitch: 0 }, rawSelectedSlot: 0, rawServerSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, uncertain: false, items: [{ slot: 0, name: 'minecraft:rotten_flesh', count: 2 }] }, heldItem: { slot: 0, name: 'minecraft:rotten_flesh', count: 2 } })
  f.shared.prediction = copy(capture.predicted)
  f.actors.splice(0, f.actors.length, ...copy(capture.enemies))
  f.host.getState = () => {
    const state = copy(f.raw)
    Object.assign(state, { rawServerPosition: copy(f.raw.position), rawServerPositionUpdatedAt: f.raw.positionUpdatedAt })
    if (f.shared.prediction) Object.assign(state, { position: copy(f.shared.prediction.position), positionSource: 'client_prediction', predicted: copy(f.shared.prediction), positionUpdatedAt: f.shared.prediction.updatedAt })
    return state
  }
  f.host.setPrediction = prediction => { f.shared.prediction = { ...copy(prediction), updatedAt: Date.now(), source: 'client_prediction', serverConfirmed: false } }
  let actualTick = -1n
  const packets = []
  f.host.client.queue = (name, packet) => {
    assert.equal(name, 'player_auth_input')
    // Match the host's monotonically allocated receipt. A producer requesting
    // an already-used tick receives the real newer tick and must fail closed.
    actualTick = packet.tick > actualTick ? packet.tick : actualTick + 1n
    packets.push({ at: Date.now(), name, packet: copy({ ...packet, tick: actualTick }) })
    return { tick: actualTick }
  }
  const beats = []
  const heartbeat = setInterval(() => beats.push(Date.now()), 25)
  t.after(() => clearInterval(heartbeat))
  f.runtime.resumeRequested()
  const context = operationId => ({ operationId, signal: new AbortController().signal, threats: evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 }).threats })
  return { ...f, blocks, packets, constructions, beats, context }
}

test('real Runtime input remains continuous through soil planning, 900ms mining, AIR and native Guard', { timeout: 15000 }, async t => {
  const f = fixture(t)
  for (let n = 0; n < 100 && f.queuedFrames.length < 3; n++) await delay(10)
  assert.ok(f.queuedFrames.length >= 3, JSON.stringify(f.streams[0].stats()))
  const firstFrame = f.queuedFrames.length
  const firstPacket = f.packets.length
  const firstBeat = f.beats.length
  const warmConstructions = f.constructions.length
  const baseline = await f.safeties[0].options.escape(f.context(401))
  assert.equal(baseline.reason, 'no_known_away_route')
  const initialConstructions = f.constructions.length
  const action = Promise.resolve(f.safeties[0].options.clearEscape(f.context(402)))
  action.catch(() => {})
  for (let n = 0; n < 200 && f.miners[0].snapshot().phase !== 'mining'; n++) await delay(5)
  assert.equal(f.miners[0].snapshot().phase, 'mining', JSON.stringify({ mining: f.miners[0].snapshot(), input: f.streams[0].stats(), idle: f.runtime.snapshot().idle }))
  const miningStarted = Date.now()
  const duringClearConstructions = f.constructions.length
  await delay(925)
  assert.equal(f.miners[0].snapshot().phase, 'mining')
  assert.equal(f.motions[0].starts.length, 0)
  assert.ok(f.packets.slice(firstPacket).some(value => value.packet.block_action?.some(action => action.action === 'start_break' && key(action.position) === key(obstacle))))
  assert.equal(f.constructions.length, duringClearConstructions)
  f.blocks.set(key(obstacle), { known: true, position: { ...obstacle }, name: 'minecraft:air', properties: {}, extra: [], boundingBox: 'empty', runtimeId: 3690217760 })
  f.runtime.applyPacket('update_block', {})
  const cleared = await action
  assert.equal(cleared.cleared, true, JSON.stringify(cleared))
  assert.equal(cleared.serverConfirmed, true)
  assert.equal(cleared.escaped, undefined)
  assert.ok(Date.now() - miningStarted >= 900)
  const escape = await f.safeties[0].options.escape({ ...f.context(403), reason: 'confirmed_soil_clearance', preferredTarget: cleared.target })
  assert.equal(escape.arrived, true, JSON.stringify({ escape, input: f.streams[0].stats(), motion: f.motions[0].native.snapshot(), idle: f.runtime.snapshot().idle }))
  // The uphill leg clears canonical danger; the separate pause/work margin
  // still retains the observed pursuer. Arrival does not imply work clearance.
  assert.equal(escape.escaped, false, JSON.stringify(escape))
  assert.equal(escape.partialEscape, true, JSON.stringify(escape))
  assert.equal(escape.workClearancePending, true, JSON.stringify(escape))
  assert.deepEqual(escape.currentThreats, [])
  assert.equal(escape.serverConfirmed, false)
  assert.equal(f.motions[0].starts.length, 1)
  await delay(150)
  const frames = f.queuedFrames.slice(firstFrame)
  const packets = f.packets.slice(firstPacket)
  const beats = f.beats.slice(firstBeat)
  assert.ok(frames.some(frame => frame.producer === 'input'))
  assert.ok(frames.some(frame => frame.producer === 'navigation'))
  assert.ok(frames.every(frame => frame.modeled && frame.receiptConfirmed))
  const gaps = frames.flatMap((frame, index) => index && frame.tick !== frames[index - 1].tick + 1n ? [{ previous: { tick: String(frames[index - 1].tick), producer: frames[index - 1].producer, queuedAt: frames[index - 1].queuedAt }, next: { tick: String(frame.tick), producer: frame.producer, queuedAt: frame.queuedAt } }] : [])
  if (gaps.length) {
    const ticks = new Set(gaps.flatMap(gap => [gap.previous.tick, gap.next.tick]))
    const motion = f.motions[0].native.snapshot()
    t.diagnostic(JSON.stringify({ gaps, packets: f.packets.filter(value => ticks.has(String(value.packet.tick))).map(value => ({ tick: String(value.packet.tick), at: value.at, actions: value.packet.block_action, flags: value.packet.input_data })), cursor: f.histories[0].snapshot(), motion: { phase: motion.phase, reason: motion.reason, tick: motion.tick, lastTimerGapMs: motion.lastTimerGapMs }, movementStart: f.motions[0].native.diagnostics(), input: f.streams[0].stats(), clearance: f.runtime.snapshot().clearance }))
  }
  for (let n = 1; n < frames.length; n++) assert.equal(frames[n].tick, frames[n - 1].tick + 1n)
  const queuedGap = Math.max(...packets.slice(1).map((packet, index) => packet.at - packets[index].at))
  const heartbeatGap = Math.max(...beats.slice(1).map((beat, index) => beat - beats[index]))
  const clearance = f.runtime.snapshot().clearance
  const evidence = { queuedGap, heartbeatGap, registryConstructionsDuringBaseline: initialConstructions - warmConstructions, registryConstructionsDuringClear: duringClearConstructions - initialConstructions, registryConstructionsThroughGuard: f.constructions.length - initialConstructions, constructionMs: f.constructions.slice(initialConstructions).map(value => value.ms), queuedFrames: frames.length, movementStarts: f.motions[0].starts.length, clearance }
  t.diagnostic(JSON.stringify(evidence))
  assert.ok(queuedGap <= 200, JSON.stringify(evidence))
  assert.ok(heartbeatGap <= 200, JSON.stringify(evidence))
  assert.ok(clearance.maxPlanningSliceMs < 200, JSON.stringify(evidence))
  assert.equal(duringClearConstructions - initialConstructions, 0, 'Emergency clearance reuses initialized physics instead of rebuilding a registry')
  assert.equal(f.streams[0].stats().lastError, null)
  assert.equal(f.runtime.snapshot().idle.error, null)
  assert.equal(f.histories[0].snapshot().lastReset, 'anchor_missing', 'No cursor failure, missing receipt or fabricated correction anchor')
})

test('the final observed close Creeper refuses clearance while real idle ticks continue', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const creeper = f.actors.find(actor => actor.runtimeId === '24')
  // Actual terminal observation, 2026-10-31T19:45:34.613Z: the pursuer had
  // already crossed the unchanged clearance distance gate during the stall.
  Object.assign(creeper, { runtimeId: '28', uniqueId: '-554050781160', position: { x: -16.610675811767578, y: 68, z: 25.959278106689453 } })
  for (let n = 0; n < 100 && f.queuedFrames.length < 3; n++) await delay(10)
  const before = f.queuedFrames.length
  const result = await f.safeties[0].options.clearEscape(f.context(404))
  assert.equal(result.cleared, false)
  await delay(120)
  assert.ok(f.queuedFrames.length > before)
  assert.equal(f.miners[0].snapshot().phase, 'idle')
  assert.equal(f.motions[0].starts.length, 0)
  assert.ok(f.packets.every(value => !value.packet.block_action?.some(action => action.action === 'start_break')))
  assert.equal(f.streams[0].stats().lastError, null)
})

test('a Creeper primed at the first planning yield cancels before any real mining input', { timeout: 5000 }, async t => {
  const f = fixture(t)
  for (let n = 0; n < 100 && f.queuedFrames.length < 3; n++) await delay(10)
  assert.ok(f.queuedFrames.length >= 3)
  const before = f.queuedFrames.length
  const action = Promise.resolve(f.safeties[0].options.clearEscape(f.context(405)))
  const rejected = assert.rejects(action, /clearance|aborted|planning|interrupted/i)
  // clearEscape has returned at its first asynchronous planner yield. Apply
  // the received danger change before any planning continuation can run.
  const creeper = f.actors.find(actor => actor.runtimeId === '24')
  creeper.primed = true
  f.runtime.applyPacket('entity_event', { runtime_entity_id: creeper.runtimeId, event_id: 32 })
  await rejected
  await delay(120)
  assert.equal(f.miners[0].snapshot().phase, 'idle')
  assert.equal(f.motions[0].starts.length, 0)
  assert.ok(f.packets.every(value => !value.packet.block_action?.some(action => action.action === 'start_break')))
  assert.ok(f.queuedFrames.length > before)
  for (let n = 1; n < f.queuedFrames.length; n++) assert.equal(f.queuedFrames[n].tick, f.queuedFrames[n - 1].tick + 1n)
  assert.equal(f.streams[0].stats().lastError, null)
  assert.equal(f.runtime.snapshot().idle.error, null)
  assert.equal(f.histories[0].snapshot().lastReset, 'anchor_missing')
})

test('explicit cancellation at the first planning yield preserves the real idle input cursor', { timeout: 5000 }, async t => {
  const f = fixture(t)
  for (let n = 0; n < 100 && f.queuedFrames.length < 3; n++) await delay(10)
  assert.ok(f.queuedFrames.length >= 3)
  const before = f.queuedFrames.length
  const controller = new AbortController()
  const action = Promise.resolve(f.safeties[0].options.clearEscape({ ...f.context(406), signal: controller.signal }))
  const rejected = assert.rejects(action, /planning cancelled/)
  controller.abort(new Error('Explicit planning cancelled'))
  await rejected
  await delay(120)
  assert.equal(f.miners[0].snapshot().phase, 'idle')
  assert.equal(f.motions[0].starts.length, 0)
  assert.ok(f.packets.every(value => !value.packet.block_action?.some(action => action.action === 'start_break')))
  assert.ok(f.queuedFrames.length > before)
  assert.ok(f.queuedFrames.every(frame => frame.modeled && frame.receiptConfirmed))
  for (let n = 1; n < f.queuedFrames.length; n++) assert.equal(f.queuedFrames[n].tick, f.queuedFrames[n - 1].tick + 1n)
  assert.equal(f.streams[0].stats().lastError, null)
  assert.equal(f.runtime.snapshot().idle.error, null)
  assert.equal(f.histories[0].snapshot().lastReset, 'anchor_missing')
})
