'use strict'

// Work of the starter jobs falls due while the Bot stands inside its mine.
// Real Realm 2026-11-24 03:34:34-03:52 JST, plan 4cb5a6d99dac0652de75, feet (9841.52, 31.50, 10094.50) on the last
// floor slab of upper:branch-19-left: the hourly review of the held house repair made the objective 「壊れた本拠点を
// 直します」 and the starter jobs got the player inside the mine. 「真上へ掘る途中で止まりました（0段、
// PILLAR_ASCENT_POSITION_UNCONFIRMED、No safe route found）」 32 times, 「掘る・積む道もありません
// （BUILD_ROUTE_SEARCH_LIMIT・調べたマス 23136〜24000）」 31 times, 「帰還[rmwteige6] をあきらめます … CLIMB_FAILED」,
// 「地上へ出られないため、拠点の家を建てられません」; the feet did not move in eighteen minutes.
// Real: the expedition runtime (dragon-runtime.js: the expedition, its saved record, the goal ledger, the journal),
// the mine's controller, route and ports (requestMine builds the mine here; leaveMine takes the ladder), the
// scaffold hands, navigation and physics.
// Stand-in: test/helpers/branch-mine-world.js answers blocks, positions, placements and the ladder move; the mine
// is its own small plan in flat stone, not the received mine. The starter jobs are not run: the test reads who
// has the player.
// Before: the expedition gave the player away inside the mine (tick() false at once, nothing moved).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { requestMine } = require('../src/modes/mining/mine-controller')
const { insideMine } = require('../src/modes/mining/mine-location')
const { createDragonRuntime } = require('../src/modes/dragon-runtime')
const { createDragonState } = require('../src/modes/dragon-state')

const turns = async n => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }

async function scene (t, house) {
  const w = createMineWorld(t)
  // The mine is dug until a branch step is under way, the Bot standing in it.
  for (let i = 0; i < 200 && !((w.branch.progress.upper.cursor ?? 0) >= 3 && insideMine(w.ctx, w.branch)); i++) await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: 8 })
  assert.ok(insideMine(w.ctx, w.branch), 'the Bot stands inside the mine')
  const raw = () => ({ ...w.raw, position: w.feet() }), host = () => ({ getLife: () => w.raw.lifecycle, meta: { startGame: { seed: 1 } }, world: { getBlock: w.getBlock } })
  const seed = createDragonState({ root: w.ctx.root, shared: {}, getState: raw, getLife: () => w.raw.lifecycle, getWorldId: () => 1 })
  const record = seed.record()
  Object.assign(record.early, { spawnReady: true, mine: { branch: w.branch } })
  assert.equal(await seed.save(record), true)
  const shared = { playerHouse: house }, lines = [], calls = { early: 0 }
  let at = 1e9
  const rt = createDragonRuntime({ now: () => at, shared, root: w.ctx.root, getBlock: w.getBlock, log: line => lines.push(line), getFeet: w.feet,
    runtime: { ...w.ctx.runtime, raw, host, armor: () => ({ known: true, worn: [] }), inventory: () => w.inv },
    active: () => true, legacyBusy: () => false, legacyIdle: () => true, stopLegacy: () => {}, lifeKey: () => 'a/0', loading: () => false, threatened: () => false,
    stepPorts: signal => ({ ...w.ctx, shared, cancelled: () => signal.aborted, signal, log: line => lines.push(line) }),
    early: async () => { calls.early++; return { done: false, reason: '採掘を続けます。' } } })
  // A step saves its record to disk: the looks go on in real time until `until` holds (20 s at most).
  const run = async until => { let owned; for (const end = Date.now() + 20000; Date.now() < end;) { at += 2000; owned = rt.tick(); await turns(50); await new Promise(resolve => setTimeout(resolve, 5)); if (until(owned)) break } return owned }
  return { w, rt, run, lines, shared, calls }
}
const REPAIR = { origin: { x: 40, y: 70, z: 40 }, done: false, built: true, repair: { state: 'running', since: 1e9 - 1000 } }

test('the house repair falls due inside the mine: the expedition keeps the player, takes the ladder out, then hands over', async t => {
  const { w, rt, run, lines, calls } = await scene(t, REPAIR)
  assert.equal(rt.objective()?.legacy, true)
  assert.equal(rt.tick(), true, 'inside the mine the player stays with the expedition')
  const owned = await run(owned => owned === false)
  assert.equal(owned, false, 'at the entrance the starter jobs have the player\n' + lines.join('\n'))
  assert.equal(insideMine(w.ctx, w.branch), false)
  assert.ok(w.feet().y >= w.plan.shaft.topY - 0.2, 'the feet are at the surface: ' + JSON.stringify(w.feet()))
  assert.equal(calls.early, 0, 'the early step is not asked while the starter jobs are due')
  assert.ok(lines.some(line => /採掘場からはしごで地上へ出ます/.test(line)), lines.join('\n'))
})

test('outside the mine the starter jobs have the player at once, as before', async t => {
  const { w, rt } = await scene(t, REPAIR)
  w.setFeet({ x: w.plan.shaft.approach.x + 6, y: 70, z: w.plan.shaft.approach.z })
  assert.equal(rt.tick(), false)
})

test('no work of the starter jobs is due: the step inside the mine is the early step, not the way out', async t => {
  const { w, run, calls } = await scene(t, { origin: { x: 40, y: 70, z: 40 }, done: true, built: true })
  const before = w.feet(), climbs = w.climbs.length
  assert.equal(await run(() => calls.early >= 2), true)
  assert.ok(calls.early >= 1, 'the early step is asked')
  assert.deepEqual(w.feet(), before)
  assert.equal(w.climbs.length, climbs)
})
