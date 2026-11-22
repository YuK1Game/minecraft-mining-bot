'use strict'

// The storage job's hands on the runtime's ordinary operations: crafting in
// the inventory grid and at a table, normal placement, and the chest window.
// A craft counts by the received inventory, a placement by the received
// block, a deposit by the received inventory slot.
const TABLE = 'minecraft:crafting_table'
const AIR = /^minecraft:(?:air|cave_air|void_air|short_grass|fern|leaf_litter)$/
const { createContainerPorts } = require('./return/container-ports')

function createStoragePorts ({ operations, getBlock, getFeet, getInventory, reservedPlacement = () => false, held = () => false, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, memory = null, tool }) {
  const items = () => getInventory()?.items ?? []
  const count = name => items().filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  async function patient (run, canRetry = () => true) {
    const end = now() + 10000
    for (;;) {
      try { return await run() } catch (error) {
        if (!canRetry() || !/待って|待機|使用中|確認しています/.test(String(error?.message ?? '')) || now() >= end || disposed()) throw error
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
  function craftPlanks (log, times = 1, maxTimes = times) {
    const output = log.replace(/_(?:log|wood)$/, '_planks').replace(/_(?:stem|hyphae)$/, '_planks')
    if (maxTimes === times || typeof operations.crafting.preview !== 'function') return craftSmall(output, times)
    for (let batch = times; batch <= maxTimes; batch++) {
      if (operations.crafting.preview(output, { times: batch })?.ready === true) return craftSmall(output, batch)
    }
    return false
  }

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
  let retrySafe = true
  // Normal placement of a held block on the floor of a cell; it counts when the block is received.
  async function place (cell, name) {
    retrySafe = true
    if (reservedPlacement(cell)) return false
    const stacks = () => items().filter(item => item?.name === name && item.count > 0)
    let item = stacks().find(stack => stack.slot <= 8)
    try {
      if (!item && stacks().length) { await patient(() => operations.inventory.equip(stacks()[0].slot)); item = stacks().find(stack => stack.slot <= 8) }
      if (!item) return false
      await patient(() => {
        retrySafe = false
        let result
        try {
          result = operations.interactions.placeBlock({ position: cell, slot: item.slot, face: 1, alignFacing: name === 'minecraft:chest' })
        } catch (error) {
          // A synchronous preflight refusal has not queued a transaction.
          retrySafe = !error?.details?.placementFailure
          throw error
        }
        return Promise.resolve(result).catch(error => {
          const receipt = error?.details?.placementFailure
          retrySafe = !!receipt && (receipt.serverRejected === true || receipt.notSent === true && receipt.transactionQueued === false && receipt.wireSent === false)
          throw error
        })
      }, () => retrySafe)
    } catch (error) {
      const receipt = error?.details?.placementFailure
      if (receipt) retrySafe = receipt.serverRejected === true || receipt.notSent === true && receipt.transactionQueued === false && receipt.wireSent === false
      refusal = String(error?.message ?? error).slice(0, 120); return false
    }
    return until(() => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && found.name === name }, 5000)
  }

  async function placeTable () {
    const at = feetCell()
    if (!at) return null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) for (const dy of [0, -1]) {
      const cell = { x: at.x + dx, y: at.y + dy, z: at.z + dz }, here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
      if (here?.known !== true || !AIR.test(here.name ?? '') || below?.known !== true || below.boundingBox !== 'block') continue
      if (await place(cell, TABLE)) return cell
      if (!retrySafe) return null
    }
    return null
  }

  async function craftAtTable (table, output, times) {
    const before = count(output)
    try {
      await patient(() => operations.interactions.openCraftingTable(table))
      await operations.crafting.craft(output, { times })
      return await until(() => count(output) >= before + times, 4000)
    } catch { return false } finally {
      close()
      try { await operations.playerWorkstations?.recoverAt(table) } catch { /* Pending recovery survives interruption. */ }
    }
  }

  // The chest window: opening, reading, depositing and taking out (return/container-ports.js).
  const box = createContainerPorts({ operations, getInventory, getBlock, getFeet, held, disposed, sleep, now, memory, tool })

  return { craftSmall, craftPlanks, tableNear, place, hold, drop, placeTable, craftAtTable, recoverTables: () => operations.playerWorkstations?.recoverNearby({ tablesOnly: true }), placementRetrySafe: () => retrySafe, room: box.room, contents: box.contents, store: box.store, take: box.take, withdraw: box.withdraw, inspect: box.inspect, deposit: box.deposit, recoverTransfer: box.recoverTransfer, access: box.access, refusal: () => refusal }
}

module.exports = { createStoragePorts }
