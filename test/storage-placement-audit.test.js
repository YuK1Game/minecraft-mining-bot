'use strict'

// Live 2026-11-13: with gamerule sendcommandfeedback false the Realm sends no
// success replies, so the air audit uses an inverted command whose answers are
// failure replies (recorded on the live Realm).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createStoragePlacementAudit } = require('../src/storage-placement-audit')

function fixture () {
  let clock = 1000, serial = 0
  const state = { profile: 'audit-test', realm: { id: '1' }, connectionId: 'c1', startedAt: '2026-11-13T00:00:00.000Z', dimension: 'overworld', runtimeEntityId: '41', playerName: 'Bot', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20 }
  const sent = []
  const audit = createStoragePlacementAudit({ client: { queue: (name, packet) => sent.push({ name, packet: structuredClone(packet) }) }, getState: () => state, now: () => clock, timeoutMs: 100, randomUUID: () => `12345678-1234-4321-8765-${String(++serial).padStart(12, '0')}` })
  const reply = output => ({ origin: structuredClone(sent.at(-1).packet.origin), output_type: 'all_output', success_count: 0, output, has_data: false })
  return { audit, sent, reply, advance: ms => { clock += ms } }
}
const p = { x: 10, y: 20, z: 30 }
const AIR = [{ success: false, message_id: 'commands.generic.noTargetMatch', parameters: [] }, { success: false, message_id: 'commands.execute.failed', parameters: ['testfor', 'Bot'] }]
const NOT_AIR = [{ success: false, message_id: 'commands.execute.falseCondition', parameters: ['if', 'block'] }]

test('the inverted air audit sends an execute/testfor command and confirms air only from the recorded failure pair', async () => {
  const f = fixture(), pending = f.audit.confirmAir(p, { operationId: 'op' })
  assert.equal(f.sent[0].packet.command, '/execute if block 10 20 30 air run testfor @s[rm=1000000]')
  f.advance(10); f.audit.applyPacket('command_output', f.reply(AIR))
  const r = await pending
  assert.equal(r.serverConfirmed, true)
})

test('a false execute condition is a confirmed not-air result; success and other replies stay unconfirmed', async () => {
  let f = fixture(), pending = f.audit.confirmAir(p, { operationId: 'op' })
  f.audit.applyPacket('command_output', f.reply(NOT_AIR))
  assert.equal((await pending).reason, 'STORAGE_TARGET_NOT_AIR')
  for (const output of [
    [{ success: true, message_id: 'commands.testforblock.success', parameters: ['10', '20', '30'] }],
    [{ success: false, message_id: 'commands.generic.permission', parameters: [] }],
    [AIR[0]],
    [AIR[0], { ...AIR[1], message_id: 'commands.execute.other' }],
    [{ ...NOT_AIR[0], parameters: ['unless', 'block'] }]
  ]) {
    f = fixture(); pending = f.audit.confirmAir(p, { operationId: 'op' })
    const packet = f.reply(output); if (output[0].success) packet.success_count = 1
    f.audit.applyPacket('command_output', packet)
    const r = await pending
    assert.equal(r.serverConfirmed, false, JSON.stringify(output))
    assert.notEqual(r.reason, 'STORAGE_TARGET_NOT_AIR', JSON.stringify(output))
  }
})
