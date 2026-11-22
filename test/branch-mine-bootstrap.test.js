'use strict'

// Actual supplier, tree completion, early home-reserve goal, mine controller,
// scaffold/navigation, HousePorts, crafting and furnace modules. The scene starts
// with a bucket and a partially stocked home kit. Its upper-only mine plan is
// explicit; site selection and house construction have separate integration tests.
// Blocks, chest transfers and ladder arrival witnesses come from the local peer,
// not a live server. Full Runtime combat/input arbitration is not exercised here.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBootstrapWorld } = require('./helpers/branch-mine-bootstrap-world')
const { homeIronTarget } = require('../src/modes/dragon-home-iron')
const tools = ['minecraft:iron_pickaxe', 'minecraft:iron_sword']
const stored = w => tools.every(name => w.homeSlots.some(i => i.name === name && i.count > 0))
const observations = w => ({ digs: w.digs.length, places: w.places.length, crafts: w.recipes.made.length, transfers: w.recipes.transfers.length })
async function finish (w) { for (let i = 0; i < 350 && !stored(w); i++) await w.tick() }

test('mine one iron target for carried and reserve tools, then smelt and stock both at home', async t => {
  const w = createBootstrapWorld(t)
  assert.deepEqual(w.items.map(item => item.name), ['minecraft:bucket'], 'no ladders, slabs, chests, fuel or pre-made tool')
  await finish(w)
  const detail = JSON.stringify({ history: w.history.slice(-12), bag: w.items, made: w.recipes.made, cooked: w.recipes.cooked, logs: w.lines.slice(-12), progress: w.branch.progress, shaft: w.branch.shaft }, null, 2)
  assert.ok(stored(w), detail)
  assert.ok(tools.every(name => w.items.some(i => i.name === name && i.count === 1)), 'each tool has one carried copy')
  for (const name of ['oak_planks', 'stick', 'wooden_pickaxe', 'stone_pickaxe', 'torch', 'ladder', 'cobblestone_slab', 'chest', 'iron_pickaxe', 'iron_sword']) assert.ok(w.recipes.made.some(i => i.name === name), name)
  const requests = w.saved.map(mine => mine.branch?.request).filter(request => request?.resource === 'raw_iron')
  assert.equal(homeIronTarget([], [], []), 66, 'two whole kits include armour, tools, shields and buckets')
  assert.deepEqual([...new Set(requests.map(request => request.targetHeld))], [10], 'both pickaxes and swords share the whole deficit')
  const ironCooks = w.recipes.cooked.filter(i => i.output === 'iron_ingot')
  assert.equal(ironCooks.reduce((sum, i) => sum + i.count, 0), 10)
  assert.ok(ironCooks.every(i => w.stations.some(station => station.item === 'furnace' &&
    ['x', 'y', 'z'].every(axis => station.position[axis] === i.furnace[axis]))), 'all iron uses a home furnace')
  assert.equal(w.recipes.transfers.filter(i => i.type === 'put' && i.name === 'raw_iron').length, 1, 'all ten ore enter the furnace together')
  assert.ok(w.recipes.cooked.some(i => i.output === 'charcoal'), 'mine lighting fuel is cooked from harvested wood')
  assert.ok(w.recipes.cooked.some(i => i.output === 'iron_ingot'), 'received raw ore is actually put into the furnace')
  assert.ok(w.digs.some(i => i.name === 'minecraft:iron_ore' && i.target.y === 66), 'iron is excavated inside the fixed upper mine')
  assert.ok(w.opened.includes('upper:cargo-0') && w.opened.includes('upper:supply'), 'both mine chests supplied all 54 received slots')
  assert.ok(w.climbs.some(i => i.to.y < i.from.y) && w.climbs.some(i => i.to.y > i.from.y), 'a received ladder route carries ore back up')
  assert.equal(w.feet().y, 70, 'reserve is completed back on the surface')
  assert.ok(w.recipes.made.filter(i => i.name === 'stone_pickaxe').length > 1, 'surface tool replacement is part of the trip')
  assert.ok(w.recipes.made.every(i => i.feet.y >= 70), 'workstations are reached by the actual return route')
  assert.ok(w.branch.progress.upper.confirmedSteps >= 3, 'both lobby slices and the first main slice are finished')
  assert.equal(w.branch.segmentTask, undefined, 'no excavated corridor is abandoned without its floor, seal and lighting')
  assert.equal(w.branch.vein, undefined, 'no ore excavation debt remains at home')
  t.diagnostic(JSON.stringify({ looks: w.history.length, ironDug: w.digs.filter(i => i.name === 'minecraft:iron_ore').length,
    ironSmelted: w.recipes.cooked.filter(i => i.output === 'iron_ingot').reduce((n, i) => n + i.count, 0),
    stonePicksMade: w.recipes.made.filter(i => i.name === 'stone_pickaxe').length, ladderMoves: w.climbs.length }))
})

test('cancel after a shaft dig receipt resumes the same mine, and rejected iron withdrawal is not credited', async t => {
  const w = createBootstrapWorld(t), planId = w.plan.id
  let interrupted = false
  w.onMine(p => {
    if (!interrupted && p.x === 0 && p.y === 68 && p.z === 5) { interrupted = true; w.cancel() }
  })
  w.recipes.rejectIronTake()
  for (let i = 0; i < 250 && !interrupted; i++) await w.tick()
  assert.equal(interrupted, true, JSON.stringify(w.history.slice(-3)))
  assert.equal(w.getBlock(0, 68, 5).name, 'minecraft:air', 'the dig arrived before its owner was cancelled')
  const before = observations(w)
  for (let i = 0; i < 3; i++) await w.tick()
  assert.deepEqual(observations(w), before, 'a cancelled owner starts no more work')
  assert.equal(stored(w), false)
  w.restart()
  await finish(w)
  assert.equal(w.ctx.memory.early.mine.branch.plan.id, planId, 'same saved shaft and fixed corridors are resumed')
  assert.equal(stored(w), true, JSON.stringify(w.history.slice(-5)))
  assert.deepEqual(w.recipes.rejected, [{ output: 'iron_ingot', before: 0, after: 0, madeTools: 0 }], 'rejected take neither grants iron nor crafts a phantom pick')
  assert.ok(w.recipes.transfers.some(i => i.type === 'take' && i.name === 'iron_ingot'), 'a later accepted server transfer supplies the finished tool')
  assert.equal(w.recipes.transfers.filter(i => i.type === 'put' && i.name === 'raw_iron').length, 1, 'the rejected take does not send the bot back for ore')
  assert.equal(w.ctx.memory.early.reserveReady, undefined, 'the tools alone are not the complete home kit')
})
