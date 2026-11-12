'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports={fixture,item,airItem,names}\n', file)
const { fixture, item, airItem, names } = loaded.exports
names.set(5, 'minecraft:diorite'); names.set(6, 'minecraft:arrow')

async function lateSurplus () {
  const f = fixture('shulker')
  f.bag[0].count = 8
  for (let slot = 0; slot < 36; slot++) if (!f.bag[slot].count) f.bag[slot] = item(6, 64, 1000 + slot)
  let injected = false
  const first = await f.run({ onCheckpoint: cp => {
    if (!injected && cp.stage === 'depositing' && cp.intent === null && cp.plan[0].transferred === 8) {
      injected = true
      const empty = f.bag.map((raw, slot) => ({ raw, slot })).filter(row => !row.raw.count)
      assert.equal(empty.length, 2)
      f.bag[empty[0].slot] = item(4, 2, 9001)
      f.bag[empty[1].slot] = item(5, 1, 9002)
    }
  } })
  assert.equal(first.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.equal(first.checkpoint.intent, null)
  assert.equal(first.checkpoint.plan[0].transferred, 8)
  assert.equal(f.events.some(e => e.type === 'mine'), false)
  const pending = copy(first.checkpoint), writes = []
  const originalSnapshot = f.dependencies.chest.snapshot, originalRaw = f.dependencies.chest.rawItem
  const flags = { unknown: false, replay: false }
  f.dependencies.chest.snapshot = () => { const r = originalSnapshot(); if (flags.replay) r.window.replayed = true; return r }
  f.dependencies.chest.rawItem = slot => flags.unknown && slot === 26 ? null : originalRaw(slot)
  let owner = 1
  const controller = createQuarryPortableStorage({ ...f.dependencies, captureActionOwner: () => owner, runActionOwned: (captured, fn) => { if (captured !== owner) throw Object.assign(new Error('owner changed'), { code: 'STORAGE_ACTION_OWNER_CHANGED' }); return fn() } })
  f.controller.ownsShulker = (...args) => controller.ownsShulker(...args)
  const resume = (request = {}, onCheckpoint = null) => controller.storeCarried({ ...copy(f.request), checkpoint: copy(pending), allowRecoverySpace: true, ...request }, { canPlace: () => true, onCheckpoint: async cp => { writes.push(copy(cp)); if (onCheckpoint) await onCheckpoint(cp) } })
  return { f, pending, writes, flags, resume, takeover: () => { owner++ } }
}

test('a completed old plan reserves two slots with whole late-surplus stacks through ordinary confirmed transfers', async () => {
  const h = await lateSurplus(), originalEntry = copy(h.pending.plan[0])
  const result = await h.resume()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.recovered, true)
  assert.equal(result.checkpoint.recoverySpaceExtensions, 2)
  assert.deepEqual(result.checkpoint.plan[0], originalEntry)
  assert.deepEqual(result.checkpoint.plan.slice(1).map(p => ({ name: p.name, count: p.count, transferred: p.transferred, recoverySpace: p.recoverySpace })), [
    { name: 'minecraft:stone', count: 2, transferred: 2, recoverySpace: true },
    { name: 'minecraft:diorite', count: 1, transferred: 1, recoverySpace: true }
  ])
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  assert.equal(h.f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(h.f.events.filter(e => e.type === 'mine').length, 1)
  assert.equal(h.f.events.filter(e => e.type === 'deposit').length, 3)
  const firstAppended = h.writes.find(cp => cp.recoverySpaceExtensions === 1)
  assert.equal(firstAppended.plan[1].transferred, 0)
  assert.deepEqual(firstAppended.deposited, h.pending.deposited, 'appending a plan credits no material')
})

test('without the explicit automated opt-in the old bounded plan is not expanded', async () => {
  const h = await lateSurplus(), result = await h.resume({ allowRecoverySpace: false })
  assert.equal(result.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.deepEqual(result.checkpoint.plan, h.pending.plan)
  assert.equal(h.f.events.filter(e => e.type === 'deposit').length, 1)
  assert.equal(h.f.events.some(e => e.type === 'mine'), false)
})

test('three extensions are a persisted hard cap despite repeated natural refill', async () => {
  const h = await lateSurplus()
  const result = await h.resume({}, cp => {
    if (cp.intent === null && cp.plan.at(-1)?.recoverySpace && cp.plan.at(-1).transferred === cp.plan.at(-1).count) {
      for (let slot = 0; slot < 36; slot++) if (!h.f.bag[slot].count) h.f.bag[slot] = item(4, 2, 11000 + cp.recoverySpaceExtensions * 100 + slot)
    }
  })
  assert.equal(result.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.equal(result.checkpoint.recoverySpaceExtensions, 3)
  assert.equal(result.checkpoint.plan.filter(p => p.recoverySpace).length, 3)
  assert.equal(h.f.events.some(e => e.type === 'mine'), false)
  const retry = await h.resume({ checkpoint: result.checkpoint })
  assert.equal(retry.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.equal(retry.checkpoint.recoverySpaceExtensions, 3)
})

test('unknown or full box and invalid counters cannot authorize a new late transfer', async t => {
  for (const kind of ['unknown', 'replay', 'full', 'null', 'negative', 'over-cap']) await t.test(kind, async () => {
    const h = await lateSurplus(), cp = copy(h.pending)
    if (kind === 'unknown') h.flags.unknown = true
    if (kind === 'replay') h.flags.replay = true
    if (kind === 'full') h.f.containers.set(key(cp.positions[0]), Array.from({ length: 27 }, (_, i) => item(6, 64, 12000 + i)))
    if (kind === 'null') cp.recoverySpaceExtensions = null
    if (kind === 'negative') cp.recoverySpaceExtensions = -1
    if (kind === 'over-cap') cp.recoverySpaceExtensions = 4
    const result = await h.resume({ checkpoint: cp })
    assert.equal(result.status, 'blocked')
    assert.equal(result.checkpoint.plan.length, 1)
    assert.equal(h.f.events.filter(e => e.type === 'deposit').length, 1)
    assert.equal(h.f.events.some(e => e.type === 'mine'), false)
  })
})

test('reserves and partial kept stacks are not taken just to open a recovery slot', async () => {
  const h = await lateSurplus()
  for (let slot = 0; slot < 36; slot++) if ([4, 5].includes(h.f.bag[slot].network_id)) h.f.bag[slot] = item(3, 56, 13000 + slot)
  const before = copy(h.f.bag)
  const result = await h.resume({ inventoryPolicy: { keepExitDirt: 64, keepSealBlocks: 32, keepSealMaterial: 'dirt' } })
  assert.equal(result.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.deepEqual(h.f.bag, before)
  assert.equal(result.checkpoint.plan.length, 1)
})

test('append persistence failure rolls back plan and undefined counter and sends no new transfer', async () => {
  const h = await lateSurplus()
  const result = await h.resume({}, cp => { if (cp.recoverySpaceExtensions === 1) throw new Error('disk failed') })
  assert.equal(result.reason, 'STORAGE_PERSISTENCE_FAILED')
  assert.deepEqual(result.checkpoint.plan, h.pending.plan)
  assert.equal(result.checkpoint.recoverySpaceExtensions, undefined)
  assert.equal(h.f.events.filter(e => e.type === 'deposit').length, 1)
})

test('a changed whole source or changed operation owner after append cannot send its transfer', async t => {
  for (const mode of ['source', 'owner']) await t.test(mode, async () => {
    const h = await lateSurplus()
    const result = await h.resume({}, cp => {
      if (cp.recoverySpaceExtensions === 1 && cp.plan.at(-1).transferred === 0) {
        if (mode === 'owner') h.takeover()
        else { const row = h.f.items().find(i => i.name === cp.plan.at(-1).name); h.f.bag[row.slot].count++ }
      }
    })
    assert.equal(result.status, 'blocked')
    assert.equal(h.f.events.filter(e => e.type === 'deposit').length, 1)
    assert.equal(h.f.events.some(e => e.type === 'mine'), false)
  })
})

test('two-slot reserve is best effort and the existing minimum-one-slot recovery is unchanged', async () => {
  const h = await lateSurplus()
  for (let slot = 0; slot < 36; slot++) if ([4, 5].includes(h.f.bag[slot].network_id)) h.f.bag[slot] = item(6, 64, 14000 + slot)
  h.f.bag[35] = airItem()
  const result = await h.resume()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.recoverySpaceExtensions, undefined)
  assert.equal(result.recovered, true)
})

test('live case 2026-11-12: after a received drop-pickup round, three more confirmed top-ups free the recovery slot', async () => {
  const h = await lateSurplus()
  const capped = await h.resume({}, cp => {
    if (cp.intent === null && cp.plan.at(-1)?.recoverySpace && cp.plan.at(-1).transferred === cp.plan.at(-1).count) {
      for (let slot = 0; slot < 36; slot++) if (!h.f.bag[slot].count) h.f.bag[slot] = item(4, 2, 12000 + cp.recoverySpaceExtensions * 100 + slot)
    }
  })
  assert.equal(capped.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED')
  assert.equal(capped.checkpoint.recoverySpaceExtensions, 3)
  const again = await h.resume({ checkpoint: capped.checkpoint })
  assert.equal(again.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED', 'without a pickup round the cap holds')
  const topped = await h.resume({ checkpoint: capped.checkpoint, recoverySpaceRounds: 1 })
  assert.ok(topped.checkpoint.recoverySpaceExtensions > 3 && topped.checkpoint.recoverySpaceExtensions <= 6, String(topped.checkpoint.recoverySpaceExtensions))
  assert.notEqual(topped.reason, 'STORAGE_RECOVERY_SLOT_REQUIRED', JSON.stringify(topped.reason))
  assert.ok(topped.checkpoint.plan.filter(p => p.recoverySpace).every(p => p.transferred === p.count), 'every top-up is a confirmed whole transfer')
})
