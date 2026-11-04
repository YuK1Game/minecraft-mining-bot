'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const copy = value => structuredClone(value)

function fixture (t, mode = 'valid') {
  const file = path.resolve(__dirname, 'runtime-idle-safety.test.js')
  let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  source = source.replace('  const calls = [];', `  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0
  const epoch = 1800000000000, advance = ms => { elapsed += ms; t.mock.timers.tick(ms) }
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const starts = [], guardCalls = [], guardResults = [], histories = [], records = []
  const calls = [];`)
  source = source.replace('  const target = { exports: {} };', `
  overrides['./input'] = { createInput: options => nativeRequire('./input').createInput({ ...options, startGameReceivedAt: 0, clock: () => elapsed }) }
  overrides['./input-history'] = { createInputHistory: options => { const value = nativeRequire('./input-history').createInputHistory(options); histories.push(value); return value } }
  overrides['./movement'] = { createMovement: options => {
    const value = nativeRequire('./movement').createMovement({ ...options, startGameReceivedAt: 0, clock: () => elapsed, onQueuedFrame: frame => { records.push(copy(frame)); options.onQueuedFrame(frame) }, onPrediction: prediction => {
      options.onPrediction(prediction)
      if (starts.length >= 2 && mode === 'valid') actors[0].uniqueId = '-changed-after-second-start'
    } })
    const start = value.start
    value.start = (target, settings) => { starts.push({ target: copy(target), settings, at: Date.now() }); return start(target, settings) }
    return value
  } }
  overrides['./guarded-route'] = { createGuardedRoute: options => {
    const value = nativeRequire('./guarded-route').createGuardedRoute({ ...options, clock: Date.now, delay: async ms => { advance(ms); await new Promise(resolve => setImmediate(resolve)) }, pollMs: 50, operationTimeoutMs: 1500 })
    const escape = value.escape
    value.escape = async (targets, settings) => {
      guardCalls.push({ targets: copy(targets), settings: { timeoutMs: settings.timeoutMs, maxMovementStarts: settings.maxMovementStarts }, at: Date.now() })
      const result = await escape(targets, settings); guardResults.push(copy(result))
      if (result.progressReplan?.kind === 'native_partial_landing') {
        if (mode === 'history_gap') histories[0].invalidate('controlled missing queue proof')
        if (mode === 'raw_changed') raw.positionUpdatedAt++
        if (mode === 'life') shared.deathRespawn.deathId++
        if (mode === 'uid') actors[0].uniqueId = '-replacement'
      }
      return result
    }
    return value
  } }
  const target = { exports: {} };`)
  source = source.replace("fs.readFileSync(filename, 'utf8')", "fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')")
  source = source.replace('  const runtime = create()', `
  Object.assign(raw, { startedAt: new Date(epoch - 10000).toISOString(), positionUpdatedAt: epoch, positionSource: 'server_post_move', rotation: { yaw: 0, pitch: 0 }, inventory: { known: true, items: [] }, heldItem: null })
  shared.loadingScreenEnded = true; shared.deathRespawn = { deathId: 0 }
  shared.vitals = { hunger: { value: 20, source: 'server_attribute', observedAt: new Date(epoch - 1000).toISOString() } }
  host.meta.startGame = { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }; host.meta.startGameReceivedAt = 0
  host.getState = () => ({ ...copy(raw), rawServerPosition: copy(raw.position), rawServerPositionUpdatedAt: raw.positionUpdatedAt, ...(shared.prediction ? { position: copy(shared.prediction.position), positionUpdatedAt: shared.prediction.updatedAt, positionSource: 'client_prediction', positionServerConfirmed: false, predicted: copy(shared.prediction) } : {}) })
  host.setPrediction = value => { shared.prediction = { ...copy(value), updatedAt: epoch + elapsed + 1 } }
  host.client.queue = (name, packet) => { packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } }
  const range = 12.520670751661077
  actors.push({ runtimeId: '9', uniqueId: '-9', kind: 'mob', entityType: 'minecraft:skeleton', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: .5 - Math.sqrt(range * range - 1.62 * 1.62), y: 65, z: .5 } })
  const runtime = create()`)
  source = source.replace('return { runtime, create, host, raw, shared,', 'return { advance, starts, guardCalls, guardResults, histories, records, runtime, create, host, raw, shared,')
  const loaded = { exports: {} }
  new vm.Script('(function(require,module,__filename,__dirname,mode){' + source + '\nmodule.exports={fixture};})', { filename: file }).runInThisContext()(Module.createRequire(file), loaded, file, path.dirname(file), mode)
  const f = loaded.exports.fixture(t, { wanted: true })
  t.mock.method(globalThis, 'fetch', () => assert.fail('Runtime Native progress proof remains offline'))
  f.runtime.resumeRequested()
  if (mode !== 'no_anchor') for (let tick = 0; tick < 9; tick++) f.advance(50)
  f.prefixProof = { historyCount: f.histories.length, histories: f.histories.map(history => history.snapshot()), packetCount: f.packets.length, idleError: f.shared.idleError, input: f.runtime.snapshot().input }
  return f
}

