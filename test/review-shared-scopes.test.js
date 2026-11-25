'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ensureSharedScopes,
  registerScopeKey,
  resetSessionScope,
  resetLifeScope,
  resetModeScope,
  summarizeScopes
} = require('../src/common/shared-scopes')
const { createRuntimePorts } = require('../src/runtime/runtime-ports')

test('shared-scopes: isolates persistent, session, life and mode buckets across resets', () => {
  const shared = { legacyLifeFlag: true, legacyModeFlag: 'x' }
  const scopes = ensureSharedScopes(shared)
  scopes.persistent.keep = 'forever'
  scopes.session.conn = 'c1'
  scopes.life.attack = 'mob1'
  scopes.mode.goal = 'house'
  registerScopeKey(shared, 'life', 'legacyLifeFlag')
  registerScopeKey(shared, 'mode', 'legacyModeFlag')

  assert.equal(resetLifeScope(shared, 'c1:1'), true)
  assert.equal(resetLifeScope(shared, 'c1:1'), false, 'same life key is idempotent')
  assert.equal(scopes.life.attack, undefined)
  assert.equal('legacyLifeFlag' in shared, false)
  assert.equal(scopes.session.conn, 'c1')
  assert.equal(scopes.persistent.keep, 'forever')

  assert.equal(resetModeScope(shared, 'player'), true)
  assert.equal(scopes.mode.goal, undefined)
  assert.equal('legacyModeFlag' in shared, false)

  assert.equal(resetSessionScope(shared, 'c2'), true)
  assert.equal(scopes.session.conn, undefined)
  assert.equal(scopes.persistent.keep, 'forever')

  const summary = summarizeScopes(shared)
  assert.equal(summary.meta.sessionResets, 1)
  assert.equal(summary.meta.lifeResets, 1)
  assert.equal(summary.meta.modeResets, 1)
  assert.equal(summary.counts.persistent, 1)
})

test('runtime-ports: exposes grouped port views backed by live rt bindings', () => {
  let disposed = false
  const logs = []
  const rt = {
    host: { shared: { inventoryUncertain: false }, world: { id: 'w' }, entities: { id: 'e' }, log: msg => logs.push(msg), getLife: () => ({ deathId: 2 }) },
    raw: () => ({ health: 18 }),
    working: () => ({ health: 18, phase: 'spawned' }),
    inventory: () => ({ known: true, items: [] }),
    operations: { movement: { snapshot: () => ({ phase: 'idle' }), stop: () => 'stopped' } },
    require: name => name,
    __dirname: '/src',
    get disposed () { return disposed }
  }
  const ports = createRuntimePorts(rt)
  ports.host.log('hello')
  assert.deepEqual(logs, ['hello'])
  assert.equal(ports.state.raw().health, 18)
  assert.equal(ports.inventory.isUncertain(), false)
  assert.equal(ports.motion.stop('test'), 'stopped')
  assert.equal(ports.lifecycle.isDisposed(), false)
  disposed = true
  assert.equal(ports.lifecycle.isDisposed(), true)
})

test('runtime-ports: inventory reads received state while the production inventory action controller remains separate', () => {
  let inventory = { known: false, items: [] }
  const actions = { snapshot: () => ({ busy: false }) }
  const ports = createRuntimePorts({ inventory: actions, working: () => ({ inventory }) })
  assert.equal(ports.inventory.actions, actions)
  assert.equal(ports.inventory.read().known, false)
  inventory = { known: true, items: [{ name: 'minecraft:stone', count: 3 }] }
  assert.equal(ports.inventory.read(), inventory)
})
