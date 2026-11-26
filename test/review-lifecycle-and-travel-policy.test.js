'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resetSessionScope, resetLifeScope, resetModeScope } = require('../src/common/shared-scopes')
const { createLifecycleSignal, waitForCondition } = require('../src/common/lifecycle-signal')
const { createScheduler } = require('../src/common/runtime-scheduler')
const { createTravelCostPolicy } = require('../src/travel/travel-cost-policy')
const { planCoarseRoute } = require('../src/travel/coarse-route')

test('lifecycle-signal aborts immediately when life, session, or mode scope resets', async () => {
  const shared = {}
  resetSessionScope(shared, 'conn-1')
  resetLifeScope(shared, 'life-1')
  resetModeScope(shared, 'player')

  const lifeToken = createLifecycleSignal({ shared, scopes: ['life'], reasonPrefix: 'ACTION' })
  assert.equal(lifeToken.aborted(), false)
  resetLifeScope(shared, 'life-2')
  assert.equal(lifeToken.aborted(), true)
  assert.equal(lifeToken.reasonCode(), 'ACTION_LIFE_CHANGED')

  // Session reset also aborts life-scoped waiters
  const lifeToken2 = createLifecycleSignal({ shared, scopes: ['life'], reasonPrefix: 'MINE' })
  resetSessionScope(shared, 'conn-2')
  assert.equal(lifeToken2.aborted(), true)
  assert.equal(lifeToken2.reasonCode(), 'MINE_LIFE_CHANGED')

  // Scheduler stops interval automatically when lifecycle signal aborts
  const modeToken = createLifecycleSignal({ shared, scopes: ['mode'], reasonPrefix: 'MODE' })
  let ticks = 0
  const scheduler = createScheduler()
  const entry = scheduler.every('scoped-watch', 10, () => { ticks++ }, { signal: modeToken.signal })
  assert.equal(entry.active(), true)
  resetModeScope(shared, 'quarry')
  assert.equal(entry.active(), false)
  scheduler.disposeAll()

  // waitForCondition resolves cleanly when satisfied or aborts on scope change
  let ready = false
  setTimeout(() => { ready = true }, 20)
  const okWait = await waitForCondition(() => ready, { pollMs: 5, timeoutMs: 500, shared })
  assert.equal(okWait.ok, true)
})

test('travel-cost-policy unifies danger zones, shooter groups, and soft routing penalties in coarse-route', () => {
  const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const grass = { known: true, name: 'minecraft:grass_block', boundingBox: 'block' }
  const getBlock = (x, y, z) => {
    if (Math.abs(x) > 80 || Math.abs(z) > 80) return { known: false }
    return y < 64 ? grass : air
  }

  // Direct line from (0,64,0) to (40,64,0) has a shooter at (20,64,0)
  const feet = { x: 0.5, y: 64, z: 0.5 }
  const destination = { x: 40.5, z: 0.5 }
  const policy = createTravelCostPolicy({
    shooters: [{ x: 20.5, z: 0.5 }],
    feet,
    destination
  })

  assert.equal(policy.isHardAvoided(20, 0), true, 'shooter center is hard avoided')
  assert.equal(policy.isHardAvoided(0, 0), false, 'current feet column is never hard avoided')
  assert.ok(policy.columnPenalty(20, 22) > 0, 'outer ring has soft proximity penalty')

  const route = planCoarseRoute({
    getBlock,
    start: feet,
    goal: destination,
    surfaceOnly: true,
    blocked: policy,
    costPolicy: policy
  })
  assert.equal(route.ready, true)
  assert.equal(route.reached, true)
  for (const step of route.path) {
    assert.ok(Math.hypot(step.x - 20.5, step.z - 0.5) > 17.5, 'coarse route bends cleanly around shooter zone')
  }
})
