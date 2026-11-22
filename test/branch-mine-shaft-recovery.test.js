'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { ensureShaft, shaftFinish, climb } = require('../src/modes/mining/mine-shaft')
const { leaveMine } = require('../src/modes/mining/mine-route')
const { shaftBoundary } = require('../src/modes/mining/mine-shaft-boundary')
const { mineSteps, stepCells } = require('../src/modes/mining/mine-geometry')
const key = p => `${p.x},${p.y},${p.z}`

async function upper (w) {
  for (let i = 0; i < 12 && !w.branch.shaft?.landings?.upper; i++) {
    const out = await ensureShaft(w.ctx, w.branch, 'upper')
    assert.ok(['partial', 'completed'].includes(out.status), JSON.stringify({ out, feet: w.feet(), depth: w.branch.shaft?.depth }))
  }
  assert.equal(w.branch.shaft.landings.upper, true)
}

test('same-height landing recovery recentres with ordinary walking and sends no ladder input', async t => {
  const w = createMineWorld(t), column = w.plan.shaft.ladder
  const to = { x: column.x + 0.5, y: w.plan.shaft.topY, z: column.z + 0.5 }
  w.setFeet({ ...to, z: to.z + 0.21 })
  const out = await climb(w.ctx, w.branch, to)
  assert.equal(out.code, 'MINE_POSITION_RECEIVED', JSON.stringify(out))
  assert.equal(out.serverConfirmed, true)
  assert.equal(w.climbs.length, 0)
  assert.deepEqual(w.walks.at(-1), to)
})

test('clear a dry surface plant at the planned ladder support and leave nearby plants alone', async t => {
  const w = createMineWorld(t), shaft = w.plan.shaft
  const support = { ...shaft.ladder.support, y: shaft.topY }, other = { ...support, z: support.z + 3 }
  w.put(support, 'short_grass')
  w.put(other, 'short_grass')
  const read = w.ctx.getBlock
  w.ctx.getBlock = (x, y, z) => {
    const block = read(x, y, z)
    return block.name === 'minecraft:short_grass' ? { ...block, boundingBox: 'empty' } : block
  }
  const out = await ensureShaft(w.ctx, w.branch, 'upper')
  assert.ok(['partial', 'completed'].includes(out.status), JSON.stringify(out))
  const dug = w.digs.find(entry => key(entry.target) === key(support))
  assert.equal(dug?.target.expectedName, 'minecraft:short_grass')
  assert.equal(dug?.target.accessPreparation, 'quarry')
  assert.equal(w.getBlock(support.x, support.y, support.z).name, 'minecraft:cobblestone')
  assert.equal(w.getBlock(other.x, other.y, other.z).name, 'minecraft:short_grass')
  assert.equal(w.branch.shaft.depth, shaft.topY - 1)
})

for (const column of [1, 2, 3]) test(`a received lower-bay dig in column ${column} resumes after cancellation and keeps a confirmed return`, async t => {
  const w = createMineWorld(t), target = { ...w.plan.shaft.columns[column], y: w.plan.shaft.topY - 1 }
  let cancelled = false
  w.ctx.cancelled = () => cancelled
  w.onMine(p => { if (key(p) === key(target)) cancelled = true })
  const first = await ensureShaft(w.ctx, w.branch, 'upper')
  assert.equal(first.status, 'interrupted')
  assert.equal(w.branch.shaft.depth, 70)
  assert.equal(w.feet().y, 69)
  assert.equal(w.getBlock(target.x, target.y, target.z).name, 'minecraft:air')
  cancelled = false; w.onMine(null)
  await upper(w)
  assert.equal(w.branch.pendingAction, undefined)
  assert.equal(w.digs.filter(p => key(p.target) === key(target)).length, 1, 'the received AIR is not broken again')
  const returned = await leaveMine(w.ctx, w.branch)
  assert.equal(returned.status, 'completed', JSON.stringify(returned))
  assert.equal(w.feet().y, 70)
})

