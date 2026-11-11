'use strict'

const { isDeepStrictEqual } = require('node:util')

// Accepted stack responses are server evidence, unlike a locally requested
// equipment swap. No replacement packets are sent on timeout or disconnect.
const TYPE = Object.freeze({
  main: { container_id: 'hotbar_and_inventory', dynamic_container_id: null },
  armor: { container_id: 'armor', dynamic_container_id: null },
  offhand: { container_id: 'offhand', dynamic_container_id: null }
})
const clone = value => structuredClone(value)
const valid = r => r && Number.isSafeInteger(r.network_id) && Number.isSafeInteger(r.count) &&
  (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.has_stack_id === true && Number.isSafeInteger(r.stack_id) && r.stack_id > 0)
const empty = r => valid(r) && r.network_id === 0
const slot = (kind, n, raw) => ({ slot_type: clone(TYPE[kind]), slot: n, stack_id: empty(raw) ? 0 : raw.stack_id })
const scope = s => JSON.stringify([s?.profile, s?.realm?.id, s?.dimension, s?.connectionId, s?.startedAt, s?.runtimeEntityId, s?.lifecycle?.deathId])
const fail = code => Object.assign(new Error(code), { code })

function createQuarryV22Equipment ({ client, getState, getView, getRawMain, getRawEquipment,
  allocateRequestId, commitMain, commitEquipment, onUncertain = () => {}, timeoutMs = 10000, now = Date.now }) {
  if ([getState, getView, getRawMain, getRawEquipment, allocateRequestId, commitMain, commitEquipment, onUncertain, now].some(fn => typeof fn !== 'function') || typeof client?.queue !== 'function') throw new TypeError('V22 equipment requires live item-stack ports')
  let pending = null
  const currentRaw = (kind, n) => kind === 'main' ? getRawMain(n) : getRawEquipment(kind, n)
  function status () { return { busy: pending != null, operationId: pending?.id ?? null, stage: pending?.stage ?? 'idle' } }
  function cancel (reason = 'EQUIPMENT_CANCELLED') {
    if (!pending) return
    const p = pending; pending = null
    clearTimeout(p.timer)
    p.signal?.removeEventListener('abort', p.onAbort)
    if (p.sent) onUncertain({ code: reason, operationId: p.id, kind: p.kind })
    p.reject(fail(reason))
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
    const id = allocateRequestId()
    if (!Number.isSafeInteger(id) || id >= 0 || id < -2147483647 || Math.abs(id % 2) !== 1) throw fail('EQUIPMENT_REQUEST_ID_INVALID')
    const receipt = await new Promise((resolve, reject) => {
      const p = pending = { id, from, fromSlot, to, toSlot, expectedName, src: clone(src), dst: clone(dst), scope: before, signal, resolve, reject, sent: false, stage: 'dispatch', startedAt: now() }
      p.onAbort = () => cancel('EQUIPMENT_INTERRUPTED')
      p.timer = setTimeout(() => cancel('EQUIPMENT_RECEIPT_TIMEOUT'), timeoutMs)
      signal?.addEventListener('abort', p.onAbort, { once: true })
      try {
        client.queue('item_stack_request', { requests: [{ request_id: id, actions: [{
          type_id: from === 'main' ? 'place' : 'take', legacy_type_id: from === 'main' ? 1 : 0, count: 1,
          source: slot(from, fromSlot, src), destination: slot(to, toSlot, dst)
        }], custom_names: [], cause: -1 }] })
        p.sent = true; p.stage = 'awaiting_response'
      } catch (error) { cancel('EQUIPMENT_DISPATCH_FAILED') }
    })
    const after = getView()
    const dest = to === 'main' ? after.slots[toSlot] : to === 'armor' ? after.armor.slots[toSlot] : after.offhand.slots[0]
    const source = from === 'main' ? after.slots[fromSlot] : from === 'armor' ? after.armor.slots[fromSlot] : after.offhand.slots[0]
    if (scope(getState()) !== before || dest?.known !== true || dest.empty || dest.name !== expectedName || source?.known !== true || !source.empty) throw fail('EQUIPMENT_FINAL_OBSERVATION_MISMATCH')
    return receipt
  }
  function applyPacket (name, packet) {
    const p = pending
    if (!p) return false
    if (['start_game', 'change_dimension', 'disconnect', 'respawn', 'death_info'].includes(name) || scope(getState()) !== p.scope) {
      cancel('EQUIPMENT_SCOPE_CHANGED'); return true
    }
    if (name !== 'item_stack_response') return false
    for (const response of packet.responses ?? []) {
      if (response.request_id !== p.id) continue
      if (response.status !== 'ok' && response.status !== 0) { cancel('EQUIPMENT_SERVER_REJECTED'); return true }
      const groups = new Map()
      for (const container of response.containers ?? []) {
        const kind = Object.entries(TYPE).find(([, v]) => v.container_id === container.slot_type?.container_id)?.[0]
        if (!kind || container.slot_type?.dynamic_container_id != null) continue
        for (const row of container.slots ?? []) groups.set(kind + ':' + row.slot, row)
      }
      const src = groups.get(p.from + ':' + p.fromSlot), dst = groups.get(p.to + ':' + p.toSlot)
      if (!src || !dst || src.count !== 0 || dst.count !== 1 || !Number.isSafeInteger(dst.item_stack_id) || dst.item_stack_id < 1) {
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
      pending = null; clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.onAbort)
      p.resolve({ serverConfirmed: true, confirmedBy: 'matching_item_stack_response_and_equipment_observation', requestId: p.id, from: p.from, fromSlot: p.fromSlot, to: p.to, toSlot: p.toSlot, name: p.expectedName })
      return true
    }
    return false
  }
  return { transfer, applyPacket, cancel, status }
}
module.exports = { createQuarryV22Equipment }
