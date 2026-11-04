'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const capture = require('./fixtures/bounded-jump-partial-ledge.json')
const copy = value => structuredClone(value)
const harnessFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
let source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('{ realSafety = false, wanted = false }', "{ realSafety = false, wanted = false, mode = 'future_floor' }")
source = source.replace('  const calls = [];', `  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0, postJump = false
  const epoch = Date.parse(jumpCapture.observedAt)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const inputs = [], movements = [], guardCalls = [], guardResults = [], histories = [], records = [], previews = []
  const blocks = new Map(jumpCapture.blocks.map(block => [block.position.x + ',' + block.position.y + ',' + block.position.z, copy(block)]))
  const advance = ms => { elapsed += ms; t.mock.timers.tick(ms) }
  const calls = [];`)
const inputStart = source.indexOf("    './input':")
const combatStart = source.indexOf("    './combat':", inputStart)
source = source.slice(0, inputStart) + `
    './input': { createInput: options => { const value = nativeRequire('./input').createInput({ ...options, startGameReceivedAt: 0, clock: () => elapsed }); inputs.push(value); return value } },
    './movement': { createMovement: options => {
      const value = nativeRequire('./movement').createMovement({ ...options, startGameReceivedAt: 0, clock: () => elapsed,
        onQueuedFrame: frame => { records.push({ ...copy(frame), actorPositions: Object.fromEntries(actors.map(actor => [actor.runtimeId, copy(actor.position)])) }); options.onQueuedFrame(frame) },
        onPrediction: prediction => {
          options.onPrediction(prediction)
          const pursuer = actors.find(actor => actor.runtimeId === '10')
          if (mode === 'pursuer' && records.length === 5) pursuer.position = { x: -11.35, y: 68, z: 34.5 }
          if (mode === 'smooth_005' || mode === 'smooth_010') {
            const dx = jumpCapture.position.x - pursuer.position.x, dz = jumpCapture.position.z - pursuer.position.z, length = Math.hypot(dx, dz)
            const speed = mode === 'smooth_005' ? 0.05 : 0.1
            if (length > speed) { pursuer.position.x += dx / length * speed; pursuer.position.z += dz / length * speed }
          }
        }
      })
      const preview = value.preview
      value.preview = (target, settings = {}) => { previews.push({ target: copy(target), boundedJump: copy(settings.boundedJump ?? null), postJump }); if (mode === 'second_jump' && postJump && !settings.boundedJump && target && Math.hypot(target.x - host.getState().position.x, target.z - host.getState().position.z) > 0.5) return { ready: false, reason: 'offline continuation deliberately unavailable' }; return preview(target, settings) }
      movements.push(value); return value
    } },
    './input-history': { createInputHistory: options => { const value = nativeRequire('./input-history').createInputHistory(options); histories.push(value); return value } },
    './guarded-route': { createGuardedRoute: options => {
      const value = nativeRequire('./guarded-route').createGuardedRoute({ ...options, clock: Date.now, delay: async ms => advance(ms), pollMs: 50, operationTimeoutMs: 3000 })
      const escape = value.escape
      value.escape = async (nodes, settings) => {
        const call = { nodes: copy(nodes), boundedJump: copy(settings.boundedJump ?? null), timeoutMs: settings.timeoutMs, maxMovementStarts: settings.maxMovementStarts }
        guardCalls.push(call)
        const result = await escape(nodes, settings); guardResults.push(copy(result))
        call.queuedFramesAtReturn = records.length
        if (settings.boundedJump && result.arrived) {
          postJump = true
          // This future platform is a disclosed controlled continuation oracle;
          // the first jump itself uses only the actual captured terrain.
          const floorY = Math.round(result.position.y - 1.62) - 1
          if (['future_floor', 'cached_hunger', 'spawn_order', 'smooth_005', 'smooth_010'].includes(mode)) for (let x = -12; x <= -10; x++) for (let z = 35; z <= 37; z++) for (let y = floorY; y <= floorY + 5; y++) blocks.set(x + ',' + y + ',' + z, { known: true, name: y === floorY ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, extra: [] })
        }
        return result
      }
      return value
    } },
` + source.slice(combatStart)
source = source.replace('  const runtime = create()', `  Object.assign(raw, { startedAt: new Date(epoch - 600000).toISOString(), health: jumpCapture.health, position: copy(jumpCapture.rawServerPosition), positionUpdatedAt: epoch, positionSource: 'server_post_move', inventory: { known: true, items: [] }, rawSelectedSlot: 0, heldItem: null, rotation: { yaw: jumpCapture.predicted.physicsState.yaw, pitch: 0 } })
  shared.loadingScreenEnded = true; shared.prediction = copy(jumpCapture.predicted); shared.vitals = copy(jumpCapture.vitals)
  if (mode === 'spawn_order') { raw.startedAt = '2026-10-31T18:56:55.132Z'; raw.connectedAt = '2026-10-31T18:57:18.349Z'; shared.vitals.hunger.observedAt = '2026-10-31T18:57:16.685Z' }
  if (mode === 'cached_hunger') shared.vitals.hunger.observedAt = new Date(epoch - 300000).toISOString()
  if (mode === 'stale_hunger') shared.vitals.hunger.observedAt = new Date(epoch - 700000).toISOString()
  host.meta.startGame = { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }
  host.meta.startGameReceivedAt = 0
  host.world.getBlock = (x, y, z) => copy(blocks.get(x + ',' + y + ',' + z) ?? { known: false })
  host.getState = () => {
    const state = { ...copy(raw), rawServerPosition: copy(raw.position), rawServerPositionUpdatedAt: raw.positionUpdatedAt }
    if (shared.prediction) Object.assign(state, { position: copy(shared.prediction.position), predicted: copy(shared.prediction), positionUpdatedAt: shared.prediction.updatedAt, positionSource: 'client_prediction', positionServerConfirmed: false })
    return state
  }
  host.setPrediction = prediction => { shared.prediction = { ...copy(prediction), updatedAt: epoch + elapsed, source: 'client_prediction', serverConfirmed: false } }
  host.client.queue = (name, packet) => { assert.equal(name, 'player_auth_input'); if (mode === 'no_queue' && packet.input_data?.includes('start_jumping')) throw new Error('Offline queue refused the jump'); packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } }
  actors.push(...jumpCapture.enemies.map(actor => ({ ...copy(actor), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })))
  const runtime = create()`)
