'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createChest } = require('../src/chest')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const { createCombatCoordinator } = require('../src/combat-coordinator')
const { createCombatExposure } = require('../src/combat-exposure')
const receivedInventory = require('./fixtures/inventory-resync-nonempty.json')

// Reuse the real Runtime scene with controlled services, without running the
// unrelated survival tests. Configuration is applied before Runtime creation.
function loadFixture () {
  const filename = require.resolve('./runtime-survival.test.js')
  let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  const marker = '  const create = () => { const runtime = loadRuntime(overrides)(host);'
  assert.ok(source.includes(marker), 'Runtime scene exposes its construction boundary')
  source = source.replace('function fixture (t)', 'function fixture (t, configure)')
    .replace(marker, '  configure({ overrides, host, crafting, food, mining, inventory });\n' + marker)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(source + '\nmodule.exports = fixture\n', filename)
  return loaded.exports
}
const scene = loadFixture()
function fixture (t, configure = () => {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  return scene(t, configure)
}

test('Runtime idle gates read lightweight chest metadata and each controller once per decision', t => {
  const reads = { craftingFull: 0, chestFull: 0, chestStatus: 0, combat: 0 }
  const flags = { chestBusy: false, combatBusy: false }
  const f = fixture(t, ({ overrides, crafting }) => {
    const craftSnapshot = crafting.snapshot
    crafting.status = () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null })
    crafting.snapshot = () => { reads.craftingFull++; return craftSnapshot() }
    overrides['./chest'] = { createChest: options => {
      const actual = createChest(options)
      return { ...actual,
        status: () => { reads.chestStatus++; return { ...actual.status(), busy: flags.chestBusy } },
        snapshot: () => { reads.chestFull++; return { ...actual.snapshot(), busy: flags.chestBusy } }
      }
    } }
    const createCombat = overrides['./combat'].createCombat
    overrides['./combat'] = { createCombat: options => {
      const actual = createCombat(options)
      return { ...actual, snapshot: () => { reads.combat++; return { ...actual.snapshot(), busy: flags.combatBusy } } }
    } }
  })
  const reset = () => { for (const key of Object.keys(reads)) reads[key] = 0 }
  reset()
  for (let i = 0; i < 100; i++) assert.equal(f.runtime.canReload(), true)
  assert.deepEqual(reads, { craftingFull: 0, chestFull: 0, chestStatus: 100, combat: 100 })

  flags.chestBusy = true
  assert.equal(f.runtime.canReload(), false, 'the next decision observes a newly busy chest')
  flags.chestBusy = false
  flags.combatBusy = true
  assert.equal(f.runtime.canReload(), false, 'the next decision observes a newly busy combat controller')
  flags.combatBusy = false
  assert.equal(f.runtime.canReload(), true)

  reset()
  f.host.shared.quarrySurfaceStorageOwner = { scope: 'another operation' }
  assert.equal(f.runtime.canReload(), false)
  assert.deepEqual(reads, { craftingFull: 0, chestFull: 0, chestStatus: 0, combat: 0 }, 'early ownership gates remain lazy')
  delete f.host.shared.quarrySurfaceStorageOwner
  assert.equal(f.events.length, 0, 'status reads do not send actions')
})

test('Runtime resync reports the precise remaining cooldown and only a new full receipt completes it', t => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const wire = []
  const f = fixture(t, ({ host }) => { host.client.queue = (name, packet) => wire.push({ name, packet }) })
  f.host.meta.startGame.runtime_entity_id = BigInt(f.raw.runtimeEntityId)
  f.host.shared.deathRespawn = { deathId: 132 }
  f.raw.lifecycle = { phase: 'alive', dead: false, deathId: 132 }
  f.raw.health = 6
  f.runtime.resumeRequested()
  assert.equal(f.runtime.operations.inventory.resync().freshMainObserved, false)
  now += 10000
  assert.throws(() => f.runtime.operations.inventory.resync(), error => error.code === 'RESYNC_RATE_LIMIT' && error.retryAfterMs === 10000)
  assert.equal(wire.filter(packet => packet.name === 'inventory_transaction').length, 1)
  assert.equal(f.runtime.operations.inventory.resyncStatus().freshMainObserved, false)
  f.runtime.applyPacket('inventory_content', structuredClone(receivedInventory.freshMain))
  assert.equal(f.runtime.operations.inventory.resyncStatus().freshMainObserved, true)
  assert.throws(() => f.runtime.operations.inventory.resync(), error => error.code === 'RESYNC_RATE_LIMIT' && error.retryAfterMs === 10000)
  now += 10000
  assert.equal(f.runtime.operations.inventory.resync().freshMainObserved, false, 'an old receipt cannot confirm a new request')
  assert.equal(wire.filter(packet => packet.name === 'inventory_transaction').length, 2)
})

