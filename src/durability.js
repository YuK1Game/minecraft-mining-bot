'use strict'

const createItem = require('prismarine-item')

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
      return { ...description, stackId: raw.stack_id, durabilityKnown: true, durabilityUsed: parsed.durabilityUsed, maxDurability: parsed.maxDurability, durabilityRemaining: parsed.maxDurability - parsed.durabilityUsed, durabilitySource: 'server_item_nbt' }
    } catch { return { ...description, durabilityKnown: false } }
  }
}

module.exports = { createDurabilityReader }
