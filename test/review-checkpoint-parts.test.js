'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { writeDurableJson } = require('../src/common/durable-json')
const { freeze } = require('../src/common/checkpoint-parts')
const { createDragonState } = require('../src/modes/dragon-state')
const { action } = require('../src/modes/mining/mine-common')
const { createQuarryStore } = require('../src/quarry/quarry-store')

async function rootFor (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-parts-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
const live = () => ({ profile: 'bot', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', runtimeEntityId: '7', dimension: 'overworld', phase: 'spawned', health: 20, lifecycle: { deathId: 0 }, inventory: { known: true, items: [] } })
const largePlan = id => ({ id, segments: Array.from({ length: 1500 }, (_, i) => ({ id: `upper:${i}`, from: { x: i, y: 16, z: 0 }, to: { x: i, y: 16, z: 127 } })) })

test('review: real mine action durably brackets its receipt without copying or rewriting its static plans', async t => {
  const root = await rootFor(t), raw = live(), writes = []
  let rejectReceipt = false
  const open = (shared = {}) => createDragonState({ root, shared, getState: () => raw, write: async (file, doc, options) => {
    if (rejectReceipt && doc.version === 2 && !doc.value.early.mine.branch.intent) throw new Error('receipt disk failure')
    const receipt = await writeDurableJson(file, doc, options)
    writes.push({ file, bytes: Buffer.byteLength(JSON.stringify(doc)), receipt })
    return receipt
  } })
  const state = open(), seed = state.record()
  seed.early.mine = { branch: { plan: largePlan('active'), progress: { cursor: 0 } }, sites: [{ plan: largePlan('retired'), status: 'retired' }] }
  assert.equal(await state.save(seed), true)
  const record = state.record(), branch = record.early.mine.branch, first = writes.length
  assert.equal(branch.plan, state.record().early.mine.branch.plan)
  assert.ok(Object.isFrozen(branch.plan.segments))
  const ctx = { runtime: { raw: () => raw, inventory: () => raw.inventory }, shared: {}, cancelled: () => false, saveMine: () => state.save(record) }
  let calls = 0
  const result = await action(ctx, branch, { kind: 'mine', target: { x: 1, y: 16, z: 0 } }, async () => {
    calls++
    assert.equal(open().record().early.mine.branch.intent.kind, 'mine', 'intent is on disk before any input')
    return { status: 'completed', serverConfirmed: true }
  })
  assert.equal(result.status, 'completed')
  assert.equal(calls, 1)
  assert.equal(open().record().early.mine.branch.intent, undefined)
  const perAction = writes.slice(first)
  assert.equal(perAction.length, 2)
  assert.ok(perAction.every(row => !row.file.includes('.json.parts') && row.bytes < 4000 && row.receipt.fileSynced))
  rejectReceipt = true
  const failed = await action(ctx, branch, { kind: 'walk' }, async () => ({ status: 'completed', serverConfirmed: true }))
  assert.equal(failed.code, 'MINE_CHECKPOINT')
  assert.equal(branch.intent.kind, 'walk')
  assert.equal(open().record().early.mine.branch.intent.kind, 'walk', 'failed receipt leaves the durable work debt')
})

test('review: old expedition documents migrate; missing or tampered static parts never reset progress', async t => {
  const root = await rootFor(t), raw = live()
  const open = () => createDragonState({ root, shared: {}, getState: () => raw })
  const state = open(), record = state.record()
  record.early.mine = { branch: { plan: largePlan('old'), progress: { cursor: 19 } } }
  await state.save(record)
  const directory = path.join(root, '.local', 'dragon-expedition'), file = path.join(directory, (await fs.readdir(directory)).find(name => name.endsWith('.json')))
  const disk = JSON.parse(await fs.readFile(file, 'utf8'))
  await writeDurableJson(file, { ...disk, version: 1, value: structuredClone(record) })
  const migrated = open(), copy = migrated.record()
  assert.equal(copy.early.mine.branch.progress.cursor, 19)
  copy.early.mine.branch.progress.cursor++
  await migrated.save(copy)
  const latest = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(latest.version, 2)
  const part = path.join(file + '.parts', latest.value.early.mine.branch.plan.checkpointPart + '.json')
  await fs.unlink(part)
  assert.throws(() => open().record(), { code: 'CHECKPOINT_PART_INVALID' })
  await fs.writeFile(part, JSON.stringify({ version: 1, value: { id: 'tampered' } }))
  assert.throws(() => open().record(), { code: 'CHECKPOINT_PART_INVALID' })
})

test('review: quarry checkpoints reuse immutable cell records and restore after an interrupted replacement', async t => {
  const directory = await rootFor(t), writes = []
  let fail = false
  const store = createQuarryStore({ directory, write: async (file, doc, options) => {
    if (fail && doc.checkpointParts === 1) throw new Error('manifest failure')
    const receipt = await writeDurableJson(file, doc, options)
    writes.push({ file, bytes: Buffer.byteLength(JSON.stringify(doc)) })
    return receipt
  } })
  const records = freeze({ deferred: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`${i},10,0`, { reason: 'UNREACHABLE', name: 'minecraft:stone' }])), temporary: {}, seals: {}, stair: null })
  const doc = { config: { jobId: 'parts', dimension: 'overworld' }, world: { profile: 'bot', realmId: '1', dimension: 'overworld' }, instanceId: 'same-instance', records, state: 'MINE', actionSequence: 1 }
  await store.save('parts', doc)
  const initialWrites = writes.length
  await store.save('parts', { ...doc, actionSequence: 2, checkpoint: { phase: 'mine_intent' } })
  await store.save('parts', { ...doc, actionSequence: 2, checkpoint: { phase: 'batch', receivedAir: true } })
  assert.equal(writes.length - initialWrites, 2)
  assert.ok(writes.slice(initialWrites).every(row => row.bytes < 1500 && !row.file.includes('.json.parts')))
  assert.deepEqual((await createQuarryStore({ directory }).load('parts')).records, records)
  fail = true
  await assert.rejects(store.save('parts', { ...doc, actionSequence: 3, records: freeze({ ...records, deferred: {} }) }), /manifest failure/)
  const recovered = await createQuarryStore({ directory }).load('parts')
  assert.equal(recovered.actionSequence, 2)
  assert.equal(Object.keys(recovered.records.deferred).length, 2000)
  fail = false
  await store.save('parts', { ...doc, actionSequence: 3, records: freeze({ ...records, deferred: {} }) })
  assert.equal((await fs.readdir(path.join(directory, 'parts.json.parts'))).length, 1, 'obsolete static versions are bounded')
})

