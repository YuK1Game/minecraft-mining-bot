'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarrySupplies } = require('../src/quarry-supplies')
const file = path.resolve(__dirname, 'quarry-supplies.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
const nativeRequire = loaded.require.bind(loaded)
loaded.require = id => id === 'node:test' ? { test: () => {} } : nativeRequire(id)
loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { transferFixture }\n', file)

function fixture ({ role = 'food', mode = 'applied', initialCooldown = false, noDelayClock = false, failedFresh = false, abortWait = false, lifeWait = false } = {}) {
  const f = loaded.exports.transferFixture({ role, policy: role === 'food' ? { keepFood: 5 } : {} })
  const signal = new AbortController(), docs = []
  let clock = 0, lastFresh = initialCooldown ? 0 : -Infinity, pendingMain = null, reads = 0, takes = 0, sleeps = 0
  const transfer = f.chest.withdrawItem
  f.chest.withdrawItem = async options => {
    takes++
    const before = structuredClone(f.main)
    f.setMode(mode === 'before_then_applied' ? takes === 1 ? 'unchanged' : 'applied' : mode)
    try { await transfer(options) } catch { /* Controlled server-side application with its main packet omitted. */ }
    pendingMain = structuredClone(f.main)
    before.forEach((raw, slot) => { f.main[slot] = raw })
    f.state.inventory.known = false; f.state.inventory.uncertain = true
    clock += 10000
    throw new Error('チェスト操作の実際の完了を確認できませんでした。')
  }
  const controller = createQuarrySupplies({ getState: () => f.state, crafting: f.crafting, chest: f.chest, getPortable: () => null, now: () => clock,
    getRefreshDelay: () => noDelayClock ? 0 : Math.max(0, 20000 - (clock - lastFresh)),
    sleep: async ms => { sleeps++; clock += ms; if (abortWait) signal.abort(new Error('controlled combat abort')); if (lifeWait) f.state.lifecycle.deathId++ },
    refreshInventory: async () => {
      reads++
      if (clock - lastFresh < 20000) throw Object.assign(new Error('rate limited'), { code: 'RESYNC_RATE_LIMIT' })
      if (failedFresh) return false
      lastFresh = clock
      if (pendingMain) pendingMain.forEach((raw, slot) => { f.main[slot] = structuredClone(raw) })
      f.state.inventory.known = true; delete f.state.inventory.uncertain
      return true
    }
  })
  const run = checkpoint => controller.workWithContainer({ request: f.request, position: { x: 1, y: 65, z: 1 }, checkpoint }, { signal: signal.signal, onCheckpoint: async cp => docs.push(structuredClone(cp)) })
  return { ...f, run, docs, takes: () => takes, reads: () => reads, sleeps: () => sleeps, clock: () => clock }
}

test('an applied take with omitted main slot automatically reads fresh main and fresh box, credits once and never sends another take', async () => {
  const f = fixture(), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.withdrawn.reduce((sum, row) => sum + row.count, 0), 5)
  assert.equal(result.checkpoint.reconciliation.outcome, 'applied')
  assert.equal(f.takes(), 1); assert.equal(f.reads(), 1)
  assert.equal(f.main[0].count, 5)
  assert.equal(f.state.inventory.known, true)
  assert.ok(f.docs.some(cp => cp.intent?.automaticReadCount === 1))
})

test('each of four dirt takes can recover a missing main packet while respecting the20second reader limit', async () => {
  const f = fixture({ role: 'dirt' }), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.withdrawn.reduce((sum, row) => sum + row.count, 0), 224)
  assert.equal(f.takes(), 4); assert.equal(f.reads(), 4)
  assert.equal(f.main.reduce((sum, item) => sum + item.count, 0), 224)
  assert.ok(f.sleeps() > 0)
})

test('an unchanged exact fresh pair permits only one resend; a second applied take is credited once', async () => {
  const f = fixture({ mode: 'before_then_applied' }), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(f.takes(), 2); assert.equal(f.reads(), 2)
  assert.equal(result.withdrawn.length, 1)
  assert.equal(result.withdrawn[0].count, 5)
})

test('two fresh unchanged results stop without an infinite resend loop or an invented credit', async () => {
  const f = fixture({ mode: 'unchanged' }), result = await f.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.reason, 'SUPPLY_TRANSFER_NOT_PROGRESSING')
  assert.equal(f.takes(), 2); assert.equal(f.reads(), 2)
  assert.ok(result.checkpoint.intent)
  assert.equal(result.withdrawn.length, 0)
})

test('rate limited older reader ports get one20second retry and do not reuse an old fresh receipt', async () => {
  const f = fixture({ initialCooldown: true, noDelayClock: true }), result = await f.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(f.reads(), 2)
  assert.equal(f.takes(), 1)
  assert.ok(f.clock() >= 30000)
})

test('ambiguous IDs, failed refresh, abort and life change preserve pending work without resending', async t => {
  for (const [mode, options] of [['ambiguous', { mode: 'changed_id' }], ['fresh_failed', { failedFresh: true }], ['abort', { initialCooldown: true, abortWait: true }], ['life', { initialCooldown: true, lifeWait: true }]]) await t.test(mode, async () => {
    const f = fixture(options), result = await f.run()
    assert.equal(result.status, 'blocked')
    assert.equal(f.takes(), 1)
    assert.ok(result.checkpoint.intent)
    assert.equal(result.withdrawn.length, 0)
  })
})
