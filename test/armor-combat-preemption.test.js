'use strict'

const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const filename = require.resolve('./armor.test'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', filename)
const { fixture } = loaded.exports
const air = () => ({ network_id: 0, count: 0 })
const requests = f => f.sent.filter(p => p.name === 'item_stack_request')
function scene () {
  const f = fixture({ inventory: [{ slot: 7, id: 1 }, { slot: 8, id: 4 }], respond: false })
  f.armor.applyPacket('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, air) })
  let foreign = null, closes = 0
  const snapshot = f.crafting.snapshot, close = f.crafting.closeContainer
  f.crafting.snapshot = () => ({ ...snapshot(), ...(foreign ? { openContainer: foreign } : {}) })
  f.crafting.closeContainer = () => { closes++; foreign = null; close() }
  return { ...f, replaceGui: () => { foreign = { id: 99, type: 'inventory' } }, closes: () => closes }
}

test('armor combat preemption retains the sent ACK but sends no next move and never closes the new combat GUI', async () => {
  const f = scene(), pending = f.armor.equipBest()
  await turn()
  assert.equal(requests(f).length, 1)
  const r = requests(f)[0].params.requests[0]
  const preempt = f.armor.preemptForCombat('contact')
  assert.equal(preempt.preempted, true); assert.equal(preempt.pendingRequestId, r.request_id)
  let settled = false; void pending.then(() => { settled = true })
  await turn(); assert.equal(settled, false, 'only the actual reply settles the sent request')
  f.replaceGui()
  f.armor.applyPacket('item_stack_response', { responses: [{ request_id: r.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: r.actions[0].destination.slot, count: 1, item_stack_id: 501 }] }] }] })
  const result = await pending
  assert.equal(result.length, 1); assert.equal(result[0].serverConfirmed, true)
  assert.equal(requests(f).length, 1); assert.equal(f.closes(), 0)
  assert.equal(f.crafting.snapshot().openContainer.id, 99)
  assert.equal(f.armor.snapshot().worn.find(x => x.piece === 'chestplate').name, 'minecraft:iron_chestplate')
})

test('preempting while inventory opens prevents the unsent armor request and leaves the replacement GUI alone', async () => {
  const f = scene(); let opened
  f.crafting.openInventory = () => new Promise(resolve => { opened = resolve })
  const pending = f.armor.equipBest(); await turn()
  const result = f.armor.preemptForCombat()
  assert.equal(result.pendingRequestId, null)
  f.replaceGui(); opened({ id: 9, type: 'inventory' })
  const moved = await pending
  assert.equal(moved.length, 1); assert.equal(moved[0].code, 'COMBAT_PREEMPTED')
  assert.equal(moved[0].serverConfirmed, false)
  assert.equal(requests(f).length, 0); assert.equal(f.closes(), 0)
  assert.equal(f.crafting.snapshot().openContainer.id, 99)
})

test('repeated combat preemption keeps observing an on-wire rejection without new requests or GUI cleanup', async () => {
  const f = scene(), pending = f.armor.equipBest(); await turn()
  const r = requests(f)[0].params.requests[0]
  f.armor.preemptForCombat(); f.armor.preemptForCombat()
  f.replaceGui()
  f.armor.applyPacket('item_stack_response', { responses: [{ request_id: r.request_id, status: 'error', containers: [] }] })
  const moved = await pending
  assert.equal(moved.length, 1); assert.equal(moved[0].phase, 'rejected')
  assert.equal(moved[0].serverConfirmed, false)
  assert.equal(requests(f).length, 1); assert.equal(f.closes(), 0)
  assert.equal(f.armor.snapshot().known, false)
})
