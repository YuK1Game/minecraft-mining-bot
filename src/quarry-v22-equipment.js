'use strict'

const { isDeepStrictEqual } = require('node:util')

// Accepted stack responses are server evidence, unlike a locally requested
// equipment swap. No replacement packets are sent on timeout or disconnect.
const TYPE = Object.freeze({
  hotbar: { container_id: 'hotbar', dynamic_container_id: null },
  inventory: { container_id: 'inventory', dynamic_container_id: null },
  armor: { container_id: 'armor', dynamic_container_id: null },
  offhand: { container_id: 'offhand', dynamic_container_id: null }
})
const clone = value => structuredClone(value)
const valid = r => r && Number.isSafeInteger(r.network_id) && Number.isSafeInteger(r.count) &&
  (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.has_stack_id === true && Number.isSafeInteger(r.stack_id) && r.stack_id > 0)
const empty = r => valid(r) && r.network_id === 0
// Bedrock's offhand array index is 0, but stack requests/responses use slot 1.
// Main slots keep their 0..35 index and use their specific UI container.
const wireKind = (kind, n) => kind === 'main' ? (n < 9 ? 'hotbar' : 'inventory') : kind
const slot = (kind, n, raw) => ({ slot_type: clone(TYPE[wireKind(kind, n)]), slot: kind === 'offhand' ? 1 : n, stack_id: empty(raw) ? 0 : raw.stack_id })
const scope = s => JSON.stringify([s?.profile, s?.realm?.id, s?.dimension, s?.connectionId, s?.startedAt, s?.runtimeEntityId, s?.lifecycle?.deathId])
const fail = (code, details) => Object.assign(new Error(code), { code, ...(details ? { details } : {}) })
const containerName = value => ({ 6: 'armor', 12: 'hotbar_and_inventory', 28: 'hotbar', 29: 'inventory', 34: 'offhand' })[value] ?? value
const inventoryWindow = value => value && ['inventory', -1].includes(value.type)
const sameWindow = (a, b) => a && b && String(a.id) === String(b.id) && String(a.type) === String(b.type)
const sameStack = (a, b) => valid(a) && valid(b) && a.network_id === b.network_id && a.count === b.count &&
  a.stack_id === b.stack_id && a.has_stack_id === b.has_stack_id && a.metadata === b.metadata &&
  a.block_runtime_id === b.block_runtime_id && isDeepStrictEqual(a.extra, b.extra)