test('saved Runtime consumes real Native partial landing and actual queued history to start a fresh second target in the same budget', { timeout: 6000 }, async t => {
  const f = fixture(t), raw = copy(f.raw.position), start = Date.now()
  let result, failure
  try { result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [], reason: 'confirmed_leaf_clearance', preferredTarget: { x: 0.73, y: 65, z: 1.25 } }) } catch (error) { failure = error }
  assert.equal(f.guardResults[0]?.code, 'ESCAPE_PROGRESS_REPLAN', JSON.stringify({ result, results: f.guardResults, starts: f.starts, history: f.histories[0].snapshot() }))
  assert.equal(f.guardResults[0].progressReplan.kind, 'native_partial_landing')
  assert.ok(f.guardCalls.length >= 2, JSON.stringify({ result, calls: f.guardCalls, history: f.histories[0].snapshot(), prefixProof: f.prefixProof }))
  assert.ok(f.starts.length >= 2)
  assert.notDeepEqual(f.starts[1].target, f.starts[0].target)
  assert.equal(f.guardCalls[0].settings.maxMovementStarts, 5)
  assert.equal(f.guardCalls[1].settings.maxMovementStarts, 4)
  assert.ok(f.guardCalls[1].settings.timeoutMs < f.guardCalls[0].settings.timeoutMs)
  assert.ok(Date.now() - start < 4000)
  assert.ok(f.records.some(frame => frame.receiptConfirmed && String(frame.tick) === f.guardResults[0].progressReplan.queuedTick))
  assert.deepEqual(f.raw.position, raw, 'queued model progress never fabricates a new server pose')
  assert.notEqual(result?.arrived, true); assert.notEqual(result?.escaped, true); assert.notEqual(result?.serverConfirmed, true)
  assert.ok(failure || result?.arrived === false, 'the controlled changed foe on the second leg never earns arrival')
})

test('Runtime Native progress continuation rejects a missing anchor, history gaps, raw changes, new life and reused UID', { timeout: 6000 }, async t => {
  for (const mode of ['no_anchor', 'history_gap', 'raw_changed', 'life', 'uid']) await t.test(mode, async t => {
    const f = fixture(t, mode)
    let result
    try { result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [], reason: 'confirmed_leaf_clearance', preferredTarget: { x: 0.73, y: 65, z: 1.25 } }) } catch { /* Immediate identity rejection is an honest bounded failure. */ }
    assert.ok(f.starts.length <= 1, JSON.stringify({ mode, result, starts: f.starts }))
    assert.notEqual(result?.arrived, true); assert.notEqual(result?.escaped, true); assert.notEqual(result?.serverConfirmed, true)
  })
})
