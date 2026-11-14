'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { createActionOwnerTracker } = require('../src/action-owner-tracker')
const { createMining } = require('../src/mining')

const fixtureFile = require.resolve('./quarry-portable-storage.test')
const fixtureModule = new Module(fixtureFile, module)
fixtureModule.filename = fixtureFile
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
fixtureModule._compile(fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, names }\n', fixtureFile)
const { fixture, item, names } = fixtureModule.exports

test('one crowded storage plan previews each stand once and shares one entity observation', async t => {
  const f = fixture('shulker'), actors = [], previews = new Map()
  // The review fixture covers every candidate box cell with loose items. All
  // 29 walkable stands remain fallback candidates, each with eight box cells.
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) actors.push({ kind: 'item', alive: true, runtimeId: String(actors.length + 1), position: { x: x + 0.5, y: 65, z: z + 0.5 } })
  let entityReads = 0, planned
  const controller = createQuarryPortableStorage({
    ...f.dependencies,
    getEntities: () => { entityReads++; return structuredClone(actors) },
    previewMove: stand => { const key = JSON.stringify(stand); previews.set(key, (previews.get(key) ?? 0) + 1); return { ready: true } }
  })
  const result = await controller.storeCarried(f.request, { canPlace: () => true, onCheckpoint: async checkpoint => { planned = checkpoint; throw Error('stop after read-only planning') } })
  const previewCalls = [...previews.values()].reduce((total, count) => total + count, 0)
  t.diagnostic(JSON.stringify({ entityReads, previewCalls, uniqueStands: previews.size, stand: planned?.stand, positions: planned?.positions }))
  assert.equal(result.reason, 'STORAGE_PERSISTENCE_FAILED')
  assert.equal(planned.stage, 'planned')
  assert.deepEqual(planned.stand, { x: -3, y: 65, z: 0 })
  assert.deepEqual(planned.positions, [{ x: -1, y: 65, z: 0 }])
  assert.equal(f.events.length, 0, 'planning alone never dispatches an action')
  assert.equal(previews.size, 29)
  assert.equal(previewCalls, 29)
  assert.equal(entityReads, 1)
})

test('a mob observed after planning still prevents the actual placement', async () => {
  const f = fixture('shulker'), actors = []
  let planned = false, entityReads = 0
  const controller = createQuarryPortableStorage({ ...f.dependencies, getEntities: () => { entityReads++; return structuredClone(actors) } })
  const result = await controller.storeCarried(f.request, { canPlace: () => true, onCheckpoint: async checkpoint => {
    if (planned) return
    planned = true
    const p = checkpoint.positions[0]
    actors.push({ kind: 'mob', alive: true, positionKnown: true, runtimeId: 'new-mob', position: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 } })
  } })
  assert.equal(result.reason, 'STORAGE_SITE_CHANGED')
  assert.equal(result.checkpoint.siteIssue.cause, 'ENTITY_OCCUPIES_OR_UNOBSERVED')
  assert.ok(entityReads > 1, 'the planning snapshot must not survive an awaited checkpoint')
  assert.equal(f.events.some(event => event.type === 'place'), false)
})

