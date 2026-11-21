'use strict'

const { isDeepStrictEqual } = require('node:util')

// A matching request ID proves which action was answered, not the resulting
// slot contents. Armor and discard share these receipt and freshness rules.
const empty = raw => raw?.network_id === 0 && raw.count === 0
const valid = raw => raw && Number.isInteger(raw.network_id) && Number.isInteger(raw.count) && raw.count >= 0 && raw.count <= 255 &&
  (empty(raw) ? raw.has_stack_id !== true || raw.stack_id === 0 : raw.network_id !== 0 && raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)
const emptyItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const same = (a, b) => valid(a) && valid(b) && (empty(a) && empty(b) || isDeepStrictEqual(a, b))

function scopeOf (state) {
  if (state?.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || state.lifecycle?.dead || !(state.health > 0)) throw Error('持ち物操作には現在の生存状態が必要です。')
  const life = state.lifecycle?.deathId
  if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !String(state.realm.id) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) || !['overworld', 'nether', 'end'].includes(state.dimension) || !/^[1-9]\d*$/.test(String(state.runtimeEntityId ?? '')) || !Number.isSafeInteger(life) || life < 0) throw Error('持ち物操作には現在の接続・Realm・自己ID・次元・lifeの確認が必要です。')
  return JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, state.dimension, String(state.runtimeEntityId), life])
}

function responseSlot (response, kind, slot, count) {
  const matches = id => kind === 'main'
    ? ['hotbar_and_inventory', 12].includes(id) || ['hotbar', 28].includes(id) && slot < 9 || ['inventory', 29].includes(id) && slot >= 9
    : kind === 'armor' ? ['armor', 6].includes(id) : ['offhand', 34].includes(id)
  const rows = (response.containers ?? []).filter(container => container.slot_type?.dynamic_container_id == null && matches(container.slot_type?.container_id)).flatMap(container => container.slots ?? []).filter(row => row.slot === slot)
  if (rows.length !== 1) throw Error('受理応答に対象スロットが1つずつ含まれていません。')
  const row = rows[0]
  if (row.count !== count || !Number.isInteger(row.item_stack_id) || (count === 0 ? row.item_stack_id !== 0 : row.item_stack_id <= 0 || row.item_stack_id > 2147483647)) throw Error('受理応答の個数・スタックIDを確認できません。')
  return row
}

function receivedItem (before, row) {
  const name = before?.extra?.nbt?.nbt?.value?.display?.value?.Name?.value
  if (row.durability_correction != null && row.durability_correction !== 0 || [row.custom_name, row.filtered_custom_name].some(value => value != null && value !== '' && value !== name)) throw Error('受理応答のアイテム補正には実スロットの再受信が必要です。')
  if (row.count === 0) return emptyItem()
  if (!valid(before) || empty(before)) throw Error('応答を照合する元アイテムが未受信です。')
  return { ...structuredClone(before), count: row.count, has_stack_id: true, stack_id: row.item_stack_id }
}

function captureMain (crafting, store, slot) {
  const item = crafting.rawItem(slot)
  if (!valid(item)) throw Error('対象スロットの実アイテムを確認できません。')
  return { item: structuredClone(item), revision: store?.slotInfo?.('main', slot)?.revision ?? null }
}

function validateMain (crafting, store, slot, before, after) {
  const current = crafting.rawItem(slot)
  if (same(current, after)) return
  const revision = store?.slotInfo?.('main', slot)?.revision ?? null
  if (!same(current, before.item) || before.revision != null && revision !== before.revision) throw Error('対象スロットの新しい受信結果を古い要求で上書きできません。')
}

function mainDelta (slot, item, requestId, operation) {
  return { window_id: 'inventory', slot, item: structuredClone(item), source: 'server_item_stack_response', requestId, operation, fullRefresh: false }
}

module.exports = { empty, valid, same, scopeOf, responseSlot, receivedItem, captureMain, validateMain, mainDelta }
