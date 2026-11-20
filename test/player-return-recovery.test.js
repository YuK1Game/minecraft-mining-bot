'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { createContainerPorts } = require('../src/modes/return/container-ports')
const { newGoal, restoreGoal } = require('../src/modes/return/return-goal')

const CARGO = [[0, 'diamond_pickaxe', 1], [1, 'diamond_sword', 1], [2, 'diamond', 40], [3, 'emerald', 5]]
function setup ({ fill = 0 } = {}) {
  const sim = createReturnSim({ feet: { x: 4.5, y: GROUND, z: 2.5 }, items: CARGO })
  const at = sim.shared.playerBase = sim.placeChest(5, GROUND, 0, { fill })
  sim.agent.running = true
  return { sim, at }
}
const finished = (sim, runtime) => () => !sim.goal(runtime) || sim.goal(runtime)?.state === 'held'

// The real chest module receives the exact source rejection. Only the server's
// response and full-inventory refresh are simulated; all return modules run.
function sourceRejection (sim, { refresh = true, stale = false } = {}) {
  const apply = sim.chest.applyPacket
  sim.chest.applyPacket = (name, packet, options) => apply(name, name === 'item_stack_response' ? { ...packet, responses: packet.responses.map(row => row.status === 'error' ? { ...row, status: 49 } : row) } : packet, options)
  const requests = []
  let status = null
  sim.operations.inventory.resync = () => {
    const s = sim.state
    const request = { status: 'REQUEST_SENT', requestSent: true, freshMainObserved: false, requestedAt: new Date(sim.now()).toISOString(), fullCountAtSend: requests.length, scope: { profile: s.profile, realmId: s.realm.id, connectionId: s.connectionId, startedAt: s.startedAt, runtimeEntityId: s.runtimeEntityId, dimension: s.dimension, deathId: s.lifecycle.deathId } }
    requests.push(request)
    status = request
    if (refresh) sim.later(600, () => { sim.resync(); status = { ...request, status: 'FRESH_MAIN_OBSERVED', freshMainObserved: true, observedAt: new Date(sim.now()).toISOString(), ...(stale ? { requestedAt: new Date(sim.now() - 60000).toISOString() } : {}) } })
    return structuredClone(request)
  }
  sim.operations.inventory.resyncStatus = () => structuredClone(status)
  return requests
}

test('a source rejection refreshes actual inventory before retrying the same usable chest', async () => {
  const { sim, at } = setup()
  const refreshes = sourceRejection(sim)
  sim.server.transfer = request => request === 1 ? 'reject' : 'ok'
  const runtime = sim.mount(), answers = [], deposit = runtime.storagePorts.deposit
  runtime.storagePorts.deposit = async (...args) => { const out = await deposit(...args); answers.push(out); return out }
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(refreshes.length, 1, 'one refresh for the rejected source')
  assert.equal(sim.stored(at, 'diamond'), 37)
  assert.equal(sim.stored(at, 'emerald'), 5)
  assert.equal(runtime.base.status().banked, 42, 'only successful transfers count')
  assert.equal(sim.goal(runtime), null)
  assert.equal(answers[0].evidence.transfer.rejectionProof.protocolStatusCode, 49)
  assert.equal(answers[0].evidence.transfer.recovery.freshMainObserved, true)
  assert.ok(sim.server.requests[1].at >= Date.parse(refreshes[0].requestedAt) + 600)
  assert.equal(sim.log.some(line => /NO_CHEST_MATERIAL|使えないため/.test(line)), false)
})

test('repeated source rejections hold with their actual cause, without replacing the empty chest', async () => {
  const { sim, at } = setup()
  const refreshes = sourceRejection(sim)
  sim.server.transfer = 'reject'
  const runtime = sim.mount()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'TRANSFER_REJECTED')
  assert.ok(refreshes.length > 0 && refreshes.length <= 3)
  assert.ok(sim.server.requests.length <= 3, 'one refused source per attempt, no request storm over all stacks')
  assert.equal(sim.storeOf(at).filter(item => !item.network_id).length, 27)
  assert.equal(runtime.base.status().banked, 0)
  assert.equal(sim.log.some(line => /NO_CHEST_MATERIAL|使えないため/.test(line)), false)
})

for (const stale of [false, true]) test(`a refresh without its own fresh receipt cannot authorize another transfer (stale=${stale})`, async () => {
  const { sim } = setup()
  const refreshes = sourceRejection(sim, { refresh: stale, stale })
  sim.server.transfer = 'reject'
  const runtime = sim.mount()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(sim.server.requests.length, 1)
  assert.equal(refreshes.length, 1)
  assert.equal(sim.goal(runtime)?.hold.code, 'TRANSFER_REJECTED')
  assert.equal(runtime.base.status().banked, 0)
})

