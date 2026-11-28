'use strict'

const { createHousePorts } = require('../house/house-ports')
const { houseClickGeometry } = require('../../actions/house-placement')
const { interactionSightError } = require('../../actions/interaction-sight')
const { completed, blocked, failed, interrupted } = require('../return/return-result')
const { key, cell, air, solid, bottomSlab, full, held, receivedInventory, value, FILL_BLOCKS, scopeOf } = require('./mine-observed')
const { sameWorld, mineWorldScope } = require('./mine-state')
const { digTool, toolNeeded } = require('../dig-tool')
const { supportIntent, recordSupportReceipt } = require('./mine-support-receipt')
const { mineLadderResult } = require('./mine-ladder-result')
const RETRYABLE_MATERIALS = new Set(['minecraft:torch', 'minecraft:cobblestone_slab', 'minecraft:ladder', 'minecraft:crafting_table', 'minecraft:furnace', ...FILL_BLOCKS])
const NORMAL = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]

function placements (block, request) {
  const position = request.position, name = full(request.name)
  if (!cell(position)) return []
  const clickY = request.clickY ?? (/_slab$/.test(name) ? 0.25 : 0.5)
  if (request.clicked || request.support) return [{ ...request, name, clicked: request.clicked ?? request.support, clickY }]
  return [1, 2, 3, 4, 5].flatMap(face => {
    const n = NORMAL[face], clicked = { x: position.x - n[0], y: position.y - n[1], z: position.z - n[2] }
    return solid(block(clicked)) ? [{ ...request, name, clicked, face, clickY }] : []
  })
}

