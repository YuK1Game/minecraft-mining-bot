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
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.05), fz = Math.floor(feet.z)
  const key = cell => `${cell.x},${cell.y},${cell.z}`
  const kept = new Set(avoid.map(key))
  const out = []
  // Beside the feet first; in a 1-wide stair tunnel the only open cells are the
  // steps above and below (live 2026-11-16 22:31 JST, y=-37: 36/36 slots and
  // 「tuff を置けません。置ける場所がありません」 with only dy 0/1 within 3 m).
  for (const dy of [0, 1, 2, -1]) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const cell = { x: fx + dx, y: fy + dy, z: fz + dz }
    if ((dx === 0 && dz === 0) || kept.has(key(cell)) || kept.has(key({ ...cell, y: cell.y - 1 })) || tried.has(key(cell))) continue
    if (Math.hypot(cell.x + 0.5 - feet.x, cell.z + 0.5 - feet.z) > (dy === 0 || dy === 1 ? 3 : 3.5)) continue
    const here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
    if (here?.known !== true || !AIR.test(here.name ?? '') || here.extra?.length || below?.known !== true || below.boundingBox !== 'block') continue
    if (/chest|crafting_table|furnace/.test(below.name ?? '')) continue
    out.push(cell)
  }
  // Farther cells first, so the Bot's own way out stays open longest.
  const rank = cell => [0, 1, 2, -1].indexOf(cell.y - fy)
  return out.sort((a, b) => rank(a) - rank(b) || Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z) - Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z))
}

// What a mined wall block drops, when it is one plain rock.
const DROP = { stone: 'cobblestone', deepslate: 'cobbled_deepslate', cobblestone: 'cobblestone', cobbled_deepslate: 'cobbled_deepslate', tuff: 'tuff', andesite: 'andesite', diorite: 'diorite', granite: 'granite', calcite: 'calcite', dirt: 'dirt' }

// Plain rock that a bare hand (any non-tool held) breaks without a drop.
const BARE = { tuff: 1, stone: 1, andesite: 1, diorite: 1, granite: 1, cobblestone: 2, deepslate: 3, cobbled_deepslate: 3 }

// A wall cell beside the Bot (feet or head height) to open for the stack:
// { cell, bare }. First one whose drop fits into a held stack (mined with the
// pickaxe, the drop takes no slot); otherwise plain rock dug with the stack
// itself in hand, which drops nothing (bare: true), softest first.
// In a 1-wide tunnel the steps hold only a block or two (live 2026-11-16
// 22:35-22:39 JST, y=-37: a tuff stack never fit, 36/36 slots for 4 minutes),
// and the open cells there are kept for the chests (22:43-22:47 JST: every
// deepslate wall dropped cobbled_deepslate with no stack to merge into, so no
// wall was opened at all).
function pocketCell (getBlock, feet, inventory, placing, refused, avoid = []) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.05), fz = Math.floor(feet.z)
  const key = cell => `${cell.x},${cell.y},${cell.z}`
  const kept = new Set(avoid.flatMap(cell => [key(cell), key({ ...cell, y: cell.y - 1 })]))
  const room = name => (inventory?.items ?? []).some(item => item?.name === `minecraft:${name}` && item.count < 64)
  const bare = []
  for (const dy of [1, 0]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = { x: fx + dx, y: fy + dy, z: fz + dz }
    if (refused.has(key(cell)) || kept.has(key(cell))) continue
    const block = getBlock(cell.x, cell.y, cell.z), name = String(block?.name ?? '').replace('minecraft:', '')
    if (block?.known !== true || block.extra?.length) continue
    if (DROP[name] && `minecraft:${DROP[name]}` !== placing && room(DROP[name])) return { cell, bare: false }
    if (BARE[name]) bare.push({ cell, rank: BARE[name] * 2 + (dy === 0 ? 0 : 1) })
  }
  const soft = bare.sort((a, b) => a.rank - b.rank)[0]
  return soft ? { cell: soft.cell, bare: true } : null
}

async function makeRoom ({ hands, getBlock, getFeet, getInventory, avoid = [], say = () => {}, mine = null, dig = null, why = () => null }) {
  if (free(getInventory()) >= 1) return true
  const stack = pick(getInventory())
  if (!stack) { say('持ち物に空きを作れません（置ける16個以下の石材がありません）'); return false }
  const tried = new Set(), refused = new Set(), note = []
  let pockets = 0
  for (let step = 0; step < 2 * (MOST + 4) && free(getInventory()) < 1; step++) {
    const feet = getFeet()
    const cell = feet && roomCells(getBlock, feet, avoid, tried)[0]
    if (!cell) {
      const wall = mine && feet && pocketCell(getBlock, feet, getInventory(), stack.name, refused, avoid)
      if (!wall || (wall.bare && !dig)) { note.push(feet ? `壁の候補なし 足 ${feet.x.toFixed(2)},${feet.y.toFixed(2)},${feet.z.toFixed(2)}` : '足の位置なし'); break }
      // Bare digging holds the stack itself, so nothing drops into the full inventory.
      const held = wall.bare ? (await hands.hold?.(stack.name)) !== false : true
      const opened = held && (wall.bare ? await dig(wall.cell) : await mine(wall.cell))
      if (opened) pockets++
      else { refused.add(`${wall.cell.x},${wall.cell.y},${wall.cell.z}`); note.push(`${held ? '掘れない' : '持ち替えできない'} ${wall.cell.x},${wall.cell.y},${wall.cell.z}${held && why() ? ` ${String(why()).slice(0, 80)}` : ''}`) }
      continue
    }
    if (!await hands.place(cell, stack.name)) { tried.add(`${cell.x},${cell.y},${cell.z}`); note.push(`置けない ${cell.x},${cell.y},${cell.z}`) }
  }
  if (pockets) say(`石材を置く場所を作るため、坑道の壁を ${pockets} マス掘りました`)
  const ok = free(getInventory()) >= 1
  say(ok ? `持ち物に空きを作るため、${stack.name.replace('minecraft:', '')} ${stack.count} 個を足元の横に置きました` : `持ち物に空きを作れません（${stack.name.replace('minecraft:', '')} を置けません${hands.refusal?.() ? `: ${hands.refusal()}` : '。置ける場所がありません'}${note.length ? `; ${note.slice(-4).join('; ')}` : ''}）`)
  return ok
}

module.exports = { makeRoom, roomCells, pocketCell, pick, free }
