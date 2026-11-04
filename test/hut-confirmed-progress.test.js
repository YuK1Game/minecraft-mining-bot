'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createAutonomy } = require('../src/autonomy')
const copy = value => structuredClone(value)
const file = path.resolve(__dirname, 'hut.test.js')
const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const target = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: file }).runInThisContext()(target.exports, Module.createRequire(file), target, file, path.dirname(file))

async function opened () {
  const f = target.exports.fixture()
  await f.hut.execute({ radius: 0 }); await f.hut.leave()
  const memo = f.hut.memo(); const entry = memo.site.insideStandpoint
  f.state.health = 13
  f.state.position = { x: entry.x - 8, y: entry.y + 1.62, z: entry.z + 1 }
  f.state.rawServerPosition = copy(f.state.position); f.state.rawServerPositionUpdatedAt = 100
  f.state.positionUpdatedAt = 100; f.state.positionSource = 'correct_player_move_prediction'
  return { ...f, memo, entry }
}
function correctedController (f, mode = 'progress') {
  let motion = { phase: 'idle' }
  const original = f.movement.start
  const movement = { ...f.movement, start: target => {
    const before = copy(f.state.position)
    const point = { x: (before.x + target.x) / 2, y: target.y, z: (before.z + target.z) / 2 }
    if (mode === 'away') point.x = before.x - 1
    original(point)
    if (mode !== 'stationary') f.state.rawServerPosition = copy(f.state.position)
    if (mode !== 'stale') f.state.rawServerPositionUpdatedAt++
    f.state.positionUpdatedAt = f.state.rawServerPositionUpdatedAt
    if (mode === 'damage') f.state.health--
    if (mode === 'scope') f.state.connectionId = 'another-connection'
    motion = { phase: 'replan_required' }
    return motion
  }, stop: reason => { f.movement.stop(reason); motion = { phase: 'stopped' } } }
  return f.create({ memo: f.memo, movement, getMovement: () => motion })
}

test('a fresh received correction toward the Hut yields an incomplete confirmed-progress batch and drains old movement', async () => {
  const f = await opened(); const hut = correctedController(f)
  const before = copy(hut.memo())
  const result = await hut.execute()
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'progress')
  assert.equal(result.progressConfirmed, true)
  assert.equal(result.arrived, false)
  assert.equal(result.goalComplete, false)
  assert.equal(result.closed, false)
  assert.equal(result.inside, false)
  assert.equal(result.collected, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.requiresObservation, true)
  assert.equal(result.busy, false)
  assert.ok(result.progress.receivedProgress > 3)
  assert.ok(result.progress.closerBy > 3)
  assert.equal(hut.memo().stepIndex, before.stepIndex)
  assert.deepEqual(hut.memo().placements, before.placements)
  assert.equal(hut.memo().pendingPlacement, null)
  assert.ok(f.calls.some(call => call.type === 'move_stop'))
})

test('stale, stationary, wrong-way, damaged and changed-session corrections remain failures', async () => {
  for (const mode of ['stale', 'stationary', 'away', 'damage', 'scope']) {
    const f = await opened(); const hut = correctedController(f, mode)
    await assert.rejects(hut.execute(), error => ['REPLAN_REQUIRED', 'TOOK_DAMAGE', 'SESSION_CHANGED'].includes(error.code), mode)
    assert.notEqual(hut.snapshot().phase, 'progress', mode)
    assert.equal(hut.snapshot().closed, false, mode)
    assert.equal(hut.snapshot().busy, false, mode)
  }
})

test('historical open doors report only the real missing dirt inventory and close only after two fresh spends', async () => {
  const f = await opened()
  f.setDirt(0)
  assert.deepEqual(f.hut.snapshot().closureMaterials, { item: 'minecraft:dirt', requiredDirt: 2, availableDirt: 0, missingDirt: 2, requiresServerInventory: true })
  f.setDirt(1)
  assert.equal(f.hut.preview().closureMaterials.missingDirt, 1)
  f.setDirt(2)
  const result = await f.hut.execute()
  assert.equal(result.closed, true)
  assert.equal(result.inside, true)
  assert.equal(f.countDirt(), 0)
  assert.equal(result.closureMaterials.missingDirt, 0)
})

test('Autonomy treats successive confirmed Hut progress batches as returns rather than action failures', async t => {
  const f = await opened(); const hut = correctedController(f)
  let actions = 0
  const autonomy = createAutonomy({ getState: () => ({ ...copy(f.state), entities: [] }), observe: () => ({ blocks: [], threats: [], capabilities: {} }), planAction: () => ({ type: 'return_shelter', stage: 'safety', reason: 'Return to the own Hut' }), actions: { return_shelter: async () => { actions++; return hut.execute() } }, intervalMs: 60000 })
  t.after(() => autonomy.stop())
  autonomy.start({ objective: 'diamond', diamondCount: 1, maxActionFailures: 3 })
  for (let i = 0; i < 3; i++) await autonomy.tick()
  assert.equal(actions, 3)
  assert.equal(autonomy.snapshot().progress.failures, 0)
  assert.equal(autonomy.snapshot().progress.actionsReturned, 3)
  assert.equal(autonomy.snapshot().running, true)
  assert.equal(autonomy.snapshot().lastActionResult.goalComplete, false)
})

test('a soil-hill shelter also yields fresh received approach progress without claiming closure', async () => {
  const shelterFile = path.resolve(__dirname, 'shelter.test.js')
  const shelterSource = fs.readFileSync(shelterFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  const loaded = { exports: {} }
  new vm.Script(Module.wrap(shelterSource + '\nmodule.exports = { fixture }'), { filename: shelterFile }).runInThisContext()(loaded.exports, Module.createRequire(shelterFile), loaded, shelterFile, path.dirname(shelterFile))
  const f = loaded.exports.fixture()
  await f.shelter.execute({ radius: 0 }); await f.shelter.leave()
  const memo = f.shelter.memo(); const target = memo.site.initialSteps[0].target
  f.state.health = 13
  f.state.position = { x: target.x - 4, y: target.y + 1.62, z: target.z }
  f.state.rawServerPosition = copy(f.state.position); f.state.rawServerPositionUpdatedAt = 100
  let motion = { phase: 'idle' }
  const movement = { ...f.movement, start: point => {
    const actual = { x: (f.state.position.x + point.x) / 2, y: point.y, z: point.z }
    f.movement.start(actual)
    f.state.rawServerPosition = copy(f.state.position); f.state.rawServerPositionUpdatedAt++
    motion = { phase: 'replan_required' }; return motion
  }, stop: reason => { f.movement.stop(reason); motion = { phase: 'stopped' } } }
  const shelter = f.create({ memo, planner: () => copy(memo.site), movement, getMovement: () => motion })
  const result = await shelter.execute()
  assert.equal(result.ok, true)
  assert.equal(result.progressConfirmed, true)
  assert.equal(result.partial, true)
  assert.equal(result.arrived, false)
  assert.equal(result.closed, false)
  assert.equal(result.goalComplete, false)
  assert.equal(result.collected, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.busy, false)
  assert.deepEqual(shelter.memo().placements, memo.placements)
})
