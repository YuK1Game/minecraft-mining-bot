'use strict'

// The return's real chest operations and received inventory, including a
// refusal after partial progress and a caller that loses its goal mid-await.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { createContainerPorts } = require('../src/modes/return/container-ports')
const { createReturnSteps } = require('../src/modes/return/return-steps')
const { newGoal } = require('../src/modes/return/return-goal')
const { diamondsNeeded } = require('../src/modes/player-base-kit')

const feet = { x: 6.5, y: GROUND, z: 1.5 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function restockSim (counts = [10, 20]) {
  const sim = createReturnSim({ feet, items: counts.map((count, slot) => [slot, 'diamond', count]) })
  const base = sim.placeChest(5, GROUND, 0)
  sim.shared.playerBase = base
  sim.worn = { known: true, worn: [] }
  counts.forEach((count, slot) => { sim.storeOf(base)[slot] = structuredClone(sim.bag[slot]) })
  sim.die(feet)
  sim.agent.running = true
  return { sim, base }
}
const box = (sim, overrides = {}) => createContainerPorts({ operations: sim.operations, getInventory: sim.inventory, now: sim.now, sleep: sim.sleep, ...overrides })

test('partial restock reports the refused remainder and the return retries known available stock', async () => {
  const { sim, base } = restockSim()
  assert.equal(diamondsNeeded(sim.inventory().items, sim.worn), 29)
  sim.server.transfer = request => request === 2 ? 'reject' : 'ok'
  const runtime = sim.mount(), answers = [], withdraw = runtime.storagePorts.withdraw
  runtime.storagePorts.withdraw = async (...args) => { const out = await withdraw(...args); answers.push(out); return out }
  await runtime.base.tick()
  assert.equal(answers[0].status, 'partial')
  assert.equal(answers[0].progress.confirmedTransferred, 10)
  assert.equal(answers[0].remaining.items, 19)
  assert.equal(sim.held('diamond'), 29)
  assert.equal(sim.stored(base, 'diamond'), 1)
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.agent.starts.length, 1)
})

test('an unconfirmed restock after ten received items keeps the goal and waits for inventory', async () => {
  const { sim } = restockSim()
  sim.server.transfer = request => request === 1 ? 'ok' : 'drop'
  const runtime = sim.mount()
  await runtime.base.tick()
  assert.equal(sim.held('diamond'), 10)
  assert.equal(sim.inventory(), null)
  assert.equal(sim.server.requests.length, 2)
  assert.equal(sim.goal(runtime)?.wait?.kind, 'inventory_update')
  assert.equal(sim.agent.starts.length, 0)
  assert.equal(sim.log.some(line => line.includes('RETURN_DONE')), false)
  sim.server.transfer = 'ok'
  sim.resync()
  await runtime.base.tick()
  assert.equal(sim.held('diamond'), 29)
  assert.equal(sim.goal(runtime), null)
})

test('banking cargo does not hide a refusal to take known stock', async () => {
  const { sim } = restockSim([30])
  sim.give(0, 'emerald', 37)
  sim.server.transfer = request => request === 2 ? 'reject' : 'ok'
  const runtime = sim.mount()
  await runtime.base.tick()
  assert.equal(sim.held('emerald'), 0)
  assert.equal(sim.held('diamond'), 0)
  assert.ok(sim.goal(runtime))
  assert.equal(sim.log.some(line => line.includes('RETURN_DONE')), false)
  await sim.sleep(2000)
  await runtime.base.tick()
  assert.equal(sim.held('diamond'), 29)
  assert.equal(sim.goal(runtime), null)
})

test('taking all available stock finishes without requiring missing supplies', async () => {
  const { sim, base } = restockSim([10])
  const runtime = sim.mount()
  await runtime.base.tick()
  assert.equal(sim.held('diamond'), 10)
  assert.equal(sim.stored(base, 'diamond'), 0)
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.server.requests.length, 1)
})

test('manual stop during a restock sends no later withdrawal, even after inventory resync', async () => {
  const { sim } = restockSim([10, 10, 10])
  let runtime
  sim.server.transfer = request => {
    if (request !== 1) return 'ok'
    queueMicrotask(() => {
      sim.shared.playerWanted = false
      runtime.base.cancel('MANUAL_STOP')
      sim.agent.running = false
      sim.agent.stopUntil = sim.clock + 200
      sim.chest.cancel('プレイヤーモードを停止しました。')
      sim.resync()
    })
    return 'drop'
  }
  runtime = sim.mount()
  await runtime.base.tick()
  assert.equal(sim.server.requests.length, 1)
  assert.equal(sim.held('diamond'), 0)
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.agent.starts.length, 0)
})

test('an open retry checks cancellation after the previous owner finishes', async () => {
  const sim = createReturnSim({ feet }), at = sim.placeChest(5, GROUND, 0)
  let stopped = false
  sim.agent.stopUntil = sim.clock + 200
  const hands = box(sim, { sleep: async ms => { await sim.sleep(ms); stopped = true } })
  const out = await hands.inspect(at, { aborted: () => stopped })
  assert.equal(out.status, 'interrupted')
  assert.equal(sim.events.some(event => event.kind === 'open'), false)
  assert.equal(sim.chest.snapshot().window, null)
})

