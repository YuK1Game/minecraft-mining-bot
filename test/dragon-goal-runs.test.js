'use strict'

// What is and is not progress of an expedition goal, and what a goal keeps across a wait, a failure, a
// death, a reload and a restart (指示書 B4〜B8), through the real runtime over a virtual clock.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorld, PICK } = require('./helpers/dragon-goal-world')

const MIN = 60000
const WARN = /分進んでいません/, DECIDE = /決め直します/, HOLD = /保留します/, RELEASE = /保留を解いて/, MOVING = /進み始めました/
const noted = w => w.lines.filter(line => /^遠征:/.test(line))

test('B4: the wait for the morning is a wait with its own limit, not a stall; past the limit it is one', async t => {
  let night = true
  const w = await createWorld(t, { step: async () => night
    ? { done: false, phase: 'waiting', reason: '本拠点の中で朝を待ちます。', wait: { code: 'DAWN' } }
    : { done: false, reason: 'iron_helmet を準備しています（0/2）。' } })
  await w.pass(14 * MIN)
  assert.deepEqual(noted(w), [])
  assert.equal(w.goal().stalledMs, 0)
  assert.ok(w.goal().waited.DAWN >= 13 * MIN)
  assert.equal(w.rt.runState().wait.code, 'DAWN')
  // A night that does not end: after 15 minutes of it the same time counts as any other.
  await w.pass(6 * MIN + 20000)
  assert.equal(w.said(WARN).length, 1)
  assert.match(w.said(WARN)[0], /待ち DAWN は期限切れ/)
  // Decided again past the limit: the wait is looked at again, the step's choices are not dropped.
  w.shared.dragonHomeWalk = { at: w.at }
  await w.pass(5 * MIN)
  assert.equal(w.said(DECIDE).length, 1)
  assert.ok(w.shared.dragonHomeWalk, 'a wait that outlasted its limit drops nothing the step remembers')
  // Morning: the wait is over and the work is counted from here.
  night = false
  await w.pass(MIN)
  assert.equal(w.rt.runState().wait, null)
})

test('B4: a craft, a way that gets closer with a setback, and the first wood are progress; a round trip is not', async t => {
  let left = 400, trip = true
  const w = await createWorld(t, { items: [PICK, { slot: 1, name: 'minecraft:iron_ingot', count: 5 }], step: async (ctx, w) => {
    // A long way round: closer by 20 m every two minutes, set back by the server once on the way.
    if (trip) { const turn = Math.floor((w.at - 1e9) / (2 * MIN)); left = 400 - 20 * turn + (turn === 3 ? 30 : 0); ctx.goal.mark('trip:0,4,0', left) }
    return { done: false, reason: '本拠点へ戻っています。' }
  } })
  await w.pass(20 * MIN)
  assert.deepEqual(noted(w), [], 'twenty minutes of a way that gets closer are not a stall')
  assert.ok(w.goal().progressAt > 1e9 + 17 * MIN)
  // The craft: five ingots become a helmet. The value rises, and once it has stood three seconds it is a result.
  trip = false
  w.have('iron_ingot', 0); w.have('iron_helmet', 1)
  await w.pass(20000)
  assert.equal(w.goal().results, 1)
  assert.deepEqual(w.goal().marks, {}, 'a result starts the marks again')
  // The first wood since the result is one step, more of it is not another.
  await w.pass(4 * MIN)
  w.have('oak_log', 1)
  await w.pass(4 * MIN)
  w.have('oak_log', 3)
  await w.pass(30000)
  assert.deepEqual(noted(w), [], 'the first log restarted the count, and five minutes since are not yet over')
  await w.pass(MIN)
  assert.equal(w.said(WARN).length, 1, 'the next two logs did not restart it')
  // A round trip between two distances sets no new mark.
  trip = true
  const before = w.goal().progressAt
  w.step = async ctx => { ctx.goal.mark('trip:9,4,9', Math.floor(w.at / (2 * MIN)) % 2 ? 300 : 200); return { done: false, reason: '本拠点へ戻っています。' } }
  await w.pass(6 * MIN)
  assert.equal(w.goal().progressAt, before)
})

test('B5 B6: the same failure is tried three times however often the goal is decided again; another state opens it again', async t => {
  let tries = 0, cell = '0,4,0'
  const w = await createWorld(t, { step: async ctx => {
    const failure = { stage: 'rise', code: 'STILL_COVERED', state: { cell } }
    if (!ctx.goal.spent(failure)) { tries++; ctx.goal.fail(failure) }
    return { done: false, reason: '地上へ出ます。' }
  } })
  await w.pass(25 * MIN)
  assert.equal(w.said(DECIDE).length, 2, 'decided again twice meanwhile')
  assert.equal(tries, 3)
  // The Bot stands somewhere else: the same step from there is another way.
  cell = '1,4,0'
  await w.pass(MIN)
  assert.equal(tries, 6)
})

