'use strict'

// The chest window for the player's storage and the return to the base:
// opening, reading, depositing and taking out, each answered with what the
// received data shows (return-result.js).
// - A chest is "full" only when its received slots show no empty one; one that
//   did not open, or whose contents did not arrive, is "unknown", never full.
// - A deposit counts when the received inventory slot lost the items. The
//   count is kept even when the rest fails (partial).
// - What to deposit is read again before every transfer, so a stack that
//   moved to another slot is found where it is now.
// - After a transfer whose result is not confirmed (the inventory became
//   uncertain, or the slot did not change), nothing more is sent: the caller
//   waits for the inventory to be received again.
// - Why a refusal happened is read from the state (the controls are held, the
//   chest is busy, the inventory is uncertain), not from the message.
// - A chest out of reach, or with no clear line to the face the click goes to,
//   is not clicked at all: the open operation's own preview says so before
//   anything is sent (CONTAINER_NOT_IN_REACH, CONTAINER_NOT_VISIBLE), and the
//   caller stands somewhere else (live 2026-11-18 03:16-03:20 JST: 27 tries
//   from one place at chests it could not see, 17 diamonds not banked).
const { completed, partial, blocked, failed, interrupted } = require('./return-result')

const WAIT = /待って|待機|使用中|確認しています/
const OPEN_MS = 4000, SLOT_MS = 3000, PATIENT_MS = 10000, MAX_TRANSFERS = 72

