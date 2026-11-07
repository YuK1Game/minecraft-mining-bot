'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')

// Exercise the real before-begin refusal and reconciliation from the sister
// suite, rather than manufacturing a placement pin or claiming a receipt.
const fixturePath = require.resolve('./quarry-carried-placement-reconcile.test')
const fixtureModule = new Module(fixturePath, module)
fixtureModule.filename = fixturePath
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixturePath))
fixtureModule._compile(fs.readFileSync(fixturePath, 'utf8').split('\ntest(')[0] + '\nmodule.exports = setup\n', fixturePath)

const horizontal = (cell, eye) => Math.hypot(cell.x + 0.5 - eye.x, cell.z + 0.5 - eye.z)
async function afterCombat () {
  const f = fixtureModule.exports()
  const refused = await f.run()
  const result = await f.reconcile(refused.checkpoint)
  assert.equal(result.status, 'reconciled', result.reason)
  const before = result.checkpoint
  assert.equal(before.stage, 'planned')
  assert.ok(before.placementSourcePin)
  f.state.position.x += 16
  const faults = {}, writes = [], moves = [], previews = []
  let reads = 0
  const runner = createQuarryPortableStorage({
    ...f.dependencies,
    interactions: { ...f.dependencies.interactions, snapshot: () => ({ pendingOperation: null, lastResult: null }) },
    refreshInventory: async () => { reads++; faults.onRefresh?.(); return !faults.noFresh },
    previewMove: stand => {
      previews.push(structuredClone(stand))
      return { ready: !faults.noRoute && horizontal(stand, f.state.position) <= 6 }
    },
    moveTo: async (cell, options) => {
      moves.push(horizontal(cell, f.state.position))
      if (moves.at(-1) > 6) throw Error('outside normal movement bounds')
      return f.dependencies.moveTo(cell, options)
    }
  })
  f.controller.ownsShulker = runner.ownsShulker
  // Keep the public request identical to the recorded operation.
  const run = (checkpoint, options = {}) => runner.storeCarried({ ...f.request, checkpoint }, {
    canPlace: p => p.x >= 12 && p.x <= 20,
    onCheckpoint: async cp => { if (faults.save) throw Error('test disk refusal'); writes.push(structuredClone(cp)) },
    ...options
  })
  f.events.length = 0
  return { f, before, faults, writes, moves, previews, run, freshReads: () => reads }
}

test('a 16m combat displacement replans the same untouched cargo operation using fresh inventory and a short approved route', async () => {
  const { f, before, run, writes, moves, previews, freshReads } = await afterCombat()
  const inventory = structuredClone(f.bag)
  assert.ok(horizontal(before.stand, f.state.position) > 12)
  const result = await run(before)
  assert.equal(result.status, 'replan', result.reason)
  assert.equal(result.serverConfirmed, false)
  assert.equal(freshReads(), 1)
  assert.deepEqual(moves, [])
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.bag, inventory)
  const cp = result.checkpoint
  for (const field of ['jobId', 'operationId', 'selectionKey', 'scope', 'sourceIdentities', 'placementSourcePin', 'plan', 'deposited', 'placed']) assert.deepEqual(cp[field], before[field], field)
  assert.equal(cp.stage, 'planned')
  assert.equal(cp.intent, null)
  assert.equal(cp.nearbySiteReplans, 1)
  assert.equal(cp.lastSiteReplan.reason, 'stand_changed_before_placement')
  assert.deepEqual(writes.at(-1), cp)
  assert.ok(horizontal(cp.stand, f.state.position) <= 6)
  assert.ok(previews.some(p => p.x === cp.stand.x && p.y === cp.stand.y && p.z === cp.stand.z))
  assert.ok(cp.positions.every(p => p.x >= 12 && p.x <= 20))
  const resumed = await run(cp)
  assert.equal(resumed.status, 'completed', resumed.reason)
  assert.equal(resumed.recovered, true)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  assert.ok(moves.every(distance => distance <= 6))
})

test('missing pin, replacement source, stale confirmation, changed life, abort or failed persistence cannot authorize a new site', async t => {
  for (const fault of ['pin', 'replacement', 'fresh', 'life_before', 'life_after', 'abort', 'denied', 'no_route', 'save', 'limit']) await t.test(fault, async () => {
    const { f, before, faults, run, writes, moves } = await afterCombat()
    const cp = structuredClone(before), options = {}
    if (fault === 'pin') delete cp.placementSourcePin
    if (fault === 'replacement') f.bag[cp.placementSourcePin.slot].stack_id++
    if (fault === 'fresh') faults.noFresh = true
    if (fault === 'life_before') f.state.lifecycle.deathId++
    if (fault === 'life_after') faults.onRefresh = () => { f.state.lifecycle.deathId++ }
    if (fault === 'abort') {
      const control = new AbortController(); options.signal = control.signal
      faults.onRefresh = () => control.abort()
    }
    if (fault === 'denied') options.canPlace = () => false
    if (fault === 'no_route') faults.noRoute = true
    if (fault === 'save') faults.save = true
    if (fault === 'limit') cp.nearbySiteReplans = 8
    const result = await run(cp, options)
    assert.equal(result.status, 'blocked', result.reason)
    assert.equal(result.serverConfirmed, false)
    assert.deepEqual(writes, [])
    // Aborting the inventory read should clean up its owner. No movement,
    // placement, transfer or other operation may be dispatched.
    assert.deepEqual(f.events, fault === 'abort' ? [{ type: 'cancel', kind: 'inventory' }] : [])
    assert.deepEqual(moves, [])
  })
})

test('a previously placed box or a persisted transfer is never moved to a fresh site', async t => {
  for (const fault of ['placed', 'transferred']) await t.test(fault, async () => {
    const { f, before, run, writes } = await afterCombat()
    const cp = structuredClone(before)
    if (fault === 'placed') {
      const p = cp.positions[0]
      cp.placed.push({ position: p, name: 'minecraft:undyed_shulker_box', runtimeId: 302, confirmedBy: 'server_block_and_inventory' })
      f.blocks.set([p.x, p.y, p.z].join(','), { known: true, name: 'minecraft:undyed_shulker_box', runtimeId: 302, boundingBox: 'block', extra: [] })
    } else cp.plan[0].transferred = 1
    const result = await run(cp)
    assert.equal(result.status, 'blocked', result.reason)
    assert.deepEqual(result.checkpoint.positions, cp.positions)
    assert.ok(!writes.some(doc => doc.lastSiteReplan))
    assert.ok(!f.events.some(e => ['place', 'mine', 'deposit'].includes(e.type)))
  })
})
