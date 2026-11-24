'use strict'
// The parent goal's ledger (src/modes/goal/goal-ledger.js) and what counts toward the expedition's goals
// (src/modes/dragon-goal-measure.js). Virtual clock only.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createGoalLedger, CONFIRM_MS, GAP_MS, WAITS, HOLD_MS, KEYS } = require('../src/modes/goal/goal-ledger')
const { goalKey, measure, value } = require('../src/modes/dragon-goal-measure')

function bench ({ shared = {}, saved = null, world = 'w' } = {}) {
  const clock = { at: 1000000 }
  const make = () => createGoalLedger({ shared, now: () => clock.at, world: () => world, restore: () => saved })
  return { shared, clock, make, ledger: make(), pass: ms => { clock.at += ms } }
}
// Looks every 2 s for `ms`, as the expedition's tick does.
function looks (b, ms, seen = {}) {
  let last = null
  for (let t = 0; t < ms; t += 2000) { b.pass(2000); last = b.ledger.look({ scope: 's', ...(typeof seen === 'function' ? seen(t) : seen) }) }
  return last
}
const item = (name, count = 1, more = {}) => ({ name: 'minecraft:' + name, count, ...more })

test('the same key is the same goal across plans and a reload; another key is a new goal with a new id', () => {
  const b = bench()
  const first = b.ledger.open('early.home_reserve')
  assert.equal(first.opened, true)
  assert.equal(first.goal.id, 'early.home_reserve#1')
  b.pass(60000)
  assert.equal(b.ledger.open('early.home_reserve').opened, false)
  // The reload: another ledger over the same shared state.
  const again = b.make().open('early.home_reserve')
  assert.equal(again.opened, false)
  assert.equal(again.goal.startedAt, 1000000)
  const next = b.ledger.open('nether')
  assert.equal(next.opened, true)
  assert.equal(next.goal.id, 'nether#2')
  assert.equal(next.previous.id, 'early.home_reserve#1')
})

test('only looked-at time counts against the goal: a gap adds ten seconds at most', () => {
  const b = bench()
  b.ledger.open('g')
  looks(b, 60000, { value: 5 })
  assert.equal(b.ledger.goal().stalledMs, 60000)
  b.pass(3600000) // a restart, or an hour with another owner
  b.ledger.look({ value: 5, scope: 's' })
  assert.equal(b.ledger.goal().stalledMs, 60000 + GAP_MS)
})

test('a new best is a result once it has stood three seconds; a value that only flickers is none (B7)', () => {
  const b = bench()
  b.ledger.open('g')
  looks(b, 20000, { value: 10 })
  // The chest's slots arrive before the inventory: for one look the item is counted twice.
  b.pass(2000); assert.equal(b.ledger.look({ value: 18, scope: 's' }).progressed, false)
  b.pass(2000); assert.equal(b.ledger.look({ value: 10, scope: 's' }).progressed, false)
  assert.equal(b.ledger.goal().results, 0)
  // While the inventory is open nothing is measured, and nothing is counted as a result.
  b.pass(2000); assert.equal(b.ledger.look({ value: null, scope: 's' }).progressed, false)
  // A gain that stays.
  b.pass(2000); assert.equal(b.ledger.look({ value: 11, scope: 's' }).progressed, false)
  b.pass(CONFIRM_MS); assert.equal(b.ledger.look({ value: 11, scope: 's' }).progressed, true)
  const g = b.ledger.goal()
  assert.equal(g.results, 1)
  assert.equal(g.stalledMs, 0)
  assert.equal(g.best, 11)
})

