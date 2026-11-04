'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const root = path.resolve(__dirname, '..')
const runtimeFile = path.join(root, 'src/runtime.js')
const runtimeText = fs.readFileSync(runtimeFile, 'utf8').replace(/\r\n/g, '\n')
const guardFile = path.join(root, 'src/guarded-route.js')
const guardSource = fs.readFileSync(guardFile, 'utf8').replace(/\r\n/g, '\n')
const guardModule = { exports: {} }
new vm.Script(Module.wrap(guardSource), { filename: guardFile }).runInThisContext()(guardModule.exports, Module.createRequire(guardFile), guardModule, guardFile, path.dirname(guardFile))
const { createGuardedRoute } = guardModule.exports
const hutTestFile = path.join(root, 'test/hut.test.js')
let hutFixtureText = fs.readFileSync(hutTestFile, 'utf8').replace(/\r\n/g, '\n').split("test('hut constructor")[0]
hutFixtureText = hutFixtureText.replace('return { hut, create, state, world,', 'return { getState, getMovement: () => movementState, hut, create, state, world,')
const fixtures = { exports: {} }
new vm.Script(Module.wrap(hutFixtureText + '\nmodule.exports={fixture};'), { filename: hutTestFile }).runInThisContext()(fixtures.exports, Module.createRequire(hutTestFile), fixtures, hutTestFile, path.dirname(hutTestFile))
const body = runtimeText.match(/onReturned: async \(returned, context\) => \{([\s\S]*?)\n      \},\n      onProgress:/)?.[1]
const verifier = runtimeText.match(/    function verifyRouteStanding \(observed, target, \{ signal \} = \{\}\) \{[\s\S]*?\n    \}\s*\n    const routeMovement/)
if (!body || !verifier) throw new Error('Runtime handoff/verifier source was not found')
const verifierSource = verifier[0].replace(/\n    const routeMovement$/, '').trim()
const routeScope = state => ({ profile: state.profile, realmId: state.realm?.id == null ? null : String(state.realm.id), dimension: state.dimension })
const sameScope = (a, b) => a.profile === b.profile && a.realmId === b.realmId && a.dimension === b.dimension

// The actual Hut executor constructs/leaves a real fake-server hut, then its
// real moveTo() raises REPLAN_REQUIRED from a received terminal pose that is
// still outside. Only the actor transport is simulated; no error string is
// manufactured by the test.
async function scenario ({ corrections = 1, mode = 'normal' } = {}) {
  const f = fixtures.exports.fixture()
  f.state.profile = 'bot'; f.state.realm.id = '42'
  await f.hut.execute({ radius: 0 }); await f.hut.leave()
  const plan = f.hut.memo().site
  f.state.inventory.items.push({ slot: 5, name: 'minecraft:stone_sword', count: 1 })
  f.inventory.equip = slot => {
    const selected = f.state.inventory.items.find(item => item.slot === f.state.rawSelectedSlot)
    const item = f.state.inventory.items.find(item => item.slot === slot && item.count > 0)
    if (selected && selected !== item) selected.slot = slot
    item.slot = f.state.rawSelectedSlot; f.state.heldItem = structuredClone(item)
    return { phase: 'completed', serverConfirmed: true }
  }
  let version = 20000; let generation = true; let outwardPending = false; let correctionsSent = 0; let handoffs = 0
  const signals = []; const realErrors = []; const progress = []
  const controller = new AbortController()
  f.state.positionUpdatedAt = version; f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = version
  const outward = { x: plan.outsideStandpoint.x - plan.forward.x, y: plan.outsideStandpoint.y, z: plan.outsideStandpoint.z - plan.forward.z }
  const samePoint = (a, b) => ['x', 'y', 'z'].every(axis => Math.abs(a[axis] - b[axis]) < 1e-6)
  const originalStart = f.movement.start
  const originalStop = f.movement.stop
  f.movement.stop = reason => { outwardPending = false; return originalStop(reason) }
  f.movement.start = (target, options) => {
    const beforeStamp = f.state.positionUpdatedAt
    const beforeRawStamp = f.state.rawServerPositionUpdatedAt
    const result = originalStart(target, options)
    f.state.positionUpdatedAt = ++version
    if (samePoint(target, outward)) {
      f.state.position = { ...plan.outsideStandpoint, y: plan.outsideStandpoint.y + 1.62 }
      f.state.positionSource = 'client_prediction'; outwardPending = true
      return { phase: 'replan_required' }
    }
    if (samePoint(target, plan.insideStandpoint) && correctionsSent++ < corrections) {
      f.state.position = { ...plan.outsideStandpoint, y: plan.outsideStandpoint.y + 1.62 + (mode === 'unsupported' ? 0.2315 : 0) }
      f.state.positionSource = 'correct_player_move_prediction'
      if (mode === 'stale') f.state.positionUpdatedAt = beforeStamp
      f.state.rawServerPosition = { ...f.state.position }; f.state.rawServerPositionUpdatedAt = f.state.positionUpdatedAt
      if (mode === 'stale') f.state.rawServerPositionUpdatedAt = beforeRawStamp
      f.state.predicted.physicsState.onGround = mode !== 'unsupported'
      if (mode === 'damage') f.state.health--
      if (mode === 'scope') f.state.realm.id = 'other'
    }
    return result
  }
  const getState = () => ({ ...f.getState(), hut: f.hut.snapshot(), crafting: { openContainer: null }, entities: [] })
  const requireGeneration = () => { if (!generation) throw Object.assign(new Error('Old motion generation'), { code: 'GENERATION_CHANGED' }) }
  const environment = { requireGeneration, working: f.getState, routeScope, sameRouteScope: sameScope, generationPhysics: require('../src/physics').createPhysics({ world: f.world }), generationMovement: f.movement, motionOrigin: null }
  const verifyRouteStanding = vm.runInNewContext(`(${verifierSource})`, environment)
  const callbackEnvironment = {
    requireGeneration, routeState: getState, host: { shared: { hutMemo: f.hut.memo() } }, routeScope, sameRouteScope: sameScope, verifyRouteStanding,
    closeReturnedHut: async context => {
      handoffs++; signals.push(context.signal)
      try { return await f.hut.execute({}, { signal: context.signal }) } catch (error) {
        realErrors.push({ code: error.code, reason: error.message })
        if (mode === 'generation') generation = false
        if (mode === 'abort') controller.abort(new Error('Explicit handoff cancellation'))
        throw error
      }
    }
  }
  const onReturned = vm.runInNewContext(`(async (returned, context) => {${body}\n})`, callbackEnvironment)
  const guard = createGuardedRoute({ getState, movement: f.movement, getMovement: () => outwardPending ? { phase: 'replan_required' } : f.getMovement(), inventory: f.inventory, combat: { previewEngage: () => ({ ready: false }), engage: () => {}, cancel: () => {}, drain: async () => {} }, verifyStanding: verifyRouteStanding, onReturned, onProgress: e => progress.push(e), pollMs: 10, operationTimeoutMs: 1000 })
  const result = await guard.execute([outward], { signal: controller.signal, timeoutMs: 10000 })
  return { f, result, handoffs, signals, realErrors, progress }
}

