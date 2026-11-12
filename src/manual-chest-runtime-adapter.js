'use strict'

const path = require('node:path')
const { createHash } = require('node:crypto')
const { serialize } = require('node:v8')
const { observedScope } = require('./server-position-verifier')
const { createManualChestDeposit } = require('./manual-chest-deposit')
const { createQuarryV22ChestWork } = require('./quarry-v22-chest-work')
const { createQuarryV22Equipment } = require('./quarry-v22-equipment')
const { writeDurableJson, readJsonBounded } = require('./durable-json')

const fail = code => Object.assign(new Error(code), { code })
const clone = value => structuredClone(value)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const valid = item => item && Number.isInteger(item.network_id) && Number.isInteger(item.count) &&
  (item.network_id === 0 ? item.count === 0 : item.count > 0 && item.count <= 255 && item.has_stack_id === true && Number.isSafeInteger(item.stack_id) && item.stack_id > 0)
const samePoint = (a, b) => a && b && ['x', 'y', 'z'].every(axis => a[axis] === b[axis])
const sameWindow = (a, b) => a && b && String(a.id) === String(b.id) && String(a.type) === String(b.type)

function createManualChestRuntime ({ host, getState, getView, getRawMain, getRawEquipment, crafting, chest,
  generation, jobIdentity, assertIdle, onAcquire, onRelease, refreshInventory, allocateRequestId,
  commitMain, commitEquipment, onUncertain, journalDirectory = path.resolve(__dirname, '..', '.local', 'manual-chest-deposit'), closeTimeoutMs = 5000 }) {
  if ([getState, getView, getRawMain, getRawEquipment, generation, jobIdentity, assertIdle, onAcquire, onRelease,
    refreshInventory, allocateRequestId, commitMain, commitEquipment, onUncertain].some(fn => typeof fn !== 'function') ||
    typeof host?.client?.queue !== 'function' || typeof host?.world?.getBlock !== 'function' ||
    ['status', 'openInventory', 'closeContainer'].some(method => typeof crafting?.[method] !== 'function') ||
    ['open', 'depositItem', 'snapshot', 'rawItem'].some(method => typeof chest?.[method] !== 'function')) throw new TypeError('Manual chest storage requires observed runtime ports')
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0 || closeTimeoutMs > 30000) throw new TypeError('Manual chest close timeout must be bounded')
  let lease = null, journalOwner = null, windowEpoch = 0
  const closeState = host.shared ??= {}
  const currentWindow = () => crafting.status().openContainer
  const fingerprintJob = () => serialize(jobIdentity()).toString('base64')
  const currentClose = () => {
    const barrier = closeState.manualChestCloseBarrier
    return barrier?.scope === observedScope(getState()) ? barrier : null
  }
  function settleClose (barrier, error) {
    if (!barrier || !barrier.pending) return
    barrier.pending = false
    clearTimeout(barrier.timer); clearInterval(barrier.poll)
    if (error) { barrier.error = error.code ?? 'MANUAL_DEPOSIT_CLOSE_FAILED'; barrier.reject(fail(barrier.error)) }
    else { barrier.acknowledged = true; barrier.resolve() }
  }
  function sendOwnedClose (owner, window) {
    verify(owner)
    if (!window || !sameWindow(currentWindow(), window)) throw fail('MANUAL_DEPOSIT_FOREIGN_WINDOW')
    const prior = currentClose()
    if (prior && !prior.acknowledged) throw fail(prior.error ?? 'MANUAL_DEPOSIT_CLOSE_PENDING')
    const obsolete = closeState.manualChestCloseBarrier
    if (obsolete?.pending) settleClose(obsolete, fail('MANUAL_DEPOSIT_CONTEXT_CHANGED'))
    const barrier = { scope: owner.scope, generation: owner.generation, job: owner.job, window: clone(window), pending: true, acknowledged: false, error: null }
    barrier.promise = new Promise((resolve, reject) => { barrier.resolve = resolve; barrier.reject = reject })
    void barrier.promise.catch(() => {})
    closeState.manualChestCloseBarrier = barrier
    barrier.timer = setTimeout(() => settleClose(barrier, fail('MANUAL_DEPOSIT_CLOSE_TIMEOUT')), closeTimeoutMs)
    barrier.poll = setInterval(() => {
      try { if (observedScope(getState()) !== barrier.scope) settleClose(barrier, fail('MANUAL_DEPOSIT_CONTEXT_CHANGED')) } catch { settleClose(barrier, fail('MANUAL_DEPOSIT_CONTEXT_CHANGED')) }
    }, 50)
    try { crafting.closeContainer() } catch (error) { settleClose(barrier, fail('MANUAL_DEPOSIT_CLOSE_FAILED')); throw error }
  }
  async function waitForClose (owner, signal) {
    verify(owner); signal?.throwIfAborted()
    const barrier = currentClose()
    if (!barrier || barrier.acknowledged) return
    if (barrier.error) throw fail(barrier.error)
    const abort = AbortSignal.any([owner.abort.signal, ...(owner.signal ? [owner.signal] : []), ...(signal ? [signal] : [])])
    abort.throwIfAborted()
    await new Promise((resolve, reject) => {
      const onAbort = () => { abort.removeEventListener('abort', onAbort); reject(fail('MANUAL_DEPOSIT_INTERRUPTED')) }
      abort.addEventListener('abort', onAbort, { once: true })
      barrier.promise.then(() => { abort.removeEventListener('abort', onAbort); resolve() }, error => { abort.removeEventListener('abort', onAbort); reject(error) })
    })
    verify(owner); signal?.throwIfAborted()
    if (!barrier.acknowledged || currentWindow()) throw fail('MANUAL_DEPOSIT_FOREIGN_WINDOW')
  }
  const actualView = () => {
    const view = clone(getView())
    for (const [kind, size] of [['armor', 4], ['offhand', 1]]) {
      const slots = Array.from({ length: size }, (_, slot) => {
        const raw = getRawEquipment(kind, slot)
        if (!valid(raw)) return { slot, known: false, empty: false, name: null, count: null }
        const empty = raw.network_id === 0
        const name = empty ? null : crafting.itemNameOf?.(raw.network_id)
        return { ...(view[kind]?.slots?.[slot] ?? {}), slot, known: empty || typeof name === 'string', empty, name, count: raw.count }
      })
      view[kind] = { known: slots.every(slot => slot.known), slots }
    }
    return view
  }
  function inventoryIdentity () {
    const view = actualView(), state = getState()
    if (state.inventory?.known !== true || state.inventory.uncertain || view.known !== true || view.uncertain ||
      !Array.isArray(view.slots) || view.slots.length !== 36 || view.slots.some(slot => slot?.known !== true) ||
      view.armor?.known !== true || view.offhand?.known !== true) throw fail('MANUAL_DEPOSIT_INVENTORY_UNKNOWN')
    const main = Array.from({ length: 36 }, (_, slot) => getRawMain(slot))
    const armor = Array.from({ length: 4 }, (_, slot) => getRawEquipment('armor', slot))
    const offhand = getRawEquipment('offhand', 0)
    if (![...main, ...armor, offhand].every(valid)) throw fail('MANUAL_DEPOSIT_INVENTORY_UNKNOWN')
    return createHash('sha256').update(serialize({ main, armor, offhand })).digest('hex')
  }
  function verify (owner = lease) {
    if (!owner || lease !== owner || owner.revoked || owner.signal?.aborted || owner.abort.signal.aborted) throw fail('MANUAL_DEPOSIT_INTERRUPTED')
    if (observedScope(getState()) !== owner.scope || generation() !== owner.generation || fingerprintJob() !== owner.job) throw fail('MANUAL_DEPOSIT_CONTEXT_CHANGED')
    return owner
  }
  function beforeMutation (chestRequired = false) {
    const owner = verify()
    if (owner.preview) throw fail('MANUAL_DEPOSIT_PREVIEW_READ_ONLY')
    assertIdle()
    if (chestRequired && (!owner.window || owner.window.epoch !== windowEpoch || !sameWindow(currentWindow(), owner.window) || chest.snapshot().contentsKnown !== true || chest.snapshot().slotCount !== 54)) throw fail('MANUAL_DEPOSIT_FOREIGN_WINDOW')
    if (chestRequired && owner.requireEmpty && !owner.depositStarted && !Array.from({ length: 54 }, (_, slot) => chest.rawItem(slot)).every(raw => valid(raw) && raw.network_id === 0)) throw fail('MANUAL_DEPOSIT_CHEST_NOT_EMPTY')
    if (!owner.mutable && inventoryIdentity() !== owner.identity) throw fail('MANUAL_DEPOSIT_PREVIEW_STALE')
    owner.mutable = true
    return owner
  }
  const equipmentCrafting = { status: () => crafting.status(),
    openInventory: async () => {
      const owner = verify()
      if (owner.preview) throw fail('MANUAL_DEPOSIT_PREVIEW_READ_ONLY')
      await waitForClose(owner)
      verify(owner)
      if (currentWindow()) throw fail('MANUAL_DEPOSIT_FOREIGN_WINDOW')
      return crafting.openInventory()
    },
    closeContainer: () => { try { const owner = verify(), window = currentWindow(); if (window) sendOwnedClose(owner, window) } catch {} }
  }
  const equipment = createQuarryV22Equipment({ client: { queue: (name, packet) => {
    if (name !== 'item_stack_request') throw fail('MANUAL_DEPOSIT_PACKET_FORBIDDEN')
    beforeMutation(); return host.client.queue(name, packet)
  } }, crafting: equipmentCrafting, getState, getView, getRawMain, getRawEquipment, allocateRequestId, commitMain, commitEquipment, onUncertain })
  const pendingMutation = () => equipment.status().stage === 'awaiting_response' && equipment.status().busy || !!lease?.chestMutation
  function closeOwned (owner = lease) {
    if (!owner || lease !== owner || owner.revoked || owner.signal?.aborted || owner.abort.signal.aborted ||
      observedScope(getState()) !== owner.scope || generation() !== owner.generation || fingerprintJob() !== owner.job || !owner.window || owner.window.epoch !== windowEpoch ||
      !sameWindow(currentWindow(), owner.window) || chest.snapshot().pendingRequestId != null || crafting.status().pendingRequestId != null || equipment.status().busy) return
    sendOwnedClose(owner, owner.window); owner.window = null
  }
  function revoke (owner, reason) {
    if (!owner || lease !== owner) return
    owner.revoked = true; owner.abort.abort(fail(reason || 'MANUAL_DEPOSIT_INTERRUPTED'))
    if (equipment.status().busy && equipment.status().stage !== 'awaiting_response') {
      equipment.cancel(reason)
      if (!currentWindow()) crafting.cancel?.(reason)
    }
    if (owner.opening && chest.snapshot().pendingRequestId == null) chest.cancel?.(reason)
  }
  async function acquire (id, options = {}) {
    if (lease || equipment.status().busy) throw fail('MANUAL_DEPOSIT_BUSY')
    if (!UUID.test(id ?? '') || !options.scope || options.scope !== observedScope(getState())) throw fail('MANUAL_DEPOSIT_CONTEXT_CHANGED')
    options.signal?.throwIfAborted()
    assertIdle()
    const owner = { id, ...options, generation: generation(), job: fingerprintJob(), mutable: false, revoked: false, abort: new AbortController(), window: null, opening: false }
    lease = owner
    owner.onAbort = () => revoke(owner, 'MANUAL_DEPOSIT_INTERRUPTED')
    owner.signal?.addEventListener('abort', owner.onAbort, { once: true })
    try {
      await onAcquire({ id, operationId: id, scope: owner.scope, signal: owner.signal, preview: owner.preview, identity: owner.identity })
      journalOwner = { id, scope: owner.scope }
      verify(owner)
      let identity
      try { identity = inventoryIdentity() } catch (error) {
        if (!owner.preview || error.code !== 'MANUAL_DEPOSIT_INVENTORY_UNKNOWN') throw error
        if (await refreshInventory({ signal: AbortSignal.any([owner.abort.signal, ...(owner.signal ? [owner.signal] : [])]) }) !== true) throw fail('MANUAL_DEPOSIT_INVENTORY_UNKNOWN')
        verify(owner)
        identity = inventoryIdentity()
      }
      verify(owner)
      if (!owner.preview && identity !== owner.identity) throw fail('MANUAL_DEPOSIT_PREVIEW_STALE')
      owner.identity = identity
    } catch (error) { await release(id); throw error }
  }
  async function release (id) {
    const owner = lease
    if (!owner || owner.id !== id || pendingMutation()) return
    try { closeOwned(owner) } finally {
      owner.signal?.removeEventListener('abort', owner.onAbort)
      if (lease === owner) { lease = null; await onRelease(id) }
    }
  }
  async function open (position, { signal, expectedSlots = 54 } = {}) {
    const owner = verify()
    signal?.throwIfAborted()
    const block = host.world.getBlock(position.x, position.y, position.z)
    if (expectedSlots !== 54 || block?.known !== true || block.name !== 'minecraft:chest') throw fail('MANUAL_DEPOSIT_CHEST_INVALID')
    closeOwned(owner)
    await waitForClose(owner, signal)
    verify(owner); signal?.throwIfAborted()
    if (currentWindow()) throw fail('MANUAL_DEPOSIT_FOREIGN_WINDOW')
    owner.opening = true; owner.firstOpen = null
    const beforeEpoch = windowEpoch
    const adoptObserved = () => {
      const snapshot = chest.snapshot(), window = currentWindow(), first = owner.firstOpen
      if (lease === owner && !owner.revoked && !owner.signal?.aborted && !owner.abort.signal.aborted && observedScope(getState()) === owner.scope &&
        window && [0, 'container'].includes(window.type) && windowEpoch === (first?.epoch ?? beforeEpoch) &&
        sameWindow(window, first?.window ?? window) && !snapshot.window?.replayed && samePoint(snapshot.window?.position, position) &&
        String(snapshot.window.id) === String(window.id)) owner.window = { ...clone(window), epoch: windowEpoch }
    }
    try {
      const result = await chest.open(position, undefined, { expectedSlots: 54 })
      verify(owner); signal?.throwIfAborted()
      const snapshot = chest.snapshot(), window = currentWindow(), first = owner.firstOpen
      if (windowEpoch !== (first?.epoch ?? beforeEpoch) || !sameWindow(window, first?.window ?? window) || result?.serverConfirmed !== true ||
        result.slotCount !== 54 || snapshot.contentsKnown !== true || snapshot.slotCount !== 54 || snapshot.window?.replayed ||
        !samePoint(snapshot.window?.position, position) || !window || String(result.windowId) !== String(window.id)) throw fail('MANUAL_DEPOSIT_CHEST_UNCONFIRMED')
      adoptObserved()
      if (!owner.window) throw fail('MANUAL_DEPOSIT_CHEST_UNCONFIRMED')
      return result
    } catch (error) {
      // A normal but unsuitable 27-slot candidate still opened our own UI.
      // Close only its observed generation so the next candidate can be read.
      adoptObserved(); closeOwned(owner)
      throw error
    } finally { owner.opening = false }
  }
  const worker = createQuarryV22ChestWork({ getState, getView, getRawMain, getRawChest: slot => chest.rawItem(slot), getRawEquipment,
    open: (position, _slot, options) => open(position, options), close: () => closeOwned(),
    withdraw: () => { throw fail('MANUAL_DEPOSIT_WITHDRAW_FORBIDDEN') }, equipArmor: () => { throw fail('MANUAL_DEPOSIT_EQUIP_FORBIDDEN') },
    deposit: options => {
      const owner = beforeMutation(true), token = {}
      owner.depositStarted = true
      owner.chestMutation = token
      try {
        return Promise.resolve(chest.depositItem(options)).finally(() => { if (owner.chestMutation === token) owner.chestMutation = null })
      } catch (error) { if (owner.chestMutation === token) owner.chestMutation = null; throw error }
    },
    equipmentTransfer: options => equipment.transfer({ ...options, signal: undefined }),
    proveEquipmentNotDispatched: cp => {
      const owner = verify(), state = getState(), last = cp.receipts?.at(-1)
      if (owner.preview || cp.operationId !== owner.id || equipment.status().busy || pendingMutation() ||
        crafting.status().pendingRequestId != null || chest.snapshot().pendingRequestId != null) throw fail('MANUAL_DEPOSIT_OPERATION_INVALID')
      assertIdle()
      if (owner.proofAttempted || typeof host.allocate !== 'function' || last?.kind !== 'deposit' || !Number.isSafeInteger(last.requestId) ||
        last.requestId >= 0 || last.requestId < -2147483645 || Math.abs(last.requestId % 2) !== 1) return null
      const identity = inventoryIdentity()
      owner.proofAttempted = true
      const connection = JSON.stringify([state.connectionId, state.startedAt, String(state.runtimeEntityId)])
      let afterAllocationId = last.requestId
      const related = entry => entry?.source === 'connection_request_allocator' && entry.operationId === owner.id &&
        entry.scope === owner.scope && entry.connection === connection && entry.afterRequestId === last.requestId
      for (const entry of cp.equipmentRecoveries ?? []) {
        if (entry?.consumed !== true || !related(entry)) continue
        if ((entry.afterAllocationId ?? entry.afterRequestId) !== afterAllocationId || !Number.isSafeInteger(entry.reservedRequestId) ||
          entry.reservedRequestId >= 0 || entry.reservedRequestId < -2147483647 || Math.abs(entry.reservedRequestId % 2) !== 1 ||
          entry.reservedRequestId !== afterAllocationId - 2) return null
        afterAllocationId = entry.reservedRequestId
      }
      if (afterAllocationId < -2147483645) return null
      const saved = cp.equipmentRecoveries?.find(entry => entry?.consumed === false && related(entry) &&
        entry.scope === owner.scope && entry.connection === connection && entry.inventoryIdentity === identity &&
        (entry.afterAllocationId ?? entry.afterRequestId) === afterAllocationId && entry.reservedRequestId === afterAllocationId - 2 &&
        serialize(entry.intent).equals(serialize(cp.equipmentIntent)))
      if (saved) { const { intent, consumed, ...proof } = saved; return { ...clone(proof), afterAllocationId } }
      // Host's odd IDs only decrease and survive behavior reloads. If the next
      // reserved ID immediately follows our last accepted chest request, no
      // equipment request could have allocated an ID, hence none was queued.
      // Any intervening allocation makes the proof unavailable; never resend it.
      const reservedRequestId = host.allocate('craft')
      if (reservedRequestId !== afterAllocationId - 2) return null
      return { source: 'connection_request_allocator', operationId: owner.id,
        scope: owner.scope, inventoryIdentity: identity,
        connection,
        afterRequestId: last.requestId, afterAllocationId, reservedRequestId }
    },
    resync: async options => { verify(); const refreshed = await refreshInventory(options); verify(); return refreshed }
  })
  const filename = id => {
    if (!UUID.test(id ?? '')) throw fail('MANUAL_DEPOSIT_OPERATION_INVALID')
    return path.join(journalDirectory, id + '.json')
  }
  const adapter = { getState, getView: actualView, getBlock: (x, y, z) => host.world.getBlock(x, y, z), inventoryIdentity, generation, jobIdentity,
    assertIdle, acquire, release, open, close: () => closeOwned(), container: () => getView().openContainer,
    runDeposit: (request, options = {}) => {
      const owner = verify()
      if (owner.preview || request.operationId !== owner.id) throw fail('MANUAL_DEPOSIT_OPERATION_INVALID')
      // A saved empty setup checkpoint has not earned a nonempty target yet.
      // A sent deposit intent is independently reconciled by the chest worker.
      owner.requireEmpty = !request.checkpoint || !(request.checkpoint.index > 0 || request.checkpoint.intent)
      owner.depositStarted = false
      return worker.depositAll(request, { ...options, signal: AbortSignal.any([owner.abort.signal, ...(options.signal ? [options.signal] : [])]) })
    },
    save: async doc => {
      if (!journalOwner || doc?.operationId !== journalOwner.id || doc.scope !== journalOwner.scope || lease && lease.id !== doc.operationId) throw fail('MANUAL_DEPOSIT_OPERATION_INVALID')
      await writeDurableJson(filename(doc.operationId), doc)
      return writeDurableJson(path.join(journalDirectory, 'latest.json'), { operationId: doc.operationId })
    },
    load: async id => { try { return await readJsonBounded(filename(id)) } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    loadPending: async () => {
      let pointer
      try { pointer = await readJsonBounded(path.join(journalDirectory, 'latest.json')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
      const doc = await readJsonBounded(filename(pointer?.operationId))
      if (doc?.version !== 1 || doc.operationId !== pointer.operationId || doc.jobId !== 'manual_chest_' + pointer.operationId) throw fail('MANUAL_DEPOSIT_OPERATION_INVALID')
      if (doc.phase === 'completed') { if (doc.serverConfirmed === true) return null; throw fail('MANUAL_DEPOSIT_OPERATION_INVALID') }
      return doc
    },
    cancelTransfers: (id, reason) => { if (lease?.id === id) revoke(lease, reason) }
  }
  const controller = createManualChestDeposit({ adapter })
  return { prepare: input => controller.prepare(input), start: input => controller.start(input), status: () => controller.status(),
    diagnostics: () => {
      const barrier = currentClose()
      return { window: clone(currentWindow()), equipment: equipment.status(), windowEpoch,
        closing: barrier ? { window: clone(barrier.window), pending: barrier.pending, acknowledged: barrier.acknowledged, error: barrier.error, foreignOpened: barrier.foreignOpened === true } : null,
        events: clone(closeState.manualChestWindowEvents ?? []) }
    },
    retryClose: () => {
      const barrier = currentClose(), state = getState()
      if (lease || equipment.status().busy || controller.status().busy || pendingMutation()) throw fail('MANUAL_DEPOSIT_BUSY')
      assertIdle()
      if (!barrier || barrier.acknowledged || barrier.foreignOpened || currentWindow() || state.phase !== 'spawned' || !(state.health > 0) ||
        crafting.status().pendingRequestId != null || chest.snapshot().pendingRequestId != null) throw fail('MANUAL_DEPOSIT_CLOSE_RETRY_UNAVAILABLE')
      host.client.queue('container_close', { window_id: barrier.window.id, window_type: barrier.window.type, server: false })
      return { requested: true, serverConfirmed: false }
    },
    cancel: reason => { if (lease) revoke(lease, reason); return controller.cancel(reason) }, drain: () => controller.drain(),
    isBusy: () => !!lease || equipment.status().busy || controller.status().busy === true || currentClose()?.pending === true,
    equipmentBusy: () => equipment.status().busy, pendingMutation,
    applyPacket: (name, packet) => {
      if (name === 'container_open' || name === 'container_close') {
        const events = closeState.manualChestWindowEvents ??= []
        events.push({ name, at: new Date().toISOString(), id: packet.window_id, type: packet.window_type, server: packet.server })
        if (events.length > 16) events.splice(0, events.length - 16)
      }
      const window = currentWindow()
      const barrier = currentClose()
      if (barrier && !barrier.acknowledged) {
        if (name === 'container_open') {
          barrier.foreignOpened = true
          settleClose(barrier, fail('MANUAL_DEPOSIT_CLOSE_WINDOW_CHANGED'))
        } else if (name === 'container_close' && !barrier.foreignOpened && String(packet.window_id) === String(barrier.window.id) &&
          (packet.window_type == null || ['none', -9].includes(packet.window_type) || String(packet.window_type) === String(barrier.window.type))) {
          if (barrier.pending) settleClose(barrier)
          else barrier.acknowledged = true
          if (closeState.manualChestCloseBarrier === barrier) closeState.manualChestCloseBarrier = null
        }
      }
      if (name === 'container_open' || name === 'container_close' && [window, lease?.window].some(value => value && String(value.id) === String(packet.window_id))) {
        windowEpoch++
        if (lease?.opening && name === 'container_open' && !lease.firstOpen) lease.firstOpen = { epoch: windowEpoch, window: { id: packet.window_id, type: packet.window_type } }
      }
      equipment.applyPacket(name, packet)
    }
  }
}

module.exports = { createManualChestRuntime }