test('a step counts once until the next result, a mark only when closer than ever, both up to a bound', () => {
  const b = bench()
  b.ledger.open('g')
  looks(b, 10000, { value: 1 })
  assert.equal(b.ledger.step('home:furnace'), true)
  assert.equal(b.ledger.goal().stalledMs, 0)
  assert.equal(b.ledger.step('home:furnace'), false, 'the same step again is not progress')
  // To and fro between two destinations: the first reading sets the mark, coming back to it is nothing new.
  assert.equal(b.ledger.mark('trip:a', 100), false)
  assert.equal(b.ledger.mark('trip:a', 90), false, 'less than 16 m closer')
  assert.equal(b.ledger.mark('trip:a', 80), true)
  assert.equal(b.ledger.mark('trip:a', 120), false)
  assert.equal(b.ledger.mark('trip:a', 80), false)
  for (let i = 0; i < KEYS + 4; i++) b.ledger.step('roam:' + i)
  assert.equal(b.ledger.goal().steps.length, KEYS, 'new places without a result extend the clock a bounded number of times')
  assert.equal(b.ledger.step('one more'), false)
  // The first more of a support material since the last result is one step; more of it again is not.
  looks(b, 4000, { value: 1, extras: { log: 0 } })
  assert.equal(b.ledger.goal().steps.length, KEYS)
})

test('the first more of a support material since the last result is one step of the goal', () => {
  const b = bench()
  b.ledger.open('g')
  looks(b, 60000, { value: 1, extras: { log: 2, coal: 0 } })
  assert.equal(b.ledger.goal().stalledMs, 60000)
  assert.equal(looks(b, 2000, { value: 1, extras: { log: 3, coal: 0 } }).progressed, true)
  looks(b, 60000, { value: 1, extras: { log: 9, coal: 0 } })
  assert.equal(b.ledger.goal().stalledMs, 60000, 'more of the same wood is not another step')
  assert.equal(looks(b, 2000, { value: 1, extras: { log: 0, coal: 1 } }).progressed, true)
})

test('a named wait is not counted until its own limit, counted from the last progress; an unnamed one always is', () => {
  const b = bench()
  b.ledger.open('g')
  looks(b, 10 * 60000, { value: 1, wait: { code: 'DAWN' } })
  assert.equal(b.ledger.goal().stalledMs, 0)
  // The wait comes back after a moment of work: no new allowance.
  looks(b, 4000, { value: 1 })
  looks(b, 10 * 60000, { value: 1, wait: { code: 'DAWN' } })
  assert.equal(b.ledger.goal().stalledMs, 4000 + 20 * 60000 - WAITS.DAWN)
  const c = bench()
  c.ledger.open('g')
  looks(c, 60000, { value: 1, wait: { code: 'SOMETHING' } })
  assert.equal(c.ledger.goal().stalledMs, 60000)
})

test('the same failure three times, or a loop through two, spends that way; another state is another way (B5, B6)', () => {
  const b = bench()
  b.ledger.open('g')
  b.ledger.look({ value: 1, scope: 's' })
  const climb = cell => ({ stage: 'rise', code: 'STILL_COVERED', state: { cell } })
  assert.equal(b.ledger.fail(climb('1,30,1')).exhausted, false)
  assert.equal(b.ledger.spent(climb('1,30,1')), false)
  b.ledger.fail(climb('1,30,1'))
  // A reload in between: the count is in the shared state.
  b.ledger = b.make()
  assert.equal(b.ledger.fail(climb('1,30,1')).exhausted, true)
  assert.equal(b.ledger.spent(climb('1,30,1')), true)
  assert.equal(b.ledger.spent(climb('9,30,1')), false, 'from another cell the climb is tried again')
  // A way asked every two seconds fails once per its pace.
  const home = { stage: 'cook_return', code: 'HOME_NOT_REACHED', state: { from: '0,4,0' } }
  for (let i = 0; i < 20; i++) { b.pass(2000); b.ledger.fail(home, { paceMs: 60000 }) }
  assert.equal(b.ledger.spent(home), false)
  b.pass(60000); b.ledger.fail(home, { paceMs: 60000 })
  b.pass(60000); assert.equal(b.ledger.fail(home, { paceMs: 60000 }).exhausted, true)
  // Two ways taking turns.
  const c = bench()
  c.ledger.open('g'); c.ledger.look({ value: 1, scope: 's' })
  const a = { stage: 'trip', target: 'a', code: 'TRIP_FAILED', state: { from: 'x' } }, d = { stage: 'cook', code: 'COOK_NOTHING', state: { raw: 2 } }
  c.ledger.fail(a); c.ledger.fail(d); c.ledger.fail(a)
  assert.equal(c.ledger.fail(d).exhausted, true)
  // Another life drops the counts of the one before.
  c.ledger.look({ value: 1, scope: 'another life' })
  assert.equal(c.ledger.fail(a).count, 1)
})

