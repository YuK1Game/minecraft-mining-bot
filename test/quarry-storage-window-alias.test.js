'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { deserialize } = require('node:v8')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { compareShulkerContents } = require('../src/shulker-contents')

const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=fixture\n', file)

async function packed () {
  const f = loaded.exports('shulker')
  const scope = { profile: f.state.profile, realmId: String(f.state.realm.id), connectionId: f.state.connectionId,
    startedAt: f.state.startedAt, runtimeEntityId: String(f.state.runtimeEntityId), dimension: f.state.dimension, life: f.state.lifecycle.deathId }
  let cp, alias = 'first', epoch = 288, replacement = {}
  const chest = {
    ...f.dependencies.chest,
    open: async (...args) => {
      const r = await f.dependencies.chest.open(...args)
      epoch++; replacement = {}
      return { ...r, windowId: 1, scope: structuredClone(scope) }
    },
    snapshot: () => {
      const s = f.dependencies.chest.snapshot()
      return { ...s, observationSource: 'server_inventory_slot', window: { ...s.window, id: 1, type: 'container', kind: 'shulker',
        blockName: 'minecraft:undyed_shulker_box', scope: structuredClone(scope), epoch, replayed: false, ...replacement } }
    }
  }
  const crafting = {
    ...f.crafting,
    inventorySnapshot: () => {
      const s = f.crafting.inventorySnapshot()
      return { ...s, openContainer: s.openContainer && { ...s.openContainer, id: alias, coordinates: chest.snapshot().window.position } }
    }
  }
  const portable = createQuarryPortableStorage({ ...f.dependencies, chest, crafting })
  f.controller.ownsShulker = portable.ownsShulker
  // Emulate the persisted pre-close checkpoint of storage:114, while both
  // items and the packed container already have their received transfers.
  const interrupted = await portable.storeCarried(f.request, { onCheckpoint: async value => {
    if (value.stage === 'packed') { cp = structuredClone(value); throw Error('test shutdown immediately after persisted pack') }
  } })
  assert.equal(interrupted.status, 'blocked')
  assert.equal(cp.stage, 'packed')
  assert.equal(cp.windowId, 1)
  assert.equal(cp.intent, null)
  assert.equal(cp.plan[0].transferred, cp.plan[0].count)
  const before = deserialize(Buffer.from(cp.expectedContents, 'base64'))
  assert.equal(before.length, 27)
  assert.equal(before[0].count, 8)
  f.events.length = 0
  return { f, cp, before, useAlias: id => { alias = id }, replaceWindow: patch => { replacement = patch },
    resume: (onCheckpoint = async () => {}) => portable.storeCarried({ ...f.request, checkpoint: cp }, { onCheckpoint }) }
}

test('storage:114 packed window 1/first resumes with a fresh open, zero repeat deposits and exact recovered contents', async () => {
  const f = await packed(), result = await f.resume()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.recovered, true)
  assert.deepEqual(result.checkpoint.deposited, f.cp.deposited)
  assert.deepEqual(result.checkpoint.placed, f.cp.placed)
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  const raw = f.f.bag[result.checkpoint.recovered.slot]
  assert.equal(compareShulkerContents(raw, f.before, { resolveName: f.f.crafting.itemNameOf }).matches, true)
  const events = f.f.events.map(e => e.type)
  assert.ok(events.includes('open'))
  assert.equal(events.filter(type => type === 'mine').length, 1)
  assert.ok(!events.some(type => type === 'place' || type === 'deposit'))
})

test('a different or unknown current window is never closed or broken during packed storage resume', async t => {
  for (const alias of ['last', 'unknown', 'inventory']) await t.test(alias, async () => {
    const f = await packed()
    f.useAlias(alias)
    const result = await f.resume()
    assert.equal(result.reason, 'STORAGE_WINDOW_CHANGED')
    assert.equal(result.checkpoint.expectedContents, f.cp.expectedContents)
    assert.deepEqual(f.f.events, [])
  })
})

test('direct packed resume rejects a different chest which reused ID 1 before closing any open window', async () => {
  const f = await packed()
  f.replaceWindow({ epoch: 290, position: { ...f.cp.positions[0], x: f.cp.positions[0].x + 3 } })
  const result = await f.resume()
  assert.equal(result.status, 'blocked')
  assert.equal(result.reason, 'STORAGE_WINDOW_CHANGED')
  assert.equal(result.checkpoint.expectedContents, f.cp.expectedContents)
  assert.deepEqual(result.checkpoint.deposited, f.cp.deposited)
  assert.deepEqual(f.f.events, [], 'the foreign window must not be closed or replaced with a fresh open')
})

test('a confirmed same-position reopen cannot be closed if its local epoch changes while packed state is saved', async () => {
  const f = await packed()
  let beforeReplacement
  const result = await f.resume(async cp => {
    if (cp.stage === 'packed') {
      beforeReplacement = structuredClone(f.f.events)
      f.replaceWindow({ epoch: 999 })
    }
  })
  assert.ok(beforeReplacement?.some(e => e.type === 'open'))
  assert.equal(result.status, 'blocked')
  assert.equal(result.reason, 'STORAGE_WINDOW_CHANGED')
  assert.deepEqual(result.checkpoint.deposited, f.cp.deposited)
  assert.deepEqual(f.f.events, beforeReplacement, 'cannot close the replacement epoch or issue recovery mining')
})

test('an unchanged legacy packed window can be closed after a local generation reset and freshly reopened', async () => {
  const f = await packed()
  f.replaceWindow({ epoch: 2, replayed: true, slotCount: null, expectedSlots: null })
  const result = await f.resume()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.recovered, true)
  assert.equal(f.f.events.filter(e => e.type === 'mine').length, 1)
  assert.ok(!f.f.events.some(e => e.type === 'place' || e.type === 'deposit'))
})