test('review: alternating store generations never reuse a collected part and reads own the checkpoint queue', async t => {
  const directory = await rootFor(t), first = createQuarryStore({ directory }), second = createQuarryStore({ directory })
  const doc = { config: { jobId: 'rotating', dimension: 'overworld' }, world: { profile: 'bot', realmId: '1', dimension: 'overworld' }, instanceId: 'same', state: 'MINE' }
  const old = freeze({ deferred: { a: { reason: 'old' } } }), next = freeze({ deferred: { b: { reason: 'new' } } })
  for (let i = 0; i < 3; i++) {
    await first.save('rotating', { ...doc, records: old })
    assert.deepEqual((await first.load('rotating')).records, old)
    assert.equal((await fs.readdir(path.join(directory, 'rotating.json.parts'))).length, 1)
    await second.save('rotating', { ...doc, records: next })
    assert.deepEqual((await second.load('rotating')).records, next)
  }
  let release, entered
  const reachedPart = new Promise(resolve => { entered = resolve }), hold = new Promise(resolve => { release = resolve })
  const io = { ...fs, open: async (file, flags, ...args) => {
    if (flags === 'r' && file.includes('.json.parts')) { entered(); await hold }
    return fs.open(file, flags, ...args)
  } }
  const reader = createQuarryStore({ directory, io }), reading = reader.load('rotating')
  await reachedPart
  let saved = false
  const saving = first.save('rotating', { ...doc, records: old }).then(() => { saved = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saved, false, 'writer must not collect the part before the reader opens it')
  release()
  assert.deepEqual((await reading).records, next)
  await saving
  assert.deepEqual((await first.load('rotating')).records, old)
})

test('review: a shallow-frozen external document is not mistaken for immutable cell records', async t => {
  const directory = await rootFor(t), store = createQuarryStore({ directory })
  const records = Object.freeze({ deferred: {} })
  const doc = { config: { jobId: 'shallow', dimension: 'overworld' }, world: { profile: 'bot', realmId: '1', dimension: 'overworld' }, instanceId: 'same', records }
  await store.save('shallow', doc)
  records.deferred.a = { reason: 'new' }
  await store.save('shallow', doc)
  assert.equal((await store.load('shallow')).records.deferred.a.reason, 'new')
  const raw = live(), state = createDragonState({ root: directory, shared: {}, getState: () => raw }), expedition = state.record()
  expedition.early.mine = { branch: { plan: Object.freeze({ id: 'test', segments: [] }) } }
  await state.save(expedition)
  assert.throws(() => expedition.early.mine.branch.plan.segments.push({ id: 'changed' }), TypeError)
})
