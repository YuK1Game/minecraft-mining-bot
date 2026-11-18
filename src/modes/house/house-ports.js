'use strict'

const { createContainerPorts } = require('../return/container-ports')

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
  async function patient (run, retry = () => true) {
    const end = now() + 10000
    for (;;) {
      try { return await run() } catch (error) {
        if (!retry() || !/待って|待機|使用中|確認しています/.test(String(error?.message ?? '')) || now() >= end || disposed()) throw error
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
  let placementRetrySafe = true
  async function place (name, plan) {
    placementRetrySafe = true
    const slot = await inHand(name)
    if (slot == null || slot === false) { why ??= `${name} を手に持てません`; return false }
    const options = { position: plan.position, slot, clicked: plan.clicked, face: plan.face, clickY: plan.clickY, head: plan.head ?? null, alignFacing: plan.alignFacing === true }
    const preview = operations.interactions.previewHouseBlock(options)
    if (preview?.ready !== true) { why = String(preview?.errors?.[0] ?? '設置できません').slice(0, 160); return false }
    try {
      await patient(() => {
        placementRetrySafe = false
        let result
        try { result = operations.interactions.placeHouseBlock(options) } catch (error) { placementRetrySafe = !error?.details?.placementFailure; throw error }
        return Promise.resolve(result).catch(error => {
          const receipt = error?.details?.placementFailure
          placementRetrySafe = !!receipt && (receipt.serverRejected === true || receipt.notSent === true && receipt.transactionQueued === false && receipt.wireSent === false)
          throw error
        })
      }, () => placementRetrySafe)
    } catch (error) { return refused(error) }
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
      // What an interrupted smelt left behind comes out first: a result of
      // another kind blocks the furnace, and another kind of input or fuel in
      // its slot refuses ours.
      const held = n => operations.furnace.snapshot?.()?.slots?.find(slot => slot.slot === n)
      const empty = async () => { const ready = held(2); if (ready?.count > 0) await operations.furnace.takeOutput({ count: ready.count }) }
      await empty()
      const left = held(0)?.count > 0 && held(0).name !== input ? held(0) : null
      if (!left) await operations.furnace.putInput(slotOf(input), inputCount)
      if (!(held(1)?.count > 0) || held(1).name === fuel) await operations.furnace.putFuel(slotOf(fuel), fuelCount)
      if (left) { await until(() => !(held(0)?.count > 0), left.count * 11000 + 5000); why = `かまどに残っていた ${left.name} を先に焼きました` }
      else { try { await operations.furnace.waitOutput(output, inputCount, { timeoutMs: inputCount * 11000 + 5000 }) } catch { /* Take what is there. */ } }
      await empty()
    } catch (error) { refused(error) }
    close()
    await until(() => count(name => name === output) > before, 3000)
    return count(name => name === output) - before
  }
  const mine = async (cell, extra = null) => {
    try { await patient(() => operations.mining.start([extra ? { ...cell, ...extra } : cell])) } catch (error) { return refused(error) }
    return until(() => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && /air$/.test(found.name ?? '') }, 10000)
  }
  const containers = createContainerPorts({ operations, getInventory, disposed, sleep, now })
  return { place, preview, craft, smelt, mine, count, inspectChest: containers.inspect, placementRetrySafe: () => placementRetrySafe, why: () => why, reset: () => { why = null } }
}

module.exports = { createHousePorts }