function createContainerPorts ({ operations, getInventory, held = () => false, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const items = () => getInventory()?.items ?? []
  const count = name => items().filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  // A start refused only because the operation before it is still ending is tried again for ten seconds.
  // Not while something with priority holds the controls (`stop`): the caller answers that at once.
  async function patient (run, stop = () => false) {
    const end = now() + PATIENT_MS
    for (;;) {
      try { return await run() } catch (error) {
        if (!WAIT.test(String(error?.message ?? '')) || now() >= end || disposed() || stop()) throw error
        await sleep(300)
      }
    }
  }
  const view = () => { try { return operations.chest.snapshot() } catch { return null } }
  const close = () => { try { operations.crafting.closeContainer() } catch {} }
  const empty = slot => slot.known === true && !slot.name && !slot.count

  // Empty slots and received slots per chest cell (null until it was opened here).
  const rooms = new Map(), seen = new Map()
  const key = position => `${position.x},${position.y},${position.z}`
  const room = position => rooms.get(key(position)) ?? null
  const contents = position => seen.get(key(position)) ?? null
  function remember (position) {
    const slots = view()?.slots ?? []
    rooms.set(key(position), slots.filter(empty).length)
    seen.set(key(position), slots.map(slot => ({ ...slot })))
  }
  const chestOf = position => ({ x: position.x, y: position.y, z: position.z })
  const at = (window, position) => !!window?.position && window.position.x === position.x && window.position.y === position.y && window.position.z === position.z

  // Whether the open click can be sent from where the Bot stands: null, or the code of why not.
  const AWAY = { OUT_OF_REACH: 'CONTAINER_NOT_IN_REACH', SIGHT_BLOCKED: 'CONTAINER_NOT_VISIBLE' }
  function access (position) {
    let seen = null
    try { seen = operations.interactions?.previewOpenChest?.(position) } catch { return null }
    return seen?.ready === false ? AWAY[seen.code] ?? null : null
  }

  // Why the chest did not open, from the state.
  function refusal (position, error) {
    const evidence = { chest: chestOf(position) }, detail = error?.message ?? error
    if (held()) return interrupted('CONTROLS_HELD', { evidence, detail })
    if (getInventory() == null || view()?.inventoryUncertain === true) return blocked('INVENTORY_UNKNOWN', { kind: 'inventory_update', timeoutMs: 30000 }, { evidence, detail })
    if (view()?.busy === true) return blocked('CONTAINER_BUSY', { kind: 'owner_released', timeoutMs: PATIENT_MS }, { evidence, detail })
    // The window of this chest opened and its slots did not all arrive: unknown, to be read again.
    if (at(view()?.window, position) && view().contentsKnown !== true) return blocked('CONTAINER_CONTENTS_UNKNOWN', { kind: 'container_update', timeoutMs: SLOT_MS }, { evidence, detail })
    return failed(typeof error?.code === 'string' ? error.code : 'CONTAINER_OPEN_REFUSED', { evidence, detail })
  }

  // The chest open with its contents received.
  async function open (position) {
    const away = access(position)
    if (away) return failed(away, { evidence: { chest: chestOf(position) } })
    try { await patient(() => operations.chest.open(position), held) } catch (error) { return refusal(position, error) }
    if (!await until(() => view()?.contentsKnown === true, OPEN_MS)) return blocked('CONTAINER_CONTENTS_UNKNOWN', { kind: 'container_update', timeoutMs: SLOT_MS }, { evidence: { chest: chestOf(position) } })
    remember(position)
    return completed('CONTAINER_OPEN', { evidence: { chest: chestOf(position), room: room(position) } })
  }

  // Opens the chest, reads it and closes it again.
  async function inspect (position) {
    try { return await open(position) } finally { close() }
  }

  // cargo: the stacks to deposit, [{ slot, name, count }], or a function that
  // reads them from the inventory as it is now.
  async function deposit (position, cargo, { aborted = () => false } = {}) {
    const fixed = Array.isArray(cargo) ? cargo.map(stack => ({ ...stack })) : null
    const plan = fixed ? () => fixed.filter(stack => stack.count > 0) : cargo
    const skipped = new Set(), sign = stack => `${stack.slot}:${stack.name}`
    const left = () => { try { return plan().reduce((sum, stack) => sum + stack.count, 0) } catch { return null } }
    let moved = 0, refused = null
    const answer = (make, code, extra = {}) => make(code, { ...extra, progress: { confirmedTransferred: moved }, remaining: { items: left() }, evidence: { chest: chestOf(position), room: room(position), ...extra.evidence } })
    const opened = await open(position)
    if (opened.status !== 'completed') { close(); return { ...opened, progress: { confirmedTransferred: 0 }, remaining: { items: left() } } }
    try {
      for (let step = 0; step < MAX_TRANSFERS; step++) {
        if (disposed() || aborted()) return answer(interrupted, 'DEPOSIT_INTERRUPTED')
        if (getInventory() == null) return blocked('TRANSFER_UNCONFIRMED', { kind: 'inventory_update', timeoutMs: 30000 }, { progress: { confirmedTransferred: moved }, evidence: { chest: chestOf(position) } })
        const stack = plan().find(candidate => !skipped.has(sign(candidate)))
        if (!stack) break
        const window = view()
        if (window?.contentsKnown !== true) return answer((code, extra) => blocked(code, { kind: 'container_update', timeoutMs: SLOT_MS }, extra), 'CONTAINER_CONTENTS_UNKNOWN')
        remember(position)
        const free = (window.slots ?? []).find(empty)
        // Confirmed by the received slots: another chest is needed.
        if (!free) return answer(moved > 0 ? partial : failed, 'CONTAINER_FULL')
        const source = items().find(item => item.slot === stack.slot && item.name === stack.name && item.count > 0)
        if (!source) { skipped.add(sign(stack)); continue }
        const amount = Math.min(stack.count, source.count, 64), before = source.count
        try { await patient(() => operations.chest.depositItem({ sourceSlot: stack.slot, count: amount, chestSlot: free.slot, expectedName: stack.name }), () => held() || aborted()) } catch (error) {
          if (getInventory() == null || view()?.inventoryUncertain === true) return blocked('TRANSFER_UNCONFIRMED', { kind: 'inventory_update', timeoutMs: 30000 }, { progress: { confirmedTransferred: moved }, evidence: { chest: chestOf(position) }, detail: error?.message })
          if (held() || aborted()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'DEPOSIT_INTERRUPTED', { detail: error?.message })
          refused = error; skipped.add(sign(stack)); continue
        }
        // The chest answered; the inventory slot has to show it before anything else is sent.
        if (!await until(() => (items().find(item => item.slot === stack.slot && item.name === stack.name)?.count ?? 0) <= before - amount, SLOT_MS)) return answer((code, extra) => blocked(code, { kind: 'time', ms: SLOT_MS }, extra), 'TRANSFER_UNCONFIRMED')
        moved += amount
        if (fixed) stack.count -= amount
      }
    } catch (error) {
      return answer(moved > 0 ? partial : failed, 'DEPOSIT_FAILED', { detail: error?.message })
    } finally { if (view()?.contentsKnown === true) remember(position); close() }
    const rest = left()
    if (rest === 0) return answer(completed, 'CARGO_STORED')
    return answer(moved > 0 ? partial : failed, 'TRANSFER_REJECTED', { detail: refused?.message })
  }

  // The stacks pick(slots) names out of the chest. The answer says how many
  // items the inventory gained, and why the chest did not open or gave nothing
  // (live 2026-11-18 05:11 JST: a chest that gave nothing answered a bare 0,
  // and the log could not say whether it had opened).
  async function withdraw (position, pick) {
    let moved = 0, refused = null
    const opened = await open(position)
    if (opened.status !== 'completed') { close(); return { ...opened, progress: { confirmedTransferred: 0 } } }
    try {
      for (const want of pick(view().slots ?? [])) {
        if (disposed()) break
        const before = count(want.name)
        try { await patient(() => operations.chest.withdrawItem({ chestSlot: want.chestSlot, count: want.count, expectedName: want.name })) } catch (error) { refused = error; if (error?.code === 'INVENTORY_FULL') break; continue }
        if (await until(() => count(want.name) >= before + want.count, SLOT_MS)) moved += want.count
        else refused = refused ?? new Error('取り出した数を持ち物の受信で確認できませんでした。')
      }
      if (view()?.contentsKnown === true) remember(position)
    } catch (error) { refused = error /* What was taken is counted from the received inventory. */ } finally { close() }
    const extra = { progress: { confirmedTransferred: moved }, evidence: { chest: chestOf(position) } }
    return moved > 0 || !refused ? completed('KIT_TAKEN', extra) : failed('WITHDRAW_REFUSED', { ...extra, detail: refused?.message })
  }
  const take = async (position, pick) => (await withdraw(position, pick)).progress?.confirmedTransferred ?? 0

  // The count alone, for the callers that only add it up (player-storage.js).
  const store = async (position, stacks) => (await deposit(position, stacks)).progress?.confirmedTransferred ?? 0

  return { open, inspect, deposit, take, withdraw, store, room, contents, patient, access }
}

module.exports = { createContainerPorts }