source = source.replace('return { runtime, create, host, raw, shared,', 'return { advance, inputs, movements, guardCalls, guardResults, histories, records, previews, blocks, runtime, create, host, raw, shared,')
const loaded = { exports: {} }
new vm.Script('(function(require,module,__filename,__dirname,jumpCapture){' + source + '\nmodule.exports={fixture};})', { filename: harnessFile }).runInThisContext()(Module.createRequire(harnessFile), loaded, harnessFile, path.dirname(harnessFile), capture)

function fixture (t, mode = 'future_floor') {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Bounded Runtime regression must remain offline'))
  const f = loaded.exports.fixture(t, { mode })
  f.runtime.resumeRequested(); for (let tick = 0; tick < 8; tick++) f.advance(50)
  if (mode === 'unknown_head' || mode === 'liquid') for (let x = -15; x <= -5; x++) for (let z = 27; z <= 39; z++) f.blocks.set(`${x},70,${z}`, mode === 'unknown_head' ? { known: false } : { known: true, name: 'minecraft:water', position: { x, y: 70, z }, properties: { liquid_depth: 0 }, extra: [] })
  return f
}
const context = () => ({ operationId: 7, signal: new AbortController().signal, threats: [] })

test('captured partial ledge uses one real queued jump then a fresh ordinary work escape within one Runtime budget', async t => {
  const f = fixture(t), before = copy(f.raw)
  let result
  try { result = await f.safeties[0].options.escape(context()) } catch (error) { throw new Error(JSON.stringify({ error: error.message, calls: f.guardCalls, results: f.guardResults.map(value => ({ code: value.code, reason: value.reason, arrived: value.arrived, position: value.position, interruptions: value.interruptions, starts: value.movementStarts, routeInterruption: value.routeInterruption })), queued: f.records.length, tail: f.records.slice(-12).map(frame => ({ position: frame.packetPosition, controls: frame.controls })), history: f.histories[0].snapshot() })) }
  assert.equal(f.guardCalls.filter(call => call.boundedJump).length, 1, JSON.stringify({ result, calls: f.guardCalls, history: f.histories[0].snapshot() }))
  assert.ok(f.guardCalls.length >= 2)
  assert.equal(f.guardCalls[0].boundedJump.driveTicks, 9)
  assert.equal(f.guardResults[0].arrived, true)
  assert.equal(f.guardResults[0].serverConfirmed, false)
  assert.ok(f.guardCalls[0].queuedFramesAtReturn >= 3 && f.guardCalls[0].queuedFramesAtReturn <= 40)
  let previous = capture.position
  for (const frame of f.records.slice(0, f.guardCalls[0].queuedFramesAtReturn)) {
    for (const actor of [...capture.threatEvaluation.threats, ...capture.threatEvaluation.outsideDanger]) {
      const point = capture.enemies.find(value => value.runtimeId === actor.runtimeId).position
      const delta = { x: frame.packetPosition.x - previous.x, y: frame.packetPosition.y - previous.y, z: frame.packetPosition.z - previous.z }
      const denominator = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
      const ratio = denominator ? Math.max(0, Math.min(1, ((point.x - previous.x) * delta.x + (point.y - previous.y) * delta.y + (point.z - previous.z) * delta.z) / denominator)) : 0
      const clearance = Math.hypot(point.x - previous.x - delta.x * ratio, point.y - previous.y - delta.y * ratio, point.z - previous.z - delta.z * ratio)
      assert.ok(clearance >= (capture.threatEvaluation.threats.includes(actor) ? actor.distance : actor.dangerRadius) - 1e-4, actor.runtimeId)
    }
    previous = frame.packetPosition
  }
  assert.equal(f.guardCalls[1].boundedJump, null)
  assert.equal(f.guardCalls[0].maxMovementStarts, 5)
  assert.equal(f.guardCalls[1].maxMovementStarts, 4)
  assert.ok(f.guardCalls[1].timeoutMs < f.guardCalls[0].timeoutMs)
  assert.ok(result.movementStarts >= 2 && result.movementStarts <= 5)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.records.filter(frame => frame.controls.jump).length, 1)
  assert.equal(f.histories[0].snapshot().lastWitness.ready, true, JSON.stringify(f.histories[0].snapshot()))
  const diagnostic = f.runtime.snapshot().boundedJumpSearch
  assert.equal(diagnostic.attempts, 1)
  assert.equal(diagnostic.hungerReady, true)
  assert.equal(diagnostic.reason, 'landed')
  assert.equal(diagnostic.chosen.heading, f.guardCalls[0].boundedJump.heading)
  assert.equal(diagnostic.chosen.driveTicks, f.guardCalls[0].boundedJump.driveTicks)
  assert.equal(diagnostic.chosen.flightTicks, f.guardCalls[0].queuedFramesAtReturn)
  assert.equal(diagnostic.candidates, diagnostic.verified + diagnostic.rejected)
  assert.ok(diagnostic.elapsedMs >= diagnostic.maxSliceMs)
  assert.ok(JSON.stringify(diagnostic).length < 1024)
  assert.deepEqual(f.raw, before)
})