function createQuarryV22Equipment ({ client, crafting, getState, getView, getRawMain, getRawEquipment,
  allocateRequestId, commitMain, commitEquipment, onUncertain = () => {}, timeoutMs = 10000, now = Date.now }) {
  if ([getState, getView, getRawMain, getRawEquipment, allocateRequestId, commitMain, commitEquipment, onUncertain, now].some(fn => typeof fn !== 'function') || typeof client?.queue !== 'function') throw new TypeError('V22 equipment requires live item-stack ports')
  const getOpen = typeof crafting?.status === 'function'
    ? () => crafting.status().openContainer
    : typeof crafting?.snapshot === 'function' ? () => crafting.snapshot().openContainer : null
  if (!getOpen || typeof crafting?.openInventory !== 'function' || typeof crafting?.closeContainer !== 'function') throw new TypeError('V22 equipment requires an observed inventory session')
  let pending = null, windowEpoch = 0, observedWindow = getOpen()
  const currentRaw = (kind, n) => kind === 'main' ? getRawMain(n) : getRawEquipment(kind, n)
  function status () { return { busy: pending != null, operationId: pending?.id ?? null, stage: pending?.stage ?? 'idle' } }
  function markUncertain (p, code) {
    if (!p.sent || p.uncertaintyNotified) return
    p.uncertaintyNotified = true
    try { onUncertain({ code, operationId: p.id, from: p.from, to: p.to }) } catch {}
  }
  function cancel (reason = 'EQUIPMENT_CANCELLED', details) {
    if (!pending || pending.settled) return
    const p = pending
    p.settled = true
    clearTimeout(p.timer)
    p.signal?.removeEventListener('abort', p.onAbort)
    markUncertain(p, reason)
    p.reject(fail(reason, details))
  }
  function closeOwned (p, window = p.ownedWindow) {
    try {
      if (p.abandoned || p.signal?.aborted || !window || p.ownedEpoch !== windowEpoch ||
        scope(getState()) !== p.scope || !sameWindow(getOpen(), window)) return
      crafting.closeContainer()
    } catch {}
  }
  function frame (p) {
    if (p.signal?.aborted) throw fail('EQUIPMENT_INTERRUPTED')
    const s = getState(), view = getView()
    if (scope(s) !== p.scope) throw fail('EQUIPMENT_SCOPE_CHANGED')
    if (s?.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || !(s.health > 0) ||
      s.inventory?.known !== true || s.inventory.uncertain || view.known !== true ||
      view.armor?.known !== true || view.offhand?.known !== true) throw fail('EQUIPMENT_OBSERVATION_UNKNOWN')
    return view
  }
  async function transfer ({ from, fromSlot, to, toSlot, expectedName, signal } = {}) {
    if (pending) throw fail('EQUIPMENT_BUSY')
    if (!['main', 'armor', 'offhand'].includes(from) || !['main', 'armor', 'offhand'].includes(to) ||
      (from !== 'main' && to !== 'main') || from === to ||
      !Number.isSafeInteger(fromSlot) || !Number.isSafeInteger(toSlot) ||
      fromSlot < 0 || toSlot < 0 || fromSlot >= (from === 'main' ? 36 : from === 'armor' ? 4 : 1) ||
      toSlot >= (to === 'main' ? 36 : to === 'armor' ? 4 : 1) ||
      typeof expectedName !== 'string' || !expectedName.startsWith('minecraft:')) throw fail('EQUIPMENT_REQUEST_INVALID')
    const s = getState(), view = getView(), before = scope(s)
    if (s?.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || !(s.health > 0) ||
      s.inventory?.known !== true || s.inventory.uncertain || view.known !== true ||
      view.armor?.known !== true || view.offhand?.known !== true || signal?.aborted) throw fail('EQUIPMENT_OBSERVATION_UNKNOWN')
    const src = currentRaw(from, fromSlot), dst = currentRaw(to, toSlot)
    if (!valid(src) || !valid(dst) || empty(src) || !empty(dst) || src.count !== 1 ||
      (from === 'main' ? view.slots[fromSlot] : from === 'armor' ? view.armor.slots[fromSlot] : view.offhand.slots[0])?.name !== expectedName) throw fail('EQUIPMENT_SOURCE_MISMATCH')
    const p = {
      id: null, from, fromSlot, to, toSlot, expectedName, src: clone(src), dst: clone(dst), scope: before,
      signal, sent: false, settled: false, stage: 'opening_inventory', startedAt: now(),
      ownedWindow: null, window: null, abandoned: false
    }
    const response = new Promise((resolve, reject) => { p.resolve = resolve; p.reject = reject })
    void response.catch(() => {})
    pending = p
    p.onAbort = () => { p.abandoned = true; cancel('EQUIPMENT_INTERRUPTED') }
    p.timer = setTimeout(() => {
      if (!p.window) p.abandoned = true
      cancel('EQUIPMENT_RECEIPT_TIMEOUT')
    }, timeoutMs)
    signal?.addEventListener('abort', p.onAbort, { once: true })
    try {
      let open = getOpen()
      if (!open) {
        p.openingRequested = true
        p.openingEpoch = windowEpoch
        let opening
        try { opening = Promise.resolve(crafting.openInventory()) } catch (error) {
          throw fail('EQUIPMENT_OPEN_FAILED', { message: String(error.message ?? error) })
        }
        const owned = opening.then(opened => {
          if (!inventoryWindow(opened)) throw fail('EQUIPMENT_CONTAINER_INVALID')
          p.ownedWindow = clone(opened)
          // The first actual open event owns the epoch. Reading the latest
          // epoch here could adopt a replacement delivered in the same batch.
          p.ownedEpoch = p.observedOpen?.epoch ?? p.openingEpoch
          if (p.observedOpen && !sameWindow(opened, p.observedOpen.window)) {
            p.abandoned = true
            throw fail('EQUIPMENT_CONTAINER_CHANGED')
          }
          if (p.settled || pending !== p) closeOwned(p, opened)
          return opened
        })
        try { open = await Promise.race([owned, response]) } catch (error) {
          if (!p.settled && !error.code) throw fail('EQUIPMENT_OPEN_FAILED', { message: String(error.message ?? error) })
          throw error
        }
      }
      if (p.settled) return await response
      frame(p)
      if (!inventoryWindow(open) || !sameWindow(getOpen(), open)) throw fail('EQUIPMENT_CONTAINER_INVALID')
      p.window = clone(open)
      p.windowEpoch = p.openingRequested ? p.ownedEpoch : windowEpoch
      if (p.windowEpoch !== windowEpoch) { p.abandoned = true; throw fail('EQUIPMENT_CONTAINER_CHANGED') }
      if (!sameStack(currentRaw(from, fromSlot), p.src) || !sameStack(currentRaw(to, toSlot), p.dst)) throw fail('EQUIPMENT_SOURCE_CHANGED')
      p.id = allocateRequestId()
      if (!Number.isSafeInteger(p.id) || p.id >= 0 || p.id < -2147483647 || Math.abs(p.id % 2) !== 1) throw fail('EQUIPMENT_REQUEST_ID_INVALID')
      p.source = slot(from, fromSlot, p.src)
      p.destination = slot(to, toSlot, p.dst)
      p.stage = 'awaiting_response'
      p.sent = true
      try {
        client.queue('item_stack_request', { requests: [{ request_id: p.id, actions: [{
          type_id: from === 'main' ? 'place' : 'take', legacy_type_id: from === 'main' ? 1 : 0,
          count: 1, source: clone(p.source), destination: clone(p.destination)
        }], custom_names: [], cause: -1 }] })
      } catch (error) { cancel('EQUIPMENT_DISPATCH_FAILED') }
      const receipt = await response, after = frame(p)
      const dest = to === 'main' ? after.slots[toSlot] : to === 'armor' ? after.armor.slots[toSlot] : after.offhand.slots[0]
      const source = from === 'main' ? after.slots[fromSlot] : from === 'armor' ? after.armor.slots[fromSlot] : after.offhand.slots[0]
      if (dest?.known !== true || dest.empty || dest.name !== expectedName || source?.known !== true || !source.empty) throw fail('EQUIPMENT_FINAL_OBSERVATION_MISMATCH')
      return receipt
    } catch (error) {
      if (!p.settled) cancel(error.code ?? 'EQUIPMENT_OPEN_FAILED', error.details)
      else markUncertain(p, error.code ?? 'EQUIPMENT_FINAL_OBSERVATION_MISMATCH')
      throw error
    } finally {
      clearTimeout(p.timer)
      signal?.removeEventListener('abort', p.onAbort)
      closeOwned(p)
      if (pending === p) pending = null
    }
  }
  function applyPacket (name, packet) {
    const p = pending
    const windowEvent = name === 'container_open' || name === 'container_close' &&
      [observedWindow, p?.window, p?.observedOpen?.window, getOpen()].some(window => window && String(window.id) === String(packet.window_id))
    if (windowEvent) {
      windowEpoch++
      observedWindow = name === 'container_open' ? { id: packet.window_id, type: packet.window_type } : null
    }
    if (!p || p.settled) return false
    if (p.openingRequested && !p.window && windowEvent) {
      if (name !== 'container_open' || p.observedOpen) {
        p.abandoned = true
        cancel('EQUIPMENT_CONTAINER_CHANGED')
        return true
      }
      p.observedOpen = { epoch: windowEpoch, window: { id: packet.window_id, type: packet.window_type } }
    }
    if (['start_game', 'change_dimension', 'disconnect', 'respawn', 'death_info'].includes(name) || scope(getState()) !== p.scope) {
      cancel('EQUIPMENT_SCOPE_CHANGED'); return true
    }
    if (p.signal?.aborted) { cancel('EQUIPMENT_INTERRUPTED'); return true }
    if (p.window && (p.windowEpoch !== windowEpoch || !sameWindow(getOpen(), p.window))) { cancel('EQUIPMENT_CONTAINER_CHANGED'); return true }
    if (name !== 'item_stack_response') return false
    for (const response of packet.responses ?? []) {
      if (p.id === null || response.request_id !== p.id) continue
      if (response.status !== 'ok' && response.status !== 0) {
        cancel('EQUIPMENT_SERVER_REJECTED', { status: response.status, requestId: p.id })
        return true
      }
      const matching = wire => {
        const expected = wire.slot_type.container_id, rows = []
        for (const container of response.containers ?? []) {
          const actual = containerName(container.slot_type?.container_id)
          const combinedAlias = ['hotbar', 'inventory'].includes(expected) && actual === 'hotbar_and_inventory'
          if (container.slot_type?.dynamic_container_id != null || !(actual === expected || combinedAlias)) continue
          for (const row of container.slots ?? []) if (row.slot === wire.slot) rows.push(row)
        }
        return rows.length === 1 ? rows[0] : null
      }
      const src = matching(p.source), dst = matching(p.destination)
      if (!src || !dst || src.count !== 0 || (src.item_stack_id != null && src.item_stack_id !== 0) ||
        dst.count !== 1 || !Number.isSafeInteger(dst.item_stack_id) || dst.item_stack_id < 1 || dst.item_stack_id > 2147483647) {
        cancel('EQUIPMENT_RECEIPT_UNCONFIRMED'); return true
      }
      const transferred = { ...clone(p.src), stack_id: dst.item_stack_id, has_stack_id: true }
      const air = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
      try {
        if (p.from === 'main') commitMain(p.fromSlot, air, p.id)
        else commitEquipment(p.from, p.fromSlot, air, p.id)
        if (p.to === 'main') commitMain(p.toSlot, transferred, p.id)
        else commitEquipment(p.to, p.toSlot, transferred, p.id)
      } catch (error) {
        cancel('EQUIPMENT_STATE_COMMIT_FAILED'); return true
      }
      p.settled = true
      clearTimeout(p.timer)
      p.signal?.removeEventListener('abort', p.onAbort)
      p.resolve({ serverConfirmed: true, confirmedBy: 'matching_item_stack_response_and_equipment_observation', requestId: p.id, from: p.from, fromSlot: p.fromSlot, to: p.to, toSlot: p.toSlot, name: p.expectedName })
      return true
    }
    return false
  }
  return { transfer, applyPacket, cancel: reason => { if (pending) pending.abandoned = true; cancel(reason) }, status }
}
module.exports = { createQuarryV22Equipment }
