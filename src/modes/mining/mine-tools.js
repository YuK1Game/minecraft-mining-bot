'use strict'

const { digTool } = require('../dig-tool')
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
    const name = (pickFor[resource] ?? 'stone') + '_pickaxe', scope = scopeOf(ctx)
    // acquire's exact count includes a worn two-use pick. Ask for one more
    // using its own counting rule, so it cannot answer "already carried".
    await ctx.supplies.acquire(name, count(name, inventory.items) + 1)
    if (ctx.cancelled() || ctx.signal?.aborted || scopeOf(ctx) !== scope) return interrupted('MINE_INTERRUPTED')
    return blocked('MINE_TOOL_SUPPLY', { kind: 'inventory_update' }, { detail: `${name} の稼働可能な耐久度を受信してから施工します。` })
  }
}

module.exports = { createMineTools }