test('moving pursuer and queue rejection stop the jump without a second jump or fabricated landing', async t => {
  for (const mode of ['pursuer', 'no_queue']) await t.test(mode, async t => {
    const f = fixture(t, mode)
    let result
    try { result = await f.safeties[0].options.escape(context()) } catch {}
    assert.equal(f.guardCalls.filter(call => call.boundedJump).length, 1, mode)
    assert.notEqual(result?.arrived, true, mode)
    assert.ok(f.guardResults.every(value => !value.arrived), mode)
    assert.equal(f.packets.filter(row => row.packet.input_data.includes('start_jumping')).length, mode === 'no_queue' ? 0 : 1, mode)
  })
})

test('unknown jump headspace, liquid and prior-session hunger cannot queue a jump', async t => {
  for (const mode of ['unknown_head', 'liquid', 'stale_hunger']) await t.test(mode, async t => {
    const f = fixture(t, mode)
    let result
    try { result = await f.safeties[0].options.escape(context()) } catch {}
    assert.equal(f.guardCalls.filter(call => call.boundedJump).length, 0, mode + ': ' + JSON.stringify(result))
    assert.equal(f.packets.filter(row => row.packet.input_data.includes('start_jumping')).length, 0, mode)
    assert.notEqual(result?.escaped, true, mode)
    const diagnostic = f.runtime.snapshot().boundedJumpSearch
    assert.equal(diagnostic.attempts, 0)
    if (mode === 'stale_hunger') { assert.equal(diagnostic.hungerReady, false); assert.equal(diagnostic.reason, 'hunger_unready') }
  })
})

