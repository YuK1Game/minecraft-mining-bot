'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: afterAbort } = require('node:timers/promises')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { canonicalWindowId, sameWindowId } = require('../src/container-types')

const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=fixture\n', file)

// Replay a real portable controller paused immediately before the requested
// kind of work. The fake native task deliberately remains pending after the
// combat owner takes over, as can happen between movement polling ticks.
async function pausedNativeAction (kind) {
  const f = loaded.exports('shulker'), prepare = new AbortController()
  let cp
  await f.run({ signal: prepare.signal, onCheckpoint: async value => {
    if (!cp && value.stage === (kind === 'mining' ? 'breaking' : 'planned')) { cp = structuredClone(value); prepare.abort() }
  } })
  if (kind === 'movement') f.state.position.x += 2
  assert.ok(cp)
  const control = new AbortController()
  let entered, release, owner = { name: 'quarry' }, drained = false
  const started = new Promise(resolve => { entered = resolve })
  const retiring = new Promise(resolve => { release = resolve })
  const original = owner, captures = [], cancellation = [], stopped = []
  const hang = async () => { entered(); await retiring; drained = true; throw Error('old native action drained') }
  function cancel (channel, observed) {
    cancellation.push([channel, observed])
    if (observed === owner) stopped.push(channel)
  }
  const controller = createQuarryPortableStorage({
    ...f.dependencies,
    moveTo: kind === 'movement' ? hang : f.dependencies.moveTo,
    mine: kind === 'mining' ? hang : f.dependencies.mine,
    captureActionOwner: action => { captures.push([action, owner]); return owner },
    runActionOwned: (captured, work) => { assert.strictEqual(captured, owner); return work() },
    cancelAction: (action, _reason, observed) => cancel(action, observed),
    stopMining: (_reason, observed) => cancel('stopMining', observed)
  })
  f.controller.ownsShulker = controller.ownsShulker
  const pending = controller.storeCarried({ ...f.request, checkpoint: cp }, { canPlace: () => true, signal: control.signal, onCheckpoint: async () => {} })
  await started
  return { control, pending, release, original, captures, cancellation, stopped, isDrained: () => drained,
    enterCombat: () => { owner = { name: 'combat' } } }
}

for (const kind of ['movement', 'mining']) {
  test(`late abort of retired portable ${kind} cannot select the new owner's task`, async () => {
    const f = await pausedNativeAction(kind)
    try {
      f.enterCombat(); f.control.abort()
      await afterAbort()
      assert.equal(f.isDrained(), false)
      assert.ok(f.captures.some(([name, token]) => name === kind && token === f.original))
      assert.ok(f.cancellation.length >= 1)
      assert.ok(f.cancellation.every(([, token]) => token === f.original))
      assert.deepEqual(f.stopped, [])
    } finally { f.release(); await f.pending }
  })

  test(`an explicit abort of the still-owned portable ${kind} cancels its own task`, async () => {
    const f = await pausedNativeAction(kind)
    try {
      f.control.abort()
      await afterAbort()
      assert.ok(f.stopped.includes(kind) || (kind === 'mining' && f.stopped.includes('stopMining')))
      assert.deepEqual(new Set(f.stopped).size, f.stopped.length, 'each cleanup channel fires at most once')
      assert.ok(f.cancellation.every(([, token]) => token === f.original))
    } finally { f.release(); await f.pending }
  })
}

const { createActionOwnerTracker } = require('../src/action-owner-tracker')
const movementFile = require.resolve('./movement.test')
const movementSetup = new Module(movementFile, module)
movementSetup.filename = movementFile
movementSetup.paths = Module._nodeModulePaths(path.dirname(movementFile))
movementSetup._compile(fs.readFileSync(movementFile, 'utf8').split('\ntest(')[0] + '\nmodule.exports=fixture\n', movementFile)

test('a reused native movement controller keeps a newer unowned combat run when quarry cancellation arrives', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement } = movementSetup.exports()
  const tracker = createActionOwnerTracker()
  tracker.track(movement, ['start'], { invalidate: ['stop', 'resetLifecycle'] })
  t.after(() => movement.stop())
  const owner = tracker.createOwner({ name: 'portable-test' })
  const target = { x: 2.5, y: 65, z: 0.5 }
  await tracker.run(owner, async () => {
    await afterAbort()
    movement.start(target)
  })
  movement.stop('combat preemption')
  movement.start(target)
  let cancellations = 0
  assert.equal(tracker.cancel(movement, owner, () => { cancellations++; movement.stop() }), false)
  assert.equal(cancellations, 0)
  assert.deepEqual(movement.snapshot().target, target)
})

