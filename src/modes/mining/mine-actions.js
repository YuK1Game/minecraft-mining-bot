'use strict'

const { createHousePorts } = require('../house/house-ports')
const { completed, blocked, failed, interrupted } = require('../return/return-result')
const { key, cell, air, solid, bottomSlab, full, held, receivedInventory, value, scopeOf } = require('./mine-observed')
const { sameWorld, mineWorldScope } = require('./mine-state')
const { digTool, toolNeeded } = require('../dig-tool')
const { supportIntent, recordSupportReceipt } = require('./mine-support-receipt')
const { mineLadderResult } = require('./mine-ladder-result')
const NORMAL = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]

function createMineActions (ctx) {
  const block = p => ctx.getBlock(p.x, p.y, p.z)
  const inventory = () => ctx.shared.inventoryUncertain ? null : receivedInventory(ctx.runtime.inventory())
  const stopped = () => ctx.cancelled() || ctx.signal?.aborted
  const house = createHousePorts({ operations: ctx.operations, getBlock: ctx.getBlock, getInventory: inventory, disposed: stopped, ...(ctx.sleep ? { sleep: ctx.sleep, now: ctx.now } : {}) })
  const wait = (code, kind = 'terrain_received', extra = {}) => blocked(code, { kind }, extra)
  const done = (code, evidence = {}) => ({ ...completed(code, { evidence: { ...evidence, serverConfirmed: true } }), serverConfirmed: true })
  const branch = () => ctx.memory?.early?.mine?.branch
  const worldMatches = () => sameWorld(branch()?.plan?.scope, mineWorldScope(ctx.runtime.mineState?.() ?? ctx.runtime.raw()))
  const save = async () => typeof ctx.saveMine === 'function' && await ctx.saveMine() === true
  const same = scope => scope != null && scopeOf(ctx) === scope && !stopped()
  async function begin (intent) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    if (!inventory()) return wait('MINE_INVENTORY_UNKNOWN', 'inventory_update')
    const scope = scopeOf(ctx), state = branch()
    if (!scope || !state || !worldMatches()) return wait('MINE_SCOPE_UNKNOWN', 'owner_released')
    // Cancellation can arrive just after a break receipt. That completed
    // break must not leave a transfer-like pending intent blocking every
    // following cell, even when the executor has already skipped its AIR.
    const previous = state.pendingAction
    if (previous?.kind === 'dig' && cell(previous.position) && air(block(previous.position))) {
      forgetDig(previous.position)
      if (!await clear(previous.key)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    }
    if (state.pendingAction) return wait('MINE_ACTION_UNCONFIRMED', 'inventory_update', { evidence: state.pendingAction })
    state.pendingAction = { ...intent, scope, stage: 'attempting' }
    if (!await save() || !same(scope)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
    return { scope }
  }
  async function clear (expected) {
    const state = branch()
    if (state?.pendingAction && expected && state.pendingAction.key !== expected) return false
    const pending = state?.pendingAction
    if (state) delete state.pendingAction
    if (await save()) return true
    if (state && pending && !state.pendingAction) state.pendingAction = pending
    return false
  }
  function matches (p, name, plan = {}) {
    const found = block(p)
    if (found?.known !== true || found.extra?.length || found.name !== full(name)) return false
    if (/_slab$/.test(found.name)) return bottomSlab(found)
    if (found.name === 'minecraft:ladder' && Number.isInteger(plan.face)) return value(found.properties?.facing_direction) === plan.face
    return true
  }
  function forgetDig (position) {
    const state = branch()
    let changed = false
    for (const name of ['supportFills', 'temporarySeals']) if (state?.[name]) {
      const remaining = state[name].filter(p => key(p) !== key(position))
      if (remaining.length !== state[name].length) { state[name] = remaining; changed = true }
    }
    return changed
  }
  async function mine (position) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    if (!worldMatches()) return wait('MINE_SCOPE_UNKNOWN', 'owner_released')
    if (!cell(position)) return failed('MINE_CELL_INVALID')
    const actionKey = 'dig:' + key(position), pending = branch()?.pendingAction
    if (air(block(position))) {
      const changed = forgetDig(position)
      if (pending?.key === actionKey && !await clear(actionKey)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      if (changed && pending?.key !== actionKey && !await save()) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      return done('MINE_AIR_RECEIVED', { position })
    }
    if (block(position)?.known !== true) return wait('MINE_TERRAIN_UNKNOWN')
    // A break interrupted by a connection/life change has no item transfer
    // to replay. A fresh received block may be broken again, after the
    // executor's normal protected-cell/footing checks. Placements keep their
    // unresolved intent until their structure or rejection is received.
    if (pending?.key === actionKey && pending.kind === 'dig' && !await clear(actionKey)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
    if (toolNeeded(block(position).name) && !digTool(inventory()?.items, block(position).name)) return wait('MINE_TOOL_SUPPLY', 'supplies_changed')
    const start = await begin({ key: actionKey, kind: 'dig', position })
    if (!start.scope) return start
    let mined = false
    try { mined = await ctx.hands.mine(position) } catch (error) { if (!stopped()) ctx.log?.('採掘場: ' + String(error.code ?? error.message).slice(0, 120)) }
    if (!same(start.scope)) return interrupted('MINE_SCOPE_CHANGED')
    if (air(block(position))) {
      forgetDig(position)
      if (!await clear(actionKey)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      return done('MINE_AIR_RECEIVED', { position })
    }
    // Breaking the same received, unchanged block is safe to retry. No item
    // placement/transfer can be replayed through this path.
    if (block(position)?.known === true) await clear(actionKey)
    return wait(mined ? 'MINE_BLOCK_UNCONFIRMED' : 'MINE_DIG_REFUSED', 'terrain_received', { detail: ctx.hands.why?.() })
  }
  function placement (request) {
    const position = request.position, name = full(request.name)
    if (!cell(position)) return null
    if (request.clicked || request.support) return { ...request, name, clicked: request.clicked ?? request.support, clickY: request.clickY ?? (/_slab$/.test(name) ? 0.25 : 0.5) }
    for (const face of [1, 2, 3, 4, 5]) {
      const n = NORMAL[face], clicked = { x: position.x - n[0], y: position.y - n[1], z: position.z - n[2] }
      if (solid(block(clicked))) return { ...request, name, clicked, face, clickY: /_slab$/.test(name) ? 0.25 : 0.5 }
    }
    return null
  }
  async function place (request) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    if (!worldMatches()) return wait('MINE_SCOPE_UNKNOWN', 'owner_released')
    const plan = placement(request)
    if (!plan) return wait('MINE_PLACE_SUPPORT_UNKNOWN')
    const { position, name } = plan, actionKey = 'place:' + key(position), pending = branch()?.pendingAction
    if (matches(position, name, plan)) {
      // A received existing piece can be reused after a reload. This proves
      // the structure, not that an old, unconfirmed transaction consumed it.
      if (pending?.key === actionKey && pending.supportFill) {
        const saved = branch().supportFills?.some(p => key(p) === key(position) && p.name === name && p.receipt?.planId === branch().plan.id && p.receipt?.scope === pending.scope && p.receipt?.consumed === 1)
        // An in-flight support may finish after cancellation. Within that
        // same observed life, the saved AIR intent and exact item decrement
        // can reconcile it. Across lives only its durable receipt suffices.
        if (!saved && (pending.scope !== scopeOf(ctx) || !recordSupportReceipt(branch(), pending, block(position), held(inventory(), name)))) return wait('MINE_SUPPORT_RECEIPT_UNCONFIRMED', 'inventory_update')
      }
      if (pending?.key === actionKey && !await clear(actionKey)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      return done('MINE_STRUCTURE_RECEIVED', { position, reused: true })
    }
    if (!air(block(position))) return wait('MINE_PLACE_CELL_OCCUPIED')
    const before = held(inventory(), name)
    if (!(before > 0)) return wait('MINE_MATERIAL_MISSING', 'supplies_changed', { evidence: { name } })
    const supportFill = supportIntent(branch(), plan)
    const start = await begin({ key: actionKey, kind: 'place', position, name, before, ...(supportFill ? { supportFill, fromAir: true } : {}) })
    if (!start.scope) return start
    let placed = false
    try { placed = await house.place(name, plan) } catch (error) { ctx.log?.('採掘場: ' + String(error.code ?? error.message).slice(0, 120)) }
    if (!same(start.scope)) return interrupted('MINE_SCOPE_CHANGED')
    if (placed && matches(position, name, plan) && held(inventory(), name) <= before - 1 && inventory()) {
      // Commit this received support together with clearing the placement
      // intent. A later executor checkpoint failure/reload cannot lose the
      // proof and mistake our temporary floor for somebody else's block.
      if (supportFill && !recordSupportReceipt(branch(), branch()?.pendingAction, block(position), held(inventory(), name))) return wait('MINE_SUPPORT_RECEIPT_UNCONFIRMED', 'inventory_update')
      if (!await clear(actionKey)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      return done('MINE_PLACEMENT_RECEIVED', { position, name, consumed: 1 })
    }
    // Only a pre-send rejection or the server's explicit rejection permits a
    // second placement. Unknown acknowledgements retain the durable intent.
    if (house.placementRetrySafe()) await clear(actionKey)
    return wait('MINE_PLACEMENT_UNCONFIRMED', 'inventory_update', { detail: house.why() })
  }
  async function confirmPosition (to) {
    const scope = scopeOf(ctx)
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    const feet = ctx.getFeet?.()
    if (!feet || !['x', 'y', 'z'].every(axis => Number.isFinite(feet[axis]))) return wait('MINE_POSITION_UNKNOWN', 'position_changed')
    // Navigator settles inside its arrival radius. A body at most 0.2m
    // from the cell centre still fits its full floor; verify that actual
    // working pose, without claiming the requested centre was received.
    if (Math.hypot(feet.x - to.x, feet.z - to.z) > 0.2 || Math.abs(feet.y - to.y) > 0.12) return wait('MINE_POSITION_UNCONFIRMED', 'position_changed')
    const observed = { x: feet.x, y: feet.y, z: feet.z }
    const proof = await ctx.runtime.mineConfirmPosition?.(observed, { signal: ctx.signal, radius: 0.12, operationId: 'branch-mine:walk' })
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    const current = ctx.getFeet?.()
    const stable = current && Math.hypot(current.x - observed.x, current.y - observed.y, current.z - observed.z) <= 0.12
    return proof?.serverConfirmed === true && stable ? done('MINE_POSITION_RECEIVED', { position: observed, destination: to, proof }) : wait('MINE_POSITION_UNCONFIRMED', 'position_changed')
  }
  async function walk (to) {
    const scope = scopeOf(ctx)
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    let moved = false
    try { moved = await ctx.hands.walk(to) } catch (error) { return failed('MINE_WALK_REFUSED', { detail: error.message }) }
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    if (!moved) return wait('MINE_WALK_REFUSED', 'position_changed', { detail: ctx.hands.why?.() })
    return confirmPosition(to)
  }
  async function ladderMove (request) {
    const scope = scopeOf(ctx)
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    let result
    try { result = await ctx.runtime.mineLadderMove?.(request, { signal: ctx.signal }) }
    catch (error) { result = { status: 'failed', reason: error.code ?? error.message, serverConfirmed: false } }
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    return mineLadderResult(ctx, request, result)
  }
  async function observe ({ cells = null, reason = null } = {}) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    const known = () => Array.isArray(cells) && cells.length > 0 && cells.every(p => cell(p) && block(p)?.known === true)
    if (known()) return done('MINE_TERRAIN_RECEIVED')
    const scope = scopeOf(ctx)
    if (!same(scope)) return wait('MINE_SCOPE_UNKNOWN', 'owner_released')
    const result = await ctx.runtime.mineObserve?.({ cells, reason }, { signal: ctx.signal })
    if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
    if (known()) return done('MINE_TERRAIN_RECEIVED', result?.evidence ?? {})
    // Requests, including successful dispatches, are never terrain receipts.
    // Preserve the observer's zero-target/waiting distinction for the survey.
    if (['blocked', 'partial', 'failed', 'interrupted', 'cancelled'].includes(result?.status) && typeof result.code === 'string') {
      return { ...result, serverConfirmed: false, evidence: { ...(result.evidence ?? {}), serverConfirmed: false } }
    }
    return wait(result?.code === 'MINE_TERRAIN_RECEIVED' ? 'MINE_TERRAIN_WAITING' : 'MINE_OBSERVATION_UNAVAILABLE', 'terrain_received', { evidence: result?.evidence ?? null })
  }
  return { block, inventory, mine, place, placement, matches, walk, confirmPosition, ladderMove, observe, house, save, done, wait }
}

module.exports = { createMineActions }
