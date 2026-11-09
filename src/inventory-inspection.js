'use strict'

const { readShulkerContents } = require('./shulker-contents')
const { isShulkerBox } = require('./container-types')

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
const mainWindow = id => id === 'inventory' || id === 0
const armorWindow = id => id === 'armor' || id === 120
const offhandWindow = id => id === 'offhand' || id === 119
const validRaw = raw => object(raw) && Number.isInteger(raw.network_id) && integer(raw.count) && (raw.network_id === 0 ? raw.count === 0 : raw.count > 0)
const unknownSlot = slot => ({ slot, known: false, empty: false, name: null, count: null })

// This view never opens a container, changes equipment, or sends a packet.
// Item names come from the received registry; static game data supplies only
// item properties (maximum durability and enchantment names).
function createInventoryInspection ({ crafting, armorStore = {}, getChest = () => null, getState = () => ({}), store = {}, version = '1.26.60', registry, clock = () => new Date().toISOString() }) {
  const data = registry ?? require('prismarine-registry')(`bedrock_${version}`)
  const offhand = store.offhand instanceof Map ? store.offhand : (store.offhand = new Map())
  // A server can refresh equipment one slot at a time rather than resend the
  // full window. Count only actual valid observations in this lifecycle.
  const mainReceived = store.mainReceived instanceof Set ? store.mainReceived : (store.mainReceived = new Set())
  const armorReceived = store.armorReceived instanceof Set ? store.armorReceived : (store.armorReceived = new Set())
  function receiveSlots (set, size, name, packet) {
    if (name === 'inventory_content') {
      set.clear()
      if (!Array.isArray(packet.input) || packet.input.length < size || size === 36 && packet.input.length !== 36) return false
      for (let slot = 0; slot < size; slot++) if (validRaw(packet.input[slot])) set.add(slot)
    } else if (Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot < size) {
      if (validRaw(packet.item)) set.add(packet.slot)
      else set.delete(packet.slot)
    }
    return set.size === size
  }
  const resolveName = id => crafting.itemNameOf?.(id) ?? null
  // Bedrock also sends a fifth armor/body slot. The previous inspector rejected
  // that full packet by its length, while Armor retained its received slots.
  // Recover that specific old view from the retained full-window evidence.
  if (store.armorInvalidated === true && store.armorInvalidationSource == null && store.armorObservedAt != null && armorStore.known === true && armorStore.worn instanceof Map && armorStore.worn.size >= 5 && Array.from({ length: 4 }, (_, slot) => validRaw(armorStore.worn.get(slot))).every(Boolean)) store.armorInvalidated = false

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
    if (replaying) return
    if (name === 'start_game' || name === 'change_dimension' || name === 'death_info' || name === 'respawn' && (packet.runtime_entity_id == null || String(packet.runtime_entity_id) === String(getState().runtimeEntityId))) {
      mainReceived.clear(); armorReceived.clear()
      offhand.clear(); store.offhandKnown = false; store.offhandObservedAt = null
      store.mainInvalidated = true; store.armorInvalidated = true; store.armorObservedAt = null; store.observedAt = null; store.containerObservedAt = null
      store.armorInvalidationSource = 'lifecycle'
    }
    if (name === 'inventory_content' || name === 'inventory_slot') {
      if (mainWindow(packet.window_id)) {
        store.observedAt = clock()
        const complete = receiveSlots(mainReceived, 36, name, packet)
        if (name === 'inventory_content') store.mainInvalidated = !(Array.isArray(packet.input) && packet.input.length === 36 && complete)
        else if (complete) store.mainInvalidated = false
      } else if (armorWindow(packet.window_id)) {
        // A rejected armor transaction can separately invalidate the controller.
        // Do not use earlier coverage to revive its other three cached slots.
        if (name === 'inventory_slot' && armorStore.known !== true && store.armorInvalidated !== true) {
          armorReceived.clear(); store.armorInvalidated = true; store.armorInvalidationSource = 'controller'
        }
        store.armorObservedAt = clock()
        const complete = receiveSlots(armorReceived, 4, name, packet)
        if (name === 'inventory_content') {
          store.armorInvalidated = !(Array.isArray(packet.input) && packet.input.length >= 4 && complete)
          store.armorInvalidationSource = store.armorInvalidated ? 'incomplete_window' : null
        } else if (complete) {
          // Armor applies the same raw packet after this observer; all four
          // pieces now have current-life evidence, not pre-respawn leftovers.
          store.armorInvalidated = false; store.armorInvalidationSource = null
          armorStore.known = true
        }
      }
      else if (offhandWindow(packet.window_id)) {
        store.offhandObservedAt = clock()
        if (name === 'inventory_content' && Array.isArray(packet.input) && packet.input.length === 1 && validRaw(packet.input[0])) { offhand.clear(); offhand.set(0, structuredClone(packet.input[0])); store.offhandKnown = true }
        else if (name === 'inventory_slot' && packet.slot === 0 && validRaw(packet.item)) { offhand.set(0, structuredClone(packet.item)); store.offhandKnown = true }
        else { offhand.clear(); store.offhandKnown = false }
      } else store.containerObservedAt = clock()
    }
    if (name === 'item_stack_response') {
      for (const response of packet.responses ?? []) if (response.status === 'ok' || response.status === 0) for (const container of response.containers ?? []) {
        const id = container.slot_type?.container_id
        if (['inventory', 'hotbar_and_inventory', 'hotbar', 12, 28, 29].includes(id)) store.observedAt = clock()
        if (id === 'armor') store.armorObservedAt = clock()
        // Count-only updates do not identify a new offhand stack or its NBT.
        if (id === 'offhand') { offhand.clear(); store.offhandKnown = false }
      }
    }
  }

  function snapshot (state = getState()) {
    const status = crafting.status?.() ?? crafting.snapshot?.() ?? {}
    const alive = state.health !== 0 && !state.dead && !state.isDead && !state.lifecycle?.dead
    const known = alive && store.mainInvalidated !== true && state.inventory?.known === true && !state.inventory?.uncertain && status.inventoryKnown === true
    const slots = Array.from({ length: 36 }, (_, slot) => describe(crafting.rawItem(slot), slot, known))
    const armorKnown = alive && armorStore.known === true && store.armorInvalidated !== true
    const armor = { known: armorKnown, observedAt: store.armorObservedAt ?? null, slots: ARMOR_PIECES.map((piece, slot) => ({ ...describe(armorStore.worn?.get(slot), slot, armorKnown), piece })) }
    armor.known = armor.known && armor.slots.every(slot => slot.known)
    const offhandKnown = alive && store.offhandKnown === true
    const offhandView = { known: offhandKnown, observedAt: store.offhandObservedAt ?? null, slots: [describe(offhand.get(0), 0, offhandKnown)] }
    const containers = slots.filter(item => item.container).map(item => ({ id: `inventory:${item.slot}`, kind: 'shulker', name: item.displayName ?? item.name, location: 'inventory', sourceSlot: item.slot, observedAt: store.observedAt ?? null, ...item.container }))
    const chest = getChest(), chestStatus = chest?.snapshot?.()
    let openContainer = null
    if (chestStatus?.window) {
      const size = chestStatus.slotCount ?? chestStatus.window.expectedSlots ?? 27
      const containerKnown = chestStatus.contentsKnown === true && chestStatus.window.replayed !== true
      openContainer = {
        id: `window:${chestStatus.window.id}`, kind: chestStatus.kind, name: chestStatus.blockName, position: chestStatus.window.position,
        known: containerKnown, slotCount: size, observedAt: store.containerObservedAt ?? null,
        slots: Array.from({ length: Math.min(54, size) }, (_, slot) => describe(chest.rawItem(slot), slot, containerKnown))
      }
    }
    return {
      known: known && slots.every(slot => slot.known), uncertain: state.inventory?.uncertain === true, observedAt: store.observedAt ?? null,
      selectedSlot: Number.isInteger(state.selectedSlot) ? state.selectedSlot : null, selectedSlotSource: state.equipmentSource ?? 'local_selection',
      slotCount: 36, slots, armor, offhand: offhandView, containers, openContainer
    }
  }

  return { applyPacket, snapshot }
}

module.exports = { createInventoryInspection }
