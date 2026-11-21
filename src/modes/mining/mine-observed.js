'use strict'

// The mine's small, shared receipt predicates. A bounding box alone does not
// identify a slab's upper surface, and an absent property is not 'bottom'.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const key = p => `${p.x},${p.y},${p.z}`
const point = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const cell = p => point(p) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const value = v => v?.value ?? v
const air = b => b?.known === true && AIR.test(b.name ?? '') && !b.extra?.length
const solid = b => b?.known === true && b.boundingBox === 'block' && !/water|lava/.test(b.name ?? '') && !b.extra?.length
function bottomSlab (b) {
  if (!solid(b) || b.name !== 'minecraft:cobblestone_slab') return false
  const p = b.properties ?? {}
  return value(p['minecraft:vertical_half'] ?? p.vertical_half) === 'bottom' || value(p.top_slot_bit) === false || value(p.top_slot_bit) === 0
}
const receivedInventory = inv => inv?.known === true && inv.uncertain !== true && Array.isArray(inv.items) ? inv : null
const bare = name => String(name ?? '').replace(/^minecraft:/, '')
const full = name => 'minecraft:' + bare(name)
const held = (inv, name) => receivedInventory(inv) ? inv.items.filter(i => i.name === full(name) && i.count > 0).reduce((sum, i) => sum + i.count, 0) : null
const confirmed = out => out?.status === 'completed' && (out.serverConfirmed === true || out.evidence?.serverConfirmed === true)
function scopeOf (ctx) {
  return require('./mine-state').mineLiveScope(ctx.runtime.mineState?.() ?? ctx.runtime.raw())
}

module.exports = { key, point, cell, value, air, solid, bottomSlab, receivedInventory, bare, full, held, confirmed, scopeOf }