test('an old deposit finally cannot close a newer chest window', async () => {
  const sim = createReturnSim({ feet, items: [[0, 'emerald', 8]] })
  const at = sim.placeChest(5, GROUND, 0), next = sim.placeChest(5, GROUND, 3)
  const received = deferred(), resume = deferred(), deposit = sim.operations.chest.depositItem
  let stopped = false
  sim.operations.chest.depositItem = async options => { const out = await deposit(options); received.resolve(); await resume.promise; return out }
  const hands = box(sim)
  const old = hands.deposit(at, [{ slot: 0, name: 'minecraft:emerald', count: 8 }], { aborted: () => stopped })
  await received.promise
  stopped = true
  await sim.operations.chest.open(next)
  const window = sim.chest.snapshot().window
  resume.resolve()
  await old
  assert.deepEqual(sim.chest.snapshot().window, window)
  sim.operations.crafting.closeContainer()
})

test('a return uses compatible stack space even when the chest has zero empty slots', async () => {
  const sim = createReturnSim({ feet, items: [[0, 'emerald', 37]] })
  const at = sim.placeChest(5, GROUND, 0, { fill: 27 })
  sim.storeOf(at)[0] = { ...structuredClone(sim.bag[0]), count: 1, stack_id: 900 }
  sim.shared.playerBase = at
  sim.agent.running = true
  const runtime = sim.mount()
  await runtime.base.tick()
  assert.equal(sim.held('emerald'), 0)
  assert.equal(sim.stored(at, 'emerald'), 38)
  assert.equal(sim.events.some(event => event.kind === 'place_chest'), false)
  assert.equal(sim.goal(runtime), null)
})

test('a deposit splits across compatible remaining stack space and reports only the remainder full', async () => {
  const sim = createReturnSim({ feet, items: [[0, 'emerald', 10]] })
  const at = sim.placeChest(5, GROUND, 0, { fill: 27 })
  for (const slot of [0, 1]) sim.storeOf(at)[slot] = { ...structuredClone(sim.bag[0]), count: 60, stack_id: 900 + slot }
  const out = await box(sim).deposit(at, [{ slot: 0, name: 'minecraft:emerald', count: 10 }])
  assert.equal(out.status, 'partial')
  assert.equal(out.code, 'CONTAINER_FULL')
  assert.equal(out.progress.confirmedTransferred, 8)
  assert.equal(out.remaining.items, 2)
  assert.deepEqual(sim.server.requests.map(request => request.count), [4, 4])
  assert.equal(sim.held('emerald'), 2)
  assert.equal(sim.stored(at, 'emerald'), 128)
})

test('same-name stacks with different item metadata are never merged', async () => {
  const sim = createReturnSim({ feet, items: [[0, 'emerald', 10]] })
  const at = sim.placeChest(5, GROUND, 0, { fill: 27 })
  sim.storeOf(at)[0] = { ...structuredClone(sim.bag[0]), count: 1, metadata: 1, stack_id: 900 }
  const out = await box(sim).deposit(at, [{ slot: 0, name: 'minecraft:emerald', count: 10 }])
  assert.equal(out.code, 'CONTAINER_FULL')
  assert.equal(out.progress.confirmedTransferred, 0)
  assert.equal(sim.server.requests.length, 0)
  assert.equal(sim.held('emerald'), 10)
})

test('a stale house exit cannot start the following long travel', async () => {
  let live = true, indoors = true, trips = 0
  const goal = newGoal({ id: 'house-exit', base: { x: 100, y: GROUND, z: 0 }, scope: 'life-1', now: 0 })
  const steps = createReturnSteps({
    goal: () => goal,
    ports: {
      getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }),
      getPosition: () => ({ x: 0.5, y: GROUND + 1.62, z: 0.5 }),
      getFeet: () => ({ x: 0.5, y: GROUND, z: 0.5 }),
      moves: {
        water: { needed: () => false },
        house: { inside: () => indoors, leave: async () => { indoors = false; live = false; return true } },
        travel: { to: async () => { trips++ }, status: () => ({ busy: false }), cancel: async () => {} }
      }
    },
    flow: { ok: () => live, interrupter: () => null, say () {}, now: () => 0, sleep: async () => {} }
  })
  const out = await steps.travel()
  assert.equal(out.status, 'cancelled')
  assert.equal(trips, 0)
})

test('an interrupted return cannot cancel the newer owner\'s travel', async () => {
  let who = null, cancellations = 0
  let trip = { busy: true, startedAt: 'return', destination: { x: 100, z: 0 } }
  const goal = newGoal({ id: 'travel-owner', base: { x: 100, y: GROUND, z: 0 }, scope: 'life-1', now: 0 })
  const steps = createReturnSteps({
    goal: () => goal,
    ports: {
      getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }),
      getPosition: () => ({ x: 0.5, y: GROUND + 1.62, z: 0.5 }),
      moves: {
        water: { needed: () => false }, house: { inside: () => false },
        travel: { to: async () => trip, status: () => trip, cancel: async () => { cancellations++ } }
      }
    },
    flow: {
      ok: () => true, interrupter: () => who, say () {}, now: () => 0,
      sleep: async () => { who = 'ほかの作業'; trip = { busy: true, startedAt: 'new-owner', destination: { x: 100, z: 0 } } }
    }
  })
  assert.equal((await steps.travel()).status, 'interrupted')
  assert.equal(cancellations, 0)
})
