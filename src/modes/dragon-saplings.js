'use strict'

// Saplings are planted around the house, and bone meal grows them, so the house has its own wood.
//
// The trees near the house were cut out: every log for sticks, planks or charcoal was a 48 m trip by the long
// travel, often more than one (live 2026-11-28 22:53-23:02 JST: 「周辺で原木が見つからないため、長距離移動で場所を変えます」
// three times in ten minutes, while the branch mine waited for four planks). Saplings were thrown away as junk.
//
// - Only on the surface within FAR_M of the house, never while threatened (the caller checks), at most once every
//   AGAIN_MS when there is nothing to do. The step walks at most WALK_M to a spot.
// - A spot: received grass, dirt or podzol with received air above it for a tree's height, 8-26 m from the house's
//   centre, outside the house and its porch, with no sapling, log or work block within two cells, not protected.
// - Bones are made into bone meal in the inventory's own grid, and bone meal is used on a received sapling in reach.
// - A sapling counts as planted only by the received sapling block, a grown tree only by the received log. A spot
//   that did not take is not tried again for RETRY_MS.
// - The trees grown here are felled by the ordinary wood search (dragon-supply-gather.js), to their last log.
const { createTorchPorts } = require('./player-torch-ports')

const SAPLING = /^minecraft:(?:oak|spruce|birch|jungle|acacia|cherry)_sapling$/
const ANY_SAPLING = /^minecraft:[a-z_]+_sapling$/
const SOIL = /^minecraft:(?:grass_block|dirt|podzol)$/
const AIR = /^minecraft:(?:air|cave_air)$/
const CROWDED = /_sapling$|_log$|_wood$|chest|furnace|crafting_table|_bed$|door|torch|ladder|water|lava/
const FAR_M = 32, NEAR_RING = 8, FAR_RING = 26, WALK_M = 12, REACH = 4, HEIGHT = 6, MAX_SAPLINGS = 16
const AGAIN_MS = 30000, RETRY_MS = 30 * 60000, BONE_KEEP = 0
const key = at => `${at.x},${at.y},${at.z}`

function count (items, test) { return items.filter(item => item?.count > 0 && test.test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0) }

function centreOf (origin) { return { x: origin.x + 3, y: origin.y, z: origin.z + 3 } }

function inHouse (origin, at) { return at.x >= origin.x - 2 && at.x <= origin.x + 8 && at.z >= origin.z - 2 && at.z <= origin.z + 11 }

// Received soil cells with room for a tree, around the house; and the saplings already standing there.
function survey (getBlock, origin, rested = new Map(), now = Date.now(), feet = null) {
  const centre = centreOf(origin), spots = [], saplings = []
  for (let dx = -FAR_RING; dx <= FAR_RING; dx++) for (let dz = -FAR_RING; dz <= FAR_RING; dz++) {
    const d = Math.hypot(dx, dz)
    if (d > FAR_RING) continue
    const x = centre.x + dx, z = centre.z + dz
    for (let dy = -4; dy <= 4; dy++) {
      const y = centre.y + dy, soil = getBlock(x, y, z)
      if (soil?.known !== true) continue
      const above = getBlock(x, y + 1, z)
      if (above?.known === true && ANY_SAPLING.test(above.name ?? '')) { saplings.push({ x, y: y + 1, z, name: above.name }); break }
      if (d < NEAR_RING || !SOIL.test(soil.name ?? '') || soil.protected || soil.protectionSource) continue
      const at = { x, y, z }
      if (inHouse(origin, at) || (rested.get(key(at)) ?? 0) > now) continue
      let open = true
      for (let up = 1; up <= HEIGHT && open; up++) { const cell = getBlock(x, y + up, z); open = cell?.known === true && AIR.test(cell.name ?? '') && !cell.extra?.length }
      if (!open) continue
      spots.push(at)
      break
    }
  }
  const crowded = at => {
    for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) for (let oy = 0; oy <= 2; oy++) {
      const cell = getBlock(at.x + ox, at.y + oy, at.z + oz)
      if (cell?.known === true && CROWDED.test(cell.name ?? '')) return true
    }
    return false
  }
  // The spacing check is the costly part: only for the spots near enough to walk to.
  const near = feet ? spots.filter(at => Math.hypot(at.x + 0.5 - feet.x, at.z + 0.5 - feet.z) <= WALK_M + 1) : spots
  return { spots: near.filter(at => !crowded(at)), saplings }
}

