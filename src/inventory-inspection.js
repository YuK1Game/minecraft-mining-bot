'use strict'

const { readShulkerContents } = require('./shulker-contents')
const { isShulkerBox } = require('./container-types')
const { createInventoryStore } = require('./inventory-store')

const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots']
const ENCHANTMENT_LABELS = {
  protection: 'ダメージ軽減', fire_protection: '火炎耐性', feather_falling: '落下耐性', blast_protection: '爆発耐性', projectile_protection: '飛び道具耐性',
  thorns: '棘の鎧', respiration: '水中呼吸', depth_strider: '水中歩行', aqua_affinity: '水中採掘', sharpness: '鋭さ', smite: '聖なる力',
  bane_of_arthropods: '虫殺し', knockback: 'ノックバック', fire_aspect: '火属性', looting: 'アイテムボーナス', efficiency: '効率',
  silk_touch: 'シルクタッチ', unbreaking: '耐久力', fortune: '幸運', power: 'パワー', punch: '衝撃', flame: '火炎', infinity: '無限',
  luck_of_the_sea: '宝釣り', lure: '入れ食い', frost_walker: '氷渡り', mending: '修繕', binding_curse: '束縛の呪い', vanishing_curse: '消滅の呪い',
  impaling: '串刺し', riptide: '激流', loyalty: '忠誠心', channeling: '召雷', multishot: '拡散', piercing: '貫通', quick_charge: '高速装填',
  soul_speed: 'ソウルスピード', swift_sneak: 'スニーク速度上昇', density: '高密度', breach: '防具貫通', wind_burst: 'ウィンドバースト'
}
const integer = value => Number.isSafeInteger(value) && value >= 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const compound = value => value?.type === 'compound' && object(value.value)
const plain = new Set([false, 'false', 0])
const tagged = new Set([true, 'true', 65535])
const validRaw = raw => object(raw) && Number.isInteger(raw.network_id) && integer(raw.count) && (raw.network_id === 0 ? raw.count === 0 : raw.count > 0)
const unknownSlot = slot => ({ slot, known: false, empty: false, name: null, count: null })

