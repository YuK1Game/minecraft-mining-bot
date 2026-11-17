'use strict'

// The storage job's hands on the runtime's ordinary operations: crafting in
// the inventory grid and at a table, normal placement, and the chest window.
// A craft counts by the received inventory, a placement by the received
// block, a deposit by the received inventory slot.
const TABLE = 'minecraft:crafting_table'
const AIR = /^minecraft:(?:air|cave_air|void_air|short_grass|fern|leaf_litter)$/

function createStoragePorts ({ operations, getBlock, getFeet, getInventory, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const items = () => getInventory()?.items ?? []
  const count = name => items().filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  async function patient (run) {
    const end = now() + 10000
    for (;;) {
      try { return await run() } catch (error) {
        if (!/待って|待機|使用中|確認しています/.test(String(error?.message ?? '')) || now() >= end || disposed()) throw error
        await sleep(300)
      }
    }
  }
  const close = () => { try { operations.crafting.closeContainer() } catch {} }
  const feetCell = () => { const feet = getFeet(); return feet ? { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.05), z: Math.floor(feet.z) } : null }

  async function craftSmall (output, times = 1) {
    const before = count(output)
    try {
      await patient(() => operations.crafting.openInventory())
      await operations.crafting.craft(output, { times })
    } catch { return false } finally { close() }
    return until(() => count(output) > before, 3000)
  }
  const craftPlanks = (log, times) => craftSmall(log.replace(/_(?:log|wood)$/, '_planks').replace(/_(?:stem|hyphae)$/, '_planks'), times)

  function tableNear () {
    const at = feetCell()
    if (!at) return null
    for (let dy = -1; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const found = getBlock(at.x + dx, at.y + dy, at.z + dz)
      if (found?.known === true && found.name === TABLE) return { x: at.x + dx, y: at.y + dy, z: at.z + dz }
    }
    return null
  }

  // A held stack into the hand the server has selected (equip moves it there),
  // so bare digging breaks rock with no drop.
  async function hold (name) {
    const item = items().find(stack => stack?.name === name && stack.count > 0)
    if (!item) return false
    try { if ((await patient(() => operations.inventory.equip(item.slot)))?.phase === 'failed') return false } catch (error) { refusal = String(error?.message ?? error).slice(0, 120); return false }
    await sleep(250)
    return true
  }

  // Throwing a stack away; it counts when the server answers (inventory/discard.js).
  async function drop (slot, count) {
    try { return await patient(() => operations.inventory.discard(slot, count)) } catch (error) { refusal = String(error?.message ?? error).slice(0, 120); return null }
  }

  let refusal = null // the last placement refusal, for the log
  // Normal placement of a held block on the floor of a cell; it counts when the block is received.
  async function place (cell, name) {
    const stacks = () => items().filter(item => item?.name === name && item.count > 0)
    let item = stacks().find(stack => stack.slot <= 8)
    try {
      if (!item && stacks().length) { await patient(() => operations.inventory.equip(stacks()[0].slot)); item = stacks().find(stack => stack.slot <= 8) }
      if (!item) return false
      await patient(() => operations.interactions.placeBlock({ position: cell, slot: item.slot, face: 1 }))
    } catch (error) { refusal = String(error?.message ?? error).slice(0, 120); return false }
    return until(() => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && found.name === name }, 5000)
  }

  async function placeTable () {
    const at = feetCell()
    if (!at) return null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) for (const dy of [0, -1]) {
      const cell = { x: at.x + dx, y: at.y + dy, z: at.z + dz }, here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
      if (here?.known !== true || !AIR.test(here.name ?? '') || below?.known !== true || below.boundingBox !== 'block') continue
      if (await place(cell, TABLE)) return cell
    }
    return null
  }

  async function craftAtTable (table, output, times) {
    const before = count(output)
    try {
      await patient(() => operations.interactions.openCraftingTable(table))
      await operations.crafting.craft(output, { times })
    } catch { return false } finally { close() }
    return until(() => count(output) >= before + times, 4000)
  }

  // How many empty slots the chest has, and its received slots (null until it was opened once here).
  const rooms = new Map(), seen = new Map()
  const key = position => `${position.x},${position.y},${position.z}`
  const room = position => rooms.get(key(position)) ?? null
  const contents = position => seen.get(key(position)) ?? null
  const remember = position => { const slots = operations.chest.snapshot()?.slots ?? []; rooms.set(key(position), slots.filter(slot => slot.known === true && !slot.name && !slot.count).length); seen.set(key(position), slots.map(slot => ({ ...slot }))) }

  // Each stack into an empty chest slot; returns the items the inventory lost.
  async function store (position, stacks) {
    let moved = 0
    try {
      await patient(() => operations.chest.open(position))
      if (!await until(() => operations.chest.snapshot()?.contentsKnown === true, 4000)) return 0
      for (const stack of stacks) {
        if (disposed()) break
        const view = operations.chest.snapshot()
        const free = (view.slots ?? []).find(slot => slot.known === true && !slot.name && !slot.count)
        remember(position)
        if (!free) break
        const source = items().find(item => item.slot === stack.slot && item.name === stack.name && item.count > 0)
        if (!source) continue
        const amount = Math.min(stack.count, source.count, 64), before = source.count
        try { await patient(() => operations.chest.depositItem({ sourceSlot: stack.slot, count: amount, chestSlot: free.slot, expectedName: stack.name })) } catch { continue }
        if (await until(() => (items().find(item => item.slot === stack.slot && item.name === stack.name)?.count ?? 0) <= before - amount, 3000)) moved += amount
      }
    } catch { /* What was moved is counted from the received inventory. */ } finally { if (operations.chest.snapshot()?.contentsKnown === true) remember(position); close() }
    return moved
  }

  // The stacks pick(slots) names out of the chest; returns the items the inventory gained.
  async function take (position, pick) {
    let moved = 0
    try {
      await patient(() => operations.chest.open(position))
      if (!await until(() => operations.chest.snapshot()?.contentsKnown === true, 4000)) return 0
      remember(position)
      for (const want of pick(operations.chest.snapshot().slots ?? [])) {
        if (disposed()) break
        const before = count(want.name)
        try { await patient(() => operations.chest.withdrawItem({ chestSlot: want.chestSlot, count: want.count, expectedName: want.name })) } catch (error) { if (error?.code === 'INVENTORY_FULL') break; continue }
        if (await until(() => count(want.name) >= before + want.count, 3000)) moved += want.count
      }
      remember(position)
    } catch { /* What was taken is counted from the received inventory. */ } finally { close() }
    return moved
  }

  return { craftSmall, craftPlanks, tableNear, place, hold, drop, placeTable, craftAtTable, room, contents, store, take, refusal: () => refusal }
}

module.exports = { createStoragePorts }
