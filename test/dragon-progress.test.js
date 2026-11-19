'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createProgress, STALL_MS, RESET_MS } = require('../src/modes/dragon-progress')

function harness () {
  const shared = {}, lines = []
  let at = 1000000, resets = 0
  const progress = createProgress({ shared, now: () => at, log: line => lines.push(line), onReset: () => { resets++; return 'gather food' } })
  return { shared, lines, progress, pass: ms => { at += ms }, resets: () => resets }
}
const seen = (over = {}) => ({ feet: { x: -4900.5, y: 76, z: -4990.5 }, items: [{ name: 'minecraft:cooked_beef', count: 9 }], worn: [], health: 19.6, stage: 'early', ...over })

test('a step whose place, items and health do not change is reported once per five minutes, then its choices are dropped', () => {
  const h = harness()
  h.progress.note(seen(), { reason: '狩りで得た肉を確認して調理します。' })
  // A different text for the same state is not progress, and a step inside the same 8-block cell is not either.
  for (let i = 0; i < 149; i++) { h.pass(2000); h.progress.note(seen({ feet: { x: -4899.2, y: 76, z: -4989.1 } }), { reason: i % 2 ? '集めた材料を本拠点で調理します。' : '調理後の食料数を確認します。' }) }
  assert.equal(h.lines.length, 0)
  assert.equal(h.shared.dragonStall, undefined)
  h.pass(2000)
  h.progress.note(seen(), { reason: '集めた材料を本拠点で調理します。' })
  assert.equal(h.lines.length, 1)
  assert.match(h.lines[0], /5 分、場所・持ち物・体力が変わっていません（集めた材料を本拠点で調理します。）/)
  assert.equal(h.shared.dragonStall.reason, '集めた材料を本拠点で調理します。')
  for (let i = 0; i < 60; i++) { h.pass(2000); h.progress.note(seen(), { reason: 'x' }) }
  assert.equal(h.lines.length, 1)
  assert.equal(h.resets(), 0)
  h.pass(RESET_MS - STALL_MS - 120000)
  h.progress.note(seen(), { reason: 'x' })
  assert.equal(h.resets(), 1)
  assert.match(h.lines.at(-1), /覚えていた選択を捨てて、受信した状態から決め直します（gather food）/)
  h.pass(2000)
  h.progress.note(seen(), { reason: 'x' })
  assert.equal(h.resets(), 1)
})

test('a received change is progress: items, armour, health, a new cell; waiting on purpose is not a stall', () => {
  for (const change of [{ items: [{ name: 'minecraft:cooked_beef', count: 10 }] }, { worn: [{ name: 'minecraft:iron_helmet' }] }, { health: 12 }, { feet: { x: -4880, y: 76, z: -4990 } }, { stage: 'nether' }]) {
    const h = harness()
    h.progress.note(seen())
    h.pass(STALL_MS - 1000); h.progress.note(seen(change))
    h.pass(STALL_MS - 1000); h.progress.note(seen(change))
    assert.equal(h.lines.length, 0, JSON.stringify(change))
  }
  const h = harness()
  h.progress.note(seen())
  h.pass(STALL_MS); h.progress.note(seen(), { reason: 'r' })
  assert.ok(h.shared.dragonStall)
  h.pass(2000); h.progress.note(seen(), { reason: 'bed', waiting: true })
  assert.equal(h.shared.dragonStall, undefined)
  assert.match(h.lines.at(-1), /進み始めました/)
  h.pass(STALL_MS * 3); h.progress.note(seen(), { reason: 'bed', waiting: true })
  h.pass(STALL_MS - 1000); h.progress.note(seen(), { reason: 'r' })
  assert.equal(h.shared.dragonStall, undefined)
})
