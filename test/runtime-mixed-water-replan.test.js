'use strict'
// Controlled in-memory Host packets and real Native queues; no network,
// authoritative arrival, inventory change, or current Realm proof.
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), Module = require('node:module')
const root = process.cwd(), copy = v => structuredClone(v)
function load (filename, text) { const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename)); m._compile(text, filename); return m.exports }
async function scene (t) {
  const file = path.join(root, 'test/runtime-depot-resource-scope.test.js')
  const { hostScene, seed } = load(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports={hostScene,seed};')
  const movementSource = process.env.MIXED_MOVEMENT_TEST_SOURCE ?? (fs.existsSync(path.join(__dirname, '../src/movement.js')) ? path.join(__dirname, '../src/movement.js') : path.join(root, '.local/staged/mixed-water-correction-replan-r2/src/movement.js'))
  const stagedMovement = load(path.join(root, 'src/movement.js'), fs.readFileSync(movementSource, 'utf8'))
  const state = copy(seed.state)
  Object.assign(state, { health: 20, position: { x: .5, y: 66.62, z: .5 }, positionSource: 'server_post_move', positionUpdatedAt: new Date().toISOString(), inventory: { known: true, items: [] }, heldItem: null, selectedSlot: 0, rawSelectedSlot: 0, lifecycle: { phase: 'alive', deathId: 1 }, rotation: { yaw: -90, pitch: 0 } })
  delete state.predicted
  state.vitals.hunger = { value: 20, source: 'server_attribute', observedAt: new Date().toISOString() }
  const getBlock = (x, y, z) => { const wet = x >= 2 && x <= 3 && y >= 62 && y <= 64, name = wet ? 'water' : y < 65 ? 'stone' : 'air'; return { known: true, name: 'minecraft:' + name, position: { x, y, z }, boundingBox: name === 'stone' ? 'block' : 'empty', properties: wet ? { liquid_depth: 0 } : {}, extra: [] } }
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-mixed-replan-'))
  let f
  t.after(async () => { await f?.runtime.dispose('controlled Runtime mixed replay cleanup'); assert.ok(path.resolve(workspaceRoot).startsWith(path.join(os.tmpdir(), 'runtime-mixed-replan-'))); await fsp.rm(workspaceRoot, { recursive: true, force: true }) })
  const instances = [], movementOptions = [], startOptions = []
  const old = process.env.RUNTIME_TEST_SOURCE
  process.env.RUNTIME_TEST_SOURCE = process.env.MIXED_RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js')
  try {
    f = hostScene(t, workspaceRoot, { state, getBlock, overrides: {
      './movement': { ...stagedMovement, createMovement: options => { movementOptions.push(options); const m = stagedMovement.createMovement(options); instances.push(m); return { ...m, start: (target, options) => { startOptions.push(options); return m.start(target, options) } } } },
      './http-client': { createHttpClient: () => () => { throw Error('No HTTP in controlled Runtime mixed test') } }
    } })
  } finally { if (old == null) delete process.env.RUNTIME_TEST_SOURCE; else process.env.RUNTIME_TEST_SOURCE = old }
  const actualPrediction = f.host.setPrediction
  f.host.setPrediction = (value, source) => { actualPrediction(value, source); f.host.shared.motionSource = source }
  f.host.shared.deathRespawn = { deathId: 1, connectionId: state.connectionId, phase: 'confirmed', serverConfirmed: true, at: new Date().toISOString() }
  f.host.registerPacketEvents(['correct_player_move_prediction'])
  await f.runtime.resumeRequested()
  await new Promise(resolve => setTimeout(resolve, 100))
  const latest = () => f.sent.filter(p => p.name === 'player_auth_input').at(-1)
  return { ...f, instances, movementOptions, startOptions, latest, state }
}

test('real Runtime Host current-tick correction replans guarded mixed Native route and queues only the next ordinary frame', async t => {
  const f = await scene(t), target = { x: 5.5, y: 65, z: .5 }
  f.host.shared.explorationBudget={scope:'CONTROLLED_CURRENT_FULL_LIFE',life:1,attempts:7};f.host.shared.autoOptions={maxExplorations:256}
  const preserved={budget:copy(f.host.shared.explorationBudget),options:copy(f.host.shared.autoOptions),progress:copy(f.runtime.snapshot().agent.progress)}
  const started = f.runtime.operations.movement.start(target, { allowWater: true, sprint: false, maxDistance: 6, maxExpanded: 300, maxTicks: 100 })
  assert.equal(typeof f.startOptions.at(-1).beforeInput, 'function', 'normal public movement receives the private Runtime actor/owner guard')
  assert.equal(f.startOptions.at(-1).continueAfterReplay, true)
  const m = f.instances.find(value => value.snapshot().running)
  assert.ok(m, JSON.stringify(started))
  await new Promise(resolve => setTimeout(resolve, 100))
  const before = m.snapshot(), packet = copy(f.latest().packet), count = f.sent.length
  const correction = { prediction_type: 'player', position: copy(packet.position), delta: copy(packet.delta), on_ground: before.onGround, tick: packet.tick }
  f.receive('correct_player_move_prediction', correction)
  const corrected = m.snapshot()
  assert.equal(corrected.inputReplay.accepted, true, JSON.stringify(corrected))
  assert.equal(corrected.inputReplay.replayedTicks, 0)
  assert.equal(corrected.inputReplay.replanned, true, JSON.stringify(corrected))
  assert.equal(corrected.running, true)
  assert.equal(f.sent.length, count, 'Host correction handling itself sends no packet')
  assert.deepEqual(corrected.target, target)
  assert.deepEqual(corrected.timingDiagnostics.start, before.timingDiagnostics.start)
  assert.equal(corrected.correctionReplan.replans, 1)
  assert.equal(corrected.correctionReplan.maxTicks, 100)
  const rawCorrectionPose = copy(f.parsed.state.position)
  await new Promise(resolve => setTimeout(resolve, 60))
  const next = f.sent.filter(p => p.name === 'player_auth_input' && p.packet.tick > packet.tick)
  assert.ok(next.length >= 1)
  assert.equal(next[0].packet.tick, packet.tick + 1n)
  assert.deepEqual(f.parsed.state.position, rawCorrectionPose, 'Native continuation does not replace the received raw pose')
  assert.deepEqual(f.parsed.state.inventory.items, [])
  assert.equal(m.snapshot().serverConfirmed, false)
  assert.deepEqual(f.host.shared.explorationBudget,preserved.budget);assert.deepEqual(f.host.shared.autoOptions,preserved.options);assert.deepEqual(f.runtime.snapshot().agent.progress,preserved.progress)
  t.diagnostic(JSON.stringify({ controlled: true, life: 1, correctionTick: String(packet.tick), replayedFutureFrames: 0, freshNormalReplan: true, nextTick: String(next[0].packet.tick), inventoryGain: false, serverArrival: false }))
})

test('Runtime mixed replan rejects missing life, damage, canonical actors, owner changes and a revoked unchanged caller guard', async t => {
  for (const mode of ['life', 'guard', 'hp', 'actor', 'owner', 'optOut']) await t.test(mode, async t => {
    const f = await scene(t)
    let allowed = true
    if (mode === 'life') { delete f.host.shared.deathRespawn; delete f.host.shared.inventoryLifeReceipt }
    const beforeInput = () => allowed
    const options = { allowWater: true, sprint: false, maxDistance: 6, maxExpanded: 300, maxTicks: 100, ...(mode === 'guard' ? { continueAfterReplay: true, beforeInput } : {}), ...(mode === 'optOut' ? { continueAfterReplay: false } : {}) }
    if (mode === 'life') { const count = f.sent.filter(p => p.name === 'player_auth_input').length; assert.throws(() => f.runtime.operations.movement.start({ x: 5.5, y: 65, z: .5 }, options), /actual (?:scoped life|life scope)/); assert.equal(f.sent.filter(p => p.name === 'player_auth_input').length, count); assert.ok(f.instances.every(m => m.snapshot().sent === 0)); return }
    f.runtime.operations.movement.start({ x: 5.5, y: 65, z: .5 }, options)
    if (mode === 'guard') assert.strictEqual(f.startOptions.at(-1).beforeInput, beforeInput, 'existing caller guard identity remains exact')
    const m = f.instances.find(value => value.snapshot().running)
    assert.ok(m)
    await new Promise(resolve => setTimeout(resolve, 60))
    if (mode === 'guard') allowed = false
    if (mode === 'hp') f.parsed.state.health--
    if (mode === 'owner') {
      const old = m.snapshot(), oldGuard = f.startOptions.at(-1).beforeInput
      f.runtime.operations.movement.stop('Controlled actual owner stopped')
      assert.equal(oldGuard({ phase: 'moving', predictedState: copy(old.physicsState), packetPosition: copy(old.predictedPosition), controls: {}, correctionReplan: true }), false, 'captured private guard cannot survive actual controller stop')
    }
    if (mode === 'actor') f.host.entities.snapshot = () => [{ runtimeId: '999', uniqueId: '-999', entityType: 'minecraft:zombie', kind: 'mob', alive: true, positionKnown: true, dimension: 'overworld', position: { x: 2.5, y: 65, z: .5 } }]
    const before = m.snapshot(), packet = copy(f.latest().packet), count = f.sent.length
    f.receive('correct_player_move_prediction', { prediction_type: 'player', position: copy(packet.position), delta: copy(packet.delta), on_ground: before.onGround, tick: packet.tick })
    assert.notEqual(m.snapshot().inputReplay?.replanned, true, mode)
    assert.equal(f.sent.length, count)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(m.snapshot().sent, before.sent, 'denied correction must not send another movement or stale release')
    for (const output of f.sent.slice(count).filter(p => p.name === 'player_auth_input')) assert.equal(Math.hypot(output.packet.move_vector?.x ?? 0, output.packet.move_vector?.z ?? 0), 0, 'Runtime may resume only its ordinary neutral producer')
  })
})