test('unchanged current-session hunger remains usable', async t => {
  const cached = fixture(t, 'cached_hunger')
  await cached.safeties[0].options.escape(context())
  assert.equal(cached.guardCalls.filter(call => call.boundedJump).length, 1)
})

test('real attribute-before-world-spawn ordering remains valid within the actual connection session', async t => {
  const f = fixture(t, 'spawn_order')
  assert.equal(Date.parse(f.raw.connectedAt) - Date.parse(f.shared.vitals.hunger.observedAt), 1664)
  const result = await f.safeties[0].options.escape(context())
  assert.equal(f.guardCalls.filter(call => call.boundedJump).length, 1)
  assert.equal(f.guardResults[0].arrived, true)
  assert.equal(result.serverConfirmed, false)
})

test('an unavailable next route cannot authorize a second jump', async t => {
  const stopped = fixture(t, 'second_jump')
  const result = await stopped.safeties[0].options.escape(context())
  assert.equal(stopped.guardCalls.filter(call => call.boundedJump).length, 1)
  assert.ok(stopped.previews.some(value => value.postJump && !value.boundedJump))
  assert.equal(result.arrived, true, 'The last genuine full landing is retained honestly')
  assert.equal(result.escaped, false)
  assert.equal(result.partialEscape, true)
  assert.equal(result.serverConfirmed, false)
})

test('ordinary pursuit at one and two metres per second preserves the real captured jump and useful continuation', async t => {
  for (const mode of ['smooth_005', 'smooth_010']) await t.test(mode, async t => {
    const f = fixture(t, mode)
    let result, error
    try { result = await f.safeties[0].options.escape(context()) } catch (caught) { error = caught.message }
    assert.equal(f.guardResults[0]?.arrived, true, JSON.stringify({ mode, error, result, calls: f.guardCalls, guards: f.guardResults.map(value => ({ code: value.code, reason: value.reason, remaining: value.remainingRouteRejection, arrived: value.arrived })) }))
    assert.equal(f.guardCalls.filter(call => call.boundedJump).length, 1)
    assert.ok(f.guardCalls.length >= 2)
    assert.ok(result.movementStarts >= 2 && result.movementStarts <= 5)
    assert.equal(result.serverConfirmed, false)
    assert.ok(f.actors.find(actor => actor.runtimeId === '10').position.x > capture.enemies.find(actor => actor.runtimeId === '10').position.x)
    let previous = capture.position
    for (const frame of f.records.slice(0, f.guardCalls[0].queuedFramesAtReturn)) {
      for (const actor of [...capture.threatEvaluation.threats, ...capture.threatEvaluation.outsideDanger]) {
        const point = frame.actorPositions[actor.runtimeId], dx = frame.packetPosition.x - previous.x, dy = frame.packetPosition.y - previous.y, dz = frame.packetPosition.z - previous.z
        const denominator = dx * dx + dy * dy + dz * dz
        const ratio = denominator ? Math.max(0, Math.min(1, ((point.x - previous.x) * dx + (point.y - previous.y) * dy + (point.z - previous.z) * dz) / denominator)) : 0
        const distance = Math.hypot(point.x - previous.x - dx * ratio, point.y - previous.y - dy * ratio, point.z - previous.z - dz * ratio)
        const floor = capture.threatEvaluation.threats.includes(actor) ? Math.min(actor.distance, Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)) : actor.dangerRadius
        assert.ok(distance >= floor - 1e-4, `${mode}:${actor.runtimeId}`)
      }
      previous = frame.packetPosition
    }
  })
})
