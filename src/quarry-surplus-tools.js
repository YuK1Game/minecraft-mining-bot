'use strict'

// Pure, opt-in classification. A server-observed spare is never inferred
// from a tool's provenance, a box's advertised capacity, or enchant multipliers.
const { nameOf, toolOf, toolState } = require('./quarry-rules')
const { isShulkerBox } = require('./container-types')

const stackId = item => item?.stackId ?? item?.stack_id
const validStack = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647
const validSlot = value => Number.isSafeInteger(value) && value >= 0 && value < 36
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const tagged = new Set([true, 'true', 1, 65535])
const untagged = new Set([false, 'false', 0])

function observedTool (item) {
  const tool = toolOf(item)
  if (!tool || !['pickaxe', 'shovel'].includes(tool.kind) || item.count !== 1 || item.known === false || item.surplusToolMetadataKnown !== true || item.metadata !== 0 || item.durabilityKnown !== true || item.enchantmentsKnown !== true || !Array.isArray(item.enchantments)) return null
  if (![item.maxDurability, item.durabilityUsed, item.durabilityRemaining].every(Number.isSafeInteger) || item.maxDurability !== tool.maxDurability || item.durabilityUsed < 0 || item.durabilityRemaining < 0 || item.durabilityUsed + item.durabilityRemaining !== item.maxDurability) return null
  const enchantments = new Set()
  for (const enchant of item.enchantments) {
    const name = nameOf(enchant)
    if (!plainObject(enchant) || !/^[a-z][a-z_]*$/.test(name) || /^id_/.test(name) || !Number.isSafeInteger(enchant.level) || enchant.level < 1 || enchantments.has(name)) return null
    enchantments.add(name)
  }
  if (item.raw != null) {
    const raw = item.raw, extra = raw.extra
    if (!plainObject(raw) || raw.count !== 1 || raw.has_stack_id !== true || raw.stack_id !== stackId(item) || !Number.isSafeInteger(raw.network_id) || raw.network_id === 0 || raw.metadata !== 0 || !plainObject(extra) || !Array.isArray(extra.can_place_on) || extra.can_place_on.length || !Array.isArray(extra.can_destroy) || extra.can_destroy.length) return null
    if (untagged.has(extra.has_nbt)) {
      if (extra.nbt != null || item.durabilityUsed !== 0 || item.enchantments.length) return null
    } else {
      const root = extra.nbt?.nbt ?? extra.nbt
      if (!tagged.has(extra.has_nbt) || root?.type !== 'compound' || !plainObject(root.value) || Object.keys(root.value).some(key => !['Damage', 'ench'].includes(key))) return null
      const damage = root.value.Damage, ench = root.value.ench
      if (!['short', 'int'].includes(damage?.type) || damage.value !== item.durabilityUsed) return null
      if (ench == null) { if (item.enchantments.length) return null } else {
        if (ench.type !== 'list' || !['compound', 'end'].includes(ench.value?.type) || !Array.isArray(ench.value.value) || ench.value.value.length !== item.enchantments.length) return null
        for (const entry of ench.value.value) {
          const e = entry?.type === 'compound' ? entry.value : entry
          if (!['short', 'int'].includes(e?.id?.type) || !Number.isSafeInteger(e.id.value) || e.id.value < 0 || !['short', 'int'].includes(e?.lvl?.type) || !Number.isSafeInteger(e.lvl.value) || e.lvl.value < 1) return null
        }
      }
    }
  }
  return tool
}

function special (item) {
  return ['custom', 'protected', 'reserved', 'keep', 'locked', 'isLocked', 'unbreakable', 'protectionSource', 'customName', 'displayName'].some(key => item[key] != null && item[key] !== false && item[key] !== 0 && item[key] !== '') || item.repairCost != null && item.repairCost !== 0 || item.lore != null && (!Array.isArray(item.lore) || item.lore.length !== 0) || ['canPlaceOn', 'canDestroy', 'can_place_on', 'can_destroy'].some(key => item[key] != null && (!Array.isArray(item[key]) || item[key].length !== 0))
}

function surplusToolSlots (items, options = {}) {
  const surplus = new Set()
  if (options?.enabled !== true || !Array.isArray(items) || !Array.isArray(options.supplyBoxes ?? [])) return surplus
  const policy = options.toolPolicy ?? {}, bindings = options.supplyBoxes ?? []
  if (!plainObject(policy) || policy.reservedTools !== undefined && (!Array.isArray(policy.reservedTools) || policy.reservedTools.some(name => typeof name !== 'string')) || policy.reserveMinUses !== undefined && (!Number.isSafeInteger(policy.reserveMinUses) || policy.reserveMinUses < 0) || policy.returnUses !== undefined && (!Number.isSafeInteger(policy.returnUses) || policy.returnUses < 0) || policy.reserveFraction !== undefined && (!Number.isFinite(policy.reserveFraction) || policy.reserveFraction < 0 || policy.reserveFraction > 1)) return surplus
  const reserved = new Set((policy.reservedTools ?? []).map(nameOf))
  const slotCounts = new Map(), stackCounts = new Map()
  for (const item of items) {
    if (validSlot(item?.slot)) slotCounts.set(item.slot, (slotCounts.get(item.slot) ?? 0) + 1)
    if (validStack(stackId(item))) stackCounts.set(stackId(item), (stackCounts.get(stackId(item)) ?? 0) + 1)
  }
  const unique = item => validSlot(item?.slot) && validStack(stackId(item)) && slotCounts.get(item.slot) === 1 && stackCounts.get(stackId(item)) === 1
  const hasBoundSupply = kind => {
    const matches = bindings.filter(binding => binding?.role === kind)
    if (matches.length !== 1) return false
    const binding = matches[0]
    if (toolOf(binding.itemName)?.kind !== kind || !validStack(binding.stackId) || !isShulkerBox(binding.boxName)) return false
    return items.some(item => unique(item) && item.count === 1 && isShulkerBox(item.name) && nameOf(item) === nameOf(binding.boxName) && stackId(item) === binding.stackId && binding.key === `${nameOf(item)}:stack:${stackId(item)}`)
  }
  for (const kind of ['pickaxe', 'shovel']) {
    if (!hasBoundSupply(kind)) continue
    const tools = items.flatMap(item => {
      if (!unique(item) || reserved.has(nameOf(item)) || special(item)) return []
      const tool = observedTool(item)
      if (!tool || tool.kind !== kind) return []
      const state = toolState(item, policy)
      return [{ item, tool, state, usable: Math.max(0, item.durabilityRemaining - (state.reserve ?? 0)) }]
    })
    const budgets = tools.filter(t => ['diamond', 'netherite'].includes(t.tool.material) && t.state.usable === true).map(t => ({ ...t, left: t.usable }))
    const lower = tools.filter(t => !['diamond', 'netherite'].includes(t.tool.material) && t.item.enchantments.length === 0).sort((a, b) => a.item.durabilityRemaining - b.item.durabilityRemaining || a.item.slot - b.item.slot)
    for (const candidate of lower) {
      const keeper = budgets.filter(t => candidate.usable < t.usable && candidate.item.durabilityRemaining <= t.left).sort((a, b) => a.left - b.left || a.item.slot - b.item.slot)[0]
      if (!keeper) continue
      keeper.left -= candidate.item.durabilityRemaining
      surplus.add(candidate.item.slot)
    }
  }
  return surplus
}

module.exports = { surplusToolSlots }
