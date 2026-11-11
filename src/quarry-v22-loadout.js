'use strict'

// Declarative chest manifest for quarry v2.2. This module neither gives
// items nor mutates the player; it validates the actual 54 received chest
// slots before an eventual withdrawal can begin.
const CARGO = 22
const FULL = 'minecraft:'
const named = name => FULL + name
const roles = Object.freeze({
  pickaxe: { box: named('blue_shulker_box'), item: named('diamond_pickaxe'), each: 1, slots: 27 },
  shovel: { box: named('light_blue_shulker_box'), item: /^(?:minecraft:)?(?:wooden|stone|copper|iron|golden|diamond|netherite)_shovel$/, each: 1, slots: 27 },
  dirt: { box: named('brown_shulker_box'), item: named('dirt'), each: 64, slots: 27 },
  totem: { box: named('yellow_shulker_box'), item: named('totem_of_undying'), each: 1, slots: 27 }
})
const singles = Object.freeze([
  { name: named('bread'), count: 64 }, { name: named('bow'), count: 1, enchant: 'infinity' },
  { name: named('arrow'), count: 64 }, { name: named('diamond_sword'), count: 1 },
  ...['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ name: named('diamond_' + piece), count: 1 }))
])
const norm = name => String(name ?? '').replace(/^minecraft:/, '')
function knownBox (item) {
  const c = item?.container
  return c?.known === true && Array.isArray(c.slots) && c.slots.length === 27 ? c.slots : null
}
function emptyItem (slot) { return slot == null || slot.empty === true || slot.count === 0 }
function compatible (actual, expected) {
  if (!actual?.known || emptyItem(actual)) return false
  if (actual.count !== expected.count || norm(actual.name) !== norm(expected.name)) return false
  if (expected.enchant && !(actual.enchantmentsKnown === true && (actual.enchantments ?? []).some(e => norm(e.name) === expected.enchant && e.level >= 1))) return false
  return true
}
function validateV22Loadout (view) {
  const errors = []
  if (!view || view.known !== true || !Array.isArray(view.slots) || view.slots.length !== 54 || view.slots.some(x => !x || x.known !== true)) {
    return { ready: false, errors: [{ code: 'LOADOUT_CHEST_UNCONFIRMED' }] }
  }
  const stacks = view.slots.filter(slot => !emptyItem(slot))
  const used = new Set(), reserve = (predicate, label, count = 1) => {
    const matched = []
    for (let i = 0; i < stacks.length; i++) if (!used.has(i) && predicate(stacks[i])) {
      matched.push(i); if (matched.length === count) break
    }
    if (matched.length < count) errors.push({ code: 'LOADOUT_MISSING', item: label, found: matched.length, required: count })
    else for (const i of matched) used.add(i)
  }
  reserve(item => norm(item.name) === 'purple_shulker_box' && item.count === 1 && knownBox(item)?.every(emptyItem), 'empty_cargo_shulker', CARGO)
  for (const [role, definition] of Object.entries(roles)) {
    reserve(item => {
      if (norm(item.name) !== norm(definition.box) || item.count !== 1) return false
      const contents = knownBox(item)
      return !!contents && contents.every(entry =>
        !emptyItem(entry) && entry.known === true && entry.count === definition.each &&
        (definition.item instanceof RegExp ? definition.item.test(entry.name) : norm(entry.name) === norm(definition.item)))
    }, 'supply_' + role)
  }
  for (const entry of singles) reserve(item => compatible(item, entry), entry.name)
  if (used.size !== stacks.length) errors.push({ code: 'LOADOUT_UNEXPECTED_OR_INVALID', count: stacks.length - used.size })
  return { ready: errors.length === 0, errors, confirmedSlots: used.size, cargoBoxes: CARGO, supplyBoxes: Object.keys(roles).length }
}
module.exports = { CARGO, roles, singles, validateV22Loadout }
