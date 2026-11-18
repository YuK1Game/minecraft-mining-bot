'use strict'

// Room in the reserve chest for one stack of the kit.
//
// The expedition banks a second kit in the large chest of the home
// (dragon-supplies.js `reserve`). The base's chests fill with stone rubble, and a
// deposit into a full chest moves nothing: the step answered 「…の移動を確認します」
// and opened the chest again two seconds later, without end.
//
// From the received slots: the stack fits when a slot is empty, or when a stack
// of the same stackable item has space. Otherwise one stack of rubble (the
// smallest) is named to be taken out into the inventory first. Valuables, tools
// and the kit itself are never taken out; with no rubble either, there is no room.
const RUBBLE = /^minecraft:(?:cobblestone|cobbled_deepslate|stone|deepslate|diorite|andesite|granite|tuff|calcite|dripstone_block|dirt|coarse_dirt|grass_block|gravel|sand|red_sand|sandstone|netherrack|flint|rotten_flesh|leaf_litter|bone|spider_eye|wheat_seeds|[a-z_]+_sapling)$/
// Kit items that stack: the others (tools, armour, a shield) need a slot of their own.
const STACKS = /^minecraft:(?:bread|baked_potato|cooked_[a-z]+|arrow|cobblestone)$/
const free = slot => slot?.known === true && !slot.name && !slot.count

function reserveRoom (slots, stacks) {
  if (!Array.isArray(slots)) return { fits: false, evict: null }
  if (slots.some(free)) return { fits: true, evict: null }
  const merges = stacks.some(stack => STACKS.test(stack.name) && slots.some(slot => slot?.known === true && slot.name === stack.name && slot.count > 0 && slot.count < 64))
  if (merges) return { fits: true, evict: null }
  const wanted = new Set(stacks.map(stack => stack.name))
  const evict = slots.filter(slot => slot?.known === true && slot.count > 0 && RUBBLE.test(slot.name ?? '') && !wanted.has(slot.name)).sort((a, b) => a.count - b.count || a.slot - b.slot)[0] ?? null
  return { fits: false, evict: evict ? { slot: evict.slot, name: evict.name, count: evict.count } : null }
}

module.exports = { reserveRoom, RUBBLE }
