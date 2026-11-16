'use strict'

// Crafting puts its result only into an empty slot, so a full inventory gets
// one first: the smallest single stack of plain stone is set down on the floor
// beside the Bot by normal placement until its slot is empty (real Realm
// 2026-11-16 20:53-20:58 JST: 36/36 slots with 5 logs and 6 planks, every
// plank craft was refused for want of an empty slot and the job reported
// 「板材が足りません」 once a minute).
// - Only stone that is stored anyway and not the cobblestone/dirt reserve, and
//   only a stack of 16 or fewer, so a few blocks are left, not a wall.
// - Cells: received air with a received solid block below, within reach, not
//   the Bot's own column and not the cells kept for the chests. A placed block
//   may carry one more on top.
const PLACEABLE = /^minecraft:(?:cobbled_deepslate|deepslate|diorite|granite|andesite|tuff|calcite|stone|netherrack|sandstone)$/
const AIR = /^minecraft:(?:air|cave_air|void_air|short_grass|fern|leaf_litter)$/
const MOST = 16

const slotsOf = inventory => (inventory?.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
const free = inventory => 36 - new Set(slotsOf(inventory).map(item => item.slot)).size

// The stack to set down: [{ slot, name, count }] or null.
function pick (inventory) {
  const items = slotsOf(inventory)
  return items.filter(item => PLACEABLE.test(item.name ?? '') && item.count <= MOST && items.filter(other => other.name === item.name).length === 1).sort((a, b) => a.count - b.count)[0] ?? null
}

function roomCells (getBlock, feet, avoid = [], tried = new Set()) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  const key = cell => `${cell.x},${cell.y},${cell.z}`
  const kept = new Set(avoid.map(key))
  const out = []
  for (const dy of [0, 1]) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const cell = { x: fx + dx, y: fy + dy, z: fz + dz }
    if ((dx === 0 && dz === 0) || kept.has(key(cell)) || kept.has(key({ ...cell, y: cell.y - 1 })) || tried.has(key(cell))) continue
    if (Math.hypot(cell.x + 0.5 - feet.x, cell.z + 0.5 - feet.z) > 3) continue
    const here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
    if (here?.known !== true || !AIR.test(here.name ?? '') || here.extra?.length || below?.known !== true || below.boundingBox !== 'block') continue
    if (/chest|crafting_table|furnace/.test(below.name ?? '')) continue
    out.push(cell)
  }
  // Farther cells first, so the Bot's own way out stays open longest.
  return out.sort((a, b) => a.y - b.y || Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z) - Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z))
}

async function makeRoom ({ hands, getBlock, getFeet, getInventory, avoid = [], say = () => {} }) {
  if (free(getInventory()) >= 1) return true
  const stack = pick(getInventory())
  if (!stack) { say('持ち物に空きを作れません（置ける16個以下の石材がありません）'); return false }
  const tried = new Set()
  for (let step = 0; step < MOST + 4 && free(getInventory()) < 1; step++) {
    const feet = getFeet()
    const cell = feet && roomCells(getBlock, feet, avoid, tried)[0]
    if (!cell) break
    if (!await hands.place(cell, stack.name)) tried.add(`${cell.x},${cell.y},${cell.z}`)
  }
  const ok = free(getInventory()) >= 1
  say(ok ? `持ち物に空きを作るため、${stack.name.replace('minecraft:', '')} ${stack.count} 個を足元の横に置きました` : `持ち物に空きを作れません（${stack.name.replace('minecraft:', '')} を置ける場所がありません）`)
  return ok
}

module.exports = { makeRoom, roomCells, pick, free }