// The first placement whose click can be seen from `feet`. The middle of each face first. A side face whose middle
// is hidden (a rung's plate, the rim of the floor the Bot stands on) is then tried at other points of the same face:
// a block is placed by a click anywhere on a face. Real Realm 2026-11-23 12:03-12:13 JST: the wall behind the next
// rung, (9885,52,10125), opened into a cave. Its only face to click, the east face of (9884,52,10125), was hidden at
// its middle by the plate of the rung above; the south edge of that face was in plain view. The fill was refused
// every 2 s for ten minutes with no line in the log, and the goal was held.
const SPREAD = [0.5, 0.25, 0.75, 0.1, 0.9]
function visibleMinePlacement (block, request, feet) {
  if (!feet) return null
  const eye = { ...feet, y: feet.y + 1.62 }
  const seen = plan => {
    const geometry = houseClickGeometry(plan.clicked, plan.face, plan.clickY, plan.clickAcross)
    return !!geometry && solid(block(plan.clicked)) && !interactionSightError(block, eye, geometry.point, plan.clicked)
  }
  const plans = placements(block, request)
  const centred = plans.find(seen)
  if (centred) return centred
  // A slab stays a bottom slab: low on the face only. A height the caller fixed is kept.
  const heights = Number.isFinite(request.clickY) ? [request.clickY] : /_slab$/.test(full(request.name)) ? [0.25, 0.1, 0.4] : SPREAD
  for (const plan of plans) {
    if (!(plan.face >= 2)) continue
    for (const clickY of heights) for (const clickAcross of SPREAD) {
      const moved = { ...plan, clickY, clickAcross }
      if (seen(moved)) return moved
    }
  }
  return null
}

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
    // A table or furnace put down for the mine's supplies in an earlier life or connection is no part of the mine's
    // structure: whether it stands is the workstation ledger's to find (player-workstations.js). Its pending record
    // can never be confirmed from this scope and held every later dig (live 2026-11-26 06:23-06:33 JST after the
    // death at 05:57: place:9862,52,10152 crafting_table, 150 m away, MINE_ACTION_UNCONFIRMED for ten minutes).
    const left = state.pendingAction
    const feetNow = ctx.getFeet?.(), away = !!feetNow && cell(left?.position) && Math.hypot(left.position.x + 0.5 - feetNow.x, left.position.z + 0.5 - feetNow.z) > 16
    const staleRetry = left?.retryAfterAudit === true && (ctx.now ?? Date.now)() - (Number.isFinite(left.at) ? left.at : 0) > 30000
    if (left?.kind === 'place' && (left.scope !== scope || away || staleRetry) && /^minecraft:(?:crafting_table|furnace)$/.test(left.name ?? '')) {
      if (!await clear(left.key)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      if (!same(scope)) return interrupted('MINE_SCOPE_CHANGED')
      ctx.log?.(`採掘場: 前の生存回か離れた場所の ${String(left.name).replace('minecraft:', '')} 設置待ち (${key(left.position)}) は採掘場の構造ではないため、記録を外して作業を続けます`)
    }
    // Looked at again in a few seconds: the reconciliation (reconcilePlacement) runs on the next tick, and a wait for an
    // inventory change alone held the expedition for ten minutes when nothing in the bag changed (live 2026-11-26 08:37-08:47 JST).
    if (state.pendingAction) return blocked('MINE_ACTION_UNCONFIRMED', { kind: 'time', ms: 5000 }, { evidence: state.pendingAction })
    state.pendingAction = { ...intent, scope, stage: 'attempting', at: (ctx.now ?? Date.now)() }
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
  async function reconcilePlacement () {
    const state = branch(), pending = state?.pendingAction, scope = scopeOf(ctx)
    if (pending?.kind !== 'place' || pending.supportFill || !RETRYABLE_MATERIALS.has(pending.name) ||
      !cell(pending.position) || pending.key !== 'place:' + key(pending.position) ||
      pending.scope !== scope || !same(scope) || !worldMatches()) return false

    const { position, name, before } = pending
    const face = name === 'minecraft:ladder' ? state.plan.shaft?.ladder?.face : undefined
    let evidence
    if ((name !== 'minecraft:ladder' || Number.isInteger(face)) && matches(position, name, { face })) {
      evidence = { kind: 'current_structure_received' }
    } else {
      // The count may stay short for good when the material was used for other work after the unanswered send (live
      // 2026-11-26 08:37-08:42 JST: cobblestone 70 -> 30 by crafting, place:9739,16,10216 held every dig). After a minute
      // the server's own audit of the cell, received as air, is the evidence; before that the count still guards.
      // Live 2026-11-27 15:56-15:59 JST: a placement timeout sets shared.inventoryUncertain=true, making inventory()
      // return null. Let minePlacementAudit run its fresh inventory resync first instead of rejecting on null before
      // the audit, then enforce the received inventory count after the audit completes.
      const old = (ctx.now ?? Date.now)() - (Number.isFinite(pending.at) ? pending.at : 0) > 60000
      const invBefore = inventory()
      if (pending.retryAfterAudit || !Number.isSafeInteger(before) || before <= 0 ||
        (!old && invBefore && (held(invBefore, name) ?? 0) < before) || !air(block(position))) return false
      const audit = await ctx.runtime.minePlacementAudit?.(position, { signal: ctx.signal })
      const invAfter = inventory()
      if (audit?.target?.serverConfirmed !== true || !same(scope) || state.pendingAction !== pending || !air(block(position)) ||
        (!old && (!invAfter || (held(invAfter, name) ?? 0) < before))) return false
      evidence = { kind: 'current_target_air', count: held(invAfter, name), ...audit }
    }

    const previous = state.lastReconciledPlacement
    state.lastReconciledPlacement = { pending, evidence }
    if (await clear(pending.key)) {
      ctx.log?.(`採掘場: 設置待ち ${key(position)} ${name} を現在の受信状態で照合しました（${evidence.kind}）。`)
      return true
    }
    if (previous) state.lastReconciledPlacement = previous
    else delete state.lastReconciledPlacement
    return false
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
    const why = ctx.hands.why?.()
    if (!mined) {
      const line = `${key(position)} を掘れません（${String(why ?? '理由不明').replace(/[\p{C}§]/gu, ' ').slice(0, 120)}）`
      if (ctx.shared && ctx.shared.mineDigSaid !== line) {
        ctx.shared.mineDigSaid = line
        ctx.log?.('採掘場: ' + line)
      }
    }
    return wait(mined ? 'MINE_BLOCK_UNCONFIRMED' : 'MINE_DIG_REFUSED', 'terrain_received', { detail: why })
  }
  const placement = request => placements(block, request)[0] ?? null
  // A placement that was not made says where and why, once for each place and reason (it is tried again every step).
  function refusedSay (position, name, why) {
    const line = `${key(position)} に ${String(full(name)).replace(/^minecraft:/, '')} を置けません（${String(why ?? '理由不明').replace(/[\p{C}§]/gu, ' ').slice(0, 120)}）`
    if (ctx.shared.minePlaceSaid === line) return
    ctx.shared.minePlaceSaid = line
    ctx.log?.('採掘場: ' + line)
  }
  async function place (request) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    if (!worldMatches()) return wait('MINE_SCOPE_UNKNOWN', 'owner_released')
    // Shaft fills can have a solid face that is hidden by an earlier fill.
    // Keep explicit faces fixed and prefer a visible one for inferred support.
    const inferredSupport = request.supportPurpose && !request.clicked && !request.support
    const plan = (inferredSupport ? visibleMinePlacement(block, request, ctx.getFeet()) : null) ?? placement(request)
    if (!plan) { if (cell(request.position)) refusedSay(request.position, request.name, '置く面になる受信済みの固いブロックがありません'); return wait('MINE_PLACE_SUPPORT_UNKNOWN') }
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
    const recovered = branch()?.lastReconciledPlacement
    const retryAfterAudit = recovered?.evidence?.kind === 'current_target_air' && recovered.pending?.key === actionKey &&
      recovered.pending.name === name && recovered.pending.scope === scopeOf(ctx)
    const start = await begin({ key: actionKey, kind: 'place', position, name, before,
      ...(supportFill ? { supportFill, fromAir: true } : {}), ...(retryAfterAudit ? { retryAfterAudit: true } : {}) })
    if (!start.scope) return start
    let placed = false
    try { placed = await house.place(name, plan) } catch (error) { ctx.log?.('採掘場: ' + String(error.code ?? error.message).slice(0, 120)) }
    if (!same(start.scope)) return interrupted('MINE_SCOPE_CHANGED')
    const countDropped = held(inventory(), name) <= before - 1
    if (placed && matches(position, name, plan) && inventory() && (countDropped || !supportFill)) {
      // Commit this received support together with clearing the placement
      // intent. A later executor checkpoint failure/reload cannot lose the
      // proof and mistake our temporary floor for somebody else's block.
      if (supportFill && !recordSupportReceipt(branch(), branch()?.pendingAction, block(position), held(inventory(), name))) return wait('MINE_SUPPORT_RECEIPT_UNCONFIRMED', 'inventory_update')
      if (!await clear(actionKey)) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
      ctx.shared.minePlaceSaid = null
      return done('MINE_PLACEMENT_RECEIVED', { position, name, consumed: 1 })
    }
    // Preserve unknown acknowledgements for current-state reconciliation.
    // An explicit rejection can be cleared immediately.
    if (house.placementRetrySafe()) await clear(actionKey)
    refusedSay(position, name, house.why())
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
  return { block, inventory, mine, place, placement, matches, reconcilePlacement, walk, confirmPosition, ladderMove, observe, house, save, done, wait }
}

module.exports = { createMineActions, visibleMinePlacement }
