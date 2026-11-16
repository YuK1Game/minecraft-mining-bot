'use strict'

// Player mode: a full inventory goes into a large chest beside the Bot. The
// planners only stopped on a full inventory (real Realm 2026-11-16 20:47 JST:
// 「持ち物が満杯です」 every second, 15 of the 36 slots stone; user:
// 「チェスト作る機能はないの？持ち物整理したり。チェストはもちろんラージチェストになるように優先してね」).
// - It starts when 34 or more of the 36 slots are taken and something can be
//   stored: stone and other building rubble beyond a reserve (64 cobblestone
//   and 32 dirt stay for pillars and floors), leaf litter, gravel, flint,
//   rotten flesh, and pickaxes with 2 or fewer uses when another pickaxe has
//   more. Diamonds, ores, coal, food, wood, working tools and weapons stay.
// - The chest: a large chest within 5 blocks with room is used first. A single
//   chest there is made large by a second one placed beside it. Otherwise two
//   chests are placed side by side (a large chest). Chests are made from held
//   planks or logs at a crafting table within reach, or a table made and
//   placed from held planks.
// - Every step counts only by received data: a craft by the received
//   inventory, a chest by the received block, a deposit by the received slots.
const { normalizeMode } = require('./bot-mode')

const CHEST = 'minecraft:chest'
const TABLE = 'minecraft:crafting_table'
const AIR = /^minecraft:(?:air|cave_air|void_air|short_grass|fern|leaf_litter)$/
const RUBBLE = /^minecraft:(?:cobbled_deepslate|deepslate|diorite|granite|andesite|tuff|calcite|stone|gravel|flint|leaf_litter|rotten_flesh|netherrack|sandstone|sand|clay_ball|poisonous_potato)$/
const KEEP = { 'minecraft:cobblestone': 64, 'minecraft:dirt': 32 }
const START_AT = 34, NEAR = 5, AGAIN_MS = 60000

const bare = name => String(name ?? '')
const pickaxeUses = item => Number.isSafeInteger(item?.maxDurability) && Number.isSafeInteger(item?.durabilityUsed) ? item.maxDurability - item.durabilityUsed : null

// The stacks to store: [{ slot, name, count }], biggest reserve first kept.
function storable (inventory) {
  if (inventory?.known !== true || inventory.uncertain) return []
  const items = (inventory.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
  const out = []
  // Keep the reserve in the largest stacks; store the rest.
  for (const [name, keep] of Object.entries(KEEP)) {
    let left = keep
    for (const item of items.filter(item => item.name === name).sort((a, b) => b.count - a.count)) {
      if (left >= item.count) { left -= item.count; continue }
      out.push({ slot: item.slot, name, count: item.count - left }); left = 0
    }
  }
  for (const item of items) if (RUBBLE.test(bare(item.name))) out.push({ slot: item.slot, name: item.name, count: item.count })
  const picks = items.filter(item => /_pickaxe$/.test(bare(item.name)))
  if (picks.some(item => (pickaxeUses(item) ?? 0) > 2)) for (const item of picks) { const uses = pickaxeUses(item); if (uses != null && uses <= 2) out.push({ slot: item.slot, name: item.name, count: item.count }) }
  return out
}

const occupied = inventory => new Set((inventory?.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot)).size

// Chests within reach: [{ position, pair: position|null }].
function chestsNear (getBlock, feet, near = NEAR) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  const isChest = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.name === CHEST }
  const found = []
  for (let dy = -2; dy <= 3; dy++) for (let dx = -near; dx <= near; dx++) for (let dz = -near; dz <= near; dz++) {
    const x = fx + dx, y = fy + dy, z = fz + dz
    if (!isChest(x, y, z)) continue
    const pair = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([ox, oz]) => ({ x: x + ox, y, z: z + oz })).find(p => isChest(p.x, p.y, p.z)) ?? null
    found.push({ position: { x, y, z }, pair })
  }
  return found.sort((a, b) => Number(!!b.pair) - Number(!!a.pair) || Math.hypot(a.position.x - fx, a.position.z - fz) - Math.hypot(b.position.x - fx, b.position.z - fz))
}

// A cell a chest can stand in: received air with received solid ground, not
// the Bot's own cells, beside the feet level.
function chestCell (getBlock, feet, cell) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  if (cell.x === fx && cell.z === fz) return false
  if (Math.abs(cell.y - fy) > 1 || Math.hypot(cell.x + 0.5 - feet.x, cell.z + 0.5 - feet.z) > 3.5) return false
  const here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
  return here?.known === true && AIR.test(here.name ?? '') && !here.extra?.length && below?.known === true && below.boundingBox === 'block' && !/chest|crafting_table|furnace|leaves|sand$|gravel$/.test(below.name ?? '')
}

