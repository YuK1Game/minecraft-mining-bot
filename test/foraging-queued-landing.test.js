'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setTimeout: wait } = require('node:timers/promises')
const correctionPoint = { x: -22.208650588989258, y: 70.37320709228516, z: 40.36732864379883 }
const correctionVelocity = { x: 0.03044099174439907, y: 0.2481359988451004, z: 0 }
const file = path.resolve(__dirname, 'runtime-user-behaviors.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
let prefix = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
prefix = prefix.replace("  t.mock.timers.enable({ apis: ['setInterval'] })", '  let foragingOptions, productionStream; const simulated = { physics: null, body: null, jumping: false, ticks: 0, correction: null, onGroundNeutral: 0, movement: { phase: \'idle\' }, starts: 0 };')
prefix = prefix.replace("  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", `  delete overrides['./physics']; delete overrides['./navigation']; delete overrides['./input-history']
  raw.position = { x: -22.208650588989258, y: 69.62, z: 40.36732864379883 }; raw.positionUpdatedAt = new Date(Date.now() - 2000).toISOString(); raw.positionSource = 'move_player'; raw.health = 20
  raw.breath = { current: 300, maximum: 300 }; shared.deathRespawn.deathId = 68; shared.userBehaviorsEnabled = false
  host.world.getBlock = (x,y,z) => ({ known: true, name: y < 68 ? 'minecraft:stone' : 'minecraft:air', position: {x,y,z}, properties: {}, extra: [], boundingBox: y < 68 ? 'block' : 'empty' })
  game.player_position = structuredClone(raw.position); cache.observe('start_game', game)
  simulated.physics = Module.prototype.require.call(loaded, './physics').createPhysics({ world: host.world, version: '1.26.60', allowWater: false })
  simulated.body = simulated.physics.fromServer(raw)
  const actualInput = Module.prototype.require.call(loaded, './input')
  overrides['./input'] = { ...actualInput, createInput: options => {
    productionStream = actualInput.createInput({ ...options, frameProvider: frame => {
      const controls = simulated.jumping && simulated.ticks === 0 ? { jump: true } : {}
      simulated.body = simulated.physics.step({ ...simulated.body, yaw: frame.rotation.yaw, pitch: frame.rotation.pitch }, controls)
      if (simulated.jumping) simulated.ticks++
      const body = structuredClone(simulated.body), position = simulated.physics.toServerPosition(body)
      simulated.onGroundNeutral = body.onGround && !Object.values(controls).some(Boolean) ? simulated.onGroundNeutral + 1 : 0
      if (simulated.jumping && simulated.ticks === 2 && simulated.correction) queueMicrotask(() => simulated.correction(frame.tick))
      if (simulated.nextCorrection) { const next = simulated.nextCorrection; simulated.nextCorrection = null; queueMicrotask(() => next(frame.tick, position)) }
      return { position, delta: body.velocity, physicsState: body, predictedState: body, controls, inputFlags: controls.jump ? ['jumping', 'start_jumping', 'want_up'] : [], commitPrediction: () => host.setPrediction({ position, feetPosition: body.position, physicsState: body, onGround: body.onGround, velocity: body.velocity, source: 'client_prediction', serverConfirmed: false }) }
    } }); return productionStream
  } }
  const actualForaging = Module.prototype.require.call(loaded, './foraging')
  overrides['./foraging'] = { ...actualForaging, createForaging: options => {
    foragingOptions = options
    return actualForaging.createForaging({ ...options, verifyQueuedLanding: request => simulated.verify ? simulated.verify(request, options.verifyQueuedLanding) : options.verifyQueuedLanding(request), movement: {
      preview: () => ({ ready: true }), start: () => { simulated.starts++; simulated.jumping = true; simulated.ticks = 0; simulated.onGroundNeutral = 0; simulated.movement = { phase: 'moving' }; return simulated.movement }, stop: () => { simulated.movement = { phase: 'stopped' } }
    }, getMovement: () => simulated.jumping && simulated.ticks > 2 && simulated.onGroundNeutral >= 2 ? { phase: 'replan_required' } : simulated.movement })
  } }
  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)`)
prefix = prefix.replace('return { runtime, host, raw,', 'return { simulated, productionStream, foragingOptions, runtime, host, raw,')
loaded._compile(prefix + '\nmodule.exports = { scene };', file)
const { scene } = loaded.exports
async function fixture (t, mode = null) {
  const f = scene(t); f.shared.autoWanted = true
  f.actors.push({ runtimeId: '2955', uniqueId: '-2955', kind: 'item', name: 'minecraft:mutton', count: 1, alive: true, positionKnown: true, dimension: 'overworld', position: { x: -11, y: 67.125, z: 38.36 } })
  let anchored = false, prepare = null, denial = null, changed = false
  f.simulated.correction = tick => {
    if (anchored) return; anchored = true
    f.raw.position = structuredClone(correctionPoint); f.raw.positionUpdatedAt = new Date().toISOString(); f.raw.positionSource = 'correct_player_move_prediction'
    f.runtime.applyPacket('correct_player_move_prediction', { prediction_type: 'player', tick, position: structuredClone(correctionPoint), delta: structuredClone(correctionVelocity), on_ground: false, rotation: { x: 0, z: 0 } })
    f.simulated.body = f.simulated.physics.fromServer({ ...f.raw, predicted: null }, { velocity: correctionVelocity, onGround: false })
  }
  f.simulated.verify = async (request, actual) => {
    if (mode === 'default_deny') return null
    if (mode === 'old_anchor' && prepare && request.mode === 'prepare') return null
    const value = actual(request)
    if (request.mode === 'prepare' && value && !prepare) {
      prepare = { request, proof: value, anchorTick: f.runtime.snapshot().queuedPrediction.anchorTick }
      if (mode && !changed) {
        changed = true
        if (mode === 'uid') f.actors[0].uniqueId = '-other'
        if (mode === 'death') { f.raw.health = 0; f.raw.dead = true }
        if (mode === 'damage') f.raw.health--
        if (mode === 'life') f.shared.deathRespawn.deathId++
        if (mode === 'unknown_body' || mode === 'unknown_fall') { const original = f.host.world.getBlock; f.host.world.getBlock = (x,y,z) => y === (mode === 'unknown_body' ? 68 : 70) ? { known: false } : original(x,y,z) }
        if (mode === 'force') f.runtime.applyPacket('set_entity_motion', { runtime_entity_id: 1n, velocity: { x: 0.2, y: 0.1, z: 0 } })
        if (mode === 'old_owner') void f.runtime.operations.foraging.stop('fixture_old_owner').catch(() => {})
        if (mode === 'old_anchor') {
          f.simulated.nextCorrection = (tick, p) => {
            const position = { ...p, y: p.y + 0.1 }, velocity = { x: 0, y: 0, z: 0 }
            f.raw.position = position; f.raw.positionUpdatedAt = new Date().toISOString(); f.runtime.applyPacket('correct_player_move_prediction', { prediction_type: 'player', tick, position, delta: velocity, on_ground: false, rotation: { x: 0, z: 0 } })
            f.simulated.body = f.simulated.physics.fromServer({ ...f.raw, predicted: null }, { velocity, onGround: false })
          }
          await wait(350)
        }
      }
    }
    if (request.mode === 'consume') denial = value
    return value
  }
  f.runtime.resumeRequested()
  await wait(60)
  if (mode === 'missing_receipt') {
    const queue = f.host.client.queue; let missing = false
    f.host.client.queue = (name,p) => { const result = queue(name,p); if (!missing && name === 'player_auth_input' && f.simulated.jumping && f.simulated.ticks > 2) { missing = true; return {} }; return result }
  }
  return { ...f, prepare: () => prepare, denial: () => denial, anchored: () => anchored }
}
test('real received0.753m correction plus two actual Native neutral receipts permits only modeled landing progress', { timeout: 6000 }, async t => {
  const f = await fixture(t)
  const result = await f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 })
  assert.equal(f.anchored(), true); assert.equal(result.foodGained, 0); assert.equal(result.collected, false); assert.equal(result.serverConfirmed, false)
  assert.equal(result.correctionEvidence.queuedLandingVerified, true, JSON.stringify(result)); assert.equal(result.correctionEvidence.serverSupported, false); assert.equal(result.correctionEvidence.ready, false)
  assert.equal(f.simulated.starts, 1); assert.deepEqual(f.raw.position, correctionPoint)
  assert.ok(Math.abs(f.raw.position.y - f.host.getState().position.y - 0.75320709228516) < 1e-5)
  assert.ok(f.runtime.snapshot().queuedPrediction.lastWitness.ready); assert.ok(f.productionStream.stats().sent > 2)
})
test('default denial retains baseline NO_MOVEMENT_PROGRESS without granting raw landing or food', { timeout: 6000 }, async t => {
  const f = await fixture(t, 'default_deny')
  const result = await f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 })
  assert.equal(result.excludedTargets[0].reason, 'NO_MOVEMENT_PROGRESS'); assert.equal(result.correctionEvidence.queuedLandingVerified, undefined)
  assert.equal(f.runtime.snapshot().foraging.correctionEvidence.serverSupported, false); assert.deepEqual(f.raw.position, correctionPoint)
})
for (const mode of ['unknown_body', 'unknown_fall', 'uid', 'death', 'damage', 'life', 'force']) test(`${mode} invalidates an opaque prepared landing proof before any replan dispatch`, { timeout: 6000 }, async t => {
  const f = await fixture(t, mode)
  if (['uid', 'death', 'damage', 'life'].includes(mode)) await assert.rejects(f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 }))
  else { const result = await f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 }); assert.equal(result.correctionEvidence?.queuedLandingVerified, undefined); assert.equal(result.serverConfirmed, false) }
  assert.ok(f.prepare(), 'actual receipt proof was prepared before mutation'); assert.equal(f.simulated.starts, 1); assert.equal(f.runtime.snapshot().foraging.foodGained, 0)
})
test('missing actual queue receipt cannot mint either of the two grounded audit frames', { timeout: 6000 }, async t => {
  const f = await fixture(t, 'missing_receipt')
  const result = await f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 }); assert.equal(result.excludedTargets[0].reason, 'NO_MOVEMENT_PROGRESS')
  assert.equal(f.prepare(), null); assert.equal(f.simulated.starts, 1); assert.equal(f.runtime.snapshot().foraging.foodGained, 0)
})
test('a real newer correction anchor cannot consume an older opaque landing proof', { timeout: 6000 }, async t => {
  const f = await fixture(t, 'old_anchor')
  const result = await f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 }); assert.equal(result.excludedTargets[0].reason, 'NO_MOVEMENT_PROGRESS')
  assert.ok(f.prepare()); assert.equal(f.denial(), null); assert.notEqual(f.runtime.snapshot().queuedPrediction.anchorTick, f.prepare().anchorTick); assert.equal(f.simulated.starts, 1)
})
test('an old cancelled owner cannot reuse its proof while a new run is busy', { timeout: 6000 }, async t => {
  const f = await fixture(t, 'old_owner')
  await assert.rejects(f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 }))
  const saved = f.prepare(); assert.ok(saved)
  f.simulated.verify = (_, actual) => null
  const next = f.runtime.operations.foraging.execute({ targetRuntimeId: '2955', maxSteps: 1 }); const rejected = assert.rejects(next)
  assert.equal(f.runtime.snapshot().foraging.busy, true)
  assert.equal(f.foragingOptions.verifyQueuedLanding({ ...saved.request, mode: 'consume', proof: saved.proof }), null)
  await f.runtime.operations.foraging.stop('fixture_new_owner_cleanup'); await rejected
})