// A chest by the house whose last read held what `test` matches, not tried in the last five minutes.
function chestWith (shared, origin, test, state, now) {
  const memory = shared.playerChestMemory
  if (!memory) return null
  try { memory.ensure?.() } catch { /* the next look reads it */ }
  const centre = centreOf(origin)
  for (const [key, slots] of memory.seen ?? []) {
    const [x, y, z] = String(key).split(',').map(Number)
    if (![x, y, z].every(Number.isFinite) || Math.hypot(x - centre.x, z - centre.z) > FAR_M || Math.abs(y - origin.y) > 6) continue
    if ((state.rested.get('chest:' + key) ?? 0) > now) continue
    const stack = (Array.isArray(slots) ? slots : []).find(slot => slot?.count > 0 && test.test(slot.name ?? ''))
    if (stack) return { key, pos: { x, y, z }, name: stack.name, count: (slots ?? []).filter(slot => slot?.name === stack.name).reduce((sum, slot) => sum + slot.count, 0) }
  }
  return null
}

async function heldSlot (ctx, test) {
  const items = () => ctx.runtime.inventory()?.items ?? []
  let item = items().find(stack => stack.count > 0 && test.test(stack.name ?? '') && stack.slot <= 8) ?? items().find(stack => stack.count > 0 && test.test(stack.name ?? ''))
  if (!item) return null
  const equip = await ctx.operations.inventory.equip(item.slot)
  if (!equip || !['completed', 'unchanged', 'already_selected'].includes(equip.phase) || ctx.cancelled()) return null
  item = items().find(stack => stack.slot === equip.slot && stack.count > 0 && test.test(stack.name ?? ''))
  return item ?? null
}