test('decisions are bounded, then the goal is held; the hold is looked at again for a reason, with one decision (B5, B6)', () => {
  const b = bench()
  b.ledger.open('g')
  b.ledger.look({ value: 4, scope: 's' })
  assert.equal(b.ledger.limit, 3)
  for (let i = 1; i <= 3; i++) {
    looks(b, 600000, { value: 4 })
    assert.equal(b.ledger.due(600000), true)
    assert.deepEqual(b.ledger.decide(), { used: i, left: 3 - i })
    assert.equal(b.ledger.due(600000), false)
  }
  const hold = b.ledger.hold('NO_PROGRESS', { cell: '0,4,0', value: 4 })
  assert.equal(hold.until - b.clock.at, HOLD_MS[0])
  const same = { cell: '0,4,0', value: 4, scope: 's' }
  assert.equal(b.ledger.held(same).held, true)
  b.pass(60000)
  assert.equal(b.ledger.held({ ...same, value: 3 }).held, true, 'less than it had is no reason')
  assert.equal(b.ledger.held({ ...same, value: 5 }).released, 'GAINED')
  assert.equal(b.ledger.goal().decisions, 2, 'one decision is given back, not the budget')
  for (const [change, code] of [[{ cell: '1,4,0' }, 'MOVED'], [{ scope: 'next life' }, 'SCOPE']]) {
    b.ledger.hold('NO_PROGRESS', { cell: '0,4,0', value: 4 })
    assert.equal(b.ledger.held({ ...same, ...change }).released, code)
  }
  // Held again and again: the time until the next look grows to an hour.
  b.ledger.look({ value: 4, scope: 's' })
  const waits = []
  for (let i = 0; i < 4; i++) { const h = b.ledger.hold('NO_PROGRESS', { cell: '0,4,0', value: 4 }); waits.push((h.until - b.clock.at) / 60000); b.pass(h.until - b.clock.at); assert.equal(b.ledger.held(same).released, 'TIME') }
  assert.deepEqual(waits.slice(-2), [60, 60])
  // A hold taken in a wait (another owner of the input) ends with the wait.
  b.ledger.hold('WAIT_EXPIRED', { cell: '0,4,0', value: 4, wait: 'OWNER' })
  assert.equal(b.ledger.held({ ...same, wait: 'OWNER' }).held, true)
  assert.equal(b.ledger.held({ ...same, wait: null }).released, 'WAIT_OVER')
  // A real result gives the whole budget back.
  looks(b, 2000, { value: 9 }); b.pass(CONFIRM_MS)
  assert.equal(b.ledger.look({ value: 9, scope: 's' }).result, true)
  assert.equal(b.ledger.goal().decisions, 0)
})

