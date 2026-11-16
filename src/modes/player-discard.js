'use strict'

// Player mode: with no chest to use and no wood to make one, a full
// inventory is emptied by throwing the rubble away (user 2026-11-16 23:14 JST:
// 「チェストを作るために木が拾えないのであればいらないアイテムを捨てればいいのでは？」;
// live 23:10 JST at y=-37: 「チェストを作る板材が足りません（板材 8・原木 0・必要 板材 20）」).
// - Thrown: whole stacks of what the chest would take (stone beyond the
//   cobblestone/dirt reserve, gravel, flint, leaf litter, rotten flesh, worn
//   pickaxes) and plain junk (saplings, spider eyes, bones, feathers, swords
//   and pickaxes weaker than a held better one). Never diamonds, ores, coal,
//   food, wood, armour, the best tools, arrows, wool, string or gunpowder.
// - A throw counts only when the server answers it (inventory/discard.js).
// - Where it was thrown is kept for ten minutes, so the drop-pickup planning
//   does not walk back for the same things (player-drops.js).
const { storable } = require('./player-storage-rubble')

const JUNK = /^minecraft:(?:\w+_sapling|spider_eye|bone|feather|poisonous_potato|rotten_flesh|wheat_seeds|pumpkin_seeds|melon_seeds|beetroot_seeds|stick_unused)$/
const TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
const AGAIN_MS = 10 * 60 * 1000
const tierOf = name => TIER[/^minecraft:(\w+?)_(?:sword|pickaxe)$/.exec(name ?? '')?.[1]] ?? 0
const usesOf = item => Number.isSafeInteger(item?.maxDurability) && Number.isSafeInteger(item?.durabilityUsed) ? item.maxDurability - item.durabilityUsed : null

// Whole stacks to throw away: [{ slot, name, count }].
function throwable (inventory) {
  if (inventory?.known !== true || inventory.uncertain) return []
  const items = (inventory.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
  const out = new Map()
  // Only whole stacks free a slot.
  for (const stack of storable(inventory)) { const item = items.find(other => other.slot === stack.slot); if (item && stack.count >= item.count) out.set(item.slot, { slot: item.slot, name: item.name, count: item.count }) }
  for (const item of items) if (JUNK.test(item.name ?? '')) out.set(item.slot, { slot: item.slot, name: item.name, count: item.count })
  // A sword or pickaxe weaker than a held working one of the same kind.
  for (const kind of ['sword', 'pickaxe']) {
    const tools = items.filter(item => new RegExp(`_${kind}$`).test(item.name ?? ''))
    const best = Math.max(0, ...tools.filter(item => (usesOf(item) ?? 99) > 2).map(item => tierOf(item.name)))
    // One working spare pickaxe stays (the best one can wear out deep underground).
    const spare = kind === 'pickaxe' ? tools.filter(item => tierOf(item.name) < best && (usesOf(item) ?? 0) > 2).sort((a, b) => tierOf(b.name) - tierOf(a.name))[0] : null
    for (const item of tools) if (tierOf(item.name) < best && item !== spare) out.set(item.slot, { slot: item.slot, name: item.name, count: item.count })
  }
  return [...out.values()]
}

// Where to throw from: a walkable cell 3-6 m away (farthest first). Walking
// there faces the Bot away from where it stands now, the throw carries the
// stacks on ahead, and the walk back leaves them out of pickup range (live
// 2026-11-16 23:20 JST: 18 stacks thrown at the feet were all picked up again
// within 20 seconds).
function throwSpots (cells, feet) {
  const out = []
  for (const cell of cells?.values?.() ?? []) {
    const d = Math.hypot(cell.x + 0.5 - feet.x, cell.z + 0.5 - feet.z)
    if (d >= 3 && d <= 6) out.push({ cell, d })
  }
  return out.sort((a, b) => b.d - a.d).map(entry => entry.cell)
}

async function discardJunk ({ drop, walk = null, why = () => null, cells = () => null, getInventory, getFeet, shared, say = () => {}, now = Date.now }) {
  const list = throwable(getInventory())
  if (!list.length) return 0
  // Not again within a minute: a pickup that undid the throw must not loop (live 23:24-23:25 JST: 18 stacks every 8 s).
  if ((shared.playerDiscards ?? []).some(entry => entry.until - AGAIN_MS > now() - 60000)) return 0
  const home = getFeet()
  const spots = walk && home ? throwSpots(cells(), home) : []
  if (walk && !spots.length) { say('いらない物を捨てる場所がありません（3〜6m先に歩ける場所がありません。足元に捨てると拾い直すため）'); return 0 }
  // Up to three spots, farthest first (live 23:29 JST: the first walk was refused at once).
  let spot = null
  for (const cell of spots.slice(0, 3)) if (await walk({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 })) { spot = cell; break }
  if (walk && !spot) { say(`いらない物を捨てる場所へ歩けません (${spots.slice(0, 3).map(cell => `${cell.x}, ${cell.y}, ${cell.z}`).join(' / ')})${why() ? ` ${String(why()).slice(0, 100)}` : ''}`); return 0 }
  const at = getFeet() ?? home
  let thrown = 0
  const names = []
  for (const stack of list) {
    try {
      const result = await drop(stack.slot, stack.count)
      if (result?.phase === 'completed') { thrown++; names.push(`${stack.name.replace('minecraft:', '')} ${stack.count}`) }
    } catch { /* the next stack */ }
  }
  // Straight back, before the pickup delay ends.
  if (spot && thrown) await walk({ x: Math.floor(home.x) + 0.5, y: Math.floor(home.y + 0.05), z: Math.floor(home.z) + 0.5 })
  if (thrown && at) {
    const record = shared.playerDiscards = (shared.playerDiscards ?? []).filter(entry => entry.until > now())
    record.push({ x: at.x, y: at.y, z: at.z, names: list.map(stack => stack.name), until: now() + AGAIN_MS })
  }
  say(thrown ? `チェストを使えないため、いらない物を ${thrown} 枠捨てました（${names.slice(0, 8).join('、')}${names.length > 8 ? ' ほか' : ''}${spot ? `、${spot.x}, ${spot.y}, ${spot.z} から` : ''}）` : `いらない物を捨てられません（${list.length} 枠）`)
  return thrown
}

// Drops near where the same things were thrown are not walked back for.
function discarded (shared, drop, now = Date.now()) {
  const name = drop?.name ?? drop?.item?.name
  if (!drop?.position || !Array.isArray(shared?.playerDiscards)) return false
  return shared.playerDiscards.some(entry => entry.until > now && Math.hypot(drop.position.x - entry.x, drop.position.y - entry.y, drop.position.z - entry.z) <= 6 && (!name || entry.names.some(other => other === name || other === `minecraft:${name}`)))
}

module.exports = { throwable, throwSpots, discardJunk, discarded }