async function plantSaplings (ctx, { now = Date.now } = {}) {
  const shared = ctx.shared, state = shared.playerSaplings ??= { nextAt: 0, rested: new Map(), planted: 0, grown: 0 }
  if (now() < state.nextAt || ctx.runtime.raw?.()?.dimension !== 'overworld') return null
  state.nextAt = now() + AGAIN_MS
  const origin = shared.playerHouse?.origin, feet = ctx.getFeet?.()
  const inventory = ctx.runtime.inventory?.()
  if (!origin || !feet || inventory?.known !== true || inventory.uncertain || shared.inventoryUncertain) return null
  const centre = centreOf(origin)
  if (Math.hypot(feet.x - centre.x, feet.z - centre.z) > FAR_M || Math.abs(feet.y - origin.y) > 6) return null
  const items = inventory.items ?? []
  const sapling = count(items, SAPLING), bones = count(items, /^minecraft:bone$/), meal = count(items, /^minecraft:bone_meal$/)
  // Saplings and bones banked in the house's chests are taken out here, by the house: 29 saplings and 5 bones sat in
  // chests while the Bot walked 48 m at a time for a log (live 2026-11-29 00:10-00:33 JST).
  const fetch = !sapling ? SAPLING : !bones && !meal ? /^minecraft:bone$/ : null
  const stored = fetch && typeof ctx.supplies?.withdraw === 'function' ? chestWith(shared, origin, fetch, state, now()) : null
  if (stored) {
    state.rested.set('chest:' + stored.key, now() + 5 * 60000)
    // `withdraw` takes up to a held total.
    const want = count(items, new RegExp('^' + stored.name + '$')) + Math.min(16, stored.count)
    const taken = await ctx.supplies.withdraw(stored.pos, stored.name.replace('minecraft:', ''), want)
    state.nextAt = 0
    return { phase: 'working', reason: `家のチェストから ${stored.name.replace('minecraft:', '')} を取り出します（${taken?.reason ?? ''}）。` }
  }
  if (!sapling && !bones && !meal) return null
  const { spots, saplings } = survey(ctx.getBlock, origin, state.rested, now(), feet)
  const dist = at => Math.hypot(at.x + 0.5 - feet.x, at.y + 1 - feet.y, at.z + 0.5 - feet.z)
  // Bone meal first: a sapling standing is wood soon.
  if (saplings.length && (meal || bones > BONE_KEEP)) {
    if (!meal) {
      const made = await createTorchPorts({ operations: ctx.operations, getBlock: ctx.getBlock, getInventory: () => ctx.runtime.inventory(), disposed: ctx.cancelled }).craft('minecraft:bone_meal')
      state.nextAt = 0
      return { phase: 'working', reason: made ? '骨を骨粉にしました。' : '骨粉を作れませんでした。' }
    }
    const target = saplings.filter(at => dist(at) <= WALK_M).sort((a, b) => dist(a) - dist(b))[0]
    if (target) {
      if (dist(target) > REACH && !(await ctx.hands?.approach?.(target, 3)) || ctx.cancelled()) return { phase: 'working', reason: '苗木へ近づきます。' }
      const held = await heldSlot(ctx, /^minecraft:bone_meal$/)
      if (!held) return { phase: 'working', reason: '骨粉を持ち替えています。' }
      const before = ctx.getBlock(target.x, target.y, target.z)?.name
      try { await ctx.operations.interactions.useDragonItem({ item: 'minecraft:bone_meal', position: target, slot: held.slot }) } catch (error) {
        state.rested.set(key({ ...target, y: target.y - 1 }), now() + 5 * 60000)
        ctx.log?.(`プレイヤーモード: 苗木 (${target.x}, ${target.y}, ${target.z}) に骨粉を使えません（${String(error?.message ?? error).slice(0, 60)}）`)
        return null
      }
      await (ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(800)
      const after = ctx.getBlock(target.x, target.y, target.z)
      if (after?.known === true && /_log$/.test(after.name ?? '')) { state.grown++; ctx.log?.(`プレイヤーモード: 骨粉で木が育ちました (${target.x}, ${target.z})`) }
      state.nextAt = 0
      return { phase: 'working', reason: `苗木に骨粉を使いました（${before ?? '?'}）。` }
    }
  }
  if (!sapling || saplings.length >= MAX_SAPLINGS) return null
  const spot = spots.filter(at => dist(at) <= WALK_M).sort((a, b) => dist(a) - dist(b))[0]
  if (!spot) return null
  if (dist(spot) > REACH && !(await ctx.hands?.approach?.(spot, 3)) || ctx.cancelled()) { state.rested.set(key(spot), now() + RETRY_MS); return { phase: 'working', reason: '苗木を植える場所へ近づきます。' } }
  const held = await heldSlot(ctx, SAPLING)
  if (!held) return { phase: 'working', reason: '苗木を持ち替えています。' }
  try { await ctx.operations.interactions.useDragonItem({ item: held.name, position: spot, slot: held.slot }) } catch (error) {
    state.rested.set(key(spot), now() + RETRY_MS)
    ctx.log?.(`プレイヤーモード: (${spot.x}, ${spot.y + 1}, ${spot.z}) に苗木を植えられません（${String(error?.message ?? error).slice(0, 60)}）`)
    return null
  }
  await (ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(800)
  const placed = ctx.getBlock(spot.x, spot.y + 1, spot.z)
  if (placed?.known === true && ANY_SAPLING.test(placed.name ?? '')) { state.planted++; ctx.log?.(`プレイヤーモード: 家のまわりに苗木を植えました (${spot.x}, ${spot.y + 1}, ${spot.z})（${placed.name.replace('minecraft:', '')}）`) } else state.rested.set(key(spot), now() + RETRY_MS)
  state.nextAt = 0
  return { phase: 'working', reason: '家のまわりに苗木を植えています。' }
}

module.exports = { plantSaplings, survey, SAPLING, MAX_SAPLINGS }
