'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vm = require('node:vm')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const copy = value => structuredClone(value)
const prepared = createPhysics({ world: { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }, version: '1.26.60', allowWater: true })

const filename = path.join(__dirname, 'runtime-user-behaviors.test.js')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = 'let testHooks;\n' + source
source = source.replace(/^    '\.\/physics': .+$/m, "    './physics': { createPhysics: options => testHooks.physics(options) }, './navigation': { createNavigator: options => testHooks.navigator(options) }, './movement': { createMovement: options => { wireMovementOptions.push(options); return mockMovement } },")
source = source.replace(/^    '\.\/idle-safety': .+$/m, "    './idle-safety': { createIdleSafety: options => { testHooks.safetyOptions = options; return { snapshot: () => structuredClone(testHooks.protection), start: () => { testHooks.protection.running = true }, stop: async () => { testHooks.safetyStops++; testHooks.protection.running = false }, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) } } },")
source = source.replace("loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", "loaded._compile(testHooks.instrument(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')), filename)")
source += '\nmodule.exports = { scene, setHooks: value => { testHooks = value } }'
const loaded = { exports: {} }
new vm.Script(Module.wrap(source), { filename }).runInThisContext()(loaded.exports, Module.createRequire(filename), loaded, filename, path.dirname(filename))

function fixture (t) {
  const hooks = { protection: { running: true, busy: false, phase: 'observing' }, safetyStops: 0, native: [],
    physics: options => prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }),
    navigator: options => {
      const actual = createNavigator({ ...options, physics: options.physics ?? prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }) })
      return { ...actual, plan: (...args) => { const result = actual.plan(...args); hooks.native.push({ target: copy(args[1]), options: copy(args[2]), result: copy(result) }); return result } }
    },
    instrument: runtimeSource => {
      const ownerDeclaration = '    const owners = { inventory: null, combat: null, hut: null, escape: null }'
      assert.ok(runtimeSource.includes(ownerDeclaration))
      // Test-only access to the actual Root ownership object. No production
      // source or ownership algorithm is replaced by this inspection seam.
      return runtimeSource.replace(ownerDeclaration, ownerDeclaration + '\n    host.__testCombatOwners = owners')
    }
  }
  loaded.exports.setHooks(hooks)
  const f = loaded.exports.scene(t)
  f.shared.autoWanted = true
  f.shared.userBehaviorsEnabled = true
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, positionSource: 'move_entity', dimension: 'overworld', position: { x: 3.9, y: 65, z: 0.5 } }
  f.actors.push(target)
  const context = () => ({ kind: 'combat', claimId: 'combat:controlled-preflight', scope: f.scope(), target: copy(target) })
  hooks.native.length = 0
  hooks.safetyStops = 0
  return { ...f, hooks, target, context }
}

// Since 2026-11-02 an armed hostile within the 4m defence range takes the
// lease without a passive native approach probe; the bound approach still
// proves its own route.
test('an armed claim just outside 2.8m takes the lease and stops Safety once, sending nothing', async t => {
  const f = fixture(t), beforeWire = f.wire.length
  const current = f.facadeOptions.getState(), range = Math.hypot(current.position.x - f.target.position.x, current.position.y - f.target.position.y - 0.9, current.position.z - f.target.position.z)
  assert.ok(range > 2.8 && range < 4)
  const context = f.context(), token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false)
  assert.equal(f.hooks.safetyStops, 1)
  assert.equal(f.mockMovement.snapshot().running, false)
  assert.equal(f.wire.length, beforeWire, 'Passive admission sends no movement or attack packet')
  await f.facadeOptions.resumeControl({ ...context, token })
})

// Aggressive policy: another hostile's danger circle no longer vetoes the
// fight (it is only stepped around); the claim takes the lease.
test('another outside actor circle does not veto an armed near claim', async t => {
  const f = fixture(t)
  const other = { runtimeId: '71', uniqueId: '-701', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, positionSource: 'move_entity', dimension: 'overworld', position: { x: 6.4, y: 65, z: 0.5 } }
  f.actors.push(other)
  const current = f.facadeOptions.getState(), canonical = evaluateThreats(current, current.entities, { observationRadius: 32 })
  assert.ok(canonical.outsideDanger.some(actor => actor.runtimeId === other.runtimeId && actor.dangerRadius === 5))
  const beforeMotion = f.mockMovement.snapshot(), beforeWire = f.wire.length
  const context = f.context(), token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false)
  await f.facadeOptions.resumeControl({ ...context, token })
})
test.skip('(superseded) outside actor circle kept Safety running', async t => {
  const f = fixture(t), beforeMotion = f.mockMovement.snapshot(), beforeWire = f.wire.length
  assert.equal(f.hooks.safetyStops, 0)
  assert.equal(f.hooks.protection.running, true)
  assert.deepEqual(f.mockMovement.snapshot(), beforeMotion)
  assert.equal(f.wire.length, beforeWire)
})

test('an unarmed claim preserves the actual owned escape and its fresh confirmed moving frame', async t => {
  const f = fixture(t)
  f.target.position.x = 2.2 // Already within ordinary fist range: the escape veto must run first.
  const owner = { operationId: 'controlled-owned-escape' }
  f.host.__testCombatOwners.escape = owner
  Object.assign(f.hooks.protection, { running: true, busy: true, active: 'escape', phase: 'escaping' })
  f.setMovement({ phase: 'moving', running: true, route: { operation: 'navigate' }, queuedReceiptConfirmed: true, queuedAt: Date.now(), queuedTick: '1001', sent: 1, serverConfirmed: false })
  const before = f.mockMovement.snapshot(), beforeWire = f.wire.length
  const token = await f.facadeOptions.acquireControl(f.context())
  assert.equal(token.acquired, false)
  assert.equal(f.host.__testCombatOwners.escape, owner)
  assert.deepEqual(f.mockMovement.snapshot(), before)
  assert.equal(f.hooks.safetyStops, 0)
  assert.equal(f.hooks.protection.running, true)
  assert.equal(f.hooks.native.length, 0, 'The owned unarmed escape veto precedes attack and route surveys')
  assert.equal(f.wire.length, beforeWire)
})
