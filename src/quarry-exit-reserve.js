'use strict'

const { toolState } = require('./quarry-rules')
// Reserve confirmed durability by item name, not mutable inventory slots.
// This is a budget, not a claim that the selected exit is currently traversable.
function miningUsesAfterExitReserve (tool, inventory, plan, policy = {}) {
  if (!tool || tool.kind === 'hand' || !plan) return Infinity
  const needed = (plan.toolUses ?? []).filter(row => row.name === tool.name).reduce((sum, row) => sum + row.count, 0)
  if (!needed) return Infinity
  const available = (inventory ?? []).filter(item => item.name === tool.name).map(item => toolState(item, policy)).filter(Boolean).reduce((sum, state) => sum + (Number.isFinite(state.remaining) ? Math.max(0, state.remaining - state.reserve) : 0), 0)
  return Math.max(0, Math.floor(available - needed))
}
module.exports = { miningUsesAfterExitReserve }