test('Runtime connects the live cooldown and lightweight chest port to both supply and surface workflows', async t => {
  let now = 100000, ports, supplies, surface
  t.mock.method(Date, 'now', () => now)
  const f = fixture(t, ({ overrides, host }) => {
    host.shared.inventoryResync = { lastRequestedAt: 90000 }
    overrides['./quarry-runtime-adapter'] = { createQuarryRuntimeAdapter: options => {
      ports = options
      return createQuarryRuntimeAdapter(options)
    } }
    overrides['./quarry-supplies'] = { createQuarrySupplies: options => {
      supplies = options
      return { discoverBindings: () => [], snapshot: () => ({ busy: false }) }
    } }
    overrides['./quarry-v22-chest-work'] = { createQuarryV22ChestWork: options => {
      surface = options
      return { withdrawAll: async () => ({ phase: 'inspected' }) }
    } }
  })
  await assert.rejects(f.runtime.operations.quarry.configureStorage({}), /job/i)
  assert.ok(ports, 'public quarry configuration initializes the real Runtime adapter')
  ports.discoverSupplies({})
  await ports.loadoutWithdraw({})
  assert.equal(typeof supplies.getRefreshDelay, 'function')
  assert.equal(typeof surface.getRefreshDelay, 'function')
  assert.equal(typeof supplies.chest.status, 'function')
  assert.equal(Object.hasOwn(supplies.chest.status(), 'slots'), false)
  assert.equal(supplies.getRefreshDelay(), 10000)
  assert.equal(surface.getRefreshDelay(), 10000)
  now += 5000
  assert.equal(supplies.getRefreshDelay(), 5000, 'the hook observes the current cooldown on every read')
  assert.equal(surface.getRefreshDelay(), 5000)
})

test('Runtime quarry resync forwards rate limits immediately instead of polling the same rejection', async t => {
  let ports
  t.mock.method(Date, 'now', () => 100000)
  const f = fixture(t, ({ overrides, host }) => {
    host.client.queue = () => assert.fail('a cooldown cannot send a new inventory request')
    host.shared.inventoryResync = { lastRequestedAt: 90000 }
    overrides['./quarry-runtime-adapter'] = { createQuarryRuntimeAdapter: options => {
      ports = options
      return createQuarryRuntimeAdapter(options)
    } }
  })
  f.host.meta.startGame.runtime_entity_id = BigInt(f.raw.runtimeEntityId)
  f.host.shared.deathRespawn = { deathId: 132 }
  f.raw.lifecycle = { phase: 'alive', dead: false, deathId: 132 }
  f.runtime.resumeRequested()
  await assert.rejects(f.runtime.operations.quarry.configureStorage({}), /job/i)
  t.mock.method(global, 'setTimeout', () => assert.fail('the shared retry layer owns the cooldown wait'))
  await assert.rejects(ports.resyncInventory({}), error => error.code === 'RESYNC_RATE_LIMIT' && error.retryAfterMs === 10000)
})

test('Runtime work guards and coordinator engagement share one sight read only inside the current decision', async t => {
  let coordinator, reads = 0, decisions = 0
  const evaluations = []
  const f = fixture(t, ({ overrides, host }) => {
    const getBlock = host.world.getBlock
    host.world.getBlock = (...args) => { reads++; return getBlock(...args) }
    host.world.revision = () => 1
    overrides['./combat-exposure'] = { createCombatExposure: options => {
      const actual = createCombatExposure(options)
      return { ...actual,
        withDecision: work => { decisions++; return actual.withDecision(work) },
        evaluate: (...args) => {
          const before = reads, result = actual.evaluate(...args)
          evaluations.push({ reads: reads - before, intercept: result.intercept })
          return result
        }
      }
    } }
    overrides['./quarry-job'] = { createQuarryJob: () => ({
      holdsWork: () => true, shulkerHold: () => null, document: () => null,
      status: () => ({ state: 'RUNNING' }), configureStorage: async () => ({}),
      pause: () => {}, drain: async () => {},
      bridge: { canSelectTarget: (_target, _state, evidence) => ({ allowed: evidence.intercept }), canContinue: () => ({ allowed: true }) }
    }) }
    overrides['./user-behaviors'] = { createUserBehaviors: options => {
      // Real coordinator and Runtime callbacks. Controllers decline the shot,
      // so this selection test never acquires controls or sends game input.
      const controller = { preview: () => ({ ready: false }), engage: async () => assert.fail('read-only selection'), cancel: () => {}, drain: async () => {}, snapshot: () => ({ busy: false }) }
      coordinator = createCombatCoordinator({ ...options.coordinatorOptions,
        getState: options.getState, entities: options.entities, melee: controller, ranged: controller,
        canAct: () => true, canAcquireMeleeApproach: () => false,
        acquire: async () => assert.fail('read-only selection'), resume: async () => ({ resumed: true })
      })
      return { tick: coordinator.tick, cancel: coordinator.cancel, drain: coordinator.drain, snapshot: coordinator.snapshot, applyPacket: () => {} }
    } }
  })
  f.host.shared.deathRespawn = { deathId: 1 }
  f.raw.lifecycle = { phase: 'alive', dead: false, deathId: 1 }
  f.setItems([['bow', 1, 0], ['arrow', 16, 1]])
  f.actors.push({ ...f.enemy('skeleton', 10), uniqueId: '100', position: { x: 10.5, y: 65, z: 0.5 } })
  await f.runtime.operations.quarry.configureStorage({})
  await coordinator.tick()
  assert.equal(decisions, 1)
  assert.equal(evaluations.length, 2, 'quarry work guard and coordinator both evaluate the actual target')
  assert.equal(evaluations[0].intercept, true)
  assert.equal(evaluations[1].intercept, true)
  assert.ok(evaluations[0].reads > 0)
  assert.equal(evaluations[1].reads, 0, 'only the duplicate sight read is reused')
  evaluations.length = 0
  await coordinator.tick()
  assert.equal(decisions, 2)
  assert.ok(evaluations[0].reads > 0, 'the next decision observes terrain again')
  assert.equal(evaluations[1].reads, 0)
})
