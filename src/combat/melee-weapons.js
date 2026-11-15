'use strict'

// Normal Bedrock per-hit damage, including the player's base point. These are
// not Java axe damage/cooldown values. Native critical/smash damage is left to
// the server; selection never predicts a hit, an armour outcome, or a kill.
const BASE_DAMAGE = new Map()
for (const [materials, sword, axe] of [[['wooden', 'golden'], 5, 4], [['stone', 'copper'], 6, 5], [['iron'], 7, 6], [['diamond'], 8, 7], [['netherite'], 9, 8]]) for (const material of materials) { BASE_DAMAGE.set(`minecraft:${material}_sword`, sword); BASE_DAMAGE.set(`minecraft:${material}_axe`, axe) }
BASE_DAMAGE.set('minecraft:trident', 9); BASE_DAMAGE.set('minecraft:mace', 7)
// Actual grounded single-hit health deltas on unarmored, UID-bound cows in
// owned Bedrock Dedicated Server 1.26.60.6; these totals include player base 1.
// Every material/class row, including copper, was measured independently.
for (const [materials, pickaxe, shovel, hoe] of [[["wooden","golden"],3,2,3],[["stone","copper"],4,3,4],[["iron"],5,4,5],[["diamond"],6,5,6],[["netherite"],7,6,7]]) for (const material of materials) {
  BASE_DAMAGE.set(`minecraft:${material}_pickaxe`, pickaxe)
  BASE_DAMAGE.set(`minecraft:${material}_shovel`, shovel)
  BASE_DAMAGE.set(`minecraft:${material}_hoe`, hoe)
}
const UNDEAD = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'wither', 'phantom', 'zombie_pigman', 'zoglin', 'zombie_horse', 'skeleton_horse'].map(n => `minecraft:${n}`))
const ARTHROPODS = new Set(['spider', 'cave_spider', 'silverfish', 'endermite', 'bee'].map(n => `minecraft:${n}`))
const FIST_ITEMS = new Set(['minecraft:stick', 'minecraft:dirt', 'minecraft:stone', 'minecraft:cobblestone', 'minecraft:rotten_flesh', 'minecraft:bow', 'minecraft:arrow', 'minecraft:crafting_table', 'minecraft:torch'])
for (const wood of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped']) for (const suffix of ['planks', 'log', 'wood', 'stem', 'hyphae']) FIST_ITEMS.add(`minecraft:${wood}_${suffix}`)
const validRaw = raw => raw && Number.isInteger(raw.network_id) && raw.network_id >= -32768 && raw.network_id <= 32767 && Number.isInteger(raw.count) && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)

function readDamageEnchantments (raw) {
  if (raw?.extra?.has_nbt === false || raw?.extra?.has_nbt === 'false') return { enchantments: [], warnings: [], known: true }
  const root = raw?.extra?.nbt?.nbt ?? raw?.extra?.nbt
  if (root?.type !== 'compound' || !root.value || typeof root.value !== 'object') return { enchantments: [], warnings: ['server_enchantment_nbt_unavailable'], known: false }
  const tag = root.value.ench
  if (!tag) return { enchantments: [], warnings: [], known: true }
  if (tag.type !== 'list' || tag.value?.type !== 'compound' || !Array.isArray(tag.value.value)) return { enchantments: [], warnings: ['unsupported_bedrock_enchantment_nbt'], known: false }
  const enchantments = []; const warnings = []; const seen = new Set()
  for (const entry of tag.value.value) {
    const value = entry?.type === 'compound' ? entry.value : entry
    const enchantId = value?.id; const level = value?.lvl
    if (!['short', 'int'].includes(enchantId?.type) || !['short', 'int'].includes(level?.type) || !Number.isInteger(enchantId.value) || !Number.isInteger(level.value)) { warnings.push('unsupported_bedrock_enchantment_entry'); continue }
    if (![9, 10, 11, 29].includes(enchantId.value)) continue
    if (level.value < 1 || level.value > 5 || seen.has(enchantId.value)) { warnings.push(`unsupported_damage_enchantment:${enchantId.value}`); continue }
    seen.add(enchantId.value); enchantments.push({ id: enchantId.value, level: level.value })
  }
  if (enchantments.filter(e => [9, 10, 11].includes(e.id)).length > 1) return { enchantments: enchantments.filter(e => ![9, 10, 11].includes(e.id)), warnings: [...warnings, 'incompatible_damage_enchantments'], known: false }
  return { enchantments, warnings, known: warnings.length === 0 }
}

