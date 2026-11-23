'use strict'

// The pickaxe in the hand before a cell of the covered pit is mined (runtime/long-travel-runtime.js
// `travelNightPit`: the long trip's night pit, the ordinary play's shelter, the expedition's rest pit; and the
// lid when the long trip leaves its pit).
// The mining check reads the hand (actions/mining.js: rock needs a pickaxe of its tier in the selected slot).
// The pit never changed the hand, so with a sword there the first rock cell ended it.
// Real Realm 2026-11-23 JST, the expedition's wait for health with stone pickaxes in the bag (one with 24 uses,
// six with 2) and the stone sword in the hand after two hits (15.4 → 10.5 → 5.5 at 17:50): 17:52:56
// 「回復の穴を作れませんでした（DIG_REFUSED:適切なツルハシの装備を確認できません: stone）」 at (9904, 61, 10142),
// the same at 18:00:36 at (9981, 61, 10177); it waited in the open for 25 minutes and was hit again at 18:05.
// - The pickaxe is the one every other dig of the play chooses (modes/dig-tool.js `digTool`: the working pickaxe
//   of the lowest tier that mines the block; two uses left or fewer is not chosen). It goes into the hand
//   through the inventory, as the hands do (player-scaffold-ports.js `pick`).
// - A block a bare hand digs (dirt, grass) leaves the hand as it is.
// - No working pickaxe for a cell: the pit is not begun (`unmined`), so no half-dug hole is left.
const { digTool, toolNeeded } = require('../modes/dig-tool')

const SETTLE_MS = 250
const bare = name => String(name ?? '').replace(/^minecraft:/, '')

// names: the blocks the pit will mine. → the first one no working pickaxe of `items` mines, or null.
function unmined (items, names) {
  const name = names.find(name => name && toolNeeded(name) && !digTool(items, name))
  return name ? bare(name) : null
}

// name: the block to mine next. hand: the row in the hand. equip(slot): the inventory's equip.
// → { ok: true } with the hand ready (or left alone), or { ok: false, reason }.
async function holdPitTool ({ name, items, hand = null, equip, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!name || !toolNeeded(name)) return { ok: true }
  const tool = digTool(items, name, hand)
  if (!tool) return { ok: false, reason: `NO_WORKING_PICKAXE:${bare(name)}` }
  if (hand && hand.slot === tool.slot && hand.name === tool.name) return { ok: true }
  try {
    const moved = await equip(tool.slot)
    if (moved?.phase !== 'completed') return { ok: false, reason: 'PICKAXE_NOT_HELD' }
    // Already in the hand: nothing was swapped and nothing is waited for.
    if (moved.selectedSlotChanged === false && moved.slot === moved.sourceSlot) return { ok: true }
  } catch (error) { return { ok: false, reason: `PICKAXE_NOT_HELD:${String(error?.message ?? error).slice(0, 50)}` } }
  await sleep(SETTLE_MS)
  return { ok: true }
}

module.exports = { holdPitTool, unmined }
