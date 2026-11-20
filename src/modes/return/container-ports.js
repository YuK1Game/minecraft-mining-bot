'use strict'

// The chest window for the player's storage and the return to the base:
// opening, reading, depositing and taking out, each answered with what the
// received data shows (return-result.js).
// - A chest is "full" for a stack only when the lower chest operation finds
//   no compatible destination, including space in existing stacks. A chest
//   that did not open, or whose contents did not arrive, is never called full.
// - A deposit counts when the received inventory slot lost the items. The
//   count is kept even when the rest fails (partial).
// - What to deposit is read again before every transfer, so a stack that
//   moved to another slot is found where it is now.
// - After a transfer whose result is not confirmed (the inventory became
//   uncertain, or the slot did not change), nothing more is sent: the caller
//   waits for the inventory to be received again.
// - Why a refusal happened is read from the state (the controls are held, the
//   chest is busy, the inventory is uncertain), not from the message.
// - A tool in a chest slot carries its received uses (chest-tools.js), so the
//   rules that read a slot see what they see of a row of the inventory.
// - A chest out of reach, or with no clear line to the face the click goes to,
//   is not clicked at all: the open operation's own preview says so before
//   anything is sent (CONTAINER_NOT_IN_REACH, CONTAINER_NOT_VISIBLE), and the
//   caller stands somewhere else (live 2026-11-18 03:16-03:20 JST: 27 tries
//   from one place at chests it could not see, 17 diamonds not banked).
// - A preview that refuses for another reason (the inventory not confirmed,
//   the slot in hand) says nothing about the place. The place is then judged
//   by the same reach and line alone, so a chest across the base is still
//   "out of reach" and is walked to; beside it, the open itself answers with
//   its reason (live 2026-11-19 18:26:07 JST: five chests of the base were
//   each "opened" from where the Bot stood, all refused within 64 ms, and the
//   trip for the kit ended with nothing taken and nothing said).
const { completed, partial, blocked, failed, interrupted } = require('./return-result')
const { openAccess } = require('../../actions/open-face')
const { chestTool, slotTool } = require('./chest-tools')

const WAIT = /待って|待機|使用中|確認しています/
const OPEN_MS = 4000, SLOT_MS = 3000, PATIENT_MS = 10000, MAX_TRANSFERS = 72, EYE = 1.62

