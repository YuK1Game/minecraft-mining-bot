'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')

const fixturePath = require.resolve('./quarry-portable-storage.test')
const fixtureModule = new Module(fixturePath, module)
fixtureModule.filename = fixturePath
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixturePath))
fixtureModule._compile(fs.readFileSync(fixturePath, 'utf8').split('\ntest(')[0] + '\nmodule.exports = fixture\n', fixturePath)

const copy = value => structuredClone(value)
const eyeAt = p => ({ x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 })
const feetOf = p => ({ x: Math.floor(p.x), y: Math.floor(p.y - 1.62 + 0.001), z: Math.floor(p.z) })
const key = p => [p.x, p.y, p.z].join(',')
function groundPath (from, to) {
  assert.equal(from.y, to.y)
  const steps = [copy(from)], cursor = copy(from)
  for (const axis of ['x', 'z']) {
    while (cursor[axis] !== to[axis]) {
      cursor[axis] += Math.sign(to[axis] - cursor[axis])
      steps.push(copy(cursor))
    }
  }
  return steps
}

async function placedBox () {
  const f = fixtureModule.exports('shulker', { pickupOnMove: true })
  const interrupted = new AbortController()
  let cp = null
  await f.run({ signal: interrupted.signal, onCheckpoint: async checkpoint => {
    if (checkpoint.stage === 'placed' && checkpoint.placed.length === 1) { cp = copy(checkpoint); interrupted.abort() }
  } })
  assert.equal(cp.placed[0].confirmedBy, 'server_block_and_inventory')
  const relocated = offset => { f.state.position = eyeAt({ ...cp.stand, x: cp.stand.x + offset }) }
  relocated(16)
  f.events.length = 0
  const control = new AbortController(), faults = {}, plans = [], trips = [], attempts = [], seen = new Set()
  const expectedOwner = { jobId: cp.jobId, operationId: cp.operationId, scope: cp.scope }
  const checkOwner = owner => {
    assert.equal(owner.jobId, expectedOwner.jobId)
    assert.equal(owner.operationId, expectedOwner.operationId)
    assert.deepEqual(owner.scope, expectedOwner.scope)
  }
  const travel = (p, owner) => {
    checkOwner(owner); seen.add(key(p))
    return p.x >= -8 && p.x <= 25 && p.z >= -8 && p.z <= 8 && !(faults.denyHead && p.x === cp.stand.x + 8 && p.y === cp.stand.y + 1)
  }
  const options = {
    ...f.dependencies,
    getPath: async (origin, goal, owner) => {
      checkOwner(owner)
      const path = groundPath(origin, goal)
      plans.push({ origin: copy(origin), target: copy(goal), path: copy(path) })
      if (faults.abort) control.abort()
      if (faults.originMoved) relocated(17)
      if (faults.noPath) return null
      if (faults.badStart) return path.slice(1)
      if (faults.badEnd) return path.slice(0, -1)
      return path
    }, travel,
    moveTo: async (goal, settings) => {
      attempts.push(copy(goal))
      assert.equal(settings.signal, control.signal)
      assert.equal(typeof settings.travel, 'function')
      assert.deepEqual(settings.path, plans.at(-1).path)
      assert.deepEqual(settings.path[0], feetOf(f.state.position))
      assert.deepEqual(settings.path.at(-1), goal)
      for (const p of settings.path) {
        assert.ok(seen.has(key(p)), 'feet must be checked before movement')
        assert.ok(seen.has(key({ ...p, y: p.y + 1 })), 'head must be checked before movement')
      }
      assert.equal(settings.travel(goal), true)
      assert.equal(settings.travel({ ...goal, x: 9999 }), false)
      trips.push({ from: copy(settings.path[0]), to: copy(goal) })
      return f.dependencies.moveTo(goal, settings)
    }
  }
  const runner = createQuarryPortableStorage(options)
  f.controller.ownsShulker = runner.ownsShulker
  const run = (onCheckpoint = async () => {}) => runner.storeCarried({ ...f.request, checkpoint: cp }, { canPlace: () => true, signal: control.signal, onCheckpoint })
  return { cp, f, control, faults, plans, trips, attempts, relocated, run }
}

test('after combat each placed-box return uses fresh feet, its own permitted path, and the active owner', async () => {
  const { cp, f, relocated, plans, trips, run } = await placedBox()
  const result = await run(async checkpoint => {
    if (checkpoint.stage === 'breaking' && checkpoint.intent?.type === 'break') relocated(22)
    if (checkpoint.stage === 'awaiting_recovery') relocated(18)
  })
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.recovered, true)
  assert.deepEqual(plans.map(p => p.origin), [16, 22, 18].map(offset => ({ ...cp.stand, x: cp.stand.x + offset })))
  assert.deepEqual(trips.map(t => t.to), [cp.stand, cp.stand, cp.placed[0].position])
  assert.deepEqual(result.checkpoint.placed, cp.placed)
  assert.equal(result.checkpoint.operationId, cp.operationId)
  assert.equal(f.events.filter(e => e.type === 'place').length, 0)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  assert.deepEqual(result.deposited, [{ name: 'minecraft:dirt', count: 8 }])
})

test('unknown, truncated, disallowed, interrupted or stale return paths cannot move or reuse a placed box', async t => {
  for (const fault of ['noPath', 'badStart', 'badEnd', 'denyHead', 'abort', 'originMoved']) await t.test(fault, async () => {
    const { cp, f, faults, run, attempts } = await placedBox()
    faults[fault] = true
    const result = await run()
    assert.equal(result.status, 'blocked')
    assert.deepEqual(attempts, [])
    assert.deepEqual(result.checkpoint.placed, cp.placed)
    assert.deepEqual(result.checkpoint.positions, cp.positions)
    assert.deepEqual(result.checkpoint.deposited, cp.deposited)
    assert.ok(!f.events.some(e => ['move', 'place', 'deposit', 'mine'].includes(e.type)))
  })
})
