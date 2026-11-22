'use strict'

const { digTool } = require('../dig-tool')
const { nextGear } = require('../../survival/diamond-gear')
const { pickFor } = require('../dragon-supply-recipes')
const { count } = require('../dragon-supply-kit')
const { blocked, interrupted } = require('../return/return-result')
const { scopeOf } = require('./mine-observed')

// Admission and the actual mining hand use the same received durability
// rule. A two-use or unknown pick cannot keep a shaft stuck on one block.
function createMineTools (ctx, actions) {
  return async ({ request = null } = {}) => {
    if (ctx.cancelled() || ctx.signal?.aborted) return interrupted('MINE_INTERRUPTED')
    const inventory = actions.inventory()
    if (!inventory) return blocked('MINE_INVENTORY_UNKNOWN', { kind: 'inventory_update' })
    const resource = request?.resource ?? 'raw_iron', block = resource.replace(/^raw_/, '') + '_ore'
    const tool = digTool(inventory.items, 'minecraft:' + block)
    if (tool) return actions.done('MINE_TOOL_READY', { tool })
    let name = (pickFor[resource] ?? 'stone') + '_pickaxe'
    if (resource === 'diamond' && request?.requester === 'early' &&
        ctx.memory?.stage === 'early' && ctx.memory.early?.reserveReady === true) {
      const diamonds = count('diamond', inventory.items)
      const next = nextGear({ items: inventory.items, worn: ctx.runtime.armor?.(), diamonds })
      // If the ore is already carried, the expedition's next tool can also
      // finish the open room instead of requiring an intermediate iron tool.
      if (diamonds >= request.targetHeld && next?.output === 'diamond_pickaxe') name = next.output
    }
    const scope = scopeOf(ctx)
    // acquire's exact count includes a worn two-use pick. Ask for one more
    // using its own counting rule, so it cannot answer "already carried".
    await ctx.supplies.acquire(name, count(name, inventory.items) + 1)
    if (ctx.cancelled() || ctx.signal?.aborted || scopeOf(ctx) !== scope) return interrupted('MINE_INTERRUPTED')
    return blocked('MINE_TOOL_SUPPLY', { kind: 'inventory_update' }, { detail: `${name} の稼働可能な耐久度を受信してから施工します。` })
  }
}

module.exports = { createMineTools }
