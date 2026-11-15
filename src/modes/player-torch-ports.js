'use strict'

// The torch job's hands on the runtime's ordinary operations. A craft counts
// by the received inventory, a placement by the received torch block.
const TORCH = 'minecraft:torch'

function createTorchPorts ({ operations, getBlock, getInventory, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const count = name => (getInventory()?.items ?? []).filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  // A start refused only because the previous operation is still ending is tried again for a few seconds.
  async function patient (run) {
    const end = now() + 10000
    for (;;) {
      try { return await run() } catch (error) {
        if (!/待って|待機|使用中|確認しています/.test(String(error?.message ?? '')) || now() >= end || disposed()) throw error
        await sleep(300)
      }
    }
  }
  // Sticks and torches fit the inventory's own 2x2 grid.
  async function craft (output) {
    const before = count(output)
    try {
      await patient(() => operations.crafting.openInventory())
      await operations.crafting.craft(output, { times: 1 })
    } catch { return false } finally { try { operations.crafting.closeContainer() } catch {} }
    return until(() => count(output) > before, 3000)
  }
  async function place (cell) {
    const held = () => (getInventory()?.items ?? []).filter(item => item?.name === TORCH && item.count > 0)
    let item = held().find(stack => stack.slot <= 8)
    try {
      if (!item && held().length) { await patient(() => operations.inventory.equip(held()[0].slot)); item = held().find(stack => stack.slot <= 8) }
      if (!item) return false
      await patient(() => operations.interactions.placeBlock({ position: cell, slot: item.slot, face: 1 }))
    } catch { return false }
    return until(() => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && found.name === TORCH }, 5000)
  }
  return { craft, place }
}

module.exports = { createTorchPorts }
