'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')

const filename = require.resolve('./food.test')
const loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture,item}\n', filename)
const { fixture, item } = loaded.exports

function scene (t, options = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = fixture(options)
  f.observeHunger(14)
  let stopped = 0
  const stop = f.input.stop
  f.input.stop = () => { stopped++; stop() }
  return { ...f, stopped: () => stopped, releases: () => f.packets.filter(p => p.name === 'inventory_transaction' && p.params.transaction.transaction_type === 'item_release') }
}

test('combat preemption synchronously retires the exact food use once and late finally preserves new combat input', async t => {
  const f = scene(t), { pending } = await f.start(), rejected = assert.rejects(pending, /combat priority/)
  const before = f.bag.get(0).count
  const result = f.food.preemptForCombat('combat priority')
  assert.equal(result.preempted, true); assert.equal(result.inputStopped, true)
  assert.equal(f.stopped(), 1); assert.equal(f.releases().length, 1)
  assert.equal(f.food.snapshot().busy, false)
  f.bag.set(0, item(301, 1, 900))
  f.input.start()
  assert.equal(f.food.preemptForCombat().preempted, false)
  await rejected
  assert.equal(f.input.stats().running, true)
  assert.equal(f.stopped(), 1); assert.equal(f.releases().length, 1)
  assert.equal(f.commits.length, 0); assert.equal(before, 3)
  assert.equal(f.uncertainties.length, 1, 'sent food remains uncertain until an actual receipt')
})

test('a queued but unsent food transaction is removed synchronously without pretending consumption', async t => {
  const f = scene(t)
  const queued = []
  f.input.sendTransaction = (transaction, options) => queued.push({ transaction, options })
  const stop = f.input.stop
  f.input.stop = () => { queued.length = 0; stop() }
  const { pending } = await f.start(), rejected = assert.rejects(pending)
  assert.equal(queued.length, 1)
  const result = f.food.preemptForCombat()
  assert.equal(result.inputStopped, true); assert.equal(result.wireSent, false)
  assert.equal(queued.length, 0); assert.equal(f.releases().length, 0)
  f.input.start(); await rejected
  assert.equal(f.input.stats().running, true)
  assert.equal(f.commits.length, 0); assert.equal(f.uncertainties.length, 0)
})

test('combat preemption cancels waiting food without cancelling the already-sent equipment promise', async t => {
  let finish, actualReply = false, equipmentCalls = 0
  const equipment = new Promise(resolve => { finish = resolve })
  const f = scene(t, { equip: () => { equipmentCalls++; return equipment.then(value => { actualReply = true; return value }) } })
  const { pending } = await f.start(), rejected = assert.rejects(pending)
  const result = f.food.preemptForCombat()
  assert.equal(result.inputStopped, false); assert.equal(equipmentCalls, 1)
  assert.equal(actualReply, false); assert.equal(f.transactions.length, 0)
  f.bag.set(0, item(301, 1, 900)); f.input.start()
  await rejected
  finish({ serverConfirmed: true, slot: 0 }); await turn()
  assert.equal(actualReply, true)
  assert.equal(f.stopped(), 0); assert.equal(f.releases().length, 0)
  assert.equal(f.input.stats().running, true)
  assert.equal(f.commits.length, 0)
})

test('an already replaced same-slot item or another input target cannot be released as the retired food', async t => {
  const f = scene(t), { pending } = await f.start(), rejected = assert.rejects(pending)
  f.bag.set(0, item(301, 1, 901))
  const stats = f.input.stats
  f.input.stats = () => ({ ...stats(), target: { x: 2, y: 65, z: 1 } })
  const result = f.food.preemptForCombat()
  assert.equal(result.inputStopped, false)
  await rejected
  assert.equal(f.stopped(), 0); assert.equal(f.releases().length, 0)
  assert.equal(f.input.stats().running, true)
})

test('a genuine completed consumption remains confirmed when combat takes over before its finally', async t => {
  const f = scene(t), { pending } = await f.start()
  f.advanceHold(t); f.response()
  assert.equal(f.food.snapshot().lastResult.serverConfirmed, true)
  const stoppedBefore = f.stopped()
  f.food.preemptForCombat()
  f.bag.set(0, item(301, 1, 902)); f.input.start()
  const result = await pending
  assert.equal(result.serverConfirmed, true); assert.equal(result.consumed, true)
  assert.equal(f.commits.length, 1); assert.equal(f.uncertainties.length, 0)
  assert.equal(f.input.stats().running, true)
  assert.equal(f.stopped(), stoppedBefore)
  assert.equal(f.releases().length, 0, 'an already confirmed use has already released its input')
})
