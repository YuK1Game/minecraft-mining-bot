'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { requestMine, stepLayer } = require('../src/modes/mining/mine-controller')
const { mineSteps, stepCells } = require('../src/modes/mining/mine-geometry')
const { createDragonExpedition } = require('../src/modes/dragon-expedition')
const { createDragonContinuation } = require('../src/modes/dragon-continuation')
const { createScheduler } = require('../src/common/runtime-scheduler')

async function openedBranch (t, refusal) {
  const w = createMineWorld(t)
  const main = mineSteps(w.plan, { layer: 'upper' }).filter(step => step.kind === 'main')[1]
  w.put(stepCells(w.plan, main).clear.findLast(p => p.y === 66), 'iron_ore')
  let supplied
  for (let i = 0; i < 30; i++) {
    supplied = await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: 1 })
    if (supplied.done) break
    assert.ok(['partial', 'completed'].includes(supplied.result?.status), JSON.stringify(supplied))
  }
  assert.equal(supplied.done, true, JSON.stringify(supplied))
  const steps = mineSteps(w.plan, { layer: 'upper' }), cursor = steps.findIndex(step => step.kind === 'branch')
  const step = steps[cursor], cells = stepCells(w.plan, step), opened = cells.clear.find(p => p.y === 66)
  w.branch.progress.upper.cursor = cursor
  w.branch.request = { resource: 'coal', targetHeld: 3, layer: 'upper' }
  w.setFeet(cells.approach)
  w.put(opened, 'air')
  // Keep the real excavation, intent/receipt handling, placement and closure
  // ports. Only the mining executor's refusal is supplied by the offline peer.
  let refusals = 0
  w.ctx.hands.mine = async () => { refusals++; return false }
  w.ctx.hands.why = () => refusal
  return { ...w, cursor, step, cells, opened, refusals: () => refusals }
}

function scheduledMine (t, w) {
  let at = 0, nextId = 0, active = true, expedition
  const timers = new Map(), fastDelays = [], outcomes = []
  const schedule = (fn, ms, interval = 0) => {
    const id = ++nextId
    timers.set(id, { fn, at: at + ms, interval })
    return id
  }
  const continuation = createDragonContinuation({ active: () => active, tick: () => expedition.tick(),
    schedule: (fn, ms) => { fastDelays.push(ms); return schedule(fn, ms) }, unschedule: id => timers.delete(id) })
  expedition = createDragonExpedition({
    state: { observe: async () => {}, record: () => w.ctx.memory, save: () => w.ctx.saveMine() },
    raw: w.ctx.runtime.raw, active: () => active, lifeKey: () => 'mine-retry-life',
    legacyNeeded: () => false, legacyBusy: () => false, legacyIdle: () => true, stopLegacy () {},
    now: () => at, getBlock: w.getBlock,
    retryState: () => ({ position: w.feet(), terrainRevision: w.ctx.runtime.host().world.revision() }),
    onStepDone: continuation.onStepDone,
    run: async () => {
      const result = await stepLayer(w.ctx, w.branch, 'upper')
      outcomes.push(result)
      return { reason: '採掘区間の受信結果を確認します。', result }
    }
  })
  const scheduler = createScheduler({ now: () => at, isDisposed: () => !active,
    setIntervalImpl: (fn, ms) => schedule(fn, ms, ms), clearIntervalImpl: id => timers.delete(id) })
  scheduler.every('player-mode', 2000, () => { expedition.tick(); return expedition.settled() })
  t.after(() => { active = false; continuation.clear(); expedition.cancel(); scheduler.disposeAll() })
  const start = async () => { expedition.tick(); await expedition.settled() }
  const advance = async ms => {
    const until = at + ms
    let turns = 0
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      assert.ok(++turns <= 100, 'the scheduler must not enter an unbounded continuation loop')
      const [id, timer] = next
      at = timer.at
      if (timer.interval) timer.at += timer.interval
      else timers.delete(id)
      timer.fn()
      await expedition.settled()
    }
    at = until
  }
  return { start, advance, outcomes, fastDelays }
}

