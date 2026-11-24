'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { attachModeOperations } = require('../src/modes/mode-runtime')
const { createRuntimeOperations } = require('../src/runtime/runtime-operations')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { createLongTravel } = require('../src/travel/long-travel')
const { createReturnSteps } = require('../src/modes/return/return-steps')
const { newGoal } = require('../src/modes/return/return-goal')

test('the public agent stop cancels a return withdrawal through the real mode wiring', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Mode wiring proof stays offline'))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'player-return-wiring-'))
  const feet = { x: 6.5, y: GROUND, z: 1.5 }
  const sim = createReturnSim({ feet, items: [[0, 'diamond', 10], [1, 'diamond', 10], [2, 'diamond', 10]] })
  const base = sim.placeChest(5, GROUND, 0)
  for (let slot = 0; slot < 3; slot++) sim.storeOf(base)[slot] = structuredClone(sim.bag[slot])
  sim.die(feet)
  sim.worn = { known: true, worn: [] }
  Object.assign(sim.shared, { botMode: 'player', playerBase: base, playerHouse: { done: true }, vitals: { hunger: 20 } })
  sim.agent.running = true
  let disposed = false
  const intervals = []
  t.mock.method(Date, 'now', sim.now)
  t.mock.method(globalThis, 'setInterval', (run, ms) => { const timer = { run, ms, unref () {} }; intervals.push(timer); return timer })
  // Advance ordinary port waits with the simulated server, without real sleeps.
  t.mock.method(globalThis, 'setTimeout', (run, ms, ...args) => {
    const timer = { cancelled: false, unref () {} }
    sim.later(ms, () => { if (!timer.cancelled) run(...args) })
    return timer
  })
  const clear = globalThis.clearTimeout
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer && typeof timer === 'object' && 'cancelled' in timer) timer.cancelled = true; else clear(timer) })
  const operations = sim.operations
  operations.quarry = { status: () => null, start () {}, resume () {}, travelStatus: () => ({ busy: false }), cancelTravel () {}, travelTo: () => assert.fail('The restock chest is already in reach') }
  operations.safety = { start () {}, snapshot: () => ({ busy: false }) }
  operations.agent = {
    start: options => { sim.agent.running = true; sim.agent.starts.push(options) },
    stop: reason => {
      sim.agent.running = false; sim.agent.stopUntil = sim.clock; sim.shared.autoWanted = false
      sim.agent.stops.push(reason)
      sim.chest.cancel(reason)
    }
  }
  const host = { shared: sim.shared, world: { getBlock: sim.getBlock }, entities: { snapshot: () => [] }, log: line => sim.log.push(line) }
  const runtime = {
    host: () => host, disposed: () => disposed,
    raw: () => ({ ...sim.state, position: sim.getPosition(), inventory: sim.inventory() }),
    position: sim.getPosition, inventory: sim.inventory, mainSlot: sim.mainSlot, armor: () => sim.worn, scope: sim.scope,
    autonomy: () => ({ snapshot: () => ({ running: sim.agent.running, busy: false, actionActive: false }) }),
    motion: () => operations.movement.snapshot(), hostiles: () => [], nearestHostile: () => Infinity,
    chunkMoveHeld: () => false, resetHeld: () => false, manualChestStorage: () => null, combatOwns: () => false,
    travel: () => ({ travelClock: () => ({ night: false }) })
  }
  const mode = attachModeOperations(operations, runtime, { root })
  t.after(async () => { disposed = true; sim.chest.cancel('test cleanup'); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })
  let stoppedAt = null
  sim.server.transfer = request => {
    if (request !== 1) return 'ok'
    queueMicrotask(() => {
      stoppedAt = sim.clock
      operations.agent.stop('manual stop through public operations')
      sim.resync()
    })
    return 'drop'
  }
  const tick = intervals.find(timer => timer.ms === 2000)
  assert.ok(tick, 'The actual mode timer must drive the return')
  tick.run()
  for (let i = 0; i < 40 && stoppedAt == null; i++) await sim.sleep(200)
  assert.notEqual(stoppedAt, null, JSON.stringify(sim.log))
  for (let i = 0; i < 40; i++) await sim.sleep(200)
  assert.equal(sim.shared.playerWanted, false)
  assert.equal(mode.status().player.wanted, false)
  assert.equal(sim.shared.playerReturn, null)
  assert.equal(sim.server.requests.length, 1, 'No new request after the public stop, including after resync')
  assert.equal(sim.agent.starts.length, 0)
  assert.equal(sim.held('diamond'), 0)
})