test('a lower landing cannot resume when its floor becomes unobserved', async t => {
  const w = createMineWorld(t), front = { ...w.plan.shaft.columns[1], y: 69 }, bottom = { ...w.plan.shaft.columns[0], y: 68 }
  let cancelled = false
  w.ctx.cancelled = () => cancelled
  w.onMine(p => { if (key(p) === key(front)) cancelled = true })
  assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).status, 'interrupted')
  cancelled = false; w.onMine(null)
  w.ctx.getBlock = (x, y, z) => key({ x, y, z }) === key(bottom) ? { known: false } : w.getBlock(x, y, z)
  const digs = w.digs.length, climbs = w.climbs.length
  const resumed = await ensureShaft(w.ctx, w.branch, 'upper')
  assert.equal(resumed.code, 'MINE_TERRAIN_UNKNOWN')
  assert.equal(w.digs.length, digs)
  assert.equal(w.climbs.length, climbs)
  assert.equal(w.branch.shaft.depth, 70)
})

test('an interrupted ladder placement reconciles the received rung without placing it twice', async t => {
  const w = createMineWorld(t)
  const target = { x: w.plan.shaft.ladder.x, y: w.plan.shaft.topY, z: w.plan.shaft.ladder.z }
  const place = w.ctx.operations.interactions.placeHouseBlock
  let interrupted = false, cancelled = false
  w.ctx.cancelled = () => cancelled
  w.ctx.operations.interactions.placeHouseBlock = async request => {
    await place(request)
    if (!interrupted && key(request.position) === key(target)) {
      interrupted = true
      cancelled = true
    }
  }
  assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).status, 'interrupted')
  assert.equal(w.getBlock(target.x, target.y, target.z).name, 'minecraft:ladder')
  assert.equal(w.branch.pendingAction.name, 'minecraft:ladder')
  cancelled = false
  await upper(w)
  assert.equal(w.branch.pendingAction, undefined)
  assert.equal(w.places.filter(request => key(request.position) === key(target)).length, 1)
})

test('after leaving the unfinished shaft, a received lower rung is mounted from the adjacent surface landing', async t => {
  const w = createMineWorld(t), { shaft } = w.plan
  const target = { x: shaft.ladder.x, y: shaft.topY - 1, z: shaft.ladder.z }
  const place = w.ctx.operations.interactions.placeHouseBlock
  let cancelled = false
  w.ctx.cancelled = () => cancelled
  w.ctx.operations.interactions.placeHouseBlock = async request => {
    await place(request)
    if (key(request.position) === key(target)) cancelled = true
  }
  assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).status, 'interrupted')
  assert.equal(w.branch.pendingAction.name, 'minecraft:ladder')
  assert.equal(w.getBlock(target.x, target.y, target.z).name, 'minecraft:ladder')
  cancelled = false
  w.setFeet({ ...shaft.approach, x: shaft.approach.x - 0.04 })
  const resumed = await ensureShaft(w.ctx, w.branch, 'upper')
  assert.equal(resumed.code, 'MINE_SHAFT_ADVANCED', JSON.stringify(resumed))
  assert.equal(w.branch.shaft.depth, shaft.topY - 1)
  assert.equal(w.branch.pendingAction, undefined)
  assert.equal(w.places.filter(request => key(request.position) === key(target)).length, 1)
  const mount = w.climbs.find(request => request.to.y === target.y)
  assert.ok(mount)
  assert.equal(Math.abs(Math.floor(mount.from.x) - shaft.ladder.x) + Math.abs(Math.floor(mount.from.z) - shaft.ladder.z), 1)
})

test('a failed depth checkpoint retains the unfinished slice for received-state reconciliation', async t => {
  const w = createMineWorld(t), save = w.ctx.saveMine
  let fail = true
  w.ctx.saveMine = async () => {
    if (fail && w.branch.shaft?.depth === 69 && !w.branch.intent) { fail = false; return false }
    return save()
  }
  assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).code, 'MINE_CHECKPOINT')
  assert.equal(w.branch.shaft.depth, 70)
  const digs = w.digs.length
  assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).code, 'MINE_SHAFT_ADVANCED')
  assert.equal(w.branch.shaft.depth, 69)
  assert.equal(w.digs.length, digs)
})

