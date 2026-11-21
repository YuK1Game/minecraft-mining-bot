'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { createMineGeometry, mineSteps } = require('../src/modes/mining/mine-geometry')
const { createMineState, skipMineSegment } = require('../src/modes/mining/mine-state')
const { ensureShaft } = require('../src/modes/mining/mine-shaft')
const { compactSite } = require('../src/modes/mining/mine-sites')
const { constructionCount, noteMineProgress } = require('../src/modes/mining/mine-progress')
const { createGoalLedger, KEYS } = require('../src/modes/goal/goal-ledger')
const { createProgress } = require('../src/modes/dragon-progress')
const { measure } = require('../src/modes/dragon-goal-measure')

test('a received 54-level shaft advances the real watcher beyond sixteen steps; repeated finished work still stalls', async t => {
  const w = createMineWorld(t)
  Object.assign(w.plan, createMineGeometry({ scope: w.plan.scope, anchor: { x: 0, z: 0 }, direction: 'east', surfaceY: 70, upperY: 16, lowerY: 10, width: 12, length: 12 }))
  for (const layer of ['upper', 'lower']) w.branch.progress[layer] = createMineState(w.plan, { layer })
  let clock = 1000, holds = 0, decisions = 0
  const ledger = createGoalLedger({ shared: {}, now: () => clock, world: () => 'world' })
  const watcher = createProgress({ ledger, now: () => clock, onReset: () => decisions++, onHold: () => holds++ })
  w.ctx.goal = { step: ledger.step, mark: ledger.mark }
  const look = () => watcher.note('early.diamond', { feet: w.feet(), health: 20, scope: 'life', ...measure({ key: 'early.diamond', items: w.items, record: w.ctx.memory }) }, { reason: '縦坑を施工しています。' })
  look()
  for (let i = 0; i < KEYS; i++) ledger.step('other-confirmed-step:' + i)
  for (let i = 0; i < 54; i++) {
    const out = await ensureShaft(w.ctx, w.branch, 'upper')
    assert.ok(['partial', 'completed'].includes(out.status), JSON.stringify(out))
    // Virtual elapsed construction time, not a claim about real Realm speed.
    for (let tick = 0; tick < 35; tick++) { clock += 2000; look() }
  }
  assert.equal(w.branch.shaft.depth, 16)
  assert.equal(w.branch.shaft.landings.upper, true)
  assert.equal(ledger.goal().steps.length, KEYS)
  assert.equal(ledger.goal().marks['mine:construction'], -54)
  assert.equal(decisions, 0)
  assert.equal(holds, 0, 'continuing confirmed construction is not a stalled mineral goal')
  assert.equal(ledger.goal().results, 0, 'building the shaft does not claim possession of diamonds')

  // Re-reading the same completed shaft cannot keep a stuck goal alive forever.
  for (let tick = 0; tick < 1300 && !holds; tick++) {
    if (tick % 35 === 0) assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).code, 'MINE_SHAFT_READY')
    clock += 2000; look()
  }
  assert.equal(holds, 1)
  assert.equal(ledger.goal().hold.code, 'NO_PROGRESS')
})

test('a skipped branch, retirement, duplicate record and another world do not manufacture construction progress', t => {
  const w = createMineWorld(t), mine = w.ctx.memory.early.mine, world = w.plan.scope
  const steps = mineSteps(w.plan, { layer: 'upper' }), cursor = steps.findIndex(step => step.kind === 'branch')
  w.branch.shaft = { depth: 66, landings: { upper: true } }
  w.branch.progress.upper = { ...w.branch.progress.upper, cursor, confirmedSteps: cursor }
  const before = constructionCount(mine, world)
  w.branch.progress.upper = skipMineSegment(w.branch.progress.upper, { segmentId: steps[cursor].segmentId, code: 'MINE_HAZARD', plan: w.plan, liveScope: 'life', attempts: 3 })
  assert.ok(w.branch.progress.upper.cursor > cursor)
  assert.equal(constructionCount(mine, world), before, 'skipped steps are choices, not construction')
  const archived = compactSite(w.branch)
  mine.sites = [archived]
  assert.equal(constructionCount(mine, world), before, 'temporary duplicate during retirement counts once')
  delete mine.branch
  assert.equal(constructionCount(mine, world), before, 'retirement preserves the existing mark')
  assert.equal(constructionCount(mine, { ...world, realmId: 'elsewhere' }), 0)
})

test('reloading a goal establishes a baseline and does not recount old work or a proposed lower extension', t => {
  const w = createMineWorld(t)
  w.branch.shaft = { depth: 66, landings: { upper: true } }
  const ledger = createGoalLedger({ shared: {}, world: () => 'world' })
  ledger.open('early.diamond')
  w.ctx.goal = { mark: ledger.mark }
  assert.equal(noteMineProgress(w.ctx), false)
  const before = ledger.goal().marks['mine:construction']
  w.plan.shaft.bottomY = -54
  w.branch.progress.lower = createMineState(w.plan, { layer: 'lower' })
  assert.equal(noteMineProgress(w.ctx), false)
  assert.equal(ledger.goal().marks['mine:construction'], before)
  w.ctx.cancelled = () => true
  w.branch.shaft.depth--
  assert.equal(noteMineProgress(w.ctx), false, 'an interrupted owner cannot advance the goal')
  assert.equal(ledger.goal().marks['mine:construction'], before)
})