test('real Hut REPLAN is retried as a fresh supported batch and preserves the real original Guard interruption', async () => {
  const r = await scenario()
  assert.equal(r.handoffs, 2)
  assert.equal(r.realErrors[0].code, 'REPLAN_REQUIRED')
  assert.match(r.realErrors[0].reason, /Movement correction requires a new hut batch/)
  assert.equal(r.signals[0], r.signals[1], 'all batches share the exact callback AbortSignal')
  assert.equal(r.result.returned, true, r.result.reason)
  assert.equal(r.result.refugeConfirmed, true)
  assert.equal(r.result.outwardCompleted, false)
  assert.equal(r.result.routeInterruption.code, 'NO_MOVEMENT_PROGRESS')
  assert.match(r.result.routeInterruption.reason, /authoritative server observation/)
  assert.equal(r.result.refugeClosure.attempts, 2)
  assert.equal(r.f.hut.snapshot().closed, true)
  assert.equal(r.f.countDirt(), 0, 'two fresh placements consumed actual fake-server dirt')
})

test('three genuine fresh Hut corrections remain bounded and retain route and closure failures separately', async () => {
  const r = await scenario({ corrections: 3 })
  assert.equal(r.handoffs, 3)
  assert.equal(r.realErrors.every(e => e.code === 'REPLAN_REQUIRED'), true)
  assert.equal(r.result.arrived, false)
  assert.equal(r.result.returned, false)
  assert.equal(r.result.routeInterruption.code, 'NO_MOVEMENT_PROGRESS')
  assert.equal(r.result.refugeClosure.code, 'REPLAN_REQUIRED')
  assert.equal(r.result.refugeClosure.attempts, 3)
  assert.equal(r.signals.every(signal => signal === r.signals[0]), true)
  assert.equal(r.f.hut.snapshot().closed, false)
})

test('no stale or unsupported correction is promoted into a fresh closing batch', async () => {
  for (const mode of ['stale', 'unsupported']) {
    const r = await scenario({ mode })
    assert.equal(r.realErrors[0].code, 'REPLAN_REQUIRED')
    assert.equal(r.handoffs, 1)
    assert.equal(r.result.arrived, false)
    assert.equal(r.result.returned, false)
    assert.equal(r.result.routeInterruption.code, 'NO_MOVEMENT_PROGRESS')
    if (mode === 'stale') assert.equal(r.result.refugeClosure.retryBlockedBy, 'stale_pose')
    else { assert.equal(r.result.refugeClosure.code, 'SUPPORT_UNKNOWN'); assert.equal(r.result.refugeClosure.cause.code, 'REPLAN_REQUIRED') }
  }
})

test('actual damage, changed scope, generation and the original abort signal prohibit any handoff retry', async () => {
  for (const mode of ['damage', 'scope', 'generation', 'abort']) {
    const r = await scenario({ mode })
    assert.equal(r.handoffs, 1)
    assert.equal(r.result.returned, false)
    assert.equal(r.result.arrived, false)
    assert.equal(r.result.routeInterruption.code, 'NO_MOVEMENT_PROGRESS')
    if (mode === 'damage') assert.equal(r.realErrors[0].code, 'TOOK_DAMAGE')
    if (mode === 'abort') assert.equal(r.signals[0].aborted, true)
  }
})