test('native hop and settle starts participate in the same cancellation fence', async t => {
  for (const method of ['startHop', 'settle']) await t.test(method, ctx => {
    ctx.mock.timers.enable({ apis: ['setInterval'] })
    const { movement, state } = movementSetup.exports()
    const tracker = createActionOwnerTracker()
    tracker.track(movement, ['start', 'startHop', 'settle'], {
      invalidate: ['stop', 'resetLifecycle'], isActive: c => ['moving', 'settling'].includes(c.snapshot().phase)
    })
    ctx.after(() => movement.stop())
    const owner = tracker.createOwner({ name: 'quarry' })
    if (method === 'settle') {
      state.position = { x: 0.5, y: 67.098686, z: 0.5 }
      state.positionSource = 'correct_player_move_prediction'
    }
    const start = () => method === 'settle' ? movement.settle({ maxDrop: 1 }) : movement.startHop()
    tracker.run(owner, start)
    assert.equal(tracker.cancel(movement, owner, () => movement.stop('first owned action')), true)
    start()
    assert.equal(tracker.cancel(movement, owner, () => movement.stop('late old action')), false)
    assert.equal(movement.snapshot().running, true)
  })
})

test('a rejected competing start cannot steal the active native run; its real owner may explicitly cancel once', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { movement } = movementSetup.exports()
  const tracker = createActionOwnerTracker()
  tracker.track(movement, ['start'], { invalidate: ['stop'] })
  t.after(() => movement.stop())
  const current = tracker.createOwner({ name: 'first' }), other = tracker.createOwner({ name: 'second' })
  tracker.run(current, () => movement.start({ x: 1.5, y: 65, z: 0.5 }))
  assert.throws(() => tracker.run(other, () => movement.start({ x: 1000, y: 65, z: 0.5 })))
  let count = 0
  const stop = () => { count++; movement.stop('explicit portable stop') }
  assert.equal(tracker.cancel(movement, other, stop), false)
  assert.equal(tracker.cancel(movement, current, stop), true)
  assert.equal(tracker.cancel(movement, current, stop), false)
  assert.equal(count, 1)
  assert.equal(movement.snapshot().phase, 'stopped')
})

test('losing the connection generation or control lease vetoes cancellation even before an intervening start', () => {
  const state = { generation: 1, lease: 'quarry' }
  const tracker = createActionOwnerTracker({ isCurrent: owner => owner.context.generation === state.generation && owner.context.lease === state.lease })
  const native = { start () {}, stop () {} }
  tracker.track(native, ['start'], { invalidate: ['stop'] })
  let calls = 0
  for (const changed of ['generation', 'lease']) {
    const owner = tracker.createOwner({ ...state })
    tracker.run(owner, () => native.start())
    if (changed === 'generation') state.generation++
    else state.lease = 'combat'
    assert.equal(tracker.cancel(native, owner, () => { calls++ }), false)
  }
  assert.equal(calls, 0)
})