// Two cells side by side for a new large chest, or one beside a single chest.
function chestCells (getBlock, feet, single = null) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  if (single) return SIDES.map(([dx, dz]) => ({ x: single.x + dx, y: single.y, z: single.z + dz })).filter(cell => chestCell(getBlock, feet, cell)).slice(0, 1)
  for (const dy of [0, -1, 1]) for (const [dx, dz] of [...SIDES, [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const first = { x: fx + dx, y: fy + dy, z: fz + dz }
    if (!chestCell(getBlock, feet, first)) continue
    // The pair runs across the line of sight so both are placed facing the Bot.
    const along = Math.abs(dx) >= Math.abs(dz) ? [0, 1] : [1, 0]
    for (const sign of [1, -1]) {
      const second = { x: first.x + along[0] * sign, y: first.y, z: first.z + along[1] * sign }
      if (chestCell(getBlock, feet, second)) return [first, second]
    }
  }
  return []
}

function createPlayerStorage ({ getMode, shared, agent, hands, getBlock, getFeet, getInventory, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, stored = 0
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return true } catch { await sleep(2000) } } return false }
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const held = name => (getInventory()?.items ?? []).filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const say = text => log(`プレイヤーモード: ${text}`)

  // Chests held, made at a table from planks (logs are cut into planks first).
  async function makeChests (needed) {
    const planks = () => (getInventory()?.items ?? []).filter(item => /_planks$/.test(item?.name ?? '') && item.count > 0).reduce((sum, item) => sum + item.count, 0)
    const logs = () => (getInventory()?.items ?? []).filter(item => /_(?:log|stem|wood|hyphae)$/.test(item?.name ?? '') && !/stripped/.test(item.name) && item.count > 0)
    const want = needed - held(CHEST)
    if (want <= 0) return true
    const table = hands.tableNear()
    const plankNeed = want * 8 + (table ? 0 : held(TABLE) ? 0 : 4)
    for (let step = 0; step < 4 && planks() < plankNeed && logs().length; step++) if (!await hands.craftPlanks(logs()[0].name, Math.min(logs()[0].count, Math.ceil((plankNeed - planks()) / 4)))) break
    if (planks() < plankNeed) { say(`チェストを作る板材が足りません（板材 ${planks()}・必要 ${plankNeed}）`); return false }
    let at = table
    if (!at) {
      if (!held(TABLE) && !await hands.craftSmall(TABLE)) { say('作業台を作れません'); return false }
      at = await hands.placeTable()
      if (!at) { say('作業台を置けません'); return false }
    }
    if (!await hands.craftAtTable(at, CHEST, want)) { say('チェストを作れません'); return false }
    return held(CHEST) >= needed
  }

  async function run () {
    const feet = getFeet()
    let chests = chestsNear(getBlock, feet)
    let target = chests.find(chest => chest.pair && hands.room(chest.position) !== 0) ?? null
    // A single chest is made large first (user: large chests first).
    const single = !target ? chests.find(chest => !chest.pair) ?? null : null
    if (!target && single) {
      const cells = chestCells(getBlock, feet, single.position)
      if (cells.length && await makeChests(1) && await hands.place(cells[0], CHEST)) say(`チェストの隣にもう1つ置いてラージチェストにしました (${cells[0].x}, ${cells[0].y}, ${cells[0].z})`)
      target = { position: single.position }
    }
    if (!target) {
      const cells = chestCells(getBlock, feet)
      if (cells.length < 2) { say('ラージチェストを置ける平らな場所がありません'); return false }
      if (!await makeChests(2)) return false
      for (const cell of cells) if (!await hands.place(cell, CHEST)) { say(`チェストを置けません (${cell.x}, ${cell.y}, ${cell.z})`); return false }
      say(`ラージチェストを置きました (${cells[0].x}, ${cells[0].y}, ${cells[0].z})`)
      target = { position: cells[0] }
    }
    const moved = await hands.store(target.position, storable(getInventory()))
    stored += moved
    say(`チェスト (${target.position.x}, ${target.position.y}, ${target.position.z}) に ${moved} 個しまいました（持ち物 ${occupied(getInventory())}/36 枠）`)
    return moved > 0
  }

  async function tick () {
    if (busy || !live() || blocked() || now() < waitUntil) return null
    const inventory = getInventory(), feet = getFeet()
    if (!feet || occupied(inventory) < START_AT || !storable(inventory).length) return null
    busy = true
    let ok = false
    try {
      say(`持ち物が ${occupied(inventory)}/36 枠のため、チェストにしまいます。`)
      agent.stop('持ち物をチェストにしまっています。')
      await settle()
      ok = await run()
      return ok
    } catch (error) {
      say(`チェストにしまえません ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    } finally {
      waitUntil = now() + (ok ? 5000 : AGAIN_MS)
      busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '持ち物をチェストにしまっています。' : null, stored }) }
}

module.exports = { createPlayerStorage, storable, chestsNear, chestCells, occupied, START_AT }