test('an unresolved rejection survives a hold and reload until its own refresh is received', async () => {
  const { sim, at } = setup()
  const refreshes = sourceRejection(sim, { refresh: false })
  sim.server.transfer = 'reject'
  const first = sim.mount()
  await sim.run(first, { until: finished(sim, first), ms: 120000 })
  assert.equal(sim.server.requests.length, 1)
  assert.equal(sim.shared.playerReturn.pendingTransfer.transfer.rejectionProof.protocolStatusCode, 49)
  first.dispose()
  const second = sim.mount()
  await sim.sleep(600001)
  await sim.run(second, { until: finished(sim, second), ms: 120000 })
  assert.equal(refreshes.length, 2, 'wake retries the refresh, not the transfer')
  assert.equal(sim.server.requests.length, 1)
  assert.equal(sim.goal(second)?.hold.code, 'TRANSFER_REJECTED')
  sourceRejection(sim)
  sim.server.transfer = 'ok'
  await sim.sleep(600001)
  await sim.run(second, { until: finished(sim, second), ms: 120000 })
  assert.equal(sim.goal(second), null)
  assert.equal(sim.stored(at, 'diamond'), 37)
  assert.equal(second.base.status().banked, 42)
})

for (const change of ['connection', 'life']) test(`a new ${change} drops the old rejection while still waiting for its own inventory`, async () => {
  const { sim, at } = setup()
  sourceRejection(sim, { refresh: false })
  sim.server.transfer = 'reject'
  const runtime = sim.mount()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  if (change === 'connection') sim.reconnect()
  else sim.state.lifecycle.deathId++
  sim.server.transfer = 'ok'
  sim.state.inventory.known = false
  // The production port returns null while the new connection is unobserved.
  const original = runtime.storagePorts.deposit
  runtime.storagePorts.deposit = async (...args) => { assert.equal(sim.state.inventory.known, true); return original(...args) }
  sim.uncertain = true
  await sim.run(runtime, { ms: 4000 })
  assert.equal(sim.server.requests.length, 1)
  assert.equal(sim.shared.playerReturn.pendingTransfer, null)
  sim.state.inventory.known = true
  sim.resync()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.stored(at, 'diamond'), 37)
})

test('cancellation during refresh leaves the rejected transfer uncredited and sends nothing else', async () => {
  const { sim } = setup()
  const refreshes = sourceRejection(sim)
  const request = sim.operations.inventory.resync
  let cancelled = false
  sim.operations.inventory.resync = () => { const receipt = request(); sim.later(200, () => { cancelled = true }); return receipt }
  sim.server.transfer = 'reject'
  const box = createContainerPorts({ operations: sim.operations, getInventory: sim.inventory, sleep: sim.sleep, now: sim.now })
  const out = await box.deposit(sim.shared.playerBase, [{ slot: 2, name: 'minecraft:diamond', count: 37 }], { aborted: () => cancelled })
  assert.equal(out.status, 'interrupted')
  assert.equal(out.evidence.transfer.rejectionProof.protocolStatusCode, 49)
  assert.equal(out.progress.confirmedTransferred, 0)
  assert.equal(refreshes.length, 1)
  assert.equal(sim.server.requests.length, 1)
})

test('a fight during refresh preserves the rejection until a fresh receipt after the fight', async () => {
  const { sim, at } = setup()
  sourceRejection(sim, { refresh: false })
  const request = sim.operations.inventory.resync
  sim.operations.inventory.resync = () => { const receipt = request(); sim.later(200, () => sim.fight(1000)); return receipt }
  sim.server.transfer = 'reject'
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => !!sim.goal(runtime)?.interrupt, ms: 120000 })
  assert.equal(sim.server.requests.length, 1)
  assert.equal(sim.shared.playerReturn.pendingTransfer.transfer.rejectionProof.protocolStatusCode, 49)
  const refreshes = sourceRejection(sim)
  sim.server.transfer = 'ok'
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(refreshes.length, 1)
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.stored(at, 'diamond'), 37)
  assert.equal(runtime.base.status().banked, 42)
})

test('a withdrawal source rejection uses the same fresh-receipt barrier without crediting the refusal', async () => {
  const { sim, at } = setup()
  sim.storeOf(at)[0] = { ...structuredClone(sim.bag[2]), count: 10 }
  const refreshes = sourceRejection(sim)
  sim.server.transfer = 'reject'
  const box = createContainerPorts({ operations: sim.operations, getInventory: sim.inventory, sleep: sim.sleep, now: sim.now })
  const pick = slots => slots.filter(slot => slot.name === 'minecraft:diamond' && slot.count > 0).map(slot => ({ chestSlot: slot.slot, name: slot.name, count: slot.count }))
  const refused = await box.withdraw(at, pick)
  assert.equal(refused.code, 'WITHDRAW_REFUSED')
  assert.equal(refused.progress.confirmedTransferred, 0)
  assert.equal(refused.evidence.transfer.recovery.freshMainObserved, true)
  assert.equal(refreshes.length, 1)
  sim.server.transfer = 'ok'
  const taken = await box.withdraw(at, pick)
  assert.equal(taken.status, 'completed')
  assert.equal(taken.progress.confirmedTransferred, 10)
  assert.equal(sim.stored(at, 'diamond'), 0)
})

