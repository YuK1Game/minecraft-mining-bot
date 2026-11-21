'use strict'

// Real planner -> controller -> shaft/navigation/lighting/chests. The local
// peer supplies received terrain, positions and consumed inventory, no Realm.
const test = require('node:test'), assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { planMine } = require('../src/modes/mining/mine-plan')
const { createMineState } = require('../src/modes/mining/mine-state')
const { requestMine } = require('../src/modes/mining/mine-controller')
const { point } = require('../src/modes/mining/mine-geometry')
const { protectedBySites } = require('../src/modes/mining/mine-sites')
const held = (w, name) => w.items.filter(item => item.name === 'minecraft:' + name).reduce((n, item) => n + item.count, 0)

async function upper (t) {
  const w = createMineWorld(t), world = w.ctx.runtime.host().world
  let lowerReceived = false
  const getBlock = (x, y, z) => !lowerReceived && y < 46 ? { known: false } : w.getBlock(x, y, z)
  world.getBlock = getBlock; w.ctx.getBlock = getBlock
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.put({ x, y: 48, z }, 'iron_ore')
  const planned = await planMine({ world, getState: () => w.ctx.runtime.mineState(), origin: { x: 0.5, y: 70, z: 0.5 }, resource: 'raw_iron', targetCount: 100,
    width: 12, length: 12, searchRadius: 0, upperYs: [48], maxCandidates: 4 })
  assert.equal(planned.status, 'planned', JSON.stringify(planned))
  assert.equal(planned.plan.layers.length, 1)
  // The peer's pair registry follows the controller's saved plan, exactly as
  // a real server determines adjacent chests from the placed coordinates.
  for (const key of Object.keys(w.plan)) delete w.plan[key]
  Object.assign(w.plan, planned.plan)
  w.branch.progress = { upper: createMineState(w.plan, { layer: 'upper' }) }
  w.setFeet(w.plan.shaft.approach)
  const save = w.ctx.saveMine
  w.ctx.saveMine = async () => {
    if (w.branch.plan !== w.plan) {
      const current = w.branch.plan
      for (const key of Object.keys(w.plan)) delete w.plan[key]
      Object.assign(w.plan, structuredClone(current))
    }
    return save()
  }
  let out
  for (let i = 0; i < 65; i++) {
    out = await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: 100 })
    assert.ok(['partial', 'completed'].includes(out.result?.status), JSON.stringify({ i, out, feet: w.feet(), shaft: w.branch.shaft, intent: w.branch.intent }))
    if (w.branch.lobbyReady?.upper && !w.branch.segmentTask) break
  }
  assert.ok(w.branch.lobbyReady?.upper, JSON.stringify(out))
  assert.ok(w.branch.storage?.pairs?.['upper:supply'])
  assert.ok(held(w, 'raw_iron') > 0)
  const delivered = await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: held(w, 'raw_iron') })
  assert.equal(delivered.done, true, JSON.stringify(delivered)); assert.equal(w.feet().y, 70)
  return { ...w, receiveLower: () => { lowerReceived = true; w.put({ x: 30, y: 40, z: 30 }, 'stone') } }
}

test('upper iron is actually built and delivered before lower observation; the same received mine later delivers diamond without resetting upper work', async t => {
  const w = await upper(t), branch = w.branch, previous = structuredClone(branch)
  const digs = w.digs.length, climbs = w.climbs.length
  const unknown = await requestMine(w.ctx, { resource: 'diamond', targetHeld: 1 })
  assert.equal(unknown.result.code, 'MINE_LOWER_ORE_OBSERVATION_NEEDED', JSON.stringify(unknown))
  assert.equal(w.ctx.memory.early.mine.branch, branch)
  assert.equal(branch.plan.layers.length, 1); assert.deepEqual(branch.progress.upper, previous.progress.upper)
  assert.equal(w.digs.length, digs); assert.equal(w.climbs.length, climbs)
  w.receiveLower()
  w.put(point(w.plan, 9, 42, 5), 'diamond_ore')
  let out
  for (let i = 0; i < 45; i++) {
    out = await requestMine(w.ctx, { resource: 'diamond', targetHeld: 1 })
    if (out.done) break
    assert.ok(['partial', 'completed'].includes(out.result?.status), JSON.stringify({ i, out, feet: w.feet(), shaft: branch.shaft, intent: branch.intent }))
  }
  assert.equal(out.done, true, JSON.stringify(out)); assert.equal(w.feet().y, 70)
  assert.equal(held(w, 'diamond'), 1)
  assert.equal(branch.plan.id, previous.plan.id)
  assert.equal(branch.plan.layers.length, 2); assert.equal(branch.plan.revision, 2)
  assert.deepEqual(branch.plan.site, previous.plan.site)
  assert.deepEqual(branch.progress.upper, previous.progress.upper)
  for (const [id, pair] of Object.entries(previous.storage.pairs)) assert.deepEqual(branch.storage.pairs[id], pair)
  assert.equal(w.digs.slice(digs).some(row => row.name === 'minecraft:cobblestone_slab' && row.target.y === 47), false, 'extending a shaft preserves the existing upper slab doorway')
  assert.ok(w.climbs.slice(climbs).some(move => move.to.y < 48))
})

test('a fully observed impossible lower layer safely archives the upper mine and advances finite site search; unknown lower keeps it active', async t => {
  const w = await upper(t), branch = w.branch, before = structuredClone(branch)
  const waiting = await requestMine(w.ctx, { resource: 'diamond', targetHeld: 1 })
  assert.equal(waiting.result.code, 'MINE_LOWER_ORE_OBSERVATION_NEEDED')
  assert.equal(w.ctx.memory.early.mine.branch, branch)
  assert.equal(w.ctx.memory.early.mine.sites, undefined)
  w.receiveLower()
  const retired = await requestMine(w.ctx, { resource: 'diamond', targetHeld: 1 })
  assert.equal(retired.result.code, 'MINE_SITE_RETIRED', JSON.stringify(retired))
  assert.equal(retired.result.status, 'partial'); assert.equal(retired.done, false)
  const mine = w.ctx.memory.early.mine
  assert.equal(w.feet().y, 70); assert.equal(mine.branch, undefined)
  assert.equal(mine.sites.length, 1); assert.equal(mine.sites[0].plan.id, before.plan.id)
  assert.equal(mine.sites[0].progress.upper.confirmedSteps, before.progress.upper.confirmedSteps)
  assert.deepEqual(mine.sites[0].storage, before.storage)
  assert.equal(protectedBySites(mine.sites, before.plan.scope)(point(before.plan, 4, 48, 5)), true)
  await requestMine(w.ctx, { resource: 'diamond', targetHeld: 1 })
  assert.equal(mine.search.index, 1)
  await requestMine(w.ctx, { resource: 'diamond', targetHeld: 1 })
  assert.equal(mine.search.index, 2)
})
