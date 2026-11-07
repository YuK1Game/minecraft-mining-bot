'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// The initial-life receipt gates food (foodKnownLife) and post-reload hunger
// restoration. It must be prepared as soon as a spawned first life lacks one.
const source = fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js'), 'utf8')
const start = source.indexOf('  function ensureInitialLifeReceipt () {')
const functionEnd = source.indexOf('\n  }', start) + 4
const end = source.indexOf('  function resumeRequested () {', start)
assert.ok(start >= 0 && functionEnd > start && end > functionEnd, 'receipt and resume functions must exist')

function harness ({ shared = {}, state = {}, verified = false, prepare = () => Promise.resolve() } = {}) {
  const calls = []
  const host = { shared: { loadingScreenEnded: true, deathRespawn: null, ...shared } }
  const raw = () => ({ phase: 'spawned', dead: false, spawnPending: false, ...state })
  const ensure = Function('host', 'raw', 'verifiedInitialLifeReceipt', 'prepareInventoryLifeReceipt', source.slice(start, functionEnd) + ';return ensureInitialLifeReceipt')(host, raw, () => verified, () => { calls.push('prepare'); return prepare() })
  return { ensure, calls }
}

test('a spawned first life without a verified receipt prepares one, and resume calls it', () => {
  assert.ok(start >= 0 && end > start)
  assert.match(source.slice(end, end + 200), /ensureInitialLifeReceipt\(\)/)
  const h = harness(); h.ensure(); assert.deepEqual(h.calls, ['prepare'])
})

test('no receipt request after a respawn, while loading, dead, already verified, or before spawn', () => {
  for (const options of [{ shared: { deathRespawn: { deathId: 1 } } }, { shared: { loadingScreenEnded: false } }, { shared: { respawnTerrain: { pending: true } } }, { state: { dead: true } }, { state: { phase: 'joining' } }, { verified: true }]) {
    const h = harness(options); h.ensure(); assert.deepEqual(h.calls, [], JSON.stringify(options))
  }
})

test('a throttled or failing receipt request never throws into resume', async () => {
  const thrown = harness({ prepare: () => { throw Object.assign(new Error('Host lifecycle receipt is not ready'), { code: 'RESYNC_SCOPE_UNKNOWN' }) } })
  assert.doesNotThrow(() => thrown.ensure())
  const rejected = harness({ prepare: () => Promise.reject(new Error('mismatch')) })
  assert.doesNotThrow(() => rejected.ensure()); await new Promise(r => setImmediate(r))
})
