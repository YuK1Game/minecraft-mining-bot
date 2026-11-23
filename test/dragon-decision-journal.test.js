'use strict'

// What the Bot is after and which way it chose is in the log (src/modes/decision-journal.js; the expedition's
// words in dragon-judge.js; said from the step's order in dragon-runtime.js and from `acquire` in dragon-supplies.js).
// User, 2026-11-23 16:34 JST: 「もうちょうログ細く出せる？Botが何をしようとして、どういう行動の判断をしたか」.
// Real here: the expedition's runtime (dragon-runtime.js: the step's order, the goal's ledger and its watcher, the
// saved record), the health wait (dragon-heal.js) and the journal. Stand-ins: the early step (it does what the test
// says a step did), the meal. A line in the log is a record of a decision, not the game's result.
// Before (main dd34bb5, the second scene): 150 seconds with a change of what the kit step is after and a wait for
// health in them, and the log holds 「プレイヤーモード: …」 lines only: no goal, no reason, no number.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createJournal, expeditionJudge, owner, nextAction, QUIET_MS, AGAIN_MS, WIDE } = require('../src/modes/decision-journal')
const says = require('../src/modes/dragon-judge')
const { createWorld } = require('./helpers/dragon-goal-world')

const book = () => { const w = { at: 1e9, lines: [], shared: {} }; w.journal = createJournal({ shared: w.shared, log: line => w.lines.push(line), now: () => w.at }); return w }
const JUDGED = /^判断/

test('a decision is one line when it is made; the same decision again is none, and one more every five minutes', () => {
  const w = book()
  assert.equal(w.journal.note('遠征', 'g|heal', '遠征［g］ 体力の回復を先にします｜理由: 体力 9'), true)
  for (let i = 0; i < 100; i++) { w.at += 2000; w.journal.note('遠征', 'g|heal', '遠征［g］ 体力の回復を先にします｜理由: 体力 ' + (9 + i / 20)) }
  assert.deepEqual(w.lines, ['判断: 遠征［g］ 体力の回復を先にします｜理由: 体力 9'], 'the numbers alone are not another decision')
  w.at += AGAIN_MS
  w.journal.note('遠征', 'g|heal', '遠征［g］ 体力の回復を先にします｜理由: 体力 15')
  assert.equal(w.lines.length, 2)
  assert.match(w.lines[1], /^判断（8 分続いています）: 遠征［g］ 体力の回復を先にします｜理由: 体力 15$/, 'with the numbers of now')
  // Another decision, and another lane beside it.
  w.at += 2000
  w.journal.note('遠征', 'g|early', '遠征［g］ 装備をそろえます')
  w.journal.note('持ち主', 'expedition|', '作業の持ち主は遠征')
  assert.deepEqual(w.lines.slice(2), ['判断: 遠征［g］ 装備をそろえます', '判断: 作業の持ち主は遠征'])
})

test('two decisions taking turns every two seconds are written once in thirty seconds each, with the turns between', () => {
  const w = book()
  for (let i = 0; i < 40; i++) { w.journal.note('遠征', i % 2 ? 'b' : 'a', i % 2 ? 'B' : 'A'); w.at += 2000 }
  assert.deepEqual(w.lines.slice(0, 2), ['判断: A', '判断: B'])
  assert.equal(w.lines.length, 6, w.lines.join('\n'))
  assert.match(w.lines[2], /^判断: A（この間に \d+ 回入れ替わりました）$/)
  assert.ok(QUIET_MS >= 20000)
})

test('a line is cut at the width the log keeps; a reload of the behaviour code writes nothing again', () => {
  const w = book()
  w.journal.note('遠征', 'k', 'あ'.repeat(600))
  assert.equal(w.lines[0].length, WIDE)
  createJournal({ shared: w.shared, log: line => w.lines.push(line), now: () => w.at + 4000 }).note('遠征', 'k', 'あ'.repeat(600))
  assert.equal(w.lines.length, 1)
})