test('unchanged hazard refusals reach the fourth normal expedition tick, then seal and skip the real opened branch', async t => {
  const refusal = '対象の隣に液体・落下ブロックなどがあります。'
  const w = await openedBranch(t, refusal), f = scheduledMine(t, w)
  const revision = w.ctx.runtime.host().world.revision(), inventory = structuredClone(w.items), placements = w.places.length
  await f.start()
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(f.outcomes.length, attempt)
    assert.equal(f.outcomes.at(-1).code, 'MINE_DIG_REFUSED')
    assert.equal(f.outcomes.at(-1).detail, refusal)
    assert.equal(f.outcomes.at(-1).status, 'blocked')
    assert.equal(w.branch.failures[w.step.segmentId], attempt)
    assert.equal(w.branch.progress.upper.cursor, w.cursor)
    assert.equal(w.branch.segmentTask.stepId, w.step.id)
    assert.equal(w.branch.progress.upper.blocked.length, 0)
    assert.deepEqual(f.fastDelays, [], 'a bounded failure decision never schedules the 400 ms continuation')
    assert.equal(w.ctx.runtime.host().world.revision(), revision)
    assert.deepEqual(w.items, inventory, 'the retry budget progresses without a fabricated inventory receipt')
    await f.advance(1999)
    assert.equal(f.outcomes.length, attempt, 'only the normal player tick can repeat the refusal')
    await f.advance(1)
  }
  assert.equal(f.outcomes.length, 4)
  assert.equal(w.refusals(), 4)
  assert.equal(f.outcomes.at(-1).code, 'MINE_SEGMENT_CLOSED')
  assert.equal(f.outcomes.at(-1).status, 'partial')
  assert.equal(w.getBlock(w.opened.x, w.opened.y, w.opened.z).name, 'minecraft:cobblestone')
  assert.ok(w.places.length > placements, 'closure uses the real placement/receipt path')
  assert.ok(w.cells.clear.every(p => w.getBlock(p.x, p.y, p.z).name !== 'minecraft:air'))
  assert.ok(w.branch.progress.upper.cursor > w.cursor)
  assert.ok(w.branch.progress.upper.blocked.some(item => item.code === 'MINE_DIG_REFUSED'))
  assert.equal(w.branch.segmentTask, undefined)
  assert.equal(w.branch.failures[w.step.segmentId], undefined)
  assert.deepEqual(f.fastDelays, [400], 'confirmed closure may promptly continue to the next branch')
})

for (const [kind, refusal] of [
  ['reach', '確認済みの足場から採掘面に届きません。'],
  ['tool', '適切なツルハシの装備を確認できません: iron_ore']
]) test(`a ${kind} refusal retains the real opened branch and waits after its bounded normal retries`, async t => {
  const w = await openedBranch(t, refusal), f = scheduledMine(t, w)
  const revision = w.ctx.runtime.host().world.revision(), inventory = structuredClone(w.items), placements = w.places.length
  await f.start()
  await f.advance(8000)
  assert.equal(f.outcomes.length, 5)
  assert.equal(w.refusals(), 5)
  assert.ok(f.outcomes.every(outcome => outcome.code === 'MINE_DIG_REFUSED' && outcome.detail === refusal && outcome.status === 'blocked'))
  assert.deepEqual(f.fastDelays, [])
  assert.equal(w.branch.failures[w.step.segmentId], 5)
  assert.equal(w.branch.progress.upper.cursor, w.cursor)
  assert.equal(w.branch.progress.upper.blocked.length, 0)
  assert.equal(w.branch.segmentTask.stepId, w.step.id)
  assert.notEqual(w.branch.segmentTask.closingHazard, true)
  assert.equal(w.getBlock(w.opened.x, w.opened.y, w.opened.z).name, 'minecraft:air')
  assert.equal(w.places.length, placements)
  assert.equal(w.ctx.runtime.host().world.revision(), revision)
  assert.deepEqual(w.items, inventory)
  await f.advance(20000)
  assert.equal(f.outcomes.length, 5, 'unchanged receipts do not keep repeating the same rejected dig')
  assert.equal(w.branch.progress.upper.cursor, w.cursor)
  assert.deepEqual(f.fastDelays, [])
})
