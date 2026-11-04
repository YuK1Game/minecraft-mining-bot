'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const file = path.resolve(__dirname, 'combat-coordinator.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture };', file)
const { fixture } = loaded.exports

test('explicit stuck approach can close on an 8m hostile before any melee request and waits for real death evidence', async () => {
  let admitted = 0
  const f = fixture({ targetX: 8.5, canAcquireMeleeApproach: () => { admitted++; return true }, approachHook: ({ state, actor, args }) => {
    assert.equal(args.maxStepDistance, 6); assert.deepEqual(args.desiredDistance, { min: 1.8, max: 2.2 }); assert.equal(f.meleeCalls.length, 0)
    state.position.x = actor.position.x - 2; return { accepted: true, partialApproach: true, targetReached: false, serverConfirmed: false }
  }, meleeHook: ({ target, stopped }) => { target.alive = false; target.lastEvent = { event: 'death_animation' }; return stopped('DURATION_LIMIT') } })
  const result = await f.coordinator.tick()
  assert.equal(admitted, 2); assert.equal(f.approaches.length, 1); assert.equal(f.meleeCalls.length, 1); assert.equal(f.rangedCalls.length, 0)
  assert.equal(result.targetDead, true); assert.equal(result.serverConfirmed, true); assert.equal(result.confirmedBy, 'server_actor_death_animation')
  assert.equal(f.acquisitions.length, 1); assert.equal(f.resumes.length, 1)
})
test('stuck opt-in covers canonical ranged-standoff distances up to24 and still needs a real close position', async () => {
  let steps = 0
  const f = fixture({ targetX: 16.5, canAcquireMeleeApproach: () => true, approachHook: ({ state, actor }) => { steps++; state.position.x = Math.min(state.position.x + 5.5, actor.position.x - 2); return { accepted: true, partialApproach: true, targetReached: false } } })
  const result = await f.coordinator.tick(); assert.equal(result.targetDead, true); assert.equal(steps, 3); assert.equal(f.meleeCalls.length, 1)
  const beyond = fixture({ targetX: 25.5, maxChaseDistance: 24, canAcquireMeleeApproach: () => true, approachHook: () => assert.fail('beyond chase bound') })
  assert.equal((await beyond.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(beyond.acquisitions.length, 0)
})
test('far no-ammo retains resource work by default and when explicit stuck predicate is false or revoked', async () => {
  for (const predicate of [undefined, () => false]) {
    const f = fixture({ targetX: 8.5, canAcquireMeleeApproach: predicate, approachHook: () => assert.fail('no admission') })
    assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(f.resourceMoving(), true); assert.equal(f.acquisitions.length, 0)
  }
  let calls = 0
  const revoked = fixture({ targetX: 8.5, canAcquireMeleeApproach: () => ++calls === 1, approachHook: () => assert.fail('revoked') })
  assert.equal((await revoked.coordinator.tick()).code, 'APPROACH_ADMISSION_REVOKED'); assert.equal(revoked.acquisitions.length, 0)
})
test('ready near melee and owned far bow keep priority over optional approach admission', async () => {
  const near = fixture({ canAcquireMeleeApproach: () => assert.fail('near never needs fallback'), approachHook: () => assert.fail('near approach') })
  await near.coordinator.tick(); assert.equal(near.meleeCalls.length, 1)
  const bow = fixture({ targetX: 8.5, bow: true, canAcquireMeleeApproach: () => assert.fail('real bow has priority'), approachHook: () => assert.fail('bow approach') })
  await bow.coordinator.tick(); assert.equal(bow.rangedCalls.length, 1)
})
test('unknown identity/life, cancellation and unsafe stance never become a melee request or kill', async () => {
  for (const mode of ['uid', 'life', 'cancel', 'no_stance']) {
    const f = fixture({ targetX: 8.5, canAcquireMeleeApproach: () => true, approachHook: ({ state, target, coordinator }) => {
      if (mode === 'uid') target.uniqueId = '-999'
      if (mode === 'life') state.lifecycle.deathId++
      if (mode === 'cancel') coordinator.cancel('manual stop')
      return mode === 'no_stance' ? { ready: false, reason: 'No known bounded melee stance' } : { accepted: true }
    } })
    const result = await f.coordinator.tick()
    assert.equal(result.code, { uid: 'TARGET_CHANGED', life: 'SESSION_CHANGED', cancel: 'CANCELLED', no_stance: 'APPROACH_NOT_READY' }[mode])
    assert.equal(result.targetDead, false); assert.equal(result.serverConfirmed, false); assert.equal(f.meleeCalls.length, 0); assert.equal(f.resumes.length, 1)
    if (mode === 'no_stance') { assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(f.approaches.length, 1) }
  }
  for (const change of [{ positionKnown: false }, { uniqueId: null }]) {
    const f = fixture({ targetX: 8.5, canAcquireMeleeApproach: () => true, approachHook: () => assert.fail('unknown') }); Object.assign(f.target, change)
    assert.equal((await f.coordinator.tick()).code, 'NO_CANDIDATE'); assert.equal(f.acquisitions.length, 0)
  }
})