// This view never opens a container, changes equipment, or sends a packet.
// Item names come from the received registry; static game data supplies only
// item properties (maximum durability and enchantment names).
//
// Every slot shown here (main, armour, offhand) comes from the one inventory
// store. The same record answers "what is worn" for the dashboard, the quarry
// gates and recovery evidence, so they can no longer disagree. Without a
// shared store (tests, tools) the inspection keeps a private one fed by its
// own applyPacket.
function createInventoryInspection ({ crafting, inventoryStore = null, getChest = () => null, getState = () => ({}), store = {}, version = '1.26.60', registry, clock = () => new Date().toISOString() }) {
  const data = registry ?? require('prismarine-registry')(`bedrock_${version}`)
  const ownsStore = !(inventoryStore && typeof inventoryStore.view === 'function')
  const scopeOf = () => {
    const s = getState()
    return [s?.profile ?? null, s?.realm?.id == null ? null : String(s.realm.id), s?.connectionId ?? null, s?.startedAt ?? null, String(s?.runtimeEntityId ?? ''), s?.lifecycle?.deathId ?? null]
  }
  const records = ownsStore ? createInventoryStore({ shared: store, key: 'records', clock, getScope: scopeOf }) : inventoryStore
  function rawEquipment (kind, slot) {
    records.syncScope?.()
    const state = getState()
    if (!['armor', 'offhand'].includes(kind) || !Number.isInteger(slot) || slot < 0 || slot >= (kind === 'armor' ? 4 : 1) || state.health === 0 || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending) return null
    const raw = records.raw(kind, slot)
    return raw && validRaw(raw) ? raw : null
  }
  const resolveName = id => crafting.itemNameOf?.(id) ?? null
  function tagOf (raw) {
    const extra = raw?.extra
    if (plain.has(extra?.has_nbt) && extra.nbt == null) return { known: true, tag: null }
    const tag = extra?.nbt?.nbt ?? extra?.nbt
    return tagged.has(extra?.has_nbt) && compound(tag) ? { known: true, tag } : { known: false, tag: null }
  }

  function properties (name, tag, tagKnown) {
    const value = tag?.value
    const definition = data.itemsByName?.[String(name ?? '').replace(/^minecraft:/, '')]
    const maxDurability = integer(definition?.maxDurability) && definition.maxDurability > 0 ? definition.maxDurability : null
    const damage = value?.Damage
    // Metadata is a block/item variation, never a fallback for wear.
    const used = tagKnown && tag === null ? 0 : ['int', 'short'].includes(damage?.type) && integer(damage.value) ? damage.value : null
    const durabilityKnown = maxDurability !== null && used !== null && used <= maxDurability
    const display = compound(value?.display) ? value.display.value : null
    const lore = display?.Lore
    const enchantments = []
    const enchantTag = value?.ench
    let enchantmentsKnown = tagKnown && enchantTag == null
    if (enchantTag?.type === 'list' && ['compound', 'end'].includes(enchantTag.value?.type) && Array.isArray(enchantTag.value?.value) && enchantTag.value.value.length <= 64) {
      enchantmentsKnown = true
      for (const entry of enchantTag.value.value) {
        const e = compound(entry) ? entry.value : entry
        const id = e?.id?.value, level = e?.lvl?.value
        if (!['short', 'int'].includes(e?.id?.type) || !integer(id) || !['short', 'int'].includes(e?.lvl?.type) || !integer(level) || level < 1) { enchantmentsKnown = false; continue }
        const definition = data.enchantments?.[id]
        const enchantName = definition?.name ?? `id_${id}`
        enchantments.push({ id, name: enchantName, label: ENCHANTMENT_LABELS[enchantName] ?? definition?.displayName ?? `不明なエンチャント (${id})`, level })
      }
    }
    return {
      displayName: display?.Name?.type === 'string' && typeof display.Name.value === 'string' ? display.Name.value.slice(0, 512) : null,
      lore: lore?.type === 'list' && lore.value?.type === 'string' && Array.isArray(lore.value.value) ? lore.value.value.filter(line => typeof line === 'string').slice(0, 50).map(line => line.slice(0, 1024)) : [],
      maxStackSize: integer(definition?.stackSize) ? definition.stackSize : null,
      durabilityApplicable: maxDurability !== null, durabilityKnown, maxDurability,
      durabilityUsed: durabilityKnown ? used : null, durabilityRemaining: durabilityKnown ? maxDurability - used : null,
      durabilitySource: durabilityKnown ? 'server_item_nbt' : null, enchantmentsKnown, enchantments,
      unbreakable: tagKnown && value?.Unbreakable?.type === 'byte' ? value.Unbreakable.value !== 0 : null,
      repairCost: ['int', 'short'].includes(value?.RepairCost?.type) && integer(value.RepairCost.value) ? value.RepairCost.value : null
    }
  }

  function persistedItem (item) {
    if (!item) return null
    return { slot: item.slot, known: true, empty: false, name: item.name, count: item.count, metadata: item.metadata, networkId: null, stackId: null, ...properties(item.name, item.tag, true) }
  }

  function describe (raw, slot, known = true) {
    if (!known || !validRaw(raw)) return unknownSlot(slot)
    if (raw.network_id === 0) return { slot, known: true, empty: true, name: null, count: 0 }
    const name = resolveName(raw.network_id), observed = tagOf(raw)
    const result = {
      slot, known: true, empty: false, name, identityKnown: name !== null, count: raw.count,
      networkId: raw.network_id, stackId: raw.has_stack_id && integer(raw.stack_id) && raw.stack_id > 0 ? raw.stack_id : null,
      metadata: integer(raw.metadata) ? raw.metadata : null, ...properties(name, observed.tag, observed.known)
    }
    if (isShulkerBox(name)) {
      const contents = readShulkerContents(raw, { resolveName })
      result.container = { ...contents, slots: contents.known ? contents.slots.map(persistedItem) : null }
    }
    return result
  }

  function applyPacket (name, packet, { replaying = false } = {}) {
    // A shared store is fed once by the runtime; only a private one is fed here.
    if (ownsStore) records.apply(name, packet, { replaying })
  }

  function snapshot (state = getState()) {
    const status = crafting.status?.() ?? crafting.snapshot?.() ?? {}
    const alive = state.health !== 0 && !state.dead && !state.isDead && !state.lifecycle?.dead
    records.syncScope?.()
    const main = records.view('main')
    const known = alive && main.known && state.inventory?.known === true && !state.inventory?.uncertain && status.inventoryKnown === true
    // In production crafting's main map is the store itself; reading it keeps
    // the private-store mode (tests) on the same transaction data.
    const slots = Array.from({ length: 36 }, (_, slot) => describe(ownsStore ? crafting.rawItem(slot) : main.slots[slot].raw, slot, known && main.slots[slot].received))
    const equipment = (kind, size) => {
      // Shown as the server last confirmed it, including our own accepted
      // moves; rawEquipment() below additionally requires a server window.
      const v = records.view(kind, { loose: true })
      const rows = Array.from({ length: size }, (_, slot) => describe(v.slots[slot].raw, slot, alive && v.slots[slot].received))
      return { known: alive && rows.every(slot => slot.known), observedAt: v.observedAt, revision: v.revision, slots: rows }
    }
    const armor = equipment('armor', 4)
    armor.slots = armor.slots.map((slot, index) => ({ ...slot, piece: ARMOR_PIECES[index] }))
    const offhandView = equipment('offhand', 1)
    const containers = slots.filter(item => item.container).map(item => ({ id: `inventory:${item.slot}`, kind: 'shulker', name: item.displayName ?? item.name, location: 'inventory', sourceSlot: item.slot, observedAt: main.observedAt, ...item.container }))
    const chest = getChest(), chestStatus = chest?.snapshot?.()
    let openContainer = null
    if (chestStatus?.window) {
      const size = chestStatus.slotCount ?? chestStatus.window.expectedSlots ?? 27
      const containerKnown = chestStatus.contentsKnown === true && chestStatus.window.replayed !== true
      openContainer = {
        id: `window:${chestStatus.window.id}`, kind: chestStatus.kind, name: chestStatus.blockName, position: chestStatus.window.position,
        known: containerKnown, slotCount: size, observedAt: chestStatus.observedAt ?? null,
        slots: Array.from({ length: Math.min(54, size) }, (_, slot) => describe(chest.rawItem(slot), slot, containerKnown))
      }
    }
    return {
      known: known && slots.every(slot => slot.known), uncertain: state.inventory?.uncertain === true, observedAt: main.observedAt, revision: records.revision(),
      selectedSlot: Number.isInteger(state.selectedSlot) ? state.selectedSlot : null, selectedSlotSource: state.equipmentSource ?? 'local_selection',
      slotCount: 36, slots, armor, offhand: offhandView, containers, openContainer
    }
  }

  return { applyPacket, snapshot, rawEquipment }
}

module.exports = { createInventoryInspection }
