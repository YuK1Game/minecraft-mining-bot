'use strict'

const { digTool } = require('../dig-tool')
const { blockRule } = require('../../quarry/quarry-rules')
const { nextGear } = require('../player-diamond-gear')
const { pickFor } = require('../dragon-supply-recipes')
const { count } = require('../dragon-supply-kit')
const { blocked, interrupted } = require('../return/return-result')
const { scopeOf } = require('./mine-observed')
const { prerequisiteResult } = require('./mine-common')
const PICKS = ['wooden', 'wooden', 'stone', 'iron', 'diamond']

// Admission and the actual mining hand use the same received durability
// rule. A two-use or unknown pick cannot keep a shaft stuck on one block.
function createMineTools (ctx, actions) {
  return async ({ request = null, blockName = null } = {}) => {
    if (ctx.cancelled() || ctx.signal?.aborted) return interrupted('MINE_INTERRUPTED')
    const inventory = actions.inventory()
    if (!inventory) return blocked('MINE_INVENTORY_UNKNOWN', { kind: 'inventory_update' })
    const resource = request?.resource ?? 'raw_iron'
    const requestedBlock = 'minecraft:' + resource.replace(/^raw_/, '') + '_ore'
    const remainingTier = blockName ? blockRule(blockName)?.tier : 0
    const requiresUpgrade = remainingTier > (blockRule(requestedBlock)?.tier ?? 0)
    const block = requiresUpgrade ? blockName : requestedBlock
    const tool = digTool(inventory.items, block)
    if (tool) return actions.done('MINE_TOOL_READY', { tool })
    const material = requiresUpgrade ? PICKS[remainingTier] : pickFor[resource]
    let name = (material ?? 'stone') + '_pickaxe'
    const diamondWork = resource === 'diamond' || /^minecraft:(?:deepslate_)?diamond_ore$/.test(blockName ?? '')
    if (diamondWork && request?.requester === 'early' &&
        ctx.memory?.stage === 'early' && ctx.memory.early?.reserveReady === true) {
      const diamonds = count('diamond', inventory.items)
      const next = nextGear({ items: inventory.items, worn: ctx.runtime.armor?.(), diamonds })
      // If the ore is already carried, the expedition's next tool can also
      // finish the open room instead of requiring an intermediate iron tool.
      if ((resource !== 'diamond' || diamonds >= request.targetHeld) && next?.output === 'diamond_pickaxe') name = next.output
    }
    const scope = scopeOf(ctx)
    // acquire's exact count includes a worn two-use pick. Ask for one more
    // using its own counting rule, so it cannot answer "already carried".
    const supplied = await ctx.supplies.acquire(name, count(name, inventory.items) + 1)
    if (ctx.cancelled() || ctx.signal?.aborted || scopeOf(ctx) !== scope) return interrupted('MINE_INTERRUPTED')
    return prerequisiteResult(supplied, blocked('MINE_TOOL_SUPPLY', { kind: 'inventory_update' }, { detail: `${name} の稼働可能な耐久度を受信してから施工します。` }))
  }
}

module.exports = { createMineTools }
