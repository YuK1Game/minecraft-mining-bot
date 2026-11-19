'use strict'

// A tool lying in a chest, with the uses its own received data gives.
// The chest module (actions/chest.js) describes a slot by name, count and stack id. The uses left of a tool are
// in the same received item (its NBT), and the inventory's rows already carry them (runtime.js `readDurability`).
// The rules that compare the two sides (player-base-kit.js: what is banked, what is taken back out) need the same
// facts of an item wherever it lies: a slot here gets the same fields a row has (durabilityKnown, maxDurability,
// durabilityUsed, durabilityRemaining), from the same reader. A slot that is not a tool, is not received, or whose
// data the reader cannot read stays as it is: its uses are unknown, never guessed.
const { createDurabilityReader } = require('../../inventory/durability')

const TOOL = /_(?:pickaxe|sword|shovel|axe|hoe)$/
let reader = null
// The reader of the inventory's rows (made once; it loads the item table).
const chestTool = (description, raw) => (reader ??= createDurabilityReader())(description, raw)

// slot: one entry of the chest snapshot's `slots`; rawItem(slot): the received item of that slot.
function slotTool (slot, rawItem, read = chestTool) {
  if (slot?.known !== true || !TOOL.test(slot.name ?? '') || typeof rawItem !== 'function' || typeof read !== 'function') return slot
  try {
    const seen = read({ slot: slot.slot, name: slot.name, count: slot.count, stackId: slot.stackId }, rawItem(slot.slot))
    return seen?.durabilityKnown === true ? { ...slot, durabilityKnown: true, maxDurability: seen.maxDurability, durabilityUsed: seen.durabilityUsed, durabilityRemaining: seen.durabilityRemaining } : slot
  } catch { return slot }
}

module.exports = { chestTool, slotTool }