function createContainerPorts ({ operations, getInventory, getBlock = null, getFeet = null, held = () => false, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, memory = null, tool = chestTool }) {
  const items = () => getInventory()?.items ?? []
  const count = name => items().filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms, stop = () => false) => { const end = now() + ms; while (now() < end && !disposed() && !stop()) { if (test()) return true; await sleep(200) } return !disposed() && !stop() && test() }
  // A start refused only because the operation before it is still ending is tried again for ten seconds.
  // Not while something with priority holds the controls (`stop`): the caller answers that at once.
  async function patient (run, stop = () => false) {
    const end = now() + PATIENT_MS
    for (;;) {
      if (disposed() || stop()) throw Object.assign(new Error('チェスト操作を中断しました。'), { code: 'CONTAINER_INTERRUPTED' })
      try { return await run() } catch (error) {
        if (!WAIT.test(String(error?.message ?? '')) || now() >= end || disposed() || stop()) throw error
        await sleep(300)
      }
    }
  }
  // The chest as received; a tool in a slot with the uses its own data gives, read as the inventory's rows are.
  const view = () => { try { const seen = operations.chest.snapshot(); return Array.isArray(seen?.slots) ? { ...seen, slots: seen.slots.map(slot => slotTool(slot, operations.chest.rawItem, tool)) } : seen } catch { return null } }
  const empty = slot => slot.known === true && !slot.name && !slot.count
  // A late finally owns only the window it actually opened. A newer call,
  // another owner or another connection must keep its own window untouched.
  let owner = null
  const sameWindow = (a, b) => !!a && !!b && a.id === b.id && a.epoch === b.epoch && JSON.stringify(a.scope) === JSON.stringify(b.scope)
  function session ({ aborted = () => false } = {}) {
    const mine = { window: null }
    if (!disposed() && !aborted() && !held()) owner = mine
    mine.stop = () => disposed() || aborted() || held() || owner !== mine || (!!mine.window && !sameWindow(view()?.window, mine.window))
    return mine
  }
  const cut = (mine, code, extra) => mine.stop() ? interrupted(held() ? 'CONTROLS_HELD' : code, extra) : null
  const confirmed = (receipt, amount) => receipt?.serverConfirmed === true && receipt.inventoryConfirmed === true && receipt.containerConfirmed === true && receipt.count === amount
  function close (mine) {
    if (disposed() || held() || owner !== mine || !sameWindow(view()?.window, mine.window)) return
    try { operations.crafting.closeContainer() } catch {}
  }

  // Empty slots and received slots per chest cell (null until it was opened here).
  // With `memory` (a map kept by the caller) the received slots stay known
  // when this module is loaded again; each opening replaces them. The room is
  // not kept: after a reload a chest is opened before it is called full.
  // When each was received (`memory.at`), so that a reader of the memory can tell which of two records is the later.
  const rooms = new Map(), seen = memory?.seen ?? new Map(), stamps = memory ? (memory.at ??= new Map()) : new Map()
  const key = position => `${position.x},${position.y},${position.z}`
  const room = position => rooms.get(key(position)) ?? null
  const contents = position => seen.get(key(position)) ?? null
  function remember (position) {
    const slots = view()?.slots ?? []
    rooms.set(key(position), slots.filter(empty).length)
    seen.set(key(position), slots.map(slot => ({ ...slot })))
    stamps.set(key(position), now())
  }
  const chestOf = position => ({ x: position.x, y: position.y, z: position.z })
  const at = (window, position) => !!window?.position && window.position.x === position.x && window.position.y === position.y && window.position.z === position.z

  // Whether the open click can be sent from where the Bot stands: null, or the code of why not.
  const AWAY = { OUT_OF_REACH: 'CONTAINER_NOT_IN_REACH', SIGHT_BLOCKED: 'CONTAINER_NOT_VISIBLE' }
  function access (position) {
    let seen = null
    try { seen = operations.interactions?.previewOpenChest?.(position) } catch { return null }
    if (seen?.ready !== false) return null
    if (AWAY[seen.code]) return AWAY[seen.code]
    const feet = getBlock ? getFeet?.() : null
    if (!feet) return null
    const place = openAccess(at => getBlock(at.x, at.y, at.z), { x: feet.x, y: feet.y + EYE, z: feet.z }, position)
    return place ? AWAY[place.code] ?? null : null
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
  async function open (position, options = {}, mine = session(options)) {
    if (mine.stop()) return cut(mine, 'CONTAINER_INTERRUPTED')
    const away = access(position)
    if (away) return failed(away, { evidence: { chest: chestOf(position) } })
    let receipt
    try { receipt = await patient(() => operations.chest.open(position), mine.stop) } catch (error) { return cut(mine, 'CONTAINER_INTERRUPTED') ?? refusal(position, error) }
    if (mine.stop()) return cut(mine, 'CONTAINER_INTERRUPTED')
    const window = view()?.window
    if (!at(window, position) || (receipt?.windowId != null && receipt.windowId !== window.id)) return interrupted('CONTAINER_CHANGED')
    mine.window = window
    const received = await until(() => view()?.contentsKnown === true, OPEN_MS, mine.stop)
    if (mine.stop()) return cut(mine, 'CONTAINER_INTERRUPTED')
    if (!received) return blocked('CONTAINER_CONTENTS_UNKNOWN', { kind: 'container_update', timeoutMs: SLOT_MS }, { evidence: { chest: chestOf(position) } })
    remember(position)
    return completed('CONTAINER_OPEN', { evidence: { chest: chestOf(position), room: room(position), slotCount: view()?.window?.slotCount ?? null } })
  }

  // Opens the chest, reads it and closes it again.
  async function inspect (position, options = {}) {
    const mine = session(options)
    try {
      const out = await open(position, options, mine)
      if (mine.stop()) return cut(mine, 'CONTAINER_INTERRUPTED')
      if (out.status !== 'completed') return out
      const cargo = typeof options.cargo === 'function' ? options.cargo() : options.cargo ?? []
      // This only selects a chest to try; the lower operation proves item
      // identity (including NBT) before sending any merge request.
      const mayMerge = contents(position).some(slot => slot.known === true && slot.count > 0 && slot.count < 64 && cargo.some(stack => stack.name === slot.name))
      return { ...out, evidence: { ...out.evidence, mayMerge } }
    } finally { close(mine) }
  }

  // cargo: the stacks to deposit, [{ slot, name, count }], or a function that
  // reads them from the inventory as it is now.
  async function deposit (position, cargo, { aborted = () => false } = {}) {
    const mine = session({ aborted })
    const fixed = Array.isArray(cargo) ? cargo.map(stack => ({ ...stack })) : null
    const plan = fixed ? () => fixed.filter(stack => stack.count > 0) : cargo
    const skipped = new Set(), sign = stack => `${stack.slot}:${stack.name}`
    const left = () => { try { return plan().reduce((sum, stack) => sum + stack.count, 0) } catch { return null } }
    let moved = 0, refused = null
    const answer = (make, code, extra = {}) => make(code, { ...extra, progress: { confirmedTransferred: moved }, remaining: { items: left() }, evidence: { chest: chestOf(position), room: room(position), ...extra.evidence } })
    const opened = await open(position, { aborted }, mine)
    if (opened.status !== 'completed') { close(mine); return { ...opened, progress: { confirmedTransferred: 0 }, remaining: { items: left() } } }
    try {
      for (let step = 0; step < MAX_TRANSFERS; step++) {
        if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'DEPOSIT_INTERRUPTED')
        if (getInventory() == null) return blocked('TRANSFER_UNCONFIRMED', { kind: 'inventory_update', timeoutMs: 30000 }, { progress: { confirmedTransferred: moved }, evidence: { chest: chestOf(position) } })
        const stack = plan().find(candidate => !skipped.has(sign(candidate)))
        if (!stack) break
        const window = view()
        if (window?.contentsKnown !== true) return answer((code, extra) => blocked(code, { kind: 'container_update', timeoutMs: SLOT_MS }, extra), 'CONTAINER_CONTENTS_UNKNOWN')
        remember(position)
        const source = items().find(item => item.slot === stack.slot && item.name === stack.name && item.count > 0)
        if (!source) { skipped.add(sign(stack)); continue }
        const wanted = Math.min(stack.count, source.count, 64), before = source.count
        // Full for the whole amount may still leave several smaller matching
        // stacks. CONTAINER_FULL is a pre-send refusal; only then try their
        // received capacities. The chest module alone chooses a compatible
        // destination, so matching names never bypass its NBT check.
        const sizes = [...new Set([wanted, ...(window.slots ?? []).filter(slot => slot.known === true && slot.name === stack.name && slot.count > 0 && slot.count < 64).map(slot => Math.min(wanted, 64 - slot.count))])].sort((a, b) => b - a)
        let amount = 0, full = false, receipt = null
        try {
          for (const size of sizes) {
            try { receipt = await patient(() => operations.chest.depositItem({ sourceSlot: stack.slot, count: size, expectedName: stack.name }), mine.stop); amount = size; break } catch (error) {
              if (mine.stop() || error?.code !== 'CONTAINER_FULL') throw error
              full = true
            }
          }
        } catch (error) {
          if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'DEPOSIT_INTERRUPTED', { detail: error?.message })
          if (getInventory() == null || view()?.inventoryUncertain === true) return blocked('TRANSFER_UNCONFIRMED', { kind: 'inventory_update', timeoutMs: 30000 }, { progress: { confirmedTransferred: moved }, evidence: { chest: chestOf(position) }, detail: error?.message })
          refused = error; skipped.add(sign(stack)); continue
        }
        if (!amount && full) return answer(moved > 0 ? partial : failed, 'CONTAINER_FULL')
        // A receipt already confirmed on both sides stays credited even if a
        // fight took the controls just before this await returned. It permits
        // no new operation; callers still discard receipts from an old scope.
        const received = confirmed(receipt, amount) || await until(() => getInventory() != null && (items().find(item => item.slot === stack.slot && item.name === stack.name)?.count ?? 0) <= before - amount, SLOT_MS, mine.stop)
        if (received) { moved += amount; if (fixed) stack.count -= amount }
        if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'DEPOSIT_INTERRUPTED')
        if (!received) return answer((code, extra) => blocked(code, { kind: 'inventory_update', timeoutMs: 30000 }, extra), 'TRANSFER_UNCONFIRMED')
      }
    } catch (error) {
      return answer(moved > 0 ? partial : failed, 'DEPOSIT_FAILED', { detail: error?.message })
    } finally { if (!mine.stop() && view()?.contentsKnown === true) remember(position); close(mine) }
    const rest = left()
    if (rest === 0) return answer(completed, 'CARGO_STORED')
    return answer(moved > 0 ? partial : failed, 'TRANSFER_REJECTED', { detail: refused?.message })
  }

  // The stacks pick(slots) names out of the chest. The answer says how many
  // items the inventory gained, and why the chest did not open or gave nothing
  // (live 2026-11-18 05:11 JST: a chest that gave nothing answered a bare 0,
  // and the log could not say whether it had opened).
  async function withdraw (position, pick, { aborted = () => false } = {}) {
    const mine = session({ aborted })
    let moved = 0, refused = null
    const left = () => getInventory() == null || view()?.contentsKnown !== true ? null : pick(view().slots ?? []).reduce((sum, want) => sum + want.count, 0)
    const answer = (make, code, extra = {}) => make(code, { ...extra, progress: { confirmedTransferred: moved }, remaining: { items: left() }, evidence: { chest: chestOf(position) } })
    const unknown = detail => answer((code, extra) => blocked(code, { kind: 'inventory_update', timeoutMs: 30000 }, extra), 'TRANSFER_UNCONFIRMED', { detail })
    const opened = await open(position, { aborted }, mine)
    if (opened.status !== 'completed') { close(mine); return { ...opened, progress: { confirmedTransferred: 0 } } }
    try {
      for (const want of pick(view().slots ?? [])) {
        if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'WITHDRAW_INTERRUPTED')
        if (getInventory() == null || view()?.inventoryUncertain === true) return unknown()
        const before = count(want.name)
        let receipt
        try { receipt = await patient(() => operations.chest.withdrawItem({ chestSlot: want.chestSlot, count: want.count, expectedName: want.name }), mine.stop) } catch (error) {
          if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'WITHDRAW_INTERRUPTED', { detail: error?.message })
          if (getInventory() == null || view()?.inventoryUncertain === true) return unknown(error?.message)
          refused = error; if (error?.code === 'INVENTORY_FULL') break; continue
        }
        const received = confirmed(receipt, want.count) || await until(() => getInventory() != null && count(want.name) >= before + want.count, SLOT_MS, mine.stop)
        if (received) moved += want.count
        if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'WITHDRAW_INTERRUPTED')
        if (!received) return unknown('取り出した数を持ち物の受信で確認できませんでした。')
      }
      if (mine.stop()) return answer(interrupted, held() ? 'CONTROLS_HELD' : 'WITHDRAW_INTERRUPTED')
      if (getInventory() == null || view()?.inventoryUncertain === true) return unknown()
      if (left() === 0) return answer(completed, 'KIT_TAKEN')
      return answer(moved > 0 ? partial : failed, 'WITHDRAW_REFUSED', { detail: refused?.message })
    } catch (error) { return answer(moved > 0 ? partial : failed, 'WITHDRAW_REFUSED', { detail: error?.message }) } finally { if (!mine.stop() && view()?.contentsKnown === true) remember(position); close(mine) }
  }
  const take = async (position, pick, options) => (await withdraw(position, pick, options)).progress?.confirmedTransferred ?? 0

  // The count alone, for the callers that only add it up (player-storage.js).
  const store = async (position, stacks, options) => (await deposit(position, stacks, options)).progress?.confirmedTransferred ?? 0

  return { open, inspect, deposit, take, withdraw, store, room, contents, patient, access }
}

module.exports = { createContainerPorts }
