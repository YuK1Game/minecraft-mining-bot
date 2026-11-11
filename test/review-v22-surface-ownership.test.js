'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const filename = require.resolve('./runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { scene }\n', filename)
const { scene } = loaded.exports

function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture (t) {
  const gate = deferred(), reached = deferred(), calls = []
  let adapter, surfacePorts, held = false, autoReady = false, armorCalls = 0, preemptions = 0
  const chest = { applyPacket () {}, cancel () {}, depositDiamond () {}, snapshot: () => ({ busy: false }), rawItem: () => null,
    open: async () => { calls.push('open'); return { serverConfirmed: true, slotCount: 54 } },
    withdrawItem: async () => { calls.push('withdraw'); return { serverConfirmed: true } },
    depositItem: async () => { calls.push('deposit'); return { serverConfirmed: true } } }
  const transfer = direction => async (request, options) => {
    assert.equal(surfacePorts.getState().phase, 'spawned')
    await surfacePorts.open({ x: 0, y: 65, z: 0 }, undefined, { expectedSlots: 54 })
    await surfacePorts[direction === 'withdraw' ? 'withdraw' : 'deposit']({ count: 1, signal: options.signal })
    surfacePorts.close()
    await surfacePorts.resync(options)
    surfacePorts.getState()
    await surfacePorts.equipArmor({ maxMoves: 4 })
    return { status: 'completed', serverConfirmed: true }
  }
  const f = scene(t, { runtimeOverrides: {
    './chest': { createChest: () => chest },
    './armor': { createArmor: () => ({ preview: () => autoReady, equipBest: async () => { armorCalls++; return [] }, preemptForCombat: () => { preemptions++ }, applyPacket () {}, snapshot: () => ({ busy: false }) }) },
    './quarry-v22-chest-work': { createQuarryV22ChestWork: ports => { surfacePorts = ports; return { withdrawAll: transfer('withdraw'), depositAll: transfer('deposit') } } },
    './quarry-runtime-adapter': { createQuarryRuntimeAdapter: ports => {
      adapter = { ...createQuarryRuntimeAdapter(ports), resyncInventory: async ({ signal }) => {
        calls.push('resync'); reached.resolve()
        if (signal) signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true })
        await gate.promise
        return true
      } }
      return adapter
    } },
    './quarry-job': { createQuarryJob: () => ({ holdsWork: () => held, document: () => null, status: () => ({ state: held ? 'PREFLIGHT' : 'PAUSED' }),
      resume: async () => { held = true; try { return await adapter.loadoutWithdraw({}, { signal: f.signal.signal }) } finally { held = false } },
      storeCarriedNow: async () => { held = true; try { return await adapter.finalChestDeposit({}, { signal: f.signal.signal }) } finally { held = false } },
      pause: async () => { held = false }
    }) }
  } })
  f.signal = new AbortController()
  return { ...f, gate, reached, calls, chest, get ports () { return surfacePorts }, get adapter () { return adapter },
    armorCalls: () => armorCalls, preemptions: () => preemptions,
    tickArmor: async () => { autoReady = true; f.shared.autoWanted = true; f.shared.armorCheckedAt = 0; f.runtime.resumeRequested(); f.advance(50); await turn() } }
}

for (const method of ['resume', 'storeCarried']) {
  test(`v2.2 surface ${method} owns the resync gap, allows its explicit armor, and restores automatic work and reload`, async t => {
    const f = fixture(t), pending = f.runtime.operations.quarry[method]()
    await f.reached.promise
    assert.deepEqual(f.calls, ['open', method === 'resume' ? 'withdraw' : 'deposit', 'resync'], 'ordinary internal ports pass requireIdle without self-blocking')
    assert.equal(f.runtime.canReload(), false, 'the entire surface operation remains owned even with no active chest request')
    await f.tickArmor()
    assert.equal(f.armorCalls(), 0, 'automatic armor cannot consume a newly received transfer during resync')
    const worn = { network_id: 401, count: 1 }, offhand = { network_id: 402, count: 1 }
    f.runtime.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: worn })
    f.runtime.applyPacket('inventory_slot', { window_id: 'offhand', slot: 0, item: offhand })
    assert.deepEqual(f.ports.getRawEquipment('armor', 0), worn)
    assert.deepEqual(f.ports.getRawEquipment('offhand', 0), offhand)
    f.runtime.applyPacket('item_stack_response', { responses: [{ status: 'ok', containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: 0, count: 1, item_stack_id: 99 }] }] }] })
    assert.equal(f.ports.getRawEquipment('armor', 0), null, 'surface recovery never adopts a reconstructed worn ACK')
    f.gate.resolve()
    assert.equal((await pending).serverConfirmed, true)
    assert.equal(f.armorCalls(), 1, 'the controller can still equip armor explicitly while it owns the transfer')
    assert.equal(f.shared.quarrySurfaceStorageOwner, undefined)
    assert.equal(f.runtime.canReload(), true)
    await f.tickArmor()
    assert.equal(f.armorCalls(), 2, 'automatic armor resumes after the owner has drained')
  })
}

test('v2.2 surface ownership never delays combat priority and rejects the preempted continuation', async t => {
  const f = fixture(t), pending = f.runtime.operations.quarry.resume()
  void pending.catch(() => {})
  await f.reached.promise
  const context = { kind: 'combat', claimId: 'surface-preempt', scope: f.scope() }
  const token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(token.acquired, false)
  assert.equal(f.preemptions(), 1)
  assert.ok(f.shared.quarrySurfaceStorageOwner, 'preemption does not release the receipt observer before it drains')
  f.gate.resolve()
  await assert.rejects(pending, error => error.code === 'SURFACE_STORAGE_INTERRUPTED')
  assert.equal(f.armorCalls(), 0)
  assert.equal(f.shared.quarrySurfaceStorageOwner, undefined)
  await f.facadeOptions.resumeControl({ ...context, token })
})

test('v2.2 surface cancellation, scope change and failure release only the completed operation token', async t => {
  for (const mode of ['abort', 'scope', 'failure', 'replacement']) await t.test(mode, async t => {
    const f = fixture(t), pending = f.runtime.operations.quarry.resume()
    void pending.catch(() => {})
    await f.reached.promise
    const replacement = { scope: 'new-owner' }
    if (mode === 'abort') f.signal.abort(new Error('cancelled'))
    else if (mode === 'scope') { f.raw.connectionId = 'other-connection'; f.gate.resolve() }
    else if (mode === 'failure') f.gate.reject(new Error('received inventory unavailable'))
    else { f.shared.quarrySurfaceStorageOwner = replacement; f.gate.reject(new Error('old operation stopped')) }
    await assert.rejects(pending)
    assert.equal(f.armorCalls(), 0)
    if (mode === 'replacement') {
      assert.strictEqual(f.shared.quarrySurfaceStorageOwner, replacement, 'old finally cannot release another operation')
      delete f.shared.quarrySurfaceStorageOwner
    } else assert.equal(f.shared.quarrySurfaceStorageOwner, undefined)
    assert.equal(f.runtime.canReload(), true)
  })
})