test('another life measures again from what is received; the clock, the decisions and the most it had stay (B8)', () => {
  const b = bench()
  b.ledger.open('g')
  looks(b, 600000, { value: 30 })
  b.ledger.decide()
  const started = b.ledger.goal().startedAt
  // The death: almost nothing left, in another scope.
  b.pass(2000); b.ledger.look({ value: 8, scope: 'life 2' })
  const g = b.ledger.goal()
  assert.equal(g.best, 8)
  assert.equal(g.top, 30)
  assert.equal(g.startedAt, started)
  assert.equal(g.decisions, 1)
  assert.equal(g.scopes, 1)
  // Gathering again is a result (no stall), but gives no decisions back until there is more than there ever was.
  b.pass(2000); b.ledger.look({ value: 12, scope: 'life 2' }); b.pass(CONFIRM_MS)
  assert.equal(b.ledger.look({ value: 12, scope: 'life 2' }).result, true)
  assert.equal(b.ledger.goal().decisions, 1)
  b.pass(2000); b.ledger.look({ value: 31, scope: 'life 2' }); b.pass(CONFIRM_MS)
  b.ledger.look({ value: 31, scope: 'life 2' })
  assert.equal(b.ledger.goal().decisions, 0)
})

test('a restart reads the checkpoint: the same goal, its clock, its budget and its hold; another world or key does not (B8)', () => {
  const b = bench()
  b.ledger.open('early.home_reserve')
  looks(b, 600000, { value: 30 })
  b.ledger.decide(); b.ledger.decide()
  looks(b, 240000, { value: 30 })
  const saved = JSON.parse(JSON.stringify(b.ledger.checkpoint()))
  assert.equal(saved.stalledMin, 14)
  b.pass(3600000)
  const after = bench({ saved })
  after.clock.at = b.clock.at
  const opened = after.ledger.open('early.home_reserve')
  assert.equal(opened.opened, false)
  assert.equal(opened.goal.id, 'early.home_reserve#1')
  assert.equal(opened.goal.startedAt, 1000000)
  assert.equal(opened.goal.decisions, 2)
  assert.equal(opened.goal.stalledMs, 14 * 60000, 'the hour the Bot was off is not counted')
  assert.equal(opened.goal.top, 30)
  assert.equal(opened.goal.best, null, 'what it has is measured again from what is received')
  assert.equal(bench({ saved, world: 'another world' }).ledger.open('early.home_reserve').opened, true)
  assert.equal(bench({ saved }).ledger.open('nether').goal.id, 'nether#1')
  // The checkpoint changes with the goal, not with every look.
  const before = JSON.stringify(b.ledger.checkpoint())
  looks(b, 20000, { value: 30 })
  assert.equal(JSON.stringify(b.ledger.checkpoint()), before)
})

test('what counts toward the home kit: its items and their parts; making is a gain, eating a loss, the rest nothing', () => {
  const key = 'early.home_reserve'
  const of = (items, more = {}) => measure({ key, items, worn: [], ...more }).value
  assert.equal(measure({ key, items: null }), null, 'no value from an inventory that is not received')
  const base = of([item('stone_sword'), item('cobblestone', 64), item('rotten_flesh', 3)])
  assert.equal(base, 0)
  assert.equal(of([item('cobblestone', 640), item('dirt', 64), item('raw_copper', 10)]), 0, 'a full pack of something else is not progress')
  // Iron: ore, ingot, helmet. Each making is a gain, although the parts are used up.
  const ore = of([item('raw_iron', 5)]), ingot = of([item('iron_ingot', 5)]), helmet = of([item('iron_helmet')])
  assert.ok(ore > base && ingot > ore && helmet > ingot, `${ore} < ${ingot} < ${helmet}`)
  assert.equal(of([item('iron_helmet')]), of([], { worn: [{ name: 'minecraft:iron_helmet' }] }), 'worn or held is the same')
  assert.equal(of([]) + value('iron_helmet'), of([], { reserve: { iron_helmet: 1 } }), 'and so is the reserve chest, as received')
  // Food: the hunt, the cook, the meal.
  const raw = of([item('beef', 2)]), cooked = of([item('cooked_beef', 2)])
  assert.ok(raw > 0 && cooked > raw)
  assert.ok(of([item('cooked_beef', 1)]) < cooked)
  // Capped at what the kit can use.
  assert.equal(of([item('cooked_beef', 64)]), of([item('cooked_beef', 16)]))
  // Iron-or-below tools are disposable down to Bedrock's last use (0); diamond keeps its reserve.
  assert.ok(of([item('iron_pickaxe', 1, { durabilityRemaining: 1 })]) > 0)
  assert.ok(of([item('iron_pickaxe', 1, { durabilityRemaining: 0 })]) > 0)
  assert.equal(of([item('diamond_pickaxe', 1, { durabilityRemaining: 1 })]), 0)
  // The record's confirmed steps count, its counters and choices do not.
  const record = { stage: 'early', early: { gather: { name: 'food', count: 8 }, foodSearch: 4, supplySearch: { log: 3 } } }
  assert.equal(of([], { record }), 0)
  assert.equal(of([], { record: { stage: 'early', early: { ...record.early, spawnReady: true } } }), 1000)
  // Support materials are told apart.
  assert.deepEqual(measure({ key, items: [item('oak_log', 3), item('coal', 2)] }).extras.log, 3)
})

