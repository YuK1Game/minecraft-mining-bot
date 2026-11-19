'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { landFirst, offGrid } = require('../src/combat/approach-landing')

const delay = async () => {}

test('the planner grid: whole and half blocks are on it, 72.25 is not', () => {
  assert.equal(offGrid(72), false)
  assert.equal(offGrid(72.5), false)
  assert.equal(offGrid(72.25), true)
  assert.equal(offGrid(NaN), false)
})

test('a grounded body plans at once: no wait, no settle', async () => {
  let settles = 0, waits = 0
  assert.equal(await landFirst({ feetY: () => 73, running: () => false, settle: () => { settles++ }, delay: async () => { waits++ } }), 'grounded')
  assert.equal(settles + waits, 0)
})

test('a body in a running jump lands by itself: no settle', async () => {
  let y = 72.25, settles = 0, polls = 0
  const out = await landFirst({ feetY: () => y, running: () => polls < 3, settle: () => { settles++ }, delay: async () => { if (++polls >= 3) y = 72 } })
  assert.equal(out, 'landed')
  assert.equal(settles, 0)
})

test('live 06:33:22: feet 72.25 over a floor at 72 with nothing moving: one settle lands it', async () => {
  let y = 72.25, settling = false, settles = 0, ticks = 0
  const out = await landFirst({ feetY: () => y, running: () => settling, settle: () => { settles++; settling = true }, delay: async () => { if (settling && ++ticks >= 4) { y = 72; settling = false } } })
  assert.equal(out, 'settled')
  assert.equal(settles, 1)
})

test('a refused settle and a movement that never ends are reported, not retried', async () => {
  assert.equal(await landFirst({ feetY: () => 72.25, running: () => false, settle: () => { throw new Error('unknown terrain') }, delay }), 'refused')
  let settles = 0
  assert.equal(await landFirst({ feetY: () => 72.25, running: () => true, settle: () => { settles++ }, delay }), 'moving')
  assert.equal(settles, 0)
})

test('live 18:02:19: every route refused with the landing wait: one settle, one more plan', async () => {
  const { planLanded, settleNow } = require('../src/combat/approach-landing')
  const WAIT = 'No known bounded melee stance (routes 12, no standing 46: Wait for a supported landing before planning x12)'
  let plans = 0, lands = 0
  const out = await planLanded(async () => (++plans === 1 ? { ready: false, reason: WAIT } : { ready: true, code: 'PARTIAL_APPROACH' }), async () => { lands++; return 'settled' })
  assert.deepEqual([plans, lands, out.ready], [2, 1, true])
  // Still refused after the landing, or no landing: said in the reason, no third plan.
  plans = 0
  const still = await planLanded(async () => { plans++; return { ready: false, reason: WAIT } }, async () => 'settled')
  assert.equal(plans, 2)
  assert.match(still.reason, /\[after landing\]$/)
  plans = 0
  const refused = await planLanded(async () => { plans++; return { ready: false, reason: WAIT } }, async () => 'refused')
  assert.equal(plans, 1)
  assert.match(refused.reason, /\[landing: refused\]$/)
  // Any other refusal, and a ready approach, pass through untouched.
  lands = 0
  const other = { ready: false, reason: 'No known bounded melee stance (routes 3, no standing 2: No safe route found x3)' }
  assert.equal(await planLanded(async () => other, async () => { lands++; return 'settled' }), other)
  const ready = { ready: true }
  assert.equal(await planLanded(async () => ready, async () => { lands++; return 'settled' }), ready)
  assert.equal(lands, 0)
  // The settle itself: waits for a running movement, then settles once.
  let running = 2, settles = 0
  assert.equal(await settleNow({ running: () => running > 0, settle: () => { settles++ }, delay: async () => { running-- } }), 'settled')
  assert.equal(settles, 1)
  assert.equal(await settleNow({ running: () => true, settle: () => { settles++ }, delay }), 'moving')
  assert.equal(await settleNow({ running: () => false, settle: () => { throw new Error('no') }, delay }), 'refused')
  assert.equal(settles, 1)
})
