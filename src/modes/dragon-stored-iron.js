'use strict'

// Iron already in a chest by the house is taken before more is mined.
//
// The house chest held 8 raw iron and 3 iron ingots while the expedition mined the upper corridor for 「raw_iron 0/8」
// for half an hour and more (live 2026-11-28 22:55-23:23 JST, the iron kit asked iron_ingot 1/9): the mine's own
// storage room was read (mine-stock.js), the house's chests were not. The chest memory (player-chest-index.js) says what
// each opened chest held when it was last read; the chest itself is opened again to take it, and a chest that gave
// nothing is not tried again for REST_MS (its memory is rewritten by that look).
const NEAR_M = 48, REST_MS = 3 * 60000
const IRON = ['minecraft:iron_ingot', 'minecraft:raw_iron']

function storedIron (shared, origin) {
  const memory = shared?.playerChestMemory
  if (!origin || !memory) return []
  try { memory.ensure?.() } catch { /* read back on the next look */ }
  const out = []
  for (const [key, slots] of memory.seen ?? []) {
    const [x, y, z] = String(key).split(',').map(Number)
    if (![x, y, z].every(Number.isFinite) || Math.hypot(x - origin.x - 3, z - origin.z - 3) > NEAR_M || Math.abs(y - origin.y) > 8) continue
    for (const name of IRON) {
      const count = (Array.isArray(slots) ? slots : []).filter(slot => slot?.name === name && slot.count > 0).reduce((sum, slot) => sum + slot.count, 0)
      if (count > 0) out.push({ pos: { x, y, z }, name, count })
    }
  }
  // Ingots first: they need no furnace.
  return out.sort((a, b) => IRON.indexOf(a.name) - IRON.indexOf(b.name) || b.count - a.count)
}

const keyOf = entry => `${entry.pos.x},${entry.pos.y},${entry.pos.z}:${entry.name}`

// The chest to take from now, or null. `held(name)` counts the bag. A chest rests only after a look beside it
// (`markStoredIron`) gave nothing; the walk there does not count.
function nextStoredIron (shared, origin, held, now = Date.now()) {
  const tried = shared.dragonStoredIronTried ??= {}
  for (const entry of storedIron(shared, origin)) {
    const last = tried[keyOf(entry)]
    if (last && now - last.at < REST_MS && held(entry.name) <= last.held) continue
    return entry
  }
  return null
}

// A look beside the chest: the count held now, to see whether the next look gained anything.
function markStoredIron (shared, entry, held, now = Date.now()) {
  const tried = shared.dragonStoredIronTried ??= {}, last = tried[keyOf(entry)]
  if (!last || now - last.at >= REST_MS || held(entry.name) > last.held) tried[keyOf(entry)] = { at: now, held: held(entry.name) }
}

module.exports = { storedIron, nextStoredIron, markStoredIron, NEAR_M }