test('a failed landing checkpoint rechecks its received finish before committing readiness', async t => {
  const w = createMineWorld(t), save = w.ctx.saveMine
  let failed = false, out
  w.ctx.saveMine = async () => {
    if (!failed && w.branch.shaft?.landings?.upper) { failed = true; return false }
    return save()
  }
  for (let i = 0; i < 8 && !failed; i++) out = await ensureShaft(w.ctx, w.branch, 'upper')
  assert.equal(out.code, 'MINE_CHECKPOINT')
  assert.equal(w.branch.shaft.landings.upper, undefined)
  const places = w.places.length
  out = await ensureShaft(w.ctx, w.branch, 'upper')
  assert.equal(out.code, 'MINE_SHAFT_READY')
  assert.equal(w.branch.shaft.landings.upper, true)
  assert.equal(w.places.length, places)
})

test('shaft construction seals a two-high side cave before declaring its landing ready', async t => {
  const w = createMineWorld(t), cave = [{ x: 0, y: 67, z: 4 }, { x: 0, y: 68, z: 4 }]
  for (const p of cave) w.put(p, 'air')
  await upper(w)
  for (const p of cave) {
    assert.equal(w.getBlock(p.x, p.y, p.z).name, 'minecraft:cobblestone')
    assert.equal(w.places.filter(placed => key(placed.position) === key(p)).length, 1)
  }
  assert.equal((await leaveMine(w.ctx, w.branch)).status, 'completed')
})

test('shaft finishing refuses an unknown or liquid outside wall and never advances its depth', async t => {
  for (const unsafe of [{ known: false }, { known: true, name: 'minecraft:water', boundingBox: 'empty' }]) {
    const w = createMineWorld(t)
    assert.equal((await ensureShaft(w.ctx, w.branch, 'upper')).code, 'MINE_SHAFT_ADVANCED')
    const p = { x: 0, y: 69, z: 4 }, read = w.ctx.getBlock
    w.ctx.getBlock = (x, y, z) => key({ x, y, z }) === key(p) ? unsafe : read(x, y, z)
    const placed = w.places.length
    const out = await w.ctx.minePorts.ensureSegment(w.plan, shaftFinish(w.branch, 69))
    assert.equal(out.status, 'blocked')
    assert.equal(w.branch.shaft.depth, 69)
    assert.equal(w.places.length, placed)
  }
})

test('the shared shaft wall volume includes its backing but keeps the surface entrance outside', async t => {
  const w = createMineWorld(t), boundary = shaftBoundary(w.plan, { minY: 69, maxY: 71 })
  assert.equal(boundary.length, 8)
  assert.ok(boundary.every(p => p.y === 69 && !w.plan.shaft.columns.some(c => c.x === p.x && c.z === p.z)))
  assert.ok(boundary.some(p => p.x === w.plan.shaft.ladder.support.x && p.z === w.plan.shaft.ladder.support.z))
  assert.equal(new Set(boundary.map(key)).size, boundary.length)
})

test('a completed upper corridor stays connected only while its actual slab, clear body and light remain safe', async t => {
  const w = createMineWorld(t), first = mineSteps(w.plan, { layer: 'upper' })[0], cells = stepCells(w.plan, first)
  w.branch.progress.upper.cursor = 1
  w.branch.shaft = { depth: 66, landings: { upper: true } }
  for (const p of cells.clear) w.put(p, 'air')
  for (const p of cells.floor) w.put(p.position, 'cobblestone_slab', { 'minecraft:vertical_half': 'bottom' })
  for (const t of cells.torch) w.put(t.position, 'torch')
  const floor = { x: 2, y: 65, z: 5 }, slice = shaftFinish(w.branch, 65)
  const blocked = () => w.ctx.minePorts.lighting.boundary(w.plan, slice).some(p => key(p) === key(floor))
  assert.equal(blocked(), false)
  w.put(floor, 'cobblestone_slab', { 'minecraft:vertical_half': 'top' })
  assert.equal(blocked(), true)
  w.put(floor, 'cobblestone_slab', { 'minecraft:vertical_half': 'bottom' })
  for (const t of cells.torch) w.put(t.position, 'air')
  assert.equal(blocked(), true)
})
