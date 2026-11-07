'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { diagnoseShulkerContents, compareShulkerContents } = require('../src/shulker-contents')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')

// Use the existing real-controller fixture without registering its tests.
const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, carriedBox, item, airItem, names, key }\n', file)
const { fixture, carriedBox, item, airItem, names, key } = loaded.exports
const resolveName = id => names.get(id)
const options = { resolveName }
const copy = value => structuredClone(value)

function contentsFixture () {
  const slots = Array.from({ length: 27 }, airItem)
  slots[0] = item(3, 8, 100)
  const box = carriedBox(slots, 200)
  return { slots, box, entry: box.extra.nbt.nbt.value.Items.value.value[0] }
}

test('detailed comparisons preserve exact PASS/FAIL/UNKNOWN and legacy return shape', () => {
  const matched = contentsFixture()
  assert.deepEqual(compareShulkerContents(matched.box, matched.slots, options), { known: true, matches: true })
  assert.equal(diagnoseShulkerContents(matched.box, matched.slots, options).status, 'PASS')
  for (const [field, mutate] of [
    ['name', f => { f.entry.Name.value = 'minecraft:stone' }],
    ['count', f => { f.entry.Count.value++ }],
    ['metadata', f => { f.entry.Damage.value = 1 }]
  ]) {
    const f = contentsFixture(); mutate(f)
    const detail = diagnoseShulkerContents(f.box, f.slots, options)
    assert.deepEqual(compareShulkerContents(f.box, f.slots, options), { known: true, matches: false, reason: 'CONTENTS_MISMATCH' })
    assert.equal(detail.status, 'FAIL')
    assert.ok(detail.differences.some(diff => diff.path === `slots[0].${field}`))
  }
  const unknown = contentsFixture(); unknown.box.extra = { has_nbt: false, can_place_on: [], can_destroy: [] }
  const detail = diagnoseShulkerContents(unknown.box, unknown.slots, options)
  assert.equal(detail.status, 'UNKNOWN')
  assert.equal(detail.actual.reason, 'CONTENTS_NBT_UNOBSERVED')
  assert.deepEqual(detail.differences, [], 'unreceived content is not an invented mismatch')
})

test('NBT differences identify their path while order changes and new stack IDs stay equivalent', () => {
  const f = contentsFixture()
  const tag = { type: 'compound', value: { Damage: { type: 'int', value: 5 }, RepairCost: { type: 'int', value: 2 } } }
  f.slots[0].extra = { has_nbt: true, nbt: { version: 1, nbt: { ...copy(tag), name: '' } }, can_place_on: [], can_destroy: [] }
  f.entry.tag = { type: 'compound', value: { RepairCost: copy(tag.value.RepairCost), Damage: copy(tag.value.Damage) } }
  f.box.stack_id = 999
  assert.equal(diagnoseShulkerContents(f.box, f.slots, options).status, 'PASS')
  f.entry.tag.value.Damage.value = 6
  const detail = diagnoseShulkerContents(f.box, f.slots, options)
  assert.ok(detail.differences.some(diff => diff.path === 'slots[0].tag.value.Damage.value' && diff.expected === 5 && diff.actual === 6))
  const before = JSON.stringify(f)
  detail.differences[0].expected = 'changed by caller'
  assert.equal(JSON.stringify(f), before)
})

test('diagnostic NBT differences and scalar values are bounded', () => {
  const f = contentsFixture(), wanted = {}, actual = {}
  for (let i = 0; i < 100; i++) { wanted[`field${i}`] = { type: 'string', value: 'a'.repeat(1000) }; actual[`field${i}`] = { type: 'string', value: 'b'.repeat(1000) } }
  f.slots[0].extra = { has_nbt: true, nbt: { nbt: { type: 'compound', name: '', value: wanted } }, can_place_on: [], can_destroy: [] }
  f.entry.tag = { type: 'compound', value: actual }
  const detail = diagnoseShulkerContents(f.box, f.slots, options)
  assert.equal(detail.status, 'FAIL')
  assert.equal(detail.truncated, true)
  assert.equal(detail.differences.length, 32)
  assert.ok(JSON.stringify(detail).length < 16000)
})