async function runOwnedMining (t, mode, depositWhen = 'four_layers') {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture('shulker'), abort = new AbortController(), owners = createActionOwnerTracker()
  const cancelled = [], stopped = [], captured = [], miningOwners = []
  let controller, target, interrupted = false, stopMiningCalls = 0, inputRunning = false
  names.set(6, 'minecraft:diamond_pickaxe')
  f.bag[1] = item(6, 1, 77)
  f.state.selectedSlot = 0
  const getState = () => {
    const state = f.getState()
    state.inventory.items = state.inventory.items.map(value => value.networkId === 6 ? { ...value, durabilityKnown: true, durabilityRemaining: 1000 } : value)
    return state
  }
  const input = { lookAt () {}, start () { inputRunning = true }, stop () { inputRunning = false }, sendAction () {}, stats: () => ({ running: inputRunning }) }
  const mining = createMining({ getState, world: { getBlock: f.getBlock }, getInput: () => input, verifyOwnedShulker: (...args) => controller.ownsShulker(...args), now: f.dependencies.now })
  const originalStop = mining.stop
  mining.stop = reason => { stopped.push(reason); return originalStop(reason) }
  owners.track(mining, ['start'], { invalidate: ['stop'], isActive: current => current.snapshot().phase === 'mining' })
  t.after(() => mining.stop('test cleanup'))
  const inventory = { equip: async slot => {
    const result = await f.dependencies.equip(slot)
    f.state.heldItem = { name: names.get(f.bag[0].network_id), durabilityKnown: true, durabilityRemaining: 1000 }
    return result
  }, cancel: () => {} }
  owners.track(inventory, ['equip'], { invalidate: ['cancel'] })
  const foreignOwner = owners.createOwner({ operationId: 'external-operation' })
  controller = createQuarryPortableStorage({
    ...f.dependencies,
    getState,
    equip: slot => inventory.equip(slot),
    captureActionOwner: (kind, operation) => { const owner = owners.createOwner({ ...operation, kind }); captured.push(owner); return owner },
    runActionOwned: (owner, work) => owners.run(owner, work),
    mine: async value => {
      target = value
      miningOwners.push(owners.currentOwner())
      const progress = mining.start([target])
      if (mode === 'complete') {
        // Replay the received block/inventory changes through the existing
        // storage fixture after the real mining controller starts.
        await f.dependencies.mine(target)
        t.mock.timers.tick(50)
      }
      return progress
    },
    getMining: () => mining.snapshot(),
    cancelAction: (kind, reason, owner) => {
      cancelled.push({ kind, owner })
      if (kind === 'mining') owners.cancel(mining, owner, () => mining.stop(reason))
      if (kind === 'equip') owners.cancel(inventory, owner, () => inventory.cancel(reason))
    },
    stopMining: (reason, owner) => { stopMiningCalls++; owners.cancel(mining, owner, () => mining.stop(reason)) },
    sleep: async ms => {
      await f.dependencies.sleep(ms)
      if (mode === 'complete' || mode === 'timeout' || interrupted || mining.snapshot().phase !== 'mining') return
      interrupted = true
      if (mode === 'foreign') {
        mining.stop('external operation takes over')
        owners.run(foreignOwner, () => mining.start([target]))
      }
      abort.abort()
    }
  })
  f.controller.ownsShulker = controller.ownsShulker
  const request = { ...f.request, inventoryPolicy: { ...f.request.inventoryPolicy, depositWhen } }
  const result = await controller.storeCarried(request, { signal: abort.signal, canPlace: () => true, onCheckpoint: async () => {} })
  return { result, cancelled, stopped, captured, miningOwners, stopMiningCalls, mining, controller, foreignOwner }
}

for (const depositWhen of ['full', 'four_layers']) test(`${depositWhen} storage abort stops its actual mining controller exactly once`, async t => {
  const f = await runOwnedMining(t, 'abort', depositWhen)
  assert.equal(f.result.reason, 'STORAGE_ABORTED')
  assert.equal(f.miningOwners.length, 1, 'the real mining controller must have started')
  assert.equal(f.stopMiningCalls, 1)
  assert.equal(f.stopped.length, 1)
  assert.equal(f.mining.snapshot().phase, 'stopped')
  assert.equal(f.cancelled.filter(value => value.kind === 'mining').length, 1)
  assert.equal(f.controller.snapshot().busy, false)
})

test('nested equip restores the mining owner and normal recovery still needs received box contents', async t => {
  const f = await runOwnedMining(t, 'complete')
  assert.equal(f.result.status, 'completed', JSON.stringify(f.result))
  assert.equal(f.result.recovered, true)
  assert.equal(f.result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  assert.equal(f.miningOwners.length, 1)
  assert.equal(f.miningOwners[0].context.kind, 'mining')
  assert.equal(f.cancelled.length, 0)
  assert.equal(f.stopMiningCalls, 0)
  assert.equal(f.controller.snapshot().busy, false)
})

test('late four-layer abort cannot cancel a newer external mining owner', async t => {
  const f = await runOwnedMining(t, 'foreign')
  assert.equal(f.result.reason, 'STORAGE_ABORTED')
  assert.equal(f.miningOwners.length, 1)
  assert.equal(f.stopMiningCalls, 1, 'cleanup still uses the captured old mining owner')
  assert.deepEqual(f.stopped, ['external operation takes over'])
  assert.equal(f.mining.snapshot().phase, 'mining')
  assert.ok(f.cancelled.some(value => value.kind === 'mining' && value.owner === f.miningOwners[0]))
  assert.ok(f.cancelled.every(value => value.owner !== f.foreignOwner))
})

test('a failed observed-break wait also stops the still-owned mining controller', async t => {
  const f = await runOwnedMining(t, 'timeout')
  assert.equal(f.result.reason, 'STORAGE_BREAK_TIMEOUT')
  assert.equal(f.miningOwners.length, 1)
  assert.equal(f.stopMiningCalls, 1)
  assert.equal(f.stopped.length, 1)
  assert.equal(f.mining.snapshot().phase, 'stopped')
})
