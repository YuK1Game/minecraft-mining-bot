'use strict'

// Throwing a held stack on the ground (the player's Q key) through the normal
// inventory screen. User 2026-11-16 23:14 JST: 「チェストを作るために木が拾えないのであれば
// いらないアイテムを捨てればいいのでは？」 — underground there is no wood for a chest
// (live 23:10 JST: 「板材が足りません（板材 8・原木 0・必要 板材 20）」 at y=-37).
// It counts only when the server answers the request with the slot emptied (or
// lowered); the inventory model is then committed from that answer.
const MAIN = { container_id: 'hotbar_and_inventory', dynamic_container_id: null }
const { empty, valid, same, scopeOf, responseSlot, receivedItem, captureMain, validateMain, mainDelta } = require('./response-delta')
const copy = value => structuredClone(value)

function createDiscard ({ client, getState, crafting, allocateRequestId, inventoryStore = null, onInventory = () => {}, onUncertain = () => {}, log = () => {}, timeoutMs = 3000 }) {
  let attempt = null

  async function drop (slot, count = null) {
    if (attempt) throw new Error('前の「捨てる」操作を待っています。')
    const scope = scopeOf(getState())
    if (!Number.isInteger(slot) || slot < 0 || slot > 35) throw new Error('捨てる枠は持ち物の0〜35で指定してください。')
    if (crafting.snapshot?.().pendingRequestId != null) throw new Error('クラフト結果を待ってから捨ててください。')
    const raw = crafting.rawItem(slot)
    if (!valid(raw) || empty(raw)) throw new Error('捨てる枠の実際の持ち物を確認できません。')
    const amount = Number.isInteger(count) && count > 0 ? Math.min(count, raw.count) : raw.count
    const id = allocateRequestId()
    const mine = attempt = { id, slot, raw: copy(raw), amount, scope, before: captureMain(crafting, inventoryStore, slot), done: null, wireSent: false, finished: false, preempted: false }
    let opened = null
    try {
      if (!crafting.snapshot().openContainer) opened = await crafting.openInventory() ?? crafting.snapshot().openContainer
      if (mine.finished) return mine.result
      if (mine.preempted) return { phase: 'stopped', code: 'COMBAT_PREEMPTED', serverConfirmed: false }
      if (scopeOf(getState()) !== mine.scope) throw Error('持ち物を捨てる途中で接続またはlifeが変わりました。')
      validateMain(crafting, inventoryStore, slot, mine.before)
      const settled = new Promise(resolve => { mine.done = resolve })
      mine.wireSent = true
      client.queue('item_stack_request', { requests: [{ request_id: id, actions: [{ type_id: 'drop', legacy_type_id: 3, count: amount, source: { slot_type: copy(MAIN), slot, stack_id: raw.stack_id }, randomly: false }], custom_names: [], cause: -1 }] })
      const timer = setTimeout(() => finish(mine, { phase: 'failed', serverConfirmed: false, reason: 'no server response' }), timeoutMs)
      const result = await settled
      clearTimeout(timer)
      return result
    } catch (error) {
      const result = { phase: 'failed', serverConfirmed: false, reason: String(error.message ?? error) }
      finish(mine, result)
      return result
    } finally {
      if (attempt === mine) attempt = null
      if (opened && !mine.preempted) { try { if (scopeOf(getState()) === mine.scope && crafting.snapshot().openContainer?.id === opened.id) crafting.closeContainer() } catch { /* The new life or another operation owns the screen. */ } }
    }
  }

  function finish (mine, result) {
    if (mine.finished) return
    mine.finished = true; mine.result = result
    if (mine.wireSent && result.phase !== 'rejected' && result.serverConfirmed !== true) {
      try { if (scopeOf(getState()) === mine.scope) onUncertain({ requestId: mine.id, operation: 'discard', reason: result.reason }) } catch { /* The host already observed a different life. */ }
    }
    mine.done?.(result)
  }

  function preemptForCombat () {
    if (attempt) attempt.preempted = true
    return { preempted: !!attempt, pendingRequestId: attempt?.wireSent ? attempt.id : null }
  }

  function applyPacket (name, packet) {
    const mine = attempt
    if (!mine || mine.finished || !['item_stack_response', 'start_game', 'change_dimension', 'disconnect', 'death_info', 'respawn'].includes(name)) return
    try {
      if (['start_game', 'change_dimension', 'disconnect', 'death_info'].includes(name) || scopeOf(getState()) !== mine.scope) {
        finish(mine, { phase: 'failed', serverConfirmed: false, reason: '接続・次元・lifeが変わりました。' }); return
      }
    } catch (error) { finish(mine, { phase: 'failed', serverConfirmed: false, reason: error.message }); return }
    if (name !== 'item_stack_response') return
    for (const response of packet.responses ?? []) {
      if (response.request_id !== mine.id) continue
      if (response.status !== 'ok' && response.status !== 0) { finish(mine, { phase: 'rejected', serverConfirmed: false, reason: `server status ${response.status}` }); return }
      try {
        // Bedrock can omit the stack ID when the accepted drop emptied
        // the requested slot. A remaining stack still needs its own ID.
        const row = responseSlot(response, 'main', mine.slot, mine.raw.count - mine.amount, { allowMissingEmptyStackId: true })
        const item = receivedItem(mine.raw, row)
        validateMain(crafting, inventoryStore, mine.slot, mine.before, item)
        onInventory(mainDelta(mine.slot, item, mine.id, 'discard'))
        if (mine.finished) return
        if (scopeOf(getState()) !== mine.scope) throw Error('捨てる操作の応答反映中に接続またはlifeが変わりました。')
        if (!same(crafting.rawItem(mine.slot), item)) throw Error('捨てる操作の受理応答を持ち物1枠へ反映できませんでした。')
        finish(mine, { phase: 'completed', serverConfirmed: true, confirmedBy: 'matching_response_slot', slot: mine.slot, count: mine.amount, left: row.count, requestId: mine.id })
        try { log(`持ち物を捨てました: 枠 ${mine.slot} ${mine.amount} 個（残り ${row.count}）`) } catch {}
      } catch (error) { finish(mine, { phase: 'failed', serverConfirmed: false, reason: String(error.message ?? error) }) }
      return
    }
  }

  return { drop, applyPacket, preemptForCombat, busy: () => !!attempt }
}

module.exports = { createDiscard }
