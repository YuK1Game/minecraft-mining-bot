'use strict'

const { createContainerPorts } = require('../return/container-ports')
const { createHouseSmelt } = require('./house-smelt')

// The game operations the starter house is built with: ordinary placement on
// any face (operations.interactions.placeHouseBlock), crafting in the inventory
// or at a crafting table, and smelting in a furnace. Everything counts by the
// received inventory and received blocks.
function createHousePorts ({ operations, getBlock, getInventory, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const received = () => { const inventory = getInventory(); return inventory && inventory.known !== false && inventory.uncertain !== true ? inventory : null }
  const inventoryReady = () => received()?.known === true
  const items = () => received()?.items ?? []
  const count = test => items().filter(item => item?.count > 0 && test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(50) } return test() }
  let why = null
  const refused = error => { why = String(error?.message ?? error).slice(0, 160); return false }
  async function patient (run, retry = () => true) {
    const end = now() + 10000
    for (;;) {
      try { return await run() } catch (error) {
        if (!retry() || !/待って|待機|使用中|確認しています|停止してから/.test(String(error?.message ?? '')) || now() >= end || disposed()) throw error
        await sleep(100)
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
    const options = { position: plan.position, slot, clicked: plan.clicked, face: plan.face, clickY: plan.clickY, clickAcross: plan.clickAcross ?? null, head: plan.head ?? null, alignFacing: plan.alignFacing === true }
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
    return operations.interactions.previewHouseBlock({ position: plan.position, slot, clicked: plan.clicked, face: plan.face, clickY: plan.clickY, clickAcross: plan.clickAcross ?? null, head: plan.head ?? null })?.ready === true || item.slot > 8
  }
  async function craft (output, times, table = null, { fitMaterials = false } = {}) {
    const before = count(name => name === output)
    try {
      if (table) await patient(() => operations.interactions.openCraftingTable(table))
      else await patient(() => operations.crafting.openInventory())
      // A batch may contain enough material in total but mix recipe variants
      // (coal/charcoal or wood species). Let the received recipe and concrete
      // stack IDs choose the largest batch that can actually be sent.
      if (fitMaterials && typeof operations.crafting.preview === 'function') {
        while (times > 1 && operations.crafting.preview(output, { times }).ready !== true) times--
      }
      await operations.crafting.craft(output, { times })
    } catch (error) { close(); return refused(error) }
    close()
    return until(() => count(name => name === output) > before, 4000)
  }
  const smelting = createHouseSmelt({ operations, items, count, inventoryReady, until, patient, close, refused, disposed })
  const mine = async (cell, extra = null) => {
    try { await patient(() => operations.mining.start([extra ? { ...cell, ...extra } : cell])) } catch (error) { return refused(error) }
    return until(() => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && /air$/.test(found.name ?? '') }, 10000)
  }
  const containers = createContainerPorts({ operations, getInventory, disposed, sleep, now })
  return { place, preview, craft, ...smelting, mine, count, inspectChest: containers.inspect, placementRetrySafe: () => placementRetrySafe, why: () => why, reset: () => { why = null } }
}

module.exports = { createHousePorts }
