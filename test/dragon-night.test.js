'use strict'
// From dusk the expedition goes home and into its bed (src/modes/dragon-night.js).
// Live 2026-11-18 22:03-22:07 JST: hunting beside the house after dark, health 19.1 -> 3.6 in nine hits.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nightHome, TRY_MS } = require('../src/modes/dragon-night')
const { bedOf } = require('../src/modes/house/house-spawn')

const origin = { x: 0, y: 64, z: 0 }
function scene ({ time = 13000, source = 'server_set_time', home = true, bedReady = true, skips = true, refuse = null } = {}) {
  let clock = 1000000
  const bed = bedOf(origin)
  const f = { used: 0, woken: 0, logs: [], time, source, approached: 0 }
  f.ctx = {
    shared: { playerHouse: { origin, done: true } }, now: () => clock, log: line => f.logs.push(line), cancelled: () => false,
    getBlock: (x, y, z) => x === bed.x && y === bed.y && z === bed.z ? { known: true, name: 'minecraft:bed' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' },
    hands: { walk: async () => true },
    operations: { interactions: {
      previewUseBed: () => ({ ready: bedReady }),
      useBed: async () => { if (refuse) throw new Error(refuse); f.used++; if (skips) f.time = 24000 + 10 },
      wakeBed: async () => { f.woken++ } } }
  }
  f.step = () => nightHome(f.ctx, { clock: () => ({ time: f.time, source: f.source }), approach: async () => { f.approached++; return home }, sleep: async ms => { clock += ms } })
  f.tick = ms => { clock += ms }
  return f
}

test('by day, with an unknown clock or without a finished house, the step is not a night step', async () => {
  assert.equal(await scene({ time: 6000 }).step(), null)
  assert.equal(await scene({ source: 'guess' }).step(), null, 'an unknown clock is not a night')
  const f = scene(); f.ctx.shared.playerHouse.done = false
  assert.equal(await f.step(), null)
})

test('after dusk away from home: the step walks home and does nothing else', async () => {
  const f = scene({ home: false })
  assert.equal((await f.step()).reason, '夜のため、本拠点へ戻ります。')
  assert.equal(f.used, 0)
})

test('at home the bed is used; the night is slept when the received clock says morning', async () => {
  const f = scene()
  const out = await f.step()
  assert.equal(f.used, 1)
  assert.equal(f.woken, 0, 'the server woke the sleeper')
  assert.equal(out.reason, '朝になりました。作業に戻ります。')
  assert.equal(await f.step(), null, 'morning: the ordinary steps go on')
})

test('the night does not pass: out of the bed, wait in the house, try again after the rest', async () => {
  const f = scene({ skips: false })
  assert.equal((await f.step()).reason, '夜のため、本拠点の中で朝を待ちます。')
  assert.equal(f.used, 1); assert.equal(f.woken, 1)
  f.tick(2000)
  await f.step()
  assert.equal(f.used, 1, 'not again within the rest')
  f.tick(TRY_MS)
  await f.step()
  assert.equal(f.used, 2)
})

test('a refused bed (monsters near) is logged and the Bot stays in the house', async () => {
  const f = scene({ refuse: 'monsters nearby' })
  assert.equal((await f.step()).reason, '夜のため、本拠点の中で朝を待ちます。')
  assert.equal(f.logs.filter(line => /本拠点のベッドを使えません（monsters nearby）/.test(line)).length, 1)
})
