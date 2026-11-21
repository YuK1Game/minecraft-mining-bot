'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { fillCell } = require('../src/modes/mining/mine-shaft')
const { inspectDig } = require('../src/modes/mining/mine-excavate')
const target = { x: 1, y: 69, z: 5 }
const solidName = w => w.getBlock(target.x, target.y, target.z).name
function reloadBranch (w) {
  const saved = structuredClone(w.saved.at(-1).branch)
  for (const k of Object.keys(w.branch)) delete w.branch[k]
  Object.assign(w.branch, saved)
}

test('a received temporary floor keeps its ownership across a failed executor save and a reload', async t => {
  const w = createMineWorld(t), save = w.ctx.saveMine
  w.put(target, 'air')
  let failed = false
  w.ctx.saveMine = async () => {
    if (!failed && !w.branch.intent && solidName(w) === 'minecraft:cobblestone') { failed = true; return false }
    return save()
  }
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).code, 'MINE_CHECKPOINT')
  assert.equal(failed, true)
  assert.equal(w.saved.at(-1).branch.supportFills[0].receipt.consumed, 1)
  reloadBranch(w)
  w.raw.connectionId = 'reconnected'
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).status, 'completed')
  assert.equal(w.places.filter(p => p.position.x === target.x && p.position.y === target.y && p.position.z === target.z).length, 1)
  assert.equal(inspectDig(w.ctx, target, w.branch).clear, false, 'the recorded temporary floor remains diggable')
  assert.equal((await w.ctx.minePorts.mine(target)).status, 'completed')
  assert.deepEqual(w.saved.at(-1).branch.supportFills, [], 'the received break durably removes that permission before a replacement can reuse it')
})

test('a received floor reconciles an unsuccessful placement checkpoint from its AIR intent and exact consumption', async t => {
  const w = createMineWorld(t), save = w.ctx.saveMine
  w.put(target, 'air')
  let failed = false
  w.ctx.saveMine = async () => {
    if (!failed && w.branch.intent?.kind === 'fill' && !w.branch.pendingAction && solidName(w) === 'minecraft:cobblestone') { failed = true; return false }
    return save()
  }
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).code, 'MINE_CHECKPOINT_FAILED')
  assert.equal(w.branch.pendingAction.kind, 'place')
  reloadBranch(w)
  assert.equal(w.branch.supportFills, undefined, 'the last durable checkpoint predates the block receipt')
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).status, 'completed')
  assert.equal(w.branch.pendingAction, undefined)
  assert.equal(w.branch.supportFills[0].receipt.consumed, 1)
  assert.equal(w.places.length, 1)
})

test('a pre-existing cobblestone and an unconsumed placement cannot become owned temporary floors', async t => {
  const existing = createMineWorld(t)
  existing.put(target, 'cobblestone')
  assert.equal((await fillCell(existing.ctx, existing.branch, target, 'shaft_work_floor')).status, 'completed')
  assert.equal(existing.branch.supportFills, undefined)
  assert.equal(inspectDig(existing.ctx, target, existing.branch).code, 'MINE_PROTECTED_OR_UNSAFE')
  const pending = createMineWorld(t)
  pending.put(target, 'air'); pending.receive(false)
  assert.equal((await fillCell(pending.ctx, pending.branch, target, 'shaft_work_floor')).code, 'MINE_PLACEMENT_UNCONFIRMED')
  pending.put(target, 'cobblestone')
  assert.equal((await fillCell(pending.ctx, pending.branch, target, 'shaft_work_floor')).code, 'MINE_SUPPORT_RECEIPT_UNCONFIRMED')
  assert.equal(pending.branch.supportFills, undefined)
  assert.equal(pending.places.length, 1)
})

test('a consumed but never durably witnessed support cannot be inferred from a different life', async t => {
  const w = createMineWorld(t), save = w.ctx.saveMine
  w.put(target, 'air')
  let failed = false
  w.ctx.saveMine = async () => {
    if (!failed && w.branch.intent?.kind === 'fill' && !w.branch.pendingAction && solidName(w) === 'minecraft:cobblestone') { failed = true; return false }
    return save()
  }
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).code, 'MINE_CHECKPOINT_FAILED')
  reloadBranch(w); w.raw.lifecycle.deathId++
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).code, 'MINE_SUPPORT_RECEIPT_UNCONFIRMED')
  assert.equal(w.branch.supportFills, undefined)
  assert.equal(w.places.length, 1)
})

test('a support received during cancellation is reconciled in the same life without a second placement', async t => {
  const w = createMineWorld(t), place = w.ctx.operations.interactions.placeHouseBlock
  w.put(target, 'air')
  let cancelled = false
  w.ctx.cancelled = () => cancelled
  w.ctx.operations.interactions.placeHouseBlock = async request => { await place(request); cancelled = true }
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).status, 'interrupted')
  cancelled = false
  assert.equal((await fillCell(w.ctx, w.branch, target, 'shaft_work_floor')).status, 'completed')
  assert.equal(w.branch.pendingAction, undefined)
  assert.equal(w.branch.supportFills[0].receipt.consumed, 1)
  assert.equal(w.places.length, 1)
})