test('B6: a hold is looked at again when the goal has more than it had, and a result above all it ever had gives the decisions back', async t => {
  const w = await createWorld(t)
  await w.pass(41 * MIN)
  assert.equal(w.said(HOLD).length, 1)
  assert.equal(w.goal().decisions, 3)
  // Something the goal is made of arrives while it is held (a drop picked up on the way to the bed).
  w.have('raw_iron', 2)
  await w.pass(30000)
  assert.match(w.said(RELEASE)[0], /GAINED/)
  assert.match(w.said(MOVING)[0], /4[01] 分止まっていました/)
  assert.equal(w.goal().hold, null)
  assert.equal(w.goal().decisions, 0)
  assert.equal(w.goal().holds, 0)
  assert.equal(w.shared.dragonStall, undefined)
})

test('B7: updates that arrive apart are not a result while they disagree, and nothing is one while the inventory is open', async t => {
  const w = await createWorld(t, { items: [PICK, { slot: 1, name: 'minecraft:iron_helmet', count: 1 }] })
  await w.pass(MIN)
  // The helmet goes into the reserve chest: the chest's slots arrive a second before the inventory's.
  w.shared.dragonReserveSeen = { counts: { iron_helmet: 1 } }
  await w.pass(1000, { tickMs: 1000 })
  w.have('iron_helmet', 0)
  await w.pass(10000, { tickMs: 1000 })
  assert.equal(w.goal().results, 0, 'one helmet seen twice for a second is not a second helmet')
  // The inventory is open (a transfer nobody confirmed): what it shows is not measured.
  w.shared.inventoryUncertain = true
  w.have('iron_helmet', 1)
  await w.pass(10000, { tickMs: 1000 })
  assert.equal(w.goal().results, 0)
  assert.equal(w.goal().cand, null)
  // Received again, and still there three seconds later: now it is a result.
  w.shared.inventoryUncertain = false
  await w.pass(2000, { tickMs: 1000 })
  assert.equal(w.goal().results, 0)
  await w.pass(3000, { tickMs: 1000 })
  assert.equal(w.goal().results, 1)
})

test('B8: a restart reads the goal back from the saved record: its id, its start, its stall and its decisions', async t => {
  const w = await createWorld(t)
  const started = w.at
  await w.pass(12 * MIN + 30000)
  assert.equal(w.said(DECIDE).length, 1)
  await w.shared.flushDragonCheckpoints()
  // The process ends; five minutes later another one starts with nothing but the files.
  w.at += 5 * MIN
  w.lines.length = 0
  w.boot()
  await w.pass(30000)
  assert.equal(w.goal().id, 'early.home_reserve#1')
  assert.equal(w.goal().startedAt, started)
  assert.equal(w.goal().decisions, 1)
  assert.ok(w.goal().stalledMs >= 12 * MIN && w.goal().stalledMs < 13 * MIN + 30000, 'the time nobody looked is not counted: ' + w.goal().stalledMs)
  assert.match(w.said(WARN)[0], /が 12 分進んでいません.*決め直し 1\/3/)
  assert.deepEqual(w.said(DECIDE), [], 'the decision made before the restart is not made again')
  await w.pass(8 * MIN)
  assert.equal(w.said(DECIDE).length, 1)
  assert.match(w.said(DECIDE)[0], /決め直し 2\/3/)
})

test('B8: a death measures the goal again from what is received; its start and its decisions stay, and what the next life gathers again gives none back', async t => {
  const w = await createWorld(t, { items: [PICK, { slot: 1, name: 'minecraft:iron_helmet', count: 1 }, { slot: 2, name: 'minecraft:iron_ingot', count: 3 }] })
  const started = w.at
  await w.pass(22 * MIN)
  assert.equal(w.goal().decisions, 2)
  const top = w.goal().top
  // Another life: the items are gone.
  w.life = 'a/1'
  w.have('iron_helmet', 0); w.have('iron_ingot', 0)
  await w.pass(MIN)
  assert.equal(w.goal().id, 'early.home_reserve#1')
  assert.equal(w.goal().startedAt, started)
  assert.equal(w.goal().decisions, 2)
  assert.equal(w.goal().scopes, 1)
  assert.equal(w.goal().top, top)
  // Three ingots again: a result of this life, below what the goal once had.
  w.have('iron_ingot', 3)
  await w.pass(30000)
  assert.equal(w.goal().results, 1)
  assert.equal(w.goal().stalledMs < MIN, true)
  assert.equal(w.goal().decisions, 2, 'the budget comes back only for more than the goal ever had')
})

test('the time another owner has the player is not counted, and the same goal goes on when the expedition has it again', async t => {
  const w = await createWorld(t)
  const started = w.at
  await w.pass(3 * MIN)
  // The pickaxe breaks: the ordinary work owns the player until there is one again.
  const pick = w.raw.inventory.items
  w.raw.inventory = { known: true, items: [] }
  await w.pass(30 * MIN)
  assert.deepEqual(noted(w), [])
  w.raw.inventory = { known: true, items: pick }
  await w.pass(MIN)
  assert.equal(w.goal().id, 'early.home_reserve#1')
  assert.equal(w.goal().startedAt, started)
  assert.ok(w.goal().stalledMs >= 3 * MIN && w.goal().stalledMs <= 5 * MIN, String(w.goal().stalledMs))
  await w.pass(MIN + 30000)
  assert.equal(w.said(WARN).length, 1)
})
