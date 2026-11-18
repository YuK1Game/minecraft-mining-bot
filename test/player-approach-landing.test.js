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
