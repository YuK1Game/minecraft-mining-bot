'use strict'

// The pickaxe held to dig one block in player mode (player-scaffold-ports.js `pick`, `mine`, `descend`;
// dragon-supply-gather.js `collect`): the working pickaxe of the lowest tier that mines the block, as the quarry
// chooses for building blocks (quarry-rules.js `selectTool`: 「Lowest sufficient tier first preserves better tools」).
// - A block a pickaxe is needed for: the tier of its rule (stone 1, iron ore 2, diamond ore 3, obsidian 4).
// - A block no tool is needed for (dirt, grass, gravel): plain rock's rule. The hand stays on the cheap pickaxe,
//   so a walk through dirt and stone does not swap tools block by block (a swap goes through the inventory screen).
//   The hands change the tool for such a block only away from a better one (`toolNeeded`; with no tool in the hand
//   the block costs nothing).
// - A block with no dig rule (unknown, protected): no answer; the caller keeps its old choice.
// A pickaxe with two uses left or fewer is not chosen (as `pick` always did).
// Live 2026-11-20 15:00-15:10 JST: the only pickaxe was iron; the walks to coal near the surface dug stone, dirt and
// grass with it (the received area: stone 484, dirt 437, grass 200) and it went from 177 uses to 53 in ten minutes,
// with 140 cobblestone and 3 sticks in the bag.
const { blockRule, selectTool, toolState } = require('../quarry/quarry-rules')

const ROCK = Object.freeze({ kind: 'dig', tool: 'pickaxe', needs: 'pickaxe', tier: 1, drops: [], maxDrop: 1 })
const KEEP = { reserveMinUses: 2 }

// items: inventory rows with the received durability. name: the block's name, or nothing for plain rock.
// hand: the row in the hand, when known. A working pickaxe of the chosen tier that is already there stays: of two
// alike the one with more uses left is chosen, and without this they would change places every other block.
// → { slot, name, tier, remaining } or null (no working pickaxe mines it, or the block has no dig rule).
function digTool (items, name = null, hand = null) {
  let wanted = ROCK
  if (name) {
    const rule = blockRule(name)
    if (rule?.kind !== 'dig') return null
    if (rule.needs === 'pickaxe') wanted = { ...rule, ore: false }
    else if (rule.needs) return null
  }
  const chosen = selectTool(wanted, items, KEEP)
  if (!chosen.ok || chosen.kind !== 'pickaxe') return null
  const held = hand && hand.slot !== chosen.slot ? toolState((Array.isArray(items) ? items : []).find(item => item?.slot === hand.slot && item.name === hand.name && item.count === 1), KEEP) : null
  if (held?.usable && held.kind === 'pickaxe' && held.tier === chosen.tier) return { slot: held.item.slot, name: held.item.name, tier: held.tier, remaining: held.remaining }
  return { slot: chosen.slot, name: chosen.name, tier: chosen.tier, remaining: chosen.remaining }
}

// True for a block that only a pickaxe mines (rock, ore); false for one a bare hand digs as well (dirt, grass).
const toolNeeded = name => { const rule = blockRule(name); return rule?.kind === 'dig' && rule.needs === 'pickaxe' }

// What a stone pickaxe is made of, for the expedition to make one for digging (dragon-supplies.js).
const STONE_TIER = 2
// When rock would be dug with a pickaxe better than stone, and the cobblestone for a stone one is carried:
// 'make' with the wood for its sticks carried as well, 'wood' with none (the caller fetches a log where that is a
// short walk). Otherwise false.
// Live 2026-11-20 17:50:41-17:56:30 JST (main fb6ec4c): the bag held 299 cobblestone and a crafting table, no stick,
// plank or log, and a stone pickaxe with two uses. The stairs down from y 66 to y 44 (123 blocks) and the shaft back
// up (24 levels) were dug with the iron pickaxe: 177 uses at 17:51:03, 28 at 17:56:06.
function diggerWanted (items, held) {
  const now = digTool(items)
  if (!now || now.tier <= STONE_TIER || held('cobblestone') < 3) return false
  return held('stick') >= 2 || held('planks') >= 2 || held('log') >= 1 ? 'make' : 'wood'
}

module.exports = { digTool, toolNeeded, diggerWanted }
