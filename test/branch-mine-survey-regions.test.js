'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { surveyMineRegions } = require('../src/modes/mining/mine-survey-regions')
const { planMine } = require('../src/modes/mining/mine-plan')
const { nextMine } = require('../src/modes/mining/mine-sites')
const { plannerWorld } = require('./helpers/branch-mine-planner-world')
const { observationWorld } = require('./helpers/branch-mine-observation-world')

const current = { profile: 'survey', realm: { id: 'r' }, connectionId: 'a', startedAt: 't', runtimeEntityId: '1', dimension: 'overworld', phase: 'spawned', health: 20, lifecycle: { deathId: 0 } }

test('the default 128x128 lower survey at Y65 scans all bounded regions instead of rejecting the site before reading terrain', async () => {
  let reads = 0, yields = 0
  const world = { getBlock: () => { reads++; return { known: false } }, revision: () => 1 }
  const out = await planMine({ world, getState: () => current, origin: { x: 0.5, y: 65, z: 0.5 }, resource: 'diamond', yieldNow: async () => { yields++ } })
  assert.equal(out.status, 'observing')
  assert.equal(out.code, 'MINE_LOWER_ORE_OBSERVATION_NEEDED')
  assert.equal(reads, 105 * 105 * 137)
  assert.equal(out.diagnostics.unknown, reads)
  assert.equal(out.diagnostics.surveyRegions, 2)
  assert.ok(yields > 2000)
})

test('region snapshots preserve unknown cells and ore at both sides of a split, and invalidate when an earlier region changes', async () => {
  const f = plannerWorld({ minSection: 5 })
  f.section(0, 0, 0, 'stone'); f.section(0, 1, 0, 'stone')
  f.put({ x: 1, y: 15, z: 1 }, 'diamond_ore'); f.put({ x: 1, y: 16, z: 1 }, 'iron_ore')
  const options = { ...f, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 32, z: 2 } }, maxCells: 144 }
  const survey = await surveyMineRegions(options)
  assert.equal(survey.regions, 3)
  assert.equal(survey.known, 288); assert.equal(survey.unknown, 9)
  assert.equal(survey.at({ x: 1, y: 15, z: 1 }).name, 'minecraft:diamond_ore')
  assert.equal(survey.at({ x: 1, y: 16, z: 1 }).name, 'minecraft:iron_ore')
  assert.equal(survey.at({ x: 1, y: 32, z: 1 }).known, false)
  assert.equal(survey.at({ x: 1, y: 40, z: 1 }).known, false)
  f.put({ x: 300, y: 15, z: 300 }, 'stone')
  assert.equal(survey.current(), true)
  f.put({ x: 1, y: 1, z: 1 }, 'air')
  assert.equal(survey.current(), false)
  assert.equal(survey.terrainReceipt.current(), false)
})

test('a changed earlier region or cancelled scope cannot publish a mixed survey', async () => {
  const f = plannerWorld({ minSection: 5 })
  f.section(0, 0, 0, 'stone'); f.section(0, 1, 0, 'stone')
  const options = { ...f, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 31, z: 3 } }, maxCells: 256, batchSize: 64 }
  let turns = 0
  const changed = await surveyMineRegions({ ...options, yieldNow: async () => { if (++turns === 4) f.put({ x: 0, y: 0, z: 0 }, 'air') } })
  assert.equal(changed.code, 'MINE_TERRAIN_CHANGED')
  const abort = new AbortController()
  const cancelled = await surveyMineRegions({ ...options, yieldNow: async () => abort.abort() }, { signal: abort.signal })
  assert.equal(cancelled.status, 'cancelled')
})

test('waiting real mine surveys ignore unrelated sections and replan when a sampled section actually changes', async () => {
  const f = observationWorld({ index: 0 })
  let reads = 0
  const getBlock = f.world.getBlock
  f.world.getBlock = (...args) => { reads++; return getBlock(...args) }
  f.ctx.getBlock = f.world.getBlock
  await nextMine(f.ctx, 'raw_iron', 1)
  const first = reads
  assert.ok(first > 100000)
  f.put({ x: 500, y: 32, z: 500 }, 'stone')
  await nextMine(f.ctx, 'raw_iron', 1)
  assert.ok(reads - first < 500, `an unrelated packet caused ${reads - first} reads`)
  const before = reads
  f.section(0, 1, 0, 'stone')
  await nextMine(f.ctx, 'raw_iron', 1)
  assert.ok(reads - before > 100000, 'new receipt inside the survey invalidates its witness')
})

test('an invalid survey computation budget preserves the candidate instead of exhausting valid-site slots', async () => {
  const f = observationWorld({ index: 0 })
  f.ctx.getFeet = () => ({ x: 40000000, y: 64, z: 0 })
  const out = await nextMine(f.ctx, 'raw_iron', 1)
  assert.equal(out.result.code, 'MINE_SURVEY_BUDGET_INVALID')
  assert.equal(f.ctx.memory.early.mine.search.index, 0)
  assert.equal(f.ctx.memory.early.mine.search.rejected, undefined)
})