test('the goal key follows the objective, not the step; no key while it cannot be told', () => {
  assert.equal(goalKey(null), null)
  assert.equal(goalKey({ stage: 'nether' }), 'nether')
  assert.equal(goalKey({ stage: 'early' }, { id: 'home_reserve' }), 'early.home_reserve')
  assert.equal(goalKey({ stage: 'early' }, { id: 'observe' }), null)
  assert.equal(goalKey({ stage: 'early' }, { id: 'diamond', legacy: true }), null)
  assert.equal(goalKey({ stage: 'early' }, { id: 'diamond', legacy: false }), 'early.diamond')
})

test('a mining plan is no diamond progress, while received diamonds and crafted gear are measured',()=>{
  const key='early.diamond',record={stage:'early',early:{mine:{branch:{plan:{layers:[{id:'upper',y:16}],evaluation:{oreUnion:Array(100).fill({resource:'diamond'})}}}}}}
  assert.equal(measure({key,items:[],worn:[],record}).value,0)
  const ore=measure({key,items:[item('diamond',3)],worn:[]}).value
  const pick=measure({key,items:[item('diamond_pickaxe')],worn:[]}).value
  assert.ok(ore>0 && pick>ore)
})

test('after a decision the goal is measured from what is received: what was used up and is gathered again is a result, and gives no decision back', () => {
  const b = bench()
  b.ledger.open('g')
  b.ledger.look({ value: 18, scope: 's' })
  // Three meals: less than the goal had. Hunting one back is not more than its best, so not a result yet.
  looks(b, 60000, { value: 12 })
  assert.equal(looks(b, 60000, { value: 14 }).progressed, false)
  looks(b, 480000, { value: 14 })
  assert.equal(b.ledger.due(600000), true)
  b.ledger.decide()
  // Decided again at 14: the next piece of food is a result of the work since.
  looks(b, 10000, { value: 16 })
  assert.equal(b.ledger.goal().results, 1)
  assert.equal(b.ledger.goal().stalledMs < 10000, true)
  assert.equal(b.ledger.goal().decisions, 1, 'below the most it ever had: the decision stays used')
  assert.equal(b.ledger.goal().top, 18)
  // Eating and hunting in turn never ends the count of decisions: three, then the hold.
  for (let i = 2; i <= 3; i++) {
    looks(b, 600000, t => ({ value: Math.floor(t / 120000) % 2 ? 16 : 14 }))
    assert.equal(b.ledger.due(600000), true, 'round ' + i)
    assert.equal(b.ledger.decide().used, i)
    looks(b, 10000, { value: 16 })
  }
  assert.equal(b.ledger.goal().decisions, 3)
  // More than it ever had: the budget is back.
  looks(b, 10000, { value: 20 })
  assert.equal(b.ledger.goal().decisions, 0)
  assert.equal(b.ledger.goal().top, 20)
})