test('an unopened chest does not exclude its unobserved independent neighbour', async () => {
  const { sim, at } = setup()
  const other = sim.placeChest(6, GROUND, 0)
  sim.setBlock(at.x, at.y, at.z, 'minecraft:chest', { properties: { facing_direction: 2 } })
  sim.setBlock(other.x, other.y, other.z, 'minecraft:chest', { properties: { facing_direction: 3 } })
  sim.spares.push(other)
  sim.server.contents = position => position.x === at.x ? 'none' : 'send'
  const runtime = sim.mount()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.stored(other, 'diamond'), 37)
  assert.equal(sim.stored(other, 'emerald'), 5)
  assert.equal(sim.events.filter(event => event.kind === 'place_chest').length, 0)
})

test('a full chest beside an independent empty chest does not blacklist the empty one', async () => {
  const { sim, at } = setup({ fill: 27 })
  const other = sim.placeChest(6, GROUND, 0)
  sim.setBlock(at.x, at.y, at.z, 'minecraft:chest', { properties: { facing_direction: 2 } })
  sim.setBlock(other.x, other.y, other.z, 'minecraft:chest', { properties: { facing_direction: 3 } })
  sim.spares.push(other)
  const runtime = sim.mount()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 120000 })
  assert.equal(sim.stored(other, 'diamond'), 37)
  assert.equal(sim.stored(other, 'emerald'), 5)
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.log.some(line => /NO_CHEST_MATERIAL/.test(line)), false)
})

test('a held return reopens a formerly full chest when it wakes', async () => {
  const { sim, at } = setup({ fill: 27 })
  const runtime = sim.mount()
  await sim.run(runtime, { until: finished(sim, runtime), ms: 60000 })
  assert.equal(sim.goal(runtime)?.hold.code, 'NO_CHEST_MATERIAL')
  const opens = sim.events.filter(event => event.kind === 'open').length
  const empty = sim.bag.find(item => !item.network_id)
  for (let slot = 0; slot < 27; slot++) sim.storeOf(at)[slot] = structuredClone(empty)
  await sim.sleep(600001)
  await sim.run(runtime, { until: finished(sim, runtime), ms: 60000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.stored(at, 'diamond'), 37)
  assert.ok(sim.events.filter(event => event.kind === 'open').length > opens)
})

test('new received contents invalidate a full conclusion before the goal is held', async () => {
  const { sim, at } = setup({ fill: 27 })
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.goal(runtime)?.last?.code === 'NO_CHEST_MATERIAL', ms: 60000 })
  assert.equal(sim.goal(runtime)?.state, 'active')
  const empty = sim.bag.find(item => !item.network_id)
  for (let slot = 0; slot < 27; slot++) sim.storeOf(at)[slot] = structuredClone(empty)
  assert.equal((await runtime.storagePorts.inspect(at)).status, 'completed')
  await sim.run(runtime, { until: finished(sim, runtime), ms: 60000 })
  assert.equal(sim.goal(runtime), null)
  assert.equal(sim.stored(at, 'diamond'), 37)
})

test('a restored goal reobserves capacity instead of restoring a permanent full blacklist', () => {
  const goal = newGoal({ id: 'old-full', base: { x: 5, y: 64, z: 0 }, scope: 's', now: 0 })
  goal.full = [{ x: 5, y: 64, z: 0 }]
  assert.deepEqual(restoreGoal(goal).full, [])
})

test('a local transfer refusal retains its code and details without pretending it was server rejection', async () => {
  const { sim, at } = setup()
  const error = Object.assign(new Error('typed validation refusal'), { code: 'TEST_SOURCE_INVALID', details: { sourceSlot: 2 } })
  sim.operations.chest.depositItem = () => { throw error }
  const box = createContainerPorts({ operations: sim.operations, getInventory: sim.inventory, sleep: sim.sleep, now: sim.now })
  const out = await box.deposit(at, [{ slot: 2, name: 'minecraft:diamond', count: 37 }])
  assert.equal(out.evidence.transfer.code, 'TEST_SOURCE_INVALID')
  assert.deepEqual(out.evidence.transfer.details, { sourceSlot: 2 })
  assert.equal(out.progress.confirmedTransferred, 0)
  assert.equal(sim.server.requests.length, 0)
})