test('things asked for inside one another are one line, left to right, once the asking is as deep as it goes', () => {
  const w = book(), timers = []
  const judge = expeditionJudge({ journal: w.journal, goal: () => ({ id: 'early.home_reserve#4', key: 'early.home_reserve' }), later: run => { timers.push(run); return timers.length } })
  const helmet = judge.need('iron_helmet', 1, 2), ingot = judge.need('iron_ingot', 0, 5), raw = judge.need('raw_iron', 0, 5)
  assert.equal(w.lines.length, 0, 'nothing while the asking goes down')
  assert.equal(timers.length, 1)
  timers[0]()
  assert.deepEqual(w.lines, ['判断: 遠征［early.home_reserve#4］ いま用意する物: iron_helmet 1/2 ← iron_ingot 0/5 ← raw_iron 0/5（左の物のために、右の物を先に用意します）'])
  raw(); ingot(); helmet(); helmet()
  // The next step asks the same way: no line. With the raw iron in the bag the asking ends one thing earlier: a line.
  w.at += 2000
  const again = [judge.need('iron_helmet', 1, 2), judge.need('iron_ingot', 0, 5), judge.need('raw_iron', 2, 5)]
  again.reverse().forEach(leave => leave())
  assert.equal(w.lines.length, 1)
  w.at += 2000
  const smelt = [judge.need('iron_helmet', 1, 2), judge.need('iron_ingot', 0, 5)]
  smelt.reverse().forEach(leave => leave())
  assert.equal(w.lines[1], '判断: 遠征［early.home_reserve#4］ いま用意する物: iron_helmet 1/2 ← iron_ingot 0/5（左の物のために、右の物を先に用意します）', 'written when the outermost asking returned')
  // One thing alone.
  w.at += 2000
  judge.need('food', 3, 8)()
  assert.equal(w.lines[2], '判断: 遠征［early.home_reserve#4］ いま用意する物: food 3/8')
})

test('the words of each step carry the received numbers that chose it', () => {
  const bag = n => ({ known: true, items: Array.from({ length: n }, (_, slot) => ({ slot, name: 'minecraft:cobblestone', count: 64 })) })
  assert.deepEqual(says.heal(9.33, 16), ['heal', '体力の回復を先にします', '体力 9.3（12 以下で始め、18 で終わり）・満腹度 16'])
  assert.deepEqual(says.heal(9.33, undefined)[2], '体力 9.3（12 以下で始め、18 で終わり）・満腹度 ?', 'an unreceived hunger is not a number')
  assert.equal(says.pack(bag(35))[2], '持ち物 35/36 枠（35 枠から）')
  assert.equal(says.pack(null)[2], '持ち物は未受信（35 枠から）')
  assert.equal(says.night({ time: 24000 * 3 + 11620, source: 'server_set_time' })[2], '受信した時計 11620（夕方は 11500 から）')
  assert.equal(says.held({ code: 'NO_PROGRESS', until: 1e9 + 9.5 * 60000 }, 1e9)[2], '保留の理由 NO_PROGRESS・見直しは遅くとも 10 分後')
  assert.equal(says.held({ code: 'NO_PROGRESS', until: 1 }, 1e9)[0], 'held:NO_PROGRESS')
  const objective = { id: 'home_reserve', label: '本拠点のラージチェストに再出発用の装備を揃えます。' }
  assert.deepEqual(says.early(objective, { early: {} }), ['early.home_reserve:', objective.label, '予備チェストを開けて、足りない装備を調べる'])
  const pinned = says.early(objective, { early: { gather: { name: 'iron_helmet', count: 2 }, mine: { branch: { request: { resource: 'raw_iron', targetHeld: 5, layer: 'upper' } } } } })
  assert.deepEqual(pinned, ['early.home_reserve:iron_helmet', objective.label, '予備チェストを調べた結果、iron_helmet が 2 個要る・採掘場へ頼んでいる物: raw_iron を 5 個まで（upper）'])
  assert.equal(says.early({ id: 'wood', label: '原木から最初の道具を作ります。', legacy: true }, {})[2], '通常の作業の担当')
})

test('who has the player, and the ordinary work\'s next action with what it is aimed at', () => {
  const w = book()
  owner(w.journal, { expedition: false, label: '壊れた本拠点を直します。' })
  owner(w.journal, { expedition: false, label: '壊れた本拠点を直します。' })
  w.at += 2000
  owner(w.journal, { expedition: true, label: '本拠点のラージチェストに再出発用の装備を揃えます。', ahead: '拠点への帰還' })
  assert.deepEqual(w.lines, ['判断: 作業の持ち主は通常の作業｜いまの目的: 壊れた本拠点を直します', '判断: 作業の持ち主は遠征｜いまの目的: 本拠点のラージチェストに再出発用の装備を揃えます｜先に動いているもの: 拠点への帰還'])
  assert.equal(nextAction({ type: 'tunnel', resource: 'diamond', reason: '確認済みの鉱石へ掘り進みます。', target: { x: 9.5, y: -53, z: -4.2 }, resourceTarget: { x: 12, y: -54, z: -5 } }), '次の行動: 確認済みの鉱石へ掘り進みます。［tunnel diamond → (12, -54, -5)］')
  assert.equal(nextAction({ type: 'wait', reason: '持ち物の受信を待ちます。' }), '次の行動: 持ち物の受信を待ちます。［wait］')
  assert.equal(nextAction({ reason: 'test' }), '次の行動: test')
})

