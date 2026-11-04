'use strict'
const { equipmentReady } = require('./equipment-readiness')
const { isDeepStrictEqual: same } = require('node:util')
const { continuationScope } = require('./base-continuation')
const { resourceMinHealth } = require('./learning-health')
const copy = value => structuredClone(value)
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)
const equalPosition = (a, b) => a && b && ['x', 'y', 'z'].every(k => a[k] === b[k])
const rawValid = r => r && Number.isInteger(r.network_id) && Number.isInteger(r.count) && (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.has_stack_id === true && Number.isInteger(r.stack_id) && r.stack_id > 0)
const fingerprint = b => ({ name: b.name, runtimeId: b.runtimeId, properties: copy(b.properties ?? {}) })

// This performs ONE existing controller primitive per step. The host owns the
// movement/base/actor lease and reobserves before calling another step.
function createDepotStorageWork ({ getState, world, crafting, interactions, chest, inventory, validate = () => true }) {
  if (typeof getState !== 'function' || typeof world?.getBlock !== 'function' || typeof crafting?.preview !== 'function' || typeof crafting?.rawItem !== 'function' || typeof interactions?.previewPlace !== 'function' || typeof chest?.depositDiamond !== 'function' || typeof validate !== 'function') throw Error('Depot storage requires actual state, world and existing inventory controllers')
  let pending = null, lastResult = null, placedChest = null
  const read = p => world.getBlock(p.x, p.y, p.z)
  const items = () => crafting.snapshot().inventory ?? []
  const count = name => items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  function session (options, run = null) {
    const state = getState(), scope = continuationScope(state), observed = crafting.snapshot()
    if (!scope || !same(options?.scope, scope) || state.health <= resourceMinHealth(state) || state.inventory?.known !== true || state.inventory?.uncertain || observed.authority !== true || observed.inventoryKnown !== true || !Array.from({ length: 36 }, (_, slot) => rawValid(crafting.rawItem(slot))).every(Boolean) || validate(state, options) !== true) throw Error('Depot storage needs current living scope, authoritative inventory and host action admission')
    if (run && state.health < run.health) throw Error('Damage interrupted depot storage')
    return { state, scope, observed }
  }
  function safeCell (position, existing = false) {
    if (!integer(position)) return false
    const b = read(position), above = read({ ...position, y: position.y + 1 }), below = read({ ...position, y: position.y - 1 })
    return b?.known === true && (existing ? b.name === 'minecraft:chest' : AIR.has(b.name)) && !b.extra?.length && above?.known === true && AIR.has(above.name) && !above.extra?.length && below?.known === true && below.boundingBox === 'block' && !below.extra?.length && !/water|lava|fire|magma|sand|gravel|powder|cactus|dripstone/.test(below.name ?? '') && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([x, z]) => { const n = read({ ...position, x: position.x + x, z: position.z + z }); return n?.known === true && !['minecraft:chest', 'minecraft:trapped_chest'].includes(n.name) })
  }
  function ownsChest (options, scope) {
    const receipt = options.ownedChest ?? placedChest
    const old = receipt?.placementScope ?? receipt?.scope
    return receipt && equalPosition(receipt.position, options.storageCell) && old?.profile === scope.profile && old.realmId === scope.realmId && old.dimension === scope.dimension && same(receipt.fingerprint, fingerprint(read(options.storageCell)))
  }
  function craftPlan (name) {
    const preview = crafting.preview(name, { times: 1 }), open = crafting.snapshot().openContainer
    if (!preview.ready) return { kind: 'blocked', reason: 'RECIPE_NOT_READY', output: name, errors: copy(preview.errors ?? []) }
    if (!open || !['inventory', 'workbench', -1, 1].includes(open.type)) return { kind: open ? 'close_container' : 'open_inventory' }
    return { kind: 'craft', output: name, outputCount: preview.output.count }
  }
  function placement (name, position, state) {
    const source = items().find(i => i.name === name && i.count > 0)
    if (!source) return { kind: 'blocked', reason: 'ITEM_MISSING' }
    const selected = state.rawSelectedSlot ?? state.rawServerSelectedSlot
    if (!Number.isInteger(selected) || selected < 0 || selected > 8) return { kind: 'blocked', reason: 'SELECTED_SLOT_UNKNOWN' }
    if (source.slot !== selected) return typeof inventory?.equip === 'function' ? { kind: 'equip', sourceSlot: source.slot, item: name } : { kind: 'need_equip', sourceSlot: source.slot, item: name }
    if (crafting.snapshot().openContainer) return { kind: 'close_container' }
    const preview = interactions.previewPlace({ position, slot: selected })
    if (!preview.ready) return { kind: 'need_access', position: copy(position), errors: copy(preview.errors ?? []) }
    return { kind: 'place', item: name, position: copy(position), slot: selected, beforeCount: crafting.rawItem(selected).count, stackId: crafting.rawItem(selected).stack_id }
  }
  function preview (options) {
    try {
      const { state, scope, observed } = session(options)
      if (!integer(options.storageCell)) throw Error('Validated storageCell is required')
      if (observed.pendingRequestId != null) return { kind: 'blocked', reason: 'CRAFT_PENDING' }
      const existing = read(options.storageCell)?.name === 'minecraft:chest'
      if (!safeCell(options.storageCell, existing)) return { kind: 'blocked', reason: 'STORAGE_GEOMETRY_UNKNOWN' }
      if (existing) {
        if (!ownsChest(options, scope)) return { kind: 'verify_chest_ownership', position: copy(options.storageCell) }
        const storage = chest.snapshot(), open = observed.openContainer
        if (storage.needsOpen || !storage.contentsKnown || !equalPosition(storage.window?.position, options.storageCell) || !same(storage.window?.scope, scope)) {
          if (open) return { kind: 'close_container' }
          const access = interactions.previewOpenChest?.(options.storageCell)
          if (access?.ready !== true) return { kind: 'need_access', position: copy(options.storageCell), errors: copy(access?.errors ?? ['Actual chest interaction preview is required']) }
          return { kind: 'open_chest', position: copy(options.storageCell) }
        }
        const diamond = items().find(i => i.name === 'minecraft:diamond' && i.count > 0)
        return diamond ? { kind: 'deposit_diamond', sourceSlot: diamond.slot, count: 1 } : { kind: 'observe_inventory', reason: 'NO_CARRIED_DIAMOND' }
      }
      if (count('minecraft:chest') > 0) return placement('minecraft:chest', options.storageCell, state)
      const tablePosition = [options.tablePosition, options.tableCell].find(p => integer(p) && read(p)?.known === true && read(p).name === 'minecraft:crafting_table')
      const table = Boolean(tablePosition)
      const heldTable = count('minecraft:crafting_table') > 0
      const requiredPlanks = 8 + (!table && !heldTable ? 4 : 0)
      const boards = items().filter(i => /^minecraft:[a-z_]+_planks$/.test(i.name ?? '')).reduce((n, i) => n + i.count, 0)
      if (boards < requiredPlanks) {
        const outputs = [...new Set((observed.availableRecipes ?? []).flatMap(r => r.output ?? []).map(i => i.name).filter(name => /^minecraft:[a-z_]+_planks$/.test(name ?? '')))].slice(0, 24)
        for (const output of outputs) if (crafting.preview(output, { times: 1 }).ready) return craftPlan(output)
        return { kind: 'need_logs', count: Math.ceil((requiredPlanks - boards) / 4), missingPlanks: requiredPlanks - boards, requiredPlanks }
      }
      if (!table) {
        if (!heldTable) return craftPlan('minecraft:crafting_table')
        if (!integer(options.tableCell) || equalPosition(options.tableCell, options.storageCell)) return { kind: 'need_table_cell' }
        return placement('minecraft:crafting_table', options.tableCell, state)
      }
      const open = observed.openContainer
      if (!open || !['workbench', 1].includes(open.type) || !equalPosition(open.coordinates, tablePosition)) {
        if (open) return { kind: 'close_container' }
        const access = interactions.previewOpenCraftingTable(tablePosition)
        return access.ready ? { kind: 'open_table', position: copy(tablePosition) } : { kind: 'need_access', position: copy(tablePosition), errors: copy(access.errors ?? []) }
      }
      return craftPlan('minecraft:chest')
    } catch (error) { return { kind: 'blocked', reason: error.message } }
  }
  function cancel (reason = 'Depot storage stopped') {
    const run = pending
    if (!run || run.cancelled) return
    run.cancelled = true; run.reason = String(reason)
    try { run.controller?.cancel?.(reason) } catch { /* Controller already owns finite cleanup. */ }
  }
  async function step (options, { signal } = {}) {
    if (pending) throw Error('Depot storage is busy')
    if (signal?.aborted) throw Error('Depot storage aborted')
    const decision = preview(options)
    if (['need_logs', 'need_access', 'need_equip', 'need_table_cell', 'verify_chest_ownership', 'blocked', 'observe_inventory'].includes(decision.kind)) return copy(decision)
    const { state, scope } = session(options)
    const run = pending = { health: state.health, scope, controller: null, cancelled: false }
    const aborted = () => cancel('Depot storage aborted')
    signal?.addEventListener('abort', aborted, { once: true })
    const poll = setInterval(() => { try { session(options, run) } catch (error) { cancel(error.message) } }, 50)
    try {
      let result, receipt
      session(options, run)
      if (decision.kind === 'close_container') { run.controller = crafting; crafting.closeContainer(); result = { phase: 'requested', serverConfirmed: false } }
      if (decision.kind === 'open_inventory') { run.controller = crafting; result = await crafting.openInventory() }
      if (decision.kind === 'equip') { run.controller = inventory; const expectedItem = { ...state.inventory.items.find(item => item.slot === decision.sourceSlot) }; result = await inventory.equip(decision.sourceSlot); const current = session(options, run).state; if (!equipmentReady(result, current, { sourceSlot: decision.sourceSlot, expectedItem, rawItem: crafting.rawItem(result?.slot) })) throw Error('Real equip confirmation missing') }
      if (decision.kind === 'open_table') { run.controller = interactions; result = await interactions.openCraftingTable(decision.position); if (result?.phase !== 'completed' || result.confirmedBy !== 'server_container_open') throw Error('Actual table-open confirmation missing') }
      if (decision.kind === 'craft') {
        run.controller = crafting; const before = count(decision.output)
        result = await crafting.craft(decision.output, { times: 1 })
        if (result?.phase !== 'completed' || !result.confirmedBy || count(decision.output) < before + decision.outputCount) throw Error('Actual crafted output increase missing')
      }
      if (decision.kind === 'place') {
        run.controller = interactions; const before = crafting.rawItem(decision.slot)
        if (before.stack_id !== decision.stackId || before.count !== decision.beforeCount) throw Error('Placement source changed')
        result = await interactions.placeBlock({ position: decision.position, slot: decision.slot })
        session(options, run)
        const after = crafting.rawItem(decision.slot), block = read(decision.position)
        if (result?.phase !== 'completed' || result.confirmedBy !== 'server_block_and_inventory' || !equalPosition(result.position, decision.position) || block?.known !== true || block.name !== decision.item || before.count - after.count !== 1 || (after.count > 0 && (after.network_id !== before.network_id || !rawValid(after)))) throw Error('Actual placement and source decrease missing')
        receipt = { ...copy(result), scope: copy(scope), serverConfirmed: true, inventoryConfirmed: true, beforeCount: before.count, afterCount: after.count }
        if (decision.item === 'minecraft:chest') placedChest = { position: copy(decision.position), fingerprint: fingerprint(block), placementScope: copy(scope), receipt: copy(receipt) }
      }
      if (decision.kind === 'open_chest') { run.controller = chest; result = await chest.open(decision.position); if (result?.serverConfirmed !== true) throw Error('Actual chest-open confirmation missing') }
      if (decision.kind === 'deposit_diamond') { run.controller = chest; result = await chest.depositDiamond({ sourceSlot: decision.sourceSlot, count: 1 }); if (result?.phase !== 'completed' || result.operation !== 'deposit_diamond' || result.serverConfirmed !== true || result.inventoryConfirmed !== true || result.containerConfirmed !== true || !same(result.scope, scope) || !equalPosition(result.position, options.storageCell)) throw Error('Actual diamond deposit receipt missing'); receipt = copy(result) }
      if (run.cancelled) throw Error(run.reason)
      session(options, run)
      lastResult = { kind: decision.kind, phase: decision.kind === 'close_container' ? 'requested' : 'completed', requiresObservation: true, result: copy(result), ...(receipt ? { receipt } : {}) }
      return copy(lastResult)
    } catch (error) {
      lastResult = { kind: decision.kind, phase: 'failed', serverConfirmed: false, reason: error.message }
      throw error
    } finally { clearInterval(poll); signal?.removeEventListener('abort', aborted); if (pending === run) pending = null }
  }
  return { preview, step, cancel, snapshot: () => ({ busy: pending !== null, lastResult: copy(lastResult), placedChest: copy(placedChest) }) }
}
module.exports = { createDepotStorageWork }