function scoreMeleeWeapon (description, raw, { target = null, targetWet = false, components = null } = {}) {
  const name = description?.name
  if (!validRaw(raw) || raw.network_id !== 0 && (!description || description.count !== raw.count || description.stackId !== raw.stack_id)) return { eligible: false, damage: null, source: 'unconfirmed_stack', warnings: ['inventory_and_raw_stack_disagree'] }
  if (raw.network_id === 0) return { eligible: true, name: 'minecraft:air', damage: 1, baseDamage: 1, enchantmentBonus: 0, source: 'observed_empty_hand', damageKnown: true, fists: true, enchantments: [], warnings: [] }
  let base = BASE_DAMAGE.get(name); let source = 'vanilla_bedrock_base'
  // Official minecraft:damage is EXTRA damage added to the player's base 1.
  // https://learn.microsoft.com/minecraft/creator/reference/content/itemreference/examples/itemcomponents/minecraft_damage
  if (components != null && Object.hasOwn(components, 'minecraft:damage')) {
    const component = components['minecraft:damage']; const amount = typeof component === 'number' ? component : component?.value
    if (!Number.isInteger(amount) || amount < 0 || amount > 32767) return { eligible: false, name, damage: null, source: 'unrecognized_observed_damage_component', warnings: ['custom_damage_component_not_a_known_integer'] }
    base = amount + 1; source = 'observed_minecraft_damage_plus_player_base'
  }
  if (base == null && FIST_ITEMS.has(name)) { base = 1; source = 'known_vanilla_unarmed_item' }
  if (base == null) return { eligible: false, name, damage: null, source: 'unknown_item_components', warnings: ['no_verified_bedrock_damage_source'] }
  const parsed = readDamageEnchantments(raw)
  let bonus = 0
  for (const e of parsed.enchantments) {
    if (e.id === 9) bonus += 1.25 * e.level
    if (e.id === 10 && UNDEAD.has(target?.entityType)) bonus += 2.5 * e.level
    if (e.id === 11 && ARTHROPODS.has(target?.entityType)) bonus += 2.5 * e.level
    if (e.id === 29 && name === 'minecraft:trident' && targetWet === true) bonus += 2.5 * e.level
  }
  return { eligible: true, name, damage: base + bonus, baseDamage: base, enchantmentBonus: bonus, source, damageKnown: parsed.known, fists: base === 1 && !BASE_DAMAGE.has(name), enchantments: parsed.enchantments, warnings: parsed.warnings }
}

function selectMeleeWeapon ({ items, rawItem, selectedSlot, target = null, targetWet = false, getItemComponents = null }) {
  if (!Array.isArray(items) || typeof rawItem !== 'function' || !Number.isInteger(selectedSlot) || selectedSlot < 0 || selectedSlot > 8 || getItemComponents != null && typeof getItemComponents !== 'function') throw new Error('Weapon selection requires real inventory slots and server-selected hotbar')
  const candidates = []; const unknownCandidates = []
  for (const item of items) {
    if (!Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) { unknownCandidates.push({ name: item.name, slot: item.slot, source: 'invalid_inventory_slot' }); continue }
    const raw = rawItem(item.slot)
    let components = null
    try { components = getItemComponents?.(item, raw) ?? null } catch { unknownCandidates.push({ name: item.name, slot: item.slot, source: 'item_component_observation_failed' }); continue }
    const score = scoreMeleeWeapon(item, raw, { target, targetWet, components })
    if (score.eligible) candidates.push({ ...score, slot: item.slot, raw: structuredClone(raw), requiresEmptySelection: false })
    else unknownCandidates.push({ name: item.name, slot: item.slot, source: score.source, warnings: score.warnings })
  }
  for (let slot = 0; slot < 9; slot++) {
    if (items.some(i => i.slot === slot && i.count > 0)) continue
    const raw = rawItem(slot)
    if (validRaw(raw) && raw.network_id === 0) candidates.push({ ...scoreMeleeWeapon(null, raw), slot, raw: structuredClone(raw), requiresEmptySelection: slot !== selectedSlot })
  }
  candidates.sort((a, b) => b.damage - a.damage || b.baseDamage - a.baseDamage || Number(b.slot === selectedSlot) - Number(a.slot === selectedSlot) || a.slot - b.slot)
  if (!candidates.length) return { ready: false, source: 'no_proven_weapon_or_empty_hotbar', unknownCandidates }
  return { ready: true, ...candidates[0], selectionBasis: 'highest_proven_normal_bedrock_per_hit_damage', unknownCandidates }
}

module.exports = { scoreMeleeWeapon, selectMeleeWeapon, readDamageEnchantments }