// The expedition with its bed confirmed (the goal: the kit at home). The early step is the test's.
async function expedition (t, step) {
  const food = { preview: () => ({ ready: true }), eat: async () => {}, snapshot: () => ({ hunger: 16 }) }
  return createWorld(t, { step, ports: () => ({ operations: { food } }) })
}

test('the expedition says its goal and what it does for it once, and again when the thing it is after is another', async t => {
  const w = await expedition(t, async ctx => { if (w.at >= 1e9 + 40000) ctx.memory.early.gather = { name: 'iron_helmet', count: 2, since: w.at }; return { done: false, reason: 'iron_helmet を準備しています（0/2）。' } })
  await w.pass(40000, { tickMs: 2000 })
  assert.deepEqual(w.said(JUDGED), ['判断: 遠征［early.home_reserve#1］ 本拠点のラージチェストに再出発用の装備を揃えます｜理由: 予備チェストを開けて、足りない装備を調べる'], w.lines.join('\n'))
  await w.pass(40000, { tickMs: 2000 })
  assert.deepEqual(w.said(JUDGED).slice(1), ['判断: 遠征［early.home_reserve#1］ 本拠点のラージチェストに再出発用の装備を揃えます｜理由: 予備チェストを調べた結果、iron_helmet が 2 個要る'], w.lines.join('\n'))
})

test('a wait for health is said with the health that began it, before the wait is taken, and the work after it again', async t => {
  const w = await expedition(t, async () => ({ done: false, reason: 'iron_helmet を準備しています（0/2）。' }))
  await w.pass(20000, { tickMs: 2000 })
  w.raw.health = 11.4
  await w.pass(40000, { tickMs: 2000 })
  const judged = () => w.said(JUDGED)
  assert.equal(judged().length, 2, w.lines.join('\n'))
  assert.equal(judged()[1], '判断: 遠征［early.home_reserve#1］ 体力の回復を先にします｜理由: 体力 11.4（12 以下で始め、18 で終わり）・満腹度 16')
  assert.ok(w.lines.indexOf(judged()[1]) < w.lines.findIndex(line => /体力18以上への回復を待ちます/.test(line)), 'the decision stands before what the step answered')
  assert.equal(w.calls > 0 && w.said(/回復を待ちます/).length, 1)
  w.raw.health = 18.5
  await w.pass(20000, { tickMs: 2000 })
  assert.equal(judged().length, 3, w.lines.join('\n'))
  assert.match(judged()[2], /^判断: 遠征［early\.home_reserve#1］ 本拠点のラージチェストに再出発用の装備を揃えます/)
  // Ten more minutes of the same work: one line every five minutes, nothing else from the journal.
  await w.pass(600000, { tickMs: 2000, each: () => { w.have('iron_ingot', Math.floor((w.at - 1e9) / 20000)) } })
  assert.deepEqual(judged().slice(3).map(line => line.replace(/（\d+ 分/, '（N 分')), Array(2).fill('判断（N 分続いています）: 遠征［early.home_reserve#1］ 本拠点のラージチェストに再出発用の装備を揃えます｜理由: 予備チェストを開けて、足りない装備を調べる'), w.lines.join('\n'))
})

// Real Realm 2026-11-24 08:16 JST: hunger 6, no food, health 19.5, and the expedition went on with the mine's supplies.
test('hunger of 6 with nothing to eat is said and comes before the goal\'s work; at 7 the work goes on', async t => {
  let hunger = 7, work = 0
  const food = { preview: () => ({ ready: false, code: 'FOOD_NOT_IN_INVENTORY' }), eat: async () => {}, snapshot: () => ({ hunger }) }
  const w = await createWorld(t, { step: async () => { work += 1; return { done: false, reason: 'iron_helmet を準備しています（0/2）。' } }, ports: () => ({ operations: { food } }) })
  await w.pass(20000, { tickMs: 2000 })
  assert.ok(work > 0 && w.said(/食料を先に用意します/).length === 0, w.lines.join('\n'))
  hunger = 6
  const before = work
  await w.pass(20000, { tickMs: 2000 })
  assert.equal(w.said(JUDGED).filter(line => /食料を先に用意します｜理由: 満腹度 6（6 以下）で、食べられる物がない/.test(line)).length, 1, w.lines.join('\n'))
  assert.equal(work, before, 'the goal\'s work waits for the food')
})
