'use strict'

// Throwing a held stack on the ground (the player's Q key) through the normal
// inventory screen. User 2026-11-16 23:14 JST: 「チェストを作るために木が拾えないのであれば
// いらないアイテムを捨てればいいのでは？」 — underground there is no wood for a chest
// (live 23:10 JST: 「板材が足りません（板材 8・原木 0・必要 板材 20）」 at y=-37).
// It counts only when the server answers the request with the slot emptied (or
// lowered); the inventory model is then committed from that answer.
const MAIN = { container_id: 'hotbar_and_inventory', dynamic_container_id: null }
const MAIN_IDS = new Set(['hotbar_and_inventory', 'inventory', 'hotbar', 12, 28, 29])
const copy = value => structuredClone(value)
const EMPTY = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const empty = item => !item || item.network_id === 0 || !(item.count > 0)

function createDiscard ({ client, getState, crafting, allocateRequestId, onInventory = () => {}, log = () => {}, timeoutMs = 3000 }) {
  let attempt = null

  async function drop (slot, count = null) {
    if (attempt) throw new Error('前の「捨てる」操作を待っています。')
    const state = getState()
    if (state?.phase !== 'spawned' || state.dead === true || state.isDead === true) throw new Error('死亡中・接続前は捨てられません。')
    if (!Number.isInteger(slot) || slot < 0 || slot > 35) throw new Error('捨てる枠は持ち物の0〜35で指定してください。')
    if (crafting.snapshot?.().pendingRequestId != null) throw new Error('クラフト結果を待ってから捨ててください。')
    const raw = crafting.rawItem(slot)
    if (empty(raw) || raw.has_stack_id !== true || !(raw.stack_id > 0)) throw new Error('捨てる枠の実際の持ち物を確認できません。')
    const amount = Number.isInteger(count) && count > 0 ? Math.min(count, raw.count) : raw.count
    const id = allocateRequestId()
    const mine = attempt = { id, slot, raw: copy(raw), amount, done: null }
    let openedHere = false
    try {
      if (!crafting.snapshot().openContainer) { await crafting.openInventory(); openedHere = true }
      const settled = new Promise(resolve => { mine.done = resolve })
      client.queue('item_stack_request', { requests: [{ request_id: id, actions: [{ type_id: 'drop', legacy_type_id: 3, count: amount, source: { slot_type: copy(MAIN), slot, stack_id: raw.stack_id }, randomly: false }], custom_names: [], cause: -1 }] })
      const timer = setTimeout(() => mine.done?.({ phase: 'failed', reason: 'no server response' }), timeoutMs)
      const result = await settled
      clearTimeout(timer)
      return result
    } finally {
      if (attempt === mine) attempt = null
      if (openedHere) { try { crafting.closeContainer() } catch { /* a pending craft owns the screen */ } }
    }
  }

  function applyPacket (name, packet) {
    const mine = attempt
    if (!mine || name !== 'item_stack_response') return
    for (const response of packet.responses ?? []) {
      if (response.request_id !== mine.id) continue
      if (response.status !== 'ok' && response.status !== 0) { mine.done?.({ phase: 'rejected', reason: `server status ${response.status}` }); return }
      // The answer names the source slot's new count; commit it to the model.
      let left = mine.raw.count - mine.amount
      for (const container of response.containers ?? []) if (MAIN_IDS.has(container.slot_type?.container_id)) for (const row of container.slots ?? []) if (row.slot === mine.slot && Number.isInteger(row.count)) left = row.count
      try {
        const input = Array.from({ length: 36 }, (_, slot) => copy(crafting.rawItem(slot) ?? EMPTY()))
        input[mine.slot] = left > 0 ? { ...mine.raw, count: left } : EMPTY()
        onInventory({ window_id: 'inventory', input, container: { container_id: 'inventory', dynamic_container_id: null } })
      } catch { /* the next server inventory corrects the model */ }
      try { log(`持ち物を捨てました: 枠 ${mine.slot} ${mine.amount} 個（残り ${left}）`) } catch {}
      mine.done?.({ phase: 'completed', serverConfirmed: true, slot: mine.slot, count: mine.amount, left })
    }
  }

  return { drop, applyPacket, busy: () => !!attempt }
}

module.exports = { createDiscard }
