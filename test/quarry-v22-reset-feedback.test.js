'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { createQuarryV22Reset } = require('../src/quarry-v22-reset')
const { allowed, FAILURE_PROBE } = require('../src/loadout-command')
const missing = () => ({ slot: 0, known: true, empty: true, name: null, count: 0 })

// 2026-11-13: the realm runs with sendcommandfeedback=false (success replies
// suppressed). A reset switches it on, proves it with /testfor @s, and always
// switches it back off; "off" is proven by the failure probe still replying
// while /testfor @s stays silent. A record left "on" is restored after reconnect.
function fixture ({ record = null } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42', name: 'Test' }, connectionId: 'conn', startedAt: '2026-11-11T10:00:00Z',
    runtimeEntityId: '40', dimension: 'overworld', lifecycle: { deathId: 0 }, gameMode: 'survival', health: 20, position: { x: 8.5, y: 66.62, z: 8.5 }, inventory: { known: true } }
  const slots = Array.from({ length: 36 }, (_, slot) => ({ ...missing(), slot })), armor = Array.from({ length: 4 }, (_, slot) => ({ ...missing(), slot }))
  const view = () => ({ known: true, slots: structuredClone(slots), armor: { known: true, slots: structuredClone(armor) }, offhand: { known: true, slots: [missing()] } })
  const calls = [], saved = []
  let feedback = false
  const adapter = {
    getState: () => state, getView: view, getBlock: (x, y, z) => ({ known: true, boundingBox: y <= 64 ? 'block' : 'empty', name: y <= 64 ? 'minecraft:stone' : 'minecraft:air', extra: [] }),
    assertIdle: () => {}, acquire: () => {}, release: () => {}, cancelJob: async () => ({ serverConfirmed: true, previousJobIdentity: null, jobIdentity: null }), save: async x => saved.push(structuredClone(x)),
    load: async () => structuredClone(record), select: async () => {}, open: async () => ({ serverConfirmed: false }), close: async () => {}, deposit: async () => {}, container: () => null,
    cancelTransfers: async () => {}, publishHomeSite: () => {}, generation: () => 0
  }
  const timeout = () => Object.assign(new Error('timeout'), { code: 'RESET_COMMAND_TIMEOUT' })
  const commands = { send: async c => {
    calls.push(c)
    assert.ok(allowed(c), c)
    if (c === '/gamerule sendcommandfeedback true') { const was = feedback; feedback = true; if (!was) throw timeout(); return { serverConfirmed: true, scope: 'x' } }
    if (c === '/gamerule sendcommandfeedback false') { feedback = false; throw timeout() }
    if (c === FAILURE_PROBE) throw Object.assign(new Error('no target'), { code: 'RESET_COMMAND_REJECTED', serverRejected: true })
    if (c === '/testfor @s') { if (!feedback) throw timeout(); return { serverConfirmed: true, scope: JSON.stringify(['bot', '42', 'overworld', 'conn', '2026-11-11T10:00:00Z', '40', 0]) } }
    throw Object.assign(new Error('stop the test reset here'), { code: 'RESET_COMMAND_REJECTED' })
  }, cancel: () => {}, applyPacket: () => {} }
  const reset = createQuarryV22Reset({ adapter, commands, feedbackToggle: true })
  return { reset, calls, saved, feedback: () => feedback }
}

test('a reset switches command feedback on first and always switches it back off, proven by the probes', async () => {
  const f = fixture(), p = await f.reset.prepare()
  f.reset.start({ token: p.token, confirm: 'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY' })
  await f.reset.drain()
  assert.equal(f.calls[0], '/gamerule sendcommandfeedback true')
  assert.deepEqual(f.calls.slice(-3), ['/gamerule sendcommandfeedback false', FAILURE_PROBE, '/testfor @s'])
  assert.equal(f.feedback(), false)
  const last = f.saved.at(-1)
  assert.equal(last.feedback.restored, true); assert.equal(last.feedback.failureProbeReplied, true); assert.equal(last.feedback.successSuppressed, true)
})

test('after a reconnect a record left with feedback on is restored once; a restored one is left alone', async () => {
  const pending = fixture({ record: { operationId: 'r1', feedback: { enabledAt: 1, restored: false } } })
  const restored = await pending.reset.restoreFeedbackIfPending()
  assert.equal(restored.restored, true)
  assert.deepEqual(pending.calls, ['/gamerule sendcommandfeedback false', FAILURE_PROBE, '/testfor @s'])
  const done = fixture({ record: { operationId: 'r1', feedback: { enabledAt: 1, restored: true } } })
  assert.equal(await done.reset.restoreFeedbackIfPending(), null)
  assert.deepEqual(done.calls, [])
})
