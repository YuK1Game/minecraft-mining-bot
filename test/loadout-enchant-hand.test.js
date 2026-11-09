'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createInventory } = require('../src/inventory')
const { createLoadoutCommand, allowed } = require('../src/loadout-command')
const { fixture, item } = require('./helpers/loadout-sim')
const probe = name => `/testfor @s[hasitem={item=minecraft:${name},location=slot.weapon.mainhand,quantity=1}]`
function inventoryFor (f, { dropSelections = 0 } = {}) {
  f.state.rawSelectedSlot = 0
  const packets = [], ids = new Map()
  const crafting = { applyPacket () {}, snapshot: () => ({ authority: true, inventoryKnown: true }), rawItem: i => {
    const x = f.view.slots[i]
    if (x.empty) return { network_id: 0, count: 0 }
    if (!ids.has(x.name)) ids.set(x.name, ids.size + 1)
    return { network_id: ids.get(x.name), count: x.count, metadata: 0, has_stack_id: true, stack_id: x.stackId }
  } }
  const inventory = createInventory({ client: { queue: (name, packet) => {
    packets.push({ name, packet }); assert.equal(name, 'mob_equipment')
    if (dropSelections-- <= 0) f.setSelected(packet.selected_slot)
  } }, getState: () => f.state, crafting, allocateRequestId: () => -1, commitSelection: i => { f.state.rawSelectedSlot = i } })
  return { inventory, packets, crafting }
}
test('loadout-hand: reset selection always sends even when the local slot already matches', () => {
  const f = fixture({ serverSlot: 5 }), { inventory, packets } = inventoryFor(f)
  f.view.slots[0] = item('minecraft:diamond_pickaxe')
  for (let n = 0; n < 2; n++) {
    f.setSelected(5)
    const r = inventory.selectHotbarForReset(0)
    assert.equal(f.selected(), 0)
    assert.equal(r.selectionSent, true)
    assert.equal(r.serverConfirmed, false, 'a queued selection is not a server hand receipt')
    // Even after an echo clears the pending flag, reset must still reselect.
    inventory.applyPacket('player_hotbar', { window_id: 'inventory', selected_slot: 0 })
  }
  assert.equal(packets.length, 2)
})
test('loadout-hand: empty, non-hotbar and cancelled selections do not send anything', () => {
  const f = fixture(), { inventory, packets } = inventoryFor(f)
  for (const slot of [-1, 9, 36, 0.5]) assert.throws(() => inventory.selectHotbarForReset(slot))
  assert.throws(() => inventory.selectHotbarForReset(4))
  const c = new AbortController(); c.abort()
  assert.throws(() => inventory.selectHotbarForReset(0, { signal: c.signal }))
  assert.equal(packets.length, 0)
  f.state.health = 1
  assert.doesNotThrow(() => inventory.selectHotbarForReset(0), 'debug reset still allows a living low-health bot')
})
for (const dropSelections of [0, 1]) test(`loadout-hand: complete kit from stale server selection (dropped selections=${dropSelections})`, async () => {
  const f = fixture({ serverSlot: 5 }), { inventory, packets } = inventoryFor(f, { dropSelections })
  f.adapter.select = (slot, options) => inventory.selectHotbarForReset(slot, options)
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().serverConfirmed, true, JSON.stringify(f.reset.status()))
  assert.equal(f.selected(), 1)
  assert.equal(f.blocks.size, 0)
  assert.equal(f.commandsSent.filter(x => x === '/clear @s').length, 1)
  // 54 spare tools + four worn armor + four hotbar tools + final hand.
  assert.equal(packets.length, 63 + dropSelections)
  assert.equal(f.commandsSent.filter(x => x.startsWith('/testfor @s[')).length, 63 + dropSelections)
})
test('loadout-hand: three explicit negative hand probes stop without a single enchant', async () => {
  const f = fixture({ serverSlot: 5 }), { inventory, packets } = inventoryFor(f, { dropSelections: Infinity })
  f.adapter.select = (slot, options) => inventory.selectHotbarForReset(slot, options)
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().error.code, 'RESET_HAND_UNCONFIRMED')
  assert.equal(f.reset.status().serverConfirmed, false)
  assert.equal(packets.length, 3)
  assert.equal(f.commandsSent.filter(x => x.startsWith('/enchant')).length, 0)
  assert.equal(f.blocks.size, 1, 'no blind removal of the leftover template')
})
for (const code of ['RESET_COMMAND_TIMEOUT', 'RESET_COMMAND_REJECTED', 'RESET_SCOPE_CHANGED']) test(`loadout-hand: ${code} does not retry a probe or enchant`, async () => {
  const f = fixture()
  f.hooks.beforeSend = command => { if (command.startsWith('/testfor @s[')) throw Object.assign(Error(code), { code, messageId: 'commands.generic.permission' }) }
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().error.code, code)
  assert.equal(f.commandsSent.filter(x => x.startsWith('/testfor @s[')).length, 1)
  assert.equal(f.commandsSent.filter(x => x.startsWith('/enchant')).length, 0)
})
test('loadout-hand: an actual enchant rejection is never automatically repeated', async () => {
  const f = fixture()
  f.hooks.beforeSend = command => { if (command.startsWith('/enchant')) throw Object.assign(Error('commands.enchant.noItem'), { code: 'RESET_COMMAND_REJECTED', messageId: 'commands.enchant.noItem' }) }
  await f.start(); await f.reset.drain()
  assert.equal(f.commandsSent.filter(x => x.startsWith('/enchant')).length, 1)
  assert.equal(f.reset.status().serverConfirmed, false)
})
test('loadout-hand: cancellation during hand confirmation prevents every enchant', async () => {
  const f = fixture()
  f.hooks.afterSend = command => { if (command.startsWith('/testfor @s[')) f.reset.cancel() }
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().serverConfirmed, false)
  assert.equal(f.commandsSent.filter(x => x.startsWith('/enchant')).length, 0)
  assert.equal(f.lease(), null)
})
test('loadout-hand: read-only allowlist is fixed to own mainhand and supported kit items', () => {
  assert.equal(allowed(probe('diamond_pickaxe')), true)
  assert.equal(allowed(probe('diamond_helmet')), true)
  for (const command of [probe('dirt'), probe('diamond_pickaxe').replace('@s', '@a'), probe('bow').replace('mainhand', 'offhand'), probe('bow').replace('quantity=1', 'quantity=0'), probe('bow') + '\n/clear @a']) assert.equal(allowed(command), false)
})
for (const variant of ['valid', 'foreignUUID', 'genericSuccess', 'otherPlayer', 'manyTargets', 'negative', 'malformedNegative']) test(`loadout-hand: command receipt ${variant}`, async () => {
  const f = fixture(), sent = []
  const command = createLoadoutCommand({ client: { queue: (name, packet) => sent.push(packet) }, getState: () => f.state, timeoutMs: 500 })
  const promise = command.send(probe('diamond_pickaxe')), p = sent[0]
  const response = { origin: p.origin, success_count: 1, output: [{ success: true, message_id: 'commands.testfor.success', parameters: ['ResetBot'] }] }
  if (variant === 'foreignUUID') {
    assert.equal(command.applyPacket('command_output', { ...response, origin: { ...p.origin, uuid: '00000000-0000-0000-0000-000000000001' } }), false)
    assert.equal(command.busy(), true)
  }
  if (variant === 'genericSuccess') response.output[0].message_id = 'commands.generic.success'
  if (variant === 'otherPlayer') response.output[0].parameters = ['OtherBot']
  if (variant === 'manyTargets') response.success_count = 2
  if (['negative', 'malformedNegative'].includes(variant)) { response.success_count = 0; response.output[0] = { success: false, message_id: '%commands.testfor.failure', parameters: [] } }
  if (variant === 'malformedNegative') response.output[0].parameters = null
  command.applyPacket('command_output', response)
  if (['valid', 'foreignUUID'].includes(variant)) assert.equal((await promise).serverConfirmed, true)
  else await assert.rejects(promise, ['negative', 'malformedNegative'].includes(variant) ? { code: 'RESET_COMMAND_REJECTED', messageId: 'commands.testfor.failure', serverRejected: variant === 'negative' } : { code: 'RESET_HAND_OUTPUT_INVALID' })
})
