'use strict'

const createItem = require('prismarine-item')

// Bedrock enchantment ids found in the item NBT "ench" list.
const ENCHANTMENT_NAMES = { 15: 'efficiency', 16: 'silk_touch', 17: 'unbreaking', 18: 'fortune', 26: 'mending', 9: 'sharpness', 10: 'smite', 11: 'bane_of_arthropods', 12: 'knockback', 13: 'fire_aspect', 14: 'looting', 19: 'power', 20: 'punch', 21: 'flame', 22: 'infinity' }
// [{ name, level }] from the server item's NBT; [] when there is none.
function enchantmentsOf (raw) {
  const list = raw?.extra?.nbt?.nbt?.value?.ench?.value?.value
  if (!Array.isArray(list)) return []
  return list.map(e => ({ name: ENCHANTMENT_NAMES[e?.id?.value] ?? `id_${e?.id?.value}`, level: Number(e?.lvl?.value) || 0 })).filter(e => e.level > 0)
}

function createDurabilityReader (version = '1.26.60') {
  const Item = createItem(`bedrock_${version}`)
  return function durability (description, raw) {
    if (!description || !/_(?:pickaxe|sword|shovel|axe|hoe)$/.test(description.name ?? '')) return description
    try {
      if (!raw || raw.count !== description.count || !raw.has_stack_id || !Number.isInteger(raw.stack_id) || raw.stack_id <= 0 || description.stackId != null && raw.stack_id !== description.stackId) return { ...description, durabilityKnown: false }
      if (/_sword$/.test(description.name)) {
        const extra = raw.extra, tagged = [true, 'true', 1].includes(extra?.has_nbt), plain = [false, 'false', 0].includes(extra?.has_nbt)
        const tag = extra?.nbt?.nbt, damage = tag?.value?.Damage
        if (!tagged && !plain || tagged && (tag?.type !== 'compound' || !['int', 'short'].includes(damage?.type) || !Number.isSafeInteger(damage?.value))) return { ...description, durabilityKnown: false }
      }
      const parsed = Item.fromNotch(structuredClone(raw))
      if (`minecraft:${parsed.name}` !== description.name || !Number.isInteger(parsed.maxDurability) || !Number.isInteger(parsed.durabilityUsed) || parsed.durabilityUsed < 0 || parsed.durabilityUsed > parsed.maxDurability) return { ...description, durabilityKnown: false }
      return { ...description, enchantments: enchantmentsOf(raw), stackId: raw.stack_id, durabilityKnown: true, durabilityUsed: parsed.durabilityUsed, maxDurability: parsed.maxDurability, durabilityRemaining: parsed.maxDurability - parsed.durabilityUsed, durabilitySource: 'server_item_nbt' }
    } catch { return { ...description, durabilityKnown: false } }
  }
}

module.exports = { createDurabilityReader, enchantmentsOf }