test('a cancelled return cannot start long travel after its saved route finishes loading', async () => {
  let release, entered, cancelled = false
  const loading = new Promise(resolve => { entered = resolve })
  const saved = new Promise(resolve => { release = resolve })
  const starts = []
  const runtime = {
    host: { shared: {} },
    require: name => {
      if (name === './modes/mode-runtime') return { attachModeOperations () {} }
      if (name === './modes/dragon-ports') return { createDragonRuntimePorts: () => ({}) }
      if (name === './modes/player-workstation-runtime') return { createPlayerWorkstationRuntime: () => ({}) }
      assert.equal(name, 'node:fs/promises')
      return { readFile: () => { entered(); return saved } }
    },
    travelRuntime: { longTravelFile: () => 'unused-saved-route.json' },
    ensureLongTravel: () => ({ start: input => { starts.push(input); return { busy: true } } })
  }
  const { operations } = createRuntimeOperations(runtime)
  const pending = operations.quarry.travelTo({ destination: { x: 100, z: 0 } }, { aborted: () => cancelled })
  await loading
  cancelled = true
  release(JSON.stringify({ destination: { x: 100, z: 0 }, phase: 'travelling' }))
  await assert.rejects(pending, { code: 'LONG_TRAVEL_CANCELLED' })
  assert.equal(starts.length, 0)
  // Existing manual callers need no new argument and can still resume a route.
  const out = await operations.quarry.travelTo({ destination: { x: 100, z: 0 } })
  assert.equal(out.busy, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].resume.phase, 'travelling')
})

test('resuming the same saved route creates a new travel owner that an old return cannot cancel', async t => {
  const destination = { x: 100, z: 0 }, saved = { destination, phase: 'stopped', legs: 7, startedAt: '2026-11-14T00:00:00.000Z' }
  const persisted = [], receipts = [], cancellations = []
  let who = null
  const travel = createLongTravel({
    getState: () => ({ phase: 'spawned', health: 20, position: { x: 0.5, y: GROUND + 1.62, z: 0.5 } }),
    chunkTravel: { start: () => assert.fail('The test holds before the first leg'), status: () => ({ busy: false }), cancel: async () => {} },
    beforeLeg: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ hold: true }), { once: true })),
    save: async document => { persisted.push(document) }, now: () => 0
  })
  t.after(() => travel.cancel())
  const runtime = {
    host: { shared: {} },
    require: name => {
      if (name === './modes/mode-runtime') return { attachModeOperations () {} }
      if (name === './modes/dragon-ports') return { createDragonRuntimePorts: () => ({}) }
      if (name === './modes/player-workstation-runtime') return { createPlayerWorkstationRuntime: () => ({}) }
      assert.equal(name, 'node:fs/promises')
      return { readFile: async () => JSON.stringify(saved) }
    },
    travelRuntime: { longTravelFile: () => 'unused-saved-route.json' }, ensureLongTravel: () => travel
  }
  const { operations } = createRuntimeOperations(runtime)
  const start = async (input, options) => { const receipt = await operations.quarry.travelTo(input, options); receipts.push(receipt); return receipt }
  const goal = newGoal({ id: 'old-return', base: { ...destination, y: GROUND }, scope: 'life-1', now: 0 })
  const steps = createReturnSteps({
    goal: () => goal,
    ports: {
      getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }),
      getPosition: () => ({ x: 0.5, y: GROUND + 1.62, z: 0.5 }),
      moves: {
        water: { needed: () => false }, house: { inside: () => false },
        travel: { to: start, status: travel.status, cancel: async () => { cancellations.push(travel.status()); return travel.cancel() } }
      }
    },
    flow: {
      ok: () => true, interrupter: () => who, say () {}, now: () => 0,
      sleep: async () => { await travel.cancel(); await start({ destination }); who = 'ほかの作業' }
    }
  })
  assert.equal((await steps.travel()).status, 'interrupted')
  assert.equal(cancellations.length, 0, 'The old return must not cancel the new owner, even with an identical saved route')
  assert.equal(travel.status().busy, true)
  assert.deepEqual(receipts.map(receipt => receipt.startedAt), [saved.startedAt, saved.startedAt], 'The saved journey start remains unchanged')
  assert.deepEqual(receipts[0].destination, receipts[1].destination)
  assert.equal(typeof receipts[0].operationId, 'string')
  assert.notEqual(receipts[0].operationId, receipts[1].operationId)
  assert.equal(persisted.some(document => Object.hasOwn(document, 'operationId')), false, 'Operation ownership is never resumed from the saved route')
})
