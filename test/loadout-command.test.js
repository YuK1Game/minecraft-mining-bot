'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createLoadoutCommand, allowed } = require('../src/loadout-command')
const { randomUUID } = require('node:crypto')
const { fixture } = require('./helpers/loadout-sim')
function commandFixture (options = {}) {
  const f = fixture(), queued = []
  const cmd = createLoadoutCommand({ client: { queue: (name, packet) => queued.push({ name, packet }) }, getState: () => f.state, timeoutMs: 60, ...options })
  const response = (extra = {}) => { const r = queued.at(-1).packet; return { origin: { ...r.origin }, output_type: 'all_output', has_data: false, success_count: 1, output: [{ success: true, message_id: 'commands.testfor.success', parameters: ['ResetBot'] }], ...extra } }
  return { ...f, queued, cmd, response }
}
test('loadout: exact self-only command allowlist rejects injection, other players, arbitrary loot and mismatched cleanup coordinates', () => {
  for (const text of ['/clear @a', '/clear ResetBot', '/clear @s\n/kill @e', '/give @s diamond 64', '/loot replace entity @s slot.inventory 24 1 mine 2 64 0 minecraft:diamond_pickaxe', '/execute if block 2 64 0 minecraft:blue_shulker_box run setblock 3 64 0 minecraft:air replace', '/setblock 30000000 64 0 minecraft:blue_shulker_box keep', '/setblock 2 -64 0 minecraft:blue_shulker_box keep', '/replaceitem block 2 64 0 slot.container 27 minecraft:dirt 64']) assert.equal(allowed(text), false, text)
  assert.ok(allowed('/clear @s')); assert.ok(allowed('/replaceitem entity @s slot.armor.head 0 minecraft:air 1'))
})
test('loadout: queued commands and wrong UUID are not success; matching server output is required', async () => {
  const f = commandFixture(), p = f.cmd.send('/testfor @s')
  assert.equal(f.cmd.busy(), true); assert.equal(f.queued.length, 1)
  assert.equal(f.cmd.applyPacket('command_output', f.response({ origin: { ...f.response().origin, uuid: randomUUID() } })), false)
  await assert.rejects(f.cmd.send('/clear @s'), { code: 'RESET_COMMAND_BUSY' })
  f.cmd.applyPacket('command_output', f.response()); assert.equal((await p).serverConfirmed, true)
  assert.equal(f.cmd.busy(), false)
})
for (const variant of ['rejected', 'schema', 'disconnect', 'realm', 'death', 'abort']) test(`loadout: ${variant} cannot acknowledge a reset command`, async () => {
  const f = commandFixture(), controller = new AbortController(), p = f.cmd.send('/testfor @s', { signal: controller.signal })
  const rejection = assert.rejects(p)
  if (variant === 'rejected') f.cmd.applyPacket('command_output', f.response({ success_count: 0, output: [{ success: false, message_id: 'commands.generic.permission', parameters: [] }] }))
  if (variant === 'schema') f.cmd.applyPacket('command_output', f.response({ output: null }))
  if (variant === 'disconnect') f.cmd.applyPacket('disconnect', {})
  if (variant === 'realm') { f.state.realm.id = '99'; f.cmd.applyPacket('command_output', f.response()) }
  if (variant === 'death') { f.state.health = 0; f.cmd.applyPacket('command_output', f.response()) }
  if (variant === 'abort') controller.abort()
  await rejection; assert.equal(f.cmd.busy(), false); assert.equal(f.queued.length, 1)
})
test('loadout: timeout never auto-retries and cannot accept a late reply', async () => {
  const f = commandFixture({ timeoutMs: 10 }); await assert.rejects(f.cmd.send('/testfor @s'), { code: 'RESET_COMMAND_TIMEOUT' })
  assert.equal(f.cmd.applyPacket('command_output', f.response()), false); assert.equal(f.queued.length, 1)
})
test('loadout: reused command UUID is rejected even after previous completion', async () => {
  const f = commandFixture({ uuid: () => '12345678-1234-1234-1234-123456789abc' }), p = f.cmd.send('/testfor @s')
  f.cmd.applyPacket('command_output', f.response()); await p
  await assert.rejects(f.cmd.send('/clear @s'), { code: 'RESET_COMMAND_ID_REUSED' }); assert.equal(f.queued.length, 1)
})