const runtimeSource = fs.readFileSync(require.resolve('../src/runtime'), 'utf8').replace(/\r\n/g, '\n')
function sliceHook (start, end) {
  const at = runtimeSource.indexOf(start), until = runtimeSource.indexOf(end, at + start.length)
  assert.ok(at >= 0 && until > at, 'production runtime hook must be present')
  return runtimeSource.slice(at, until)
}
// Evaluate the production ports with isolated controller instances. Keeping
// the open and cancel closures together is essential: they share the proof.
function windowHooks ({ metadata = false } = {}) {
  const context = { generation: {}, revision: 1, scope: 'life-0', jobId: 'job', operationId: 'job:storage:42' }
  const owners = createActionOwnerTracker({ isCurrent: o => o.context.revision === context.revision && o.context.generation === context.generation && o.context.scope === context.scope })
  let window = null, open = null, closeCount = 0, resolveOpen
  const position = { x: 1, y: 64, z: 2 }
  const chest = { open: () => new Promise(resolve => { resolveOpen = resolve }), cancel () {}, rawItem () {}, snapshot: () => ({ busy: false, window }) }
  const interactions = { openWorkbench () {}, openChest () {}, cancel () {}, snapshot: () => ({ pendingOperation: null }) }
  const crafting = { closeContainer () { if (open) closeCount++; open = null }, snapshot: () => ({ openContainer: open }) }
  const metadataReads = { chest: 0, crafting: 0 }
  if (metadata) {
    chest.status = () => { metadataReads.chest++; return { busy: false, window } }
    crafting.status = () => { metadataReads.crafting++; return { openContainer: open } }
  }
  const chestStatus = () => typeof chest.status === 'function' ? chest.status() : chest.snapshot()
  const craftStatus = () => typeof crafting.status === 'function' ? crafting.status() : crafting.snapshot()
  const track = runtimeSource.split(/\r?\n/).filter(l => /^  portableActionOwners\.track\((chest|interactions),/.test(l)).join('\n')
  const container = sliceHook('    let portableOwnedWindow = null', '    function getSupplies')
  const cleanup = sliceHook('        cancelAction: (kind, reason, owner)', '\n        }\n') + '\n        }'
  const hook = Function('portableActionOwners','chest','interactions','crafting','own','requireIdle','canonicalWindowId','sameWindowId','chestStatus','craftStatus',
    track + '\n' + container + '\nreturn {open:containerPorts.open,' + cleanup + '}')(owners, chest, interactions, crafting, fn => fn, () => {}, canonicalWindowId, sameWindowId, chestStatus, craftStatus)
  function setWindow (id = 16, type = 'container', epoch = 1, craftId = id, block = position) {
    window = { id, epoch, position: { ...block } }; open = { id: craftId, type, coordinates: { ...block } }
  }
  const openOwner = owners.createOwner({ ...context })
  return { context, owners, hook, chest, interactions, setWindow, openOwner, position, metadataReads,
    begin: () => owners.run(openOwner, () => hook.open(position, 0, { expectedSlots: 27 })),
    receive: (confirmed = true, windowId = 16) => resolveOpen({ windowId, serverConfirmed: confirmed }),
    cancel: owner => hook.cancelAction('chest', 'late storage abort', owner ?? owners.createOwner({ ...context })),
    closes: () => closeCount }
}

test('portable window cancellation uses the metadata APIs when available', async () => {
  const f = windowHooks({ metadata: true }), pending = f.begin()
  f.setWindow(); f.receive(); await pending
  f.cancel()
  assert.equal(f.closes(), 1)
  assert.ok(f.metadataReads.chest > 0)
  assert.ok(f.metadataReads.crafting > 0)
})

test('only a positively received portable window for the same operation may be closed by its later cancellation', async t => {
  for (const mode of ['normal', 'prior_controller_cancel', 'other_workbench', 'reused_id', 'generation', 'revision', 'life', 'other_op', 'unconfirmed', 'replaced_during_open']) await t.test(mode, async () => {
    const f = windowHooks()
    const pending = f.begin()
    f.setWindow()
    if (mode === 'replaced_during_open') {
      f.interactions.openWorkbench(); f.setWindow(16, 'workbench', 2)
    }
    f.receive(mode !== 'unconfirmed'); await pending
    if (mode === 'other_workbench') { f.interactions.openWorkbench(); f.setWindow(17, 'workbench', 2) }
    if (mode === 'reused_id') { f.interactions.openChest(); f.setWindow(16, 'container', 2) }
    if (mode === 'prior_controller_cancel') f.chest.cancel()
    const owner = f.owners.createOwner({ ...f.context, ...(mode === 'other_op' ? { operationId: 'other:42' } : {}) })
    if (mode === 'generation') f.context.generation = {}
    if (mode === 'revision') f.context.revision++
    if (mode === 'life') f.context.scope = 'life-1'
    f.cancel(owner); f.cancel(owner)
    assert.equal(f.closes(), ['normal', 'prior_controller_cancel'].includes(mode) ? 1 : 0)
  })
})

test('matching 1/first aliases close only with the same received position, current epoch and operation owner', async t => {
  for (const mode of ['same', 'foreign_position', 'later_epoch', 'foreign_owner']) await t.test(mode, async () => {
    const f = windowHooks()
    const pending = f.begin()
    f.setWindow(1, 'container', 289, 'first', mode === 'foreign_position' ? { ...f.position, x: 8 } : f.position)
    f.receive(true, 1); await pending
    if (mode === 'later_epoch') f.setWindow(1, 'container', 290, 'first')
    const owner = f.owners.createOwner({ ...f.context, operationId: mode === 'foreign_owner' ? 'other:114' : f.context.operationId })
    f.cancel(owner); f.cancel(owner)
    assert.equal(f.closes(), mode === 'same' ? 1 : 0)
  })
})

test('a later native access-clearance start retires the preceding quarry mining cancellation owner', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const file = require.resolve('./mining-stone-access-clearance.test'), loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
  loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=fixture\n', file)
  const f = loaded.exports()
  const tracker = createActionOwnerTracker(), owner = tracker.createOwner({ op: 'quarry' })
  const line = runtimeSource.split(/\r?\n/).find(s => /^  portableActionOwners\.track\(mining,/.test(s))
  Function('portableActionOwners','mining',line)(tracker, f.mining)
  t.after(() => f.mining.stop())
  f.set(f.target, 'minecraft:dirt', 9)
  tracker.run(owner, () => f.mining.start([f.target]))
  f.mining.stop('preempt')
  f.set(f.target, 'minecraft:stone', 222)
  const clearanceOwner = tracker.createOwner({ op: 'clearance' })
  tracker.run(clearanceOwner, () => f.mining.startAccessClearance(f.options))
  assert.equal(tracker.cancel(f.mining, owner, () => f.mining.stop('old quarry cleanup')), false)
  assert.equal(f.mining.snapshot().phase, 'mining')
  assert.equal(f.mining.snapshot().operation, 'access_clearance')
  assert.equal(tracker.cancel(f.mining, clearanceOwner, () => f.mining.stop('clearance owner cleanup')), true)
})
