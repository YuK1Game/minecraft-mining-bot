'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { deserialize } = require('node:v8')
const file = path.resolve(__dirname, 'quarry-supplies.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
const nativeRequire = loaded.require.bind(loaded)
loaded.require = id => id === 'node:test' ? { test: () => {} } : nativeRequire(id)
loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { transferFixture, raw, air }\n', file)
const { transferFixture, raw, air } = loaded.exports
const unpack = value => deserialize(Buffer.from(value, 'base64'))

async function interrupted ({ role = 'pickaxe', damage = 1560 } = {}) {
  const f = transferFixture({ role })
  const name = `minecraft:diamond_${role}`
  f.main[7] = raw(name, 1, 80, damage)
  // An already full box forces taking the replacement before returning the
  // exhausted tool, as in the real interrupted take. It must still be returned.
  f.slots[26] = raw(name, 1, 126, 0)
  f.setMode('applied')
  const blocked = await f.run()
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.checkpoint.intent.direction, 'withdraw')
  const cp = structuredClone(blocked.checkpoint), slot = cp.intent.playerSlot
  const taken = structuredClone(f.main[slot])
  assert.notEqual(taken.stack_id, unpack(cp.intent.chestBefore).stack_id, 'normal transfer assigned a fresh stack ID')
  f.main[20] = taken; f.main[slot] = air()
  // Combat's hotbar swap also moves the old tool; raw identity stays intact.
  f.main[8] = f.main[7]; f.main[7] = air()
  f.setMode(null)
  return { f, cp, taken, slot }
}

test('a fresh unique tool moved by combat is reconciled with both full inventories, then the worn tool is returned once', async t => {
  for (const role of ['pickaxe', 'shovel']) await t.test(role, async () => {
    const { f, cp, taken, slot } = await interrupted({ role })
    const original = structuredClone(cp.intent), result = await f.run(cp)
    assert.equal(result.status, 'completed', result.reason)
    assert.equal(result.withdrawn.length, 1); assert.equal(result.returned.length, 1)
    assert.equal(f.logs.filter(row => row.direction === 'withdraw').length, 1)
    assert.equal(f.logs.filter(row => row.direction === 'return').length, 1)
    assert.equal(result.checkpoint.reconciliation.playerSlot, slot)
    assert.equal(result.checkpoint.reconciliation.observedPlayerSlot, 20)
    assert.equal(result.checkpoint.reconciliation.observedPlayerStackId, taken.stack_id)
    assert.equal(result.checkpoint.reconciliation.sourceStackId, unpack(original.chestBefore).stack_id)
    assert.equal(result.checkpoint.reconciliation.outcome, 'applied')
    assert.deepEqual(cp.intent, original, 'the persisted original intent is not rewritten')
    assert.equal(f.slots.filter(item => item.count && item.extra?.nbt?.nbt?.value?.Damage?.value === 1560).length, 1)
    assert.ok(result.checkpoint.completedContents, 'all 27 received slots are retained for outer box recovery')
    const transfers = f.logs.filter(row => row.direction).length
    assert.equal((await f.run(result.checkpoint)).status, 'completed')
    assert.equal(f.logs.filter(row => row.direction).length, transfers, 'completed replay never sends twice')
  })
})

test('ambiguous or altered tool histories keep the original pending intent and never resend or invent credit', async t => {
  const changes = {
    'no main baseline on an old checkpoint': ({ cp }) => { delete cp.intent.mainBefore },
    'no box baseline on an old checkpoint': ({ cp }) => { delete cp.intent.containerBefore },
    'neither baseline on an old checkpoint': ({ cp }) => { delete cp.intent.mainBefore; delete cp.intent.containerBefore },
    'different durability on the taken tool': ({ f }) => { f.main[20].extra.nbt.nbt.value.Damage.value = 1 },
    'different enchantment/NBT on a same-name tool': ({ f }) => { f.main[20].extra.nbt.nbt.value.CustomName = { type: 'string', value: 'different tool' } },
    'two new matching tools': ({ f, taken }) => { f.main[21] = { ...structuredClone(taken), stack_id: 9001 } },
    'a missing old worn tool': ({ f }) => { f.main[8] = air() },
    'an old tool ID replaced with a new same-content ID': ({ f }) => { f.main[8].stack_id = 9002 },
    'an old tool durability changed during combat': ({ f }) => { f.main[8].extra.nbt.nbt.value.Damage.value = 1561 },
    'another box slot changed': ({ f }) => { f.slots[1].stack_id = 9003 },
    'source still present in the box': ({ f, cp }) => { f.slots[cp.intent.chestSlot] = unpack(cp.intent.chestBefore) },
    'a duplicate ID across main and box': ({ f }) => { f.main[20].stack_id = f.slots[1].stack_id },
    'no fresh main received': ({ f }) => { f.setFresh(false) },
    'a stale reopened box': ({ f }) => { f.setMode('stale_open') },
    'different connection': ({ f }) => { f.state.connectionId = 'other' },
    'different life': ({ f }) => { f.state.lifecycle.deathId++ },
    'different operation': ({ cp }) => { cp.operationId = 'other' }
  }
  for (const [label, change] of Object.entries(changes)) await t.test(label, async () => {
    const context = await interrupted(); change(context)
    const { f, cp } = context, original = structuredClone(cp.intent), result = await f.run(cp)
    assert.equal(result.status, 'blocked', label)
    assert.ok(result.checkpoint.intent, label)
    assert.deepEqual({ ...result.checkpoint.intent, automaticReadCount: original.automaticReadCount }, original, label)
    assert.equal(result.withdrawn.length, 0)
    assert.equal(result.returned.length, 0)
    assert.equal(f.logs.filter(row => row.direction).length, 1, 'unknown is never replayed')
  })
})

test('a completely unchanged tool take is retried once only after both fresh inventories prove no extra tool', async () => {
  const f = transferFixture({ role: 'pickaxe' })
  f.setMode('unchanged')
  const blocked = await f.run()
  assert.ok(blocked.checkpoint.intent.mainBefore)
  assert.ok(blocked.checkpoint.intent.containerBefore)
  f.setMode(null)
  const result = await f.run(blocked.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.reconciliation.outcome, 'unchanged')
  assert.equal(result.withdrawn.length, 1)
  assert.equal(f.logs.filter(row => row.direction === 'withdraw').length, 2)
})

test('a second combat abort retains the same intent and sends no recovery transfer', async () => {
  const { f, cp } = await interrupted(), abort = new AbortController()
  abort.abort(new Error('second combat'))
  const result = await f.run(cp, { signal: abort.signal })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.checkpoint.intent, cp.intent)
  assert.equal(result.withdrawn.length, 0)
  assert.equal(f.logs.filter(row => row.direction).length, 1)
})

test('persistence failure after relocated proof retains the pending intent and credits exactly once after retry', async () => {
  const { f, cp } = await interrupted()
  f.setSaves(0); f.failSave(1)
  const failed = await f.run(cp)
  assert.equal(failed.reason, 'SUPPLY_PERSISTENCE_FAILED')
  assert.ok(failed.checkpoint.intent)
  assert.equal(failed.withdrawn.length, 0)
  f.failSave(null)
  const result = await f.run(failed.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.withdrawn.length, 1)
  assert.equal(result.returned.length, 1)
  assert.equal(f.logs.filter(row => row.direction === 'withdraw').length, 1)
})
