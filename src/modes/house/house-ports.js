'use strict'

// The game operations the starter house is built with: ordinary placement on
// any face (operations.interactions.placeHouseBlock), crafting in the inventory
// or at a crafting table, and smelting in a furnace. Everything counts by the
// received inventory and received blocks.
function createHousePorts ({ operations, getBlock, getInventory, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const items = () => getInventory()?.items ?? []
  const count = test => items().filter(item => item?.count > 0 && test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  let why = null
  const refused = error => { why = String(error?.message ?? error).slice(0, 160); return false }
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
  // A held stack of `name` into the hotbar (the selected slot), its slot back.
  async function inHand (name) {
    const stacks = () => items().filter(item => item?.name === name && item.count > 0)
    let item = stacks().find(stack => stack.slot <= 8)
    if (!item && stacks().length) { try { await patient(() => operations.inventory.equip(stacks()[0].slot)) } catch (error) { return refused(error) } item = stacks().find(stack => stack.slot <= 8) }
    return item ? item.slot : null
  }
  async function place (name, plan) {
    const slot = await inHand(name)
    if (slot == null || slot === false) { why ??= `${name} を手に持てません`; return false }
    const options = { position: plan.position, slot, clicked: plan.clicked, face: plan.face, clickY: plan.clickY, head: plan.head ?? null, alignFacing: plan.alignFacing === true }
    const preview = operations.interactions.previewHouseBlock(options)
    if (preview?.ready !== true) { why = String(preview?.errors?.[0] ?? '設置できません').slice(0, 160); return false }
    try { await patient(() => operations.interactions.placeHouseBlock(options)) } catch (error) { return refused(error) }
    return true
  }
  const preview = (name, plan) => {
    const item = items().find(stack => stack?.name === name && stack.count > 0)
    if (!item) return false
    const slot = item.slot <= 8 ? item.slot : 0
    return operations.interactions.previewHouseBlock({ position: plan.position, slot, clicked: plan.clicked, face: plan.face, clickY: plan.clickY, head: plan.head ?? null })?.ready === true || item.slot > 8
  }
  async function craft (output, times, table = null) {
    const before = count(name => name === output)
    try {
      if (table) await patient(() => operations.interactions.openCraftingTable(table))
      else await patient(() => operations.crafting.openInventory())
      await operations.crafting.craft(output, { times })
    } catch (error) { close(); return refused(error) }
    close()
    return until(() => count(name => name === output) > before, 4000)
  }
  // Smelting `input` (count) with `fuel` (count) in the furnace at `at`, then
  // taking `output` out; returns how many came out.
  async function smelt (at, input, inputCount, fuel, fuelCount, output) {
    const slotOf = name => items().find(item => item?.name === name && item.count > 0)?.slot
    const before = count(name => name === output)
    try {
      await patient(() => operations.interactions.openFurnace(at))
      await until(() => operations.furnace.snapshot?.()?.contentsKnown === true, 4000)
      if (slotOf(input) == null || slotOf(fuel) == null) { close(); why = '精錬の材料がありません'; return 0 }
      await operations.furnace.putInput(slotOf(input), inputCount)
      await operations.furnace.putFuel(slotOf(fuel), fuelCount)
      try { await operations.furnace.waitOutput(output, inputCount, { timeoutMs: inputCount * 11000 + 5000 }) } catch { /* Take what is there. */ }
      const ready = operations.furnace.snapshot?.()?.slots?.find(slot => slot.slot === 2)
      if (ready?.count > 0) await operations.furnace.takeOutput({ count: ready.count, expectedName: output })
    } catch (error) { refused(error) }
    close()
    await until(() => count(name => name === output) > before, 3000)
    return count(name => name === output) - before
  }
  const mine = async (cell, extra = null) => {
    try { await patient(() => operations.mining.start([extra ? { ...cell, ...extra } : cell])) } catch (error) { return refused(error) }
    return until(() => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && /air$/.test(found.name ?? '') }, 10000)
  }
  return { place, preview, craft, smelt, mine, count, why: () => why, reset: () => { why = null } }
}

module.exports = { createHousePorts }
