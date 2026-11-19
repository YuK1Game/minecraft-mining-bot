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
  h.progress.note(seen(), { reason: 'bed', waiting: true })
  h.pass(STALL_MS * 2); h.progress.note(seen(), { reason: 'bed', waiting: true })
  assert.equal(h.shared.dragonStall, undefined)
  h.pass(STALL_MS); h.progress.note(seen(), { reason: 'bed', waiting: true })
  assert.match(h.lines.at(-1), /15 分、場所・持ち物・体力が変わっていません（bed）/)
  h.pass(RESET_MS); h.progress.note(seen(), { reason: 'bed', waiting: true })
  assert.equal(h.resets(), 0)
  h.pass(2000); h.progress.note(seen({ health: 10 }), { reason: 'r' })
  assert.equal(h.shared.dragonStall, undefined)
  assert.match(h.lines.at(-1), /進み始めました/)
})

test('a stall noted before a reload of the behaviour code goes on, and its end is counted from its own start', () => {
  const h = harness()
  h.progress.note(seen(), { reason: 'r' })
  h.pass(STALL_MS); h.progress.note(seen(), { reason: 'r' })
  assert.equal(h.lines.length, 1)
  // The reload: a new progress over the same shared state, at a later time.
  let at = 1000000 + STALL_MS + 60000
  const lines = []
  const again = createProgress({ shared: h.shared, now: () => at, log: line => lines.push(line) })
  again.note(seen(), { reason: 'r' })
  assert.deepEqual(lines.map(line => /(\d+) 分、場所・持ち物・体力が変わっていません/.exec(line)?.[1]), ['6'], 'the same state is still the same stall')
  assert.equal(h.shared.dragonStall.since, 1000000)
  at += 60000
  again.note(seen({ feet: { x: -4870, y: 72, z: -5034 } }), { reason: 'r' })
  assert.match(lines.at(-1), /進み始めました（7 分止まっていました）/)
  assert.equal(h.shared.dragonStall, undefined)
  // Another state after the reload: the stall has ended, counted from its own start.
  const other = harness()
  other.shared.dragonStall = { since: 1000000 - 180000, reason: 'r', sig: 'something else' }
  other.progress.note(seen(), { reason: 'r' })
  assert.match(other.lines.at(-1), /進み始めました（3 分止まっていました）/)
})

test('a step that never returns is given up: the next tick starts a new one, and the old one cannot clear it', async () => {
  const { createDragonExpedition } = require('../src/modes/dragon-expedition')
  const record = { stage: 'early', early: {} }
  const raw = { phase: 'spawned', health: 20, dimension: 'overworld', inventory: { known: true, items: [] } }
  const stops = [], release = []
  let runs = 0
  const job = createDragonExpedition({ state: { observe: async () => {}, record: () => record, save: async () => true }, raw: () => raw, active: () => true,
    legacyNeeded: () => false, legacyBusy: () => false, legacyIdle: () => true, stopLegacy: reason => stops.push(reason),
    run: (r, signal) => { runs++; return new Promise(resolve => release.push(() => resolve({ reason: 'late ' + signal.aborted }))) } })
  assert.equal(job.tick(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 1)
  assert.equal(job.busy(), true)
  assert.equal(job.abandon('やめます'), true)
  assert.deepEqual(stops, ['やめます'])
  assert.equal(job.busy(), false)
  assert.equal(job.abandon('again'), false)
  assert.equal(job.tick(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 2)
  // The abandoned step answers at last: the new step stays the owner.
  release[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(job.busy(), true)
  assert.notEqual(job.status()?.reason, 'late true')
  release[1]()
  await job.settled()
  assert.equal(job.busy(), false)
  assert.equal(job.status().reason, 'late false')
})