async function runDiagnostic (fixtureOptions, freshness) {
  const f = fixture('shulker', fixtureOptions)
  let freshnessReads = 0
  const diagnostics = []
  const controller = createQuarryPortableStorage({ ...f.dependencies, getObservationFreshness: () => { freshnessReads++; return freshness }, onRecoveryDiagnostic: diagnostic => { diagnostics.push(diagnostic) } })
  f.controller.ownsShulker = controller.ownsShulker
  const result = await controller.storeCarried(copy(f.request), { canPlace: () => true, onCheckpoint: async () => {} })
  return { f, result, freshnessReads, diagnostics }
}

test('final recovery failure separates missing pickup, missing NBT, and known content mismatch', async () => {
  for (const [fixtureOptions, expectedCount, expectedId, expectedContents] of [
    [{ noPickup: true }, 'FAIL', 'FAIL', 'UNKNOWN'],
    [{ missingNBT: true }, 'PASS', 'PASS', 'UNKNOWN'],
    [{ wrongContents: true }, 'PASS', 'PASS', 'FAIL']
  ]) {
    const { f, result, freshnessReads, diagnostics } = await runDiagnostic(fixtureOptions)
    assert.equal(result.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
    assert.equal(result.recovered, false)
    assert.equal(result.checkpoint.stage, 'awaiting_recovery')
    const d = result.details.recovery
    assert.equal(d.checks.blockCleared.status, 'PASS')
    assert.equal(d.checks.currentScope.status, 'PASS')
    assert.equal(d.checks.boxCount.status, expectedCount)
    assert.equal(d.checks.newBoxId.status, expectedId)
    assert.equal(d.checks.contents.status, expectedContents)
    assert.equal(d.baseline.count, 0)
    assert.equal(d.checks.boxCount.expected, 1)
    assert.equal(d.freshness.status, 'UNKNOWN')
    assert.equal(freshnessReads, 1, 'diagnostics do not run or log on each 50ms poll')
    assert.equal(diagnostics.length, 1)
    assert.deepEqual(diagnostics[0], d)
    diagnostics[0].checks.boxCount.status = 'changed by logger'
    assert.equal(d.checks.boxCount.status, expectedCount, 'the logging sink cannot mutate persisted result details')
    assert.equal(f.events.filter(event => event.type === 'mine').length, 1)
  }
})

test('freshness reports actual receipt clocks without treating the diagnostic time as a receipt', async () => {
  const { result } = await runDiagnostic({ missingNBT: true }, { inventoryObservedAt: 1500, inventoryResync: { status: 'FRESH_MAIN_OBSERVED', requestedAt: 1200, observedAt: 1500, freshMainObserved: true, fullCountAtSend: 3 } })
  const d = result.details.recovery
  assert.equal(d.freshness.status, 'PASS')
  assert.equal(d.freshness.inventoryObservedAt, 1500)
  assert.equal(d.freshness.inventoryAgeMs, d.observedAt - 1500)
  assert.equal(d.freshness.resync.fullCountAtSend, 3)
  assert.equal(d.freshness.resync.scopeMatch, 'UNKNOWN')
  assert.equal(d.freshness.resync.freshMainObserved, false, 'an unbound historical resync is not current-life evidence')
  const broken = fixture('shulker', { missingNBT: true })
  const controller = createQuarryPortableStorage({ ...broken.dependencies, getObservationFreshness: () => { throw new Error('unavailable') }, onRecoveryDiagnostic: () => { throw new Error('logger failed') } })
  broken.controller.ownsShulker = controller.ownsShulker
  const blocked = await controller.storeCarried(copy(broken.request), { canPlace: () => true, onCheckpoint: async () => {} })
  assert.equal(blocked.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
  assert.equal(blocked.details.recovery.freshness.status, 'UNKNOWN')
})

test('resync freshness distinguishes current, old connection, old life, and unobserved scope', async () => {
  const scope = { profile: 'bot', realmId: '42', connectionId: 'one', startedAt: '2026-11-05T00:00:00Z', runtimeEntityId: '1', dimension: 'overworld', deathId: 0 }
  for (const [requestScope, expected] of [
    [scope, 'PASS'],
    [{ ...scope, connectionId: 'previous-connection' }, 'FAIL'],
    [{ ...scope, deathId: 1 }, 'FAIL'],
    [{ ...scope, dimension: 'nether' }, 'FAIL'],
    [{ ...scope, runtimeEntityId: '999' }, 'FAIL'],
    [{ ...scope, startedAt: null }, 'UNKNOWN'],
    [undefined, 'UNKNOWN']
  ]) {
    const { result } = await runDiagnostic({ missingNBT: true }, { inventoryObservedAt: 1500, inventoryResync: { status: 'FRESH_MAIN_OBSERVED', scope: requestScope, requestedAt: 1200, observedAt: 1500, freshMainObserved: true } })
    const resync = result.details.recovery.freshness.resync
    assert.equal(resync.scopeMatch, expected)
    assert.equal(resync.reportedFreshMainObserved, true)
    assert.equal(resync.freshMainObserved, expected === 'PASS')
    assert.equal(result.reason, 'STORAGE_RECOVERY_UNCONFIRMED', 'diagnostic freshness never completes recovery')
  }
})

test('diagnostics preserve the saved 23-box baseline on resume and never rebase to require 25', async () => {
  const f = fixture('shulker', { missingNBT: true })
  for (const slot of Array.from({ length: 36 }, (_, i) => i).filter(slot => slot !== 0 && slot !== 14).slice(0, 23)) f.bag[slot] = carriedBox(Array.from({ length: 27 }, airItem), 1000 + slot)
  const first = await f.run()
  assert.equal(first.details.recovery.baseline.count, 23)
  assert.equal(first.details.recovery.actual.count, 24)
  const second = await f.run({}, { ...f.request, checkpoint: first.checkpoint })
  assert.equal(second.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
  assert.equal(second.details.recovery.baseline.count, 23)
  assert.equal(second.details.recovery.checks.boxCount.expected, 24)
  assert.deepEqual(second.checkpoint.recoveryBaseline, first.checkpoint.recoveryBaseline)
  assert.equal(f.events.filter(event => event.type === 'mine').length, 1)
})

test('a reused existing box ID is diagnosed without relaxing the new-ID gate', async () => {
  const f = fixture('shulker', { reusedStackId: 900 })
  f.bag[1] = carriedBox(Array.from({ length: 27 }, airItem), 900)
  const result = await f.run()
  assert.equal(result.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
  assert.equal(result.details.recovery.checks.boxCount.status, 'PASS')
  assert.equal(result.details.recovery.checks.newBoxId.status, 'FAIL')
  assert.deepEqual(result.details.recovery.actual.candidateIds, [])
  assert.deepEqual(result.details.recovery.baseline.stackIds, [900])
  assert.equal(result.recovered, false)
})

test('later exact NBT during the existing wait succeeds without emitting failure diagnostics or re-mining', async () => {
  const f = fixture('shulker', { missingNBT: true })
  let freshnessReads = 0, sleeps = 0
  const controller = createQuarryPortableStorage({
    ...f.dependencies,
    getObservationFreshness: () => { freshnessReads++; return {} },
    sleep: async ms => {
      await f.dependencies.sleep(ms)
      if (++sleeps === 2) {
        const box = f.items().find(item => item.name === 'minecraft:undyed_shulker_box')
        const mining = f.events.find(event => event.type === 'mine')
        f.bag[box.slot] = carriedBox(f.containers.get(key(mining.target)), box.stackId)
      }
    }
  })
  f.controller.ownsShulker = controller.ownsShulker
  const result = await controller.storeCarried(copy(f.request), { canPlace: () => true, onCheckpoint: async () => {} })
  assert.equal(result.status, 'completed')
  assert.equal(result.recovered, true)
  assert.equal(result.details, undefined)
  assert.equal(freshnessReads, 0)
  assert.equal(f.events.filter(event => event.type === 'mine').length, 1)
})
