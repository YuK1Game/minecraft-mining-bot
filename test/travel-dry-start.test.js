'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { dryStart } = require('../src/modes/travel-dry-start')

test('a trip that starts afloat swims to land first', async () => {
  const logs = []
  let exits = 0
  const out = await dryStart({ needed: () => true, exit: async () => { exits++; return { ok: true } }, log: line => logs.push(line) })
  assert.equal(exits, 1)
  assert.deepEqual(out, { ok: true })
  assert.match(logs[0], /水から上がります/)
})

test('a dry trip does not swim', async () => {
  let exits = 0
  assert.equal(await dryStart({ needed: () => false, exit: async () => { exits++ } }), null)
  assert.equal(exits, 0)
})

test('a failing exit does not stop the trip', async () => {
  const out = await dryStart({ needed: () => true, exit: async () => { throw new Error('boom') } })
  assert.equal(out.ok, false)
})

test('the exit waits for the stopped work and retries a refusal to wait', async () => {
  let ready = false, calls = 0
  const out = await dryStart({
    needed: () => true,
    ready: () => { const was = ready; ready = true; return was },
    exit: async () => { calls++; return calls < 2 ? { ok: false, reason: '前の操作の終了処理を待ってください。' } : { ok: true } },
    sleep: async () => {}
  })
  assert.equal(calls, 2)
  assert.equal(out.ok, true)
})
