'use strict'
// Execute the actual private Runtime gates with explicitly bounded controller
// doubles. No Minecraft connection, operator command or user data is involved.
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createSnapshotReader } = require('../src/runtime-observation-views')
const source = fs.readFileSync(path.join(__dirname, '../src/runtime.js'), 'utf8')
function section (name, next) {
  const start = source.indexOf('  function ' + name + ' ('), end = source.indexOf('  function ' + next + ' (', start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}
const idleSource = section('requireIdle', 'inventoryLifeBaseKey')
const stopSource = section('stopActions', 'stopActionsAfterRaw')
const ensureSource = section('ensureLoadoutReset', 'quarryPackingBusy')
function fixture () {
  const b = { busy: false }, op = { snapshot: () => b }
  const behavior = { sleeping: false, claim: { kind: 'combat' } }
  const context = {
    createSnapshotReader,
    chestStatus: () => typeof context.chest.status === 'function' ? context.chest.status() : context.chest.snapshot(),
    userBehaviorSnapshot: () => behavior, userBehaviorLease: { kind: 'combat' }, userBehaviorOwns: () => true,
    userBehaviorSleeping: false, userBehaviorWakePending: false,
    resetHeld: () => false, loadoutLease: null, ownedCall: 0, manualShulkerTask: null, manualArmorOwner: null, manualChestStorage: null,
    chunkMoveHeld: () => false, chunkMoveDepth: 0,
    disposed: false, disposing: false, host: { shared: {} }, working: () => ({}), pendingStops: new Set(),
    quarryJob: null, quarryPillar: null, idleSafety: op, excavation: op, tunneling: op, recovery: op, foraging: op,
    surfaceReturn: op, shelter: op, hut: op, guardRoute: op, motionActive: () => true,
    input: { stats: () => ({ running: true }) }, food: op, furnace: op, chest: op, inventory: op,
    craftStatus: () => ({}), interactions: { snapshot: () => ({}) }, combat: { snapshot: () => ({ busy: true, engaging: true }) } }
  vm.createContext(context); vm.runInContext(idleSource, context)
  return { context, behavior, call: options => context.requireIdle(options) }
}
test('loadout-handoff: only private debug admission allows active combat; ordinary operations stay blocked', () => {
  const f = fixture()
  assert.throws(() => f.call(), /戦闘|前の操作/)
  assert.doesNotThrow(() => f.call({ loadoutHandoff: true }))
  f.behavior.sleeping = true
  assert.throws(() => f.call({ loadoutHandoff: true }), /戦闘・睡眠/)
})
test('loadout-handoff: debug admission does not bypass inventory, active quarry or pending cleanup', () => {
  for (const blocker of ['inventory', 'quarry', 'pending', 'uncertain', 'chunkMove']) {
    const f = fixture(), c = f.context
    if (blocker === 'inventory') c.inventory = { snapshot: () => ({ busy: true }) }
    if (blocker === 'quarry') c.quarryJob = { holdsWork: () => true }
    if (blocker === 'pending') c.pendingStops.add('previous')
    if (blocker === 'uncertain') c.host.shared.inventoryUncertain = true
    if (blocker === 'chunkMove') c.chunkMoveHeld = () => true
    assert.throws(() => f.call({ loadoutHandoff: true }), undefined, blocker)
  }
})
test('loadout-handoff: exact lease identity is required for post-drain validation', () => {
  const f = fixture(), c = f.context
  c.resetHeld = () => true; c.loadoutLease = 'owned-reset'
  c.userBehaviorOwns = () => false; c.combat = { snapshot: () => ({}) }; c.motionActive = () => false; c.input = null
  assert.throws(() => f.call(), { code: 'RESET_BUSY' })
  assert.throws(() => f.call({ loadoutOwner: 'other' }), { code: 'RESET_BUSY' })
  assert.doesNotThrow(() => f.call({ loadoutOwner: 'owned-reset' }))
})
test('loadout-handoff: nonfatal damage does not cancel reset transfers; death and manual stop do', async () => {
  let held = true, cancelled = 0, stopped = 0
  const state = { phase: 'spawned', health: 18 }
  const c = { resetHeld: () => held, raw: () => state, disposed: false, disposing: false,
    loadoutReset: { cancel: () => cancelled++ }, stopActionsAfterRaw: () => { stopped++; return Promise.resolve([]) } }
  vm.createContext(c); vm.runInContext(stopSource, c)
  await c.stopActions('ダメージを検知しました。')
  assert.equal(cancelled, 0); assert.equal(stopped, 0)
  await c.stopActions('manual_stop')
  assert.equal(cancelled, 1); assert.equal(stopped, 1)
  state.health = 0
  await c.stopActions('ダメージを検知しました。')
  assert.equal(cancelled, 2); assert.equal(stopped, 2)
  held = false; state.health = 18
  await c.stopActions('ダメージを検知しました。')
  assert.equal(stopped, 3, 'ordinary damage still stops ordinary work')
})
test('loadout-handoff: confirmation fences combat before draining and validates idle after it finishes', async () => {
  const events = [], validations = []; let options, resolveDrain
  const drain = new Promise(resolve => { resolveDrain = resolve })
  const c = { loadoutReset: null, loadoutLease: null, host: { shared: { loadingScreenEnded: true } }, quarryState: () => ({}),
    inventoryInspection: {}, crafting: {}, armor: {}, inventory: {}, chest: {}, ensureQuarryJob: () => null,
    createRuntimeV22ChestReset: o => { options = o; return {} },
    resetHeld: () => c.loadoutLease !== null, requireIdle: o => validations.push(o),
    autonomy: { stop: () => events.push('autonomy_stop') }, stopIdleStream: () => events.push('stream_stop'),
    stopActionsAfterRaw: reason => { assert.equal(reason, 'loadout_reset'); assert.equal(c.loadoutLease, 'reset-1'); events.push('drain'); return drain },
    resumeSafety: () => events.push('release') }
  vm.createContext(c); vm.runInContext(ensureSource, c); c.ensureLoadoutReset()
  let done = false
  const pending = options.acquire('reset-1').then(() => { done = true })
  assert.equal(c.loadoutLease, 'reset-1'); await Promise.resolve(); await Promise.resolve()
  assert.equal(done, false); assert.equal(validations.length, 1); assert.equal(validations[0].loadoutHandoff, true)
  resolveDrain(); await pending
  assert.equal(validations.length, 2); assert.equal(validations[1].loadoutOwner, 'reset-1')
  assert.deepEqual(events, ['autonomy_stop', 'stream_stop', 'drain'])
  options.release('reset-1'); assert.equal(c.loadoutLease, null)
})
