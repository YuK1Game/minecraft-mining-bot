'use strict'

const { equipmentReady } = require('./equipment-readiness')
const { setTimeout: sleep } = require('node:timers/promises')
const { evaluateThreats } = require('./threats')
const { resourceMinHealth } = require('./learning-health')

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const FURNACES = new Set(['minecraft:furnace', 'minecraft:lit_furnace'])
const RAW_IRON = new Set(['minecraft:raw_iron', 'minecraft:iron_ore', 'minecraft:deepslate_iron_ore'])
const FUEL = new Set(['minecraft:coal', 'minecraft:charcoal', ...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo'].map(name => `minecraft:${name}_planks`)])
const ORES = new Map([
  ['minecraft:coal_ore', { resource: 'coal', tier: 1 }], ['minecraft:deepslate_coal_ore', { resource: 'coal', tier: 1 }],
  ['minecraft:iron_ore', { resource: 'iron', tier: 2 }], ['minecraft:deepslate_iron_ore', { resource: 'iron', tier: 2 }],
  ['minecraft:diamond_ore', { resource: 'diamond', tier: 3 }], ['minecraft:deepslate_diamond_ore', { resource: 'diamond', tier: 3 }]
])
const TIERS = { 'minecraft:wooden_pickaxe': 1, 'minecraft:golden_pickaxe': 1, 'minecraft:stone_pickaxe': 2, 'minecraft:iron_pickaxe': 3, 'minecraft:diamond_pickaxe': 4, 'minecraft:netherite_pickaxe': 5 }
const nameOf = value => String(value ?? '').includes(':') ? String(value) : `minecraft:${value}`
const integerPoint = value => value && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]) && Math.abs(value[axis]) <= 30000000)
const key = point => `${point.x},${point.y},${point.z}`
const windowId = value => value === 'first' ? 1 : Number.isInteger(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null
const itemCount = (state, name) => (state.inventory?.items ?? []).reduce((sum, item) => sum + (nameOf(item.name) === name && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)

class DiamondActionError extends Error {
  constructor (message, code = 'ACTION_FAILED', details = {}) { super(message); this.code = code; Object.assign(this, details) }
}
function required (capability) { return new DiamondActionError(`必要な実行機能が未実装です: ${capability}`, 'CAPABILITY_REQUIRED', { capability }) }
function checkAbort (signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DiamondActionError('行動を停止しました。', 'ABORTED') }

// This adapter never creates stack IDs, recipe IDs, positions or smelted items.
// Existing connection-owned methods perform protocol operations; fresh host
// inventory/container/block snapshots provide the separate completion evidence.
function createDiamondActions ({ request, refreshState, getState, baseActions = {}, onProgress = () => {}, timeoutMs = 45000, tunnel, validateStoneAccess = null, pollIntervalMs = 100 }) {
  if (typeof request !== 'function' || typeof refreshState !== 'function' || typeof getState !== 'function' || !baseActions || typeof baseActions !== 'object' || typeof onProgress !== 'function') throw new Error('ダイヤ採取の実行には要求、状態更新、実行器と進捗通知が必要です。')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 300000 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) throw new Error('行動の待ち時間または観測間隔が不正です。')
  let active = null
  const complete = data => ({ ok: true, phase: 'completed', ...data })
  const call = (group, method, args, signal) => request('POST', '/action', { group, method, args }, { signal })
  function report (context, event) {
    for (const callback of [onProgress, typeof context.progress === 'function' ? context.progress : null]) if (callback) {
      try { Promise.resolve(callback(structuredClone(event))).catch(() => {}) } catch { /* Reporting cannot change a committed operation. */ }
    }
  }
  function guard (state, baseline, inventoryRequired = true) {
    if (state.dead || state.isDead || state.lifecycle?.dead || state.health === 0 || state.phase === 'dead') throw new DiamondActionError('死亡を確認したため作業を中断します。', 'DEAD')
    if (state.phase !== 'spawned' || !state.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis]))) throw new DiamondActionError('接続と現在位置の観測が必要です。', 'NOT_READY')
    if (!Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new DiamondActionError('体力が少ないか不明なため作業を中断します。', 'LOW_HEALTH')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new DiamondActionError('通常のサバイバル操作だけを実行します。', 'UNSUPPORTED_GAME_MODE')
    if (baseline && state.health < baseline.health) throw new DiamondActionError('作業中の被ダメージを確認しました。', 'TOOK_DAMAGE')
    if (baseline && ['startedAt', 'connectionId', 'dimension'].some(field => baseline[field] != null && state[field] != null && baseline[field] !== state[field])) throw new DiamondActionError('作業中に接続またはディメンションが変わりました。', 'STALE_SESSION')
    if (inventoryRequired && (state.inventory?.known !== true || state.inventory.uncertain === true)) throw new DiamondActionError('サーバーで確定した持ち物の一覧が必要です。', 'INVENTORY_UNKNOWN')
    const source = [state.entities, state.hostiles, state.nearbyHostiles, state.hostileEntities, state.threats].find(Array.isArray)
    const evaluation = evaluateThreats(state, source ?? null, { observationRadius: 32 })
    if (evaluation.threats.length) throw new DiamondActionError('敵が危険な範囲に入ったため作業を中断します。', 'NEARBY_THREAT')
    if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length) throw new DiamondActionError('位置不明のキャラクターがいるため追加の観測が必要です。', 'THREAT_OBSERVATION_UNKNOWN')
  }
  async function read (context, baseline, inventoryRequired = true) {
    checkAbort(context.signal)
    const state = await refreshState({ signal: context.signal }) ?? getState()
    checkAbort(context.signal)
    if (!state || typeof state !== 'object') throw new DiamondActionError('最新状態を取得できません。', 'INVALID_STATE')
    guard(state, baseline, inventoryRequired)
    return state
  }
  async function waitFor (predicate, context, baseline, inventoryRequired = true) {
    while (true) {
      const state = await read(context, baseline, inventoryRequired)
      const value = await predicate(state)
      checkAbort(context.signal)
      if (value) return value
      await sleep(pollIntervalMs, undefined, { signal: context.signal })
    }
  }
  async function bestEffort (group, method, args = []) {
    try { await call(group, method, args, AbortSignal.timeout(1500)) } catch { /* Core state retains uncertainty when a sent request was not confirmed. */ }
  }
  function operation (type, execute) {
    return async (decision = {}, context = {}) => {
      if (active) throw new DiamondActionError('前の行動がまだ終了していません。', 'ACTION_BUSY')
      checkAbort(context.signal)
      const controller = new AbortController()
      const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal
      const timeout = setTimeout(() => controller.abort(new DiamondActionError('サーバーで結果を確認できないまま行動の制限時間に達しました。', 'UNCONFIRMED_TIMEOUT')), timeoutMs)
      const scope = { ...context, signal, cleanup: null }
      let onAbort
      const cancelled = new Promise((resolve, reject) => { onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DiamondActionError('行動を停止しました。', 'ABORTED')); signal.addEventListener('abort', onAbort, { once: true }) })
      active = type
      try {
        const work = Promise.resolve().then(() => { checkAbort(signal); return execute(decision, scope) })
        return await Promise.race([work, cancelled])
      } catch (error) {
        controller.abort(error)
        if (scope.cleanup) await scope.cleanup()
        throw error
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        active = null
      }
    }
  }
  async function blockAt (point, context) {
    const page = await request('GET', `/blocks?x=${point.x}&y=${point.y}&z=${point.z}&radius=0`, undefined, { signal: context.signal })
    checkAbort(context.signal)
    return page?.blocks?.find(block => integerPoint(block.position) && key(block.position) === key(point)) ?? null
  }
  function orePlan (decision, state, allowStone = false) {
    if (!integerPoint(decision.target)) throw new DiamondActionError('鉱石には確認済みの整数座標が必要です。', 'INVALID_TARGET')
    const block = nameOf(decision.block ?? decision.targetOre?.name)
    const info = ORES.get(block) ?? (allowStone && decision.resource === 'stone' && ['minecraft:stone', 'minecraft:deepslate'].includes(block) ? { resource: 'stone', tier: 1 } : null)
    if (!info || decision.resource != null && info.resource !== decision.resource || decision.protected || decision.known === false) throw new DiamondActionError('指定対象はこの目標の既知の鉱石ではありません。', 'RESOURCE_CHANGED')
    const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
    const tool = state.inventory.items.find(item => item.slot === selected && item.count > 0)
    const requiredTier = Math.max(info.tier, Number.isSafeInteger(decision.requiredToolTier) ? decision.requiredToolTier : info.tier)
    if (!Number.isInteger(selected) || selected < 0 || selected > 8 || state.equipmentServerConfirmed === false || !tool || nameOf(state.heldItem?.name) !== nameOf(tool.name) || (state.heldItem?.slot != null && state.heldItem.slot !== selected) || !(TIERS[nameOf(tool.name)] >= requiredTier)) throw new DiamondActionError('鉱石を採取できる段階の実装備を確認できません。', 'TOOL_NOT_CONFIRMED')
    return { block, ...info, requiredTier }
  }
  function knownFurnace (state, target, expectedId) {
    const furnace = state.furnace
    if (!furnace?.window || !['furnace', 2].includes(furnace.window.type) || !integerPoint(furnace.window.coordinates) || target && key(furnace.window.coordinates) !== key(target) || expectedId != null && windowId(furnace.window.id) !== expectedId) return null
    if (!(windowId(furnace.window.id) > 0) || furnace.contentsKnown !== true || furnace.inventoryUncertain || furnace.needsOpen === true) return null
    const slots = [0, 1, 2].map(index => furnace.slots?.find(slot => slot.slot === index))
    if (!slots.every(slot => slot?.known === true && Number.isSafeInteger(slot.count) && slot.count >= 0 && (slot.count === 0 || typeof slot.name === 'string' && Number.isSafeInteger(slot.stackId) && slot.stackId > 0))) return null
    const other = state.crafting?.openContainer
    if (!other || !['furnace', 2].includes(other.type) || windowId(other.id) !== windowId(furnace.window.id)) return null
    return { ...furnace, slots }
  }
  async function furnaceTransfer (kind, decision, context) {
    const before = await read(context)
    const furnace = knownFurnace(before)
    if (!furnace) throw new DiamondActionError('実際のかまど画面と3スロットの受信が必要です。', 'FURNACE_NOT_KNOWN')
    const count = decision.count ?? 1
    if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new DiamondActionError('転送個数は1〜64で指定してください。', 'INVALID_COUNT')
    const sourceSlot = decision.sourceSlot ?? decision.slot
    const source = before.inventory.items.find(item => item.slot === sourceSlot && item.count >= count)
    const index = kind === 'take' ? 2 : kind === 'fuel' ? 1 : 0
    const existing = furnace.slots[index]
    const name = kind === 'take' ? nameOf(existing.name) : nameOf(source?.name)
    if (kind === 'take' ? name !== 'minecraft:iron_ingot' || existing.count < count || decision.expectedName && nameOf(decision.expectedName) !== name : !Number.isInteger(sourceSlot) || sourceSlot < 0 || sourceSlot > 35 || !source || !(kind === 'input' ? RAW_IRON : FUEL).has(name)) throw new DiamondActionError('転送元の実アイテム・個数・精錬結果が一致しません。', 'FURNACE_RESOURCE_CHANGED')
    if (kind !== 'take' && existing.count > 0 && nameOf(existing.name) !== name) throw new DiamondActionError('かまどの既存の中身は上書きしません。', 'FURNACE_CONTENT_CONFLICT')
    const target = furnace.window.coordinates
    const id = windowId(furnace.window.id)
    const initialCount = itemCount(before, name)
    const method = kind === 'input' ? 'putInput' : kind === 'fuel' ? 'putFuel' : 'takeOutput'
    const args = kind === 'take' ? [{ count, expectedName: name, ...(decision.targetSlot == null ? {} : { targetSlot: decision.targetSlot }) }] : [sourceSlot, count]
    context.cleanup = () => bestEffort('furnace', 'stop', ['行動を中断しました。'])
    report(context, { type: `furnace_${kind}`, phase: 'requesting', count, item: name })
    const response = await call('furnace', method, args, context.signal)
    if (response?.phase !== 'completed' || response.serverConfirmed !== true || response.operation !== kind || response.count !== count || nameOf(response.item) !== name || response.furnaceSlot !== index || windowId(response.windowId) !== id || !Number.isInteger(response.requestId)) throw new DiamondActionError('かまど転送の確定応答を確認できません。', 'FURNACE_TRANSFER_UNCONFIRMED')
    const observed = await waitFor(state => {
      const current = knownFurnace(state, target, id)
      if (!current) throw new DiamondActionError('転送の確認中にかまど画面が変わりました。', 'FURNACE_WINDOW_CHANGED')
      const last = current.lastTransfer
      if (!last?.serverConfirmed || last.phase !== 'completed' || last.requestId !== response.requestId || last.operation !== kind || last.count !== count || nameOf(last.item) !== name || last.furnaceSlot !== index || windowId(last.windowId) !== id) return null
      const slot = current.slots[index]
      if (slot.count > 0 && nameOf(slot.name) !== name) throw new DiamondActionError('転送の確認中にかまどの内容が変わりました。', 'FURNACE_CONTENT_CONFLICT')
      if (kind !== 'take' && slot.count > existing.count + count) return null
      const difference = itemCount(state, name) - initialCount
      return difference === (kind === 'take' ? count : -count) ? { current, difference } : null
    }, context, before)
    context.cleanup = null
    return complete({ serverConfirmed: true, confirmedBy: 'server_transfer_and_inventory', operation: kind, requestId: response.requestId, furnaceSlot: index, count, item: name, inventoryDelta: observed.difference, ...(kind === 'take' ? { collected: true } : {}) })
  }

  return {
    prospect: operation('prospect', async (decision, context) => {
      const before = await read(context, null, false)
      const options = { minY: -64, maxY: 80, chunkRadius: 1, maxResults: 64, ...decision.scanOptions }
      context.cleanup = () => bestEffort('prospecting', 'stop', ['観測を中断しました。'])
      await call('prospecting', 'start', [options], context.signal)
      const result = await waitFor(state => {
        const scan = state.prospecting
        if (['failed', 'stopped'].includes(scan?.phase)) throw new DiamondActionError(scan.reason ?? '鉱石の観測に失敗しました。', 'PROSPECT_FAILED')
        if (scan?.phase !== 'ready') return null
        const ores = Object.fromEntries(['coal', 'iron', 'diamond'].map(resource => [resource, (scan.ores?.[resource] ?? []).filter(ore => ore.known === true && integerPoint(ore.position) && ORES.get(nameOf(ore.name))?.resource === resource).map(ore => structuredClone(ore))]))
        return { ores, known: scan.known, unknown: scan.unknown }
      }, context, before, false)
      context.cleanup = null
      report(context, { type: 'prospect', phase: 'observed', resource: decision.resource, count: result.ores[decision.resource]?.length ?? 0 })
      return complete({ ...result, serverConfirmed: true, confirmedBy: 'server_block_observations', collected: false })
    }),
    mine_ore: operation('mine_ore', async (decision, context) => {
      if (typeof baseActions.mine_stone !== 'function') throw required('mine_ore')
      const before = await read(context)
      const plan = orePlan(decision, before)
      const preview = await request('POST', '/mining/preview', { targets: [decision.target] }, { signal: context.signal })
      const target = preview?.targets?.find(value => integerPoint(value.position) && key(value.position) === key(decision.target))
      if (!preview?.ready || nameOf(target?.name) !== plan.block || target?.protected || target?.known === false) throw new DiamondActionError('鉱石の最新プレビューが指定対象と一致しません。', 'RESOURCE_CHANGED')
      await read(context, before)
      context.cleanup = () => bestEffort('mining', 'stop', ['鉱石の採掘を中断しました。'])
      // Keep mine_ore intact: Runner rechecks this exact allowed ore name after
      // its grounded-item preparation, then confirms the resulting known air.
      const result = await baseActions.mine_stone({ ...decision, type: 'mine_ore', block: plan.block }, context)
      if (result?.ok === false || result?.phase !== 'completed' || result.serverConfirmed !== true) throw new DiamondActionError('鉱石の採掘結果がまだ確定していません。', 'MINING_UNCONFIRMED')
      await read(context, before)
      const after = await blockAt(decision.target, context)
      if (!after?.known || !AIR.has(nameOf(after.name))) throw new DiamondActionError('鉱石が既知の空気へ変わったことを確認できません。', 'BLOCK_NOT_CONFIRMED')
      context.cleanup = null
      return complete({ ...result, resource: plan.resource, block: plan.block, collected: false, confirmedBy: 'server_block_update' })
    }),
    place_furnace: operation('place_furnace', async (decision, context) => {
      let before = await read(context)
      if (!integerPoint(decision.target)) throw new DiamondActionError('設置先は整数座標で指定してください。', 'INVALID_TARGET')
      let item = before.inventory.items.find(item => nameOf(item.name) === 'minecraft:furnace' && item.count > 0 && (decision.slot == null || item.slot === decision.slot))
      if (!item) throw new DiamondActionError('実際の持ち物に指定のかまどがありません。', 'ITEM_NOT_IN_INVENTORY')
      const selected = before.rawServerSelectedSlot ?? before.rawSelectedSlot ?? before.selectedSlot
      if (item.slot !== selected || before.equipmentServerConfirmed === false || !Number.isInteger(selected) || selected < 0 || selected > 8) {
        if (typeof baseActions.equip !== 'function') throw required('equip')
        const requestedItem = { ...item }
        const equipped = await baseActions.equip({ item: 'minecraft:furnace', slot: item.slot }, context)
        before = await read(context, before)
        const confirmedSlot = before.rawServerSelectedSlot ?? before.rawSelectedSlot ?? before.selectedSlot
        item = before.inventory.items.find(item => nameOf(item.name) === 'minecraft:furnace' && item.count > 0 && item.slot === confirmedSlot && item.slot >= 0 && item.slot <= 8)
        if (equipped?.phase !== 'completed' || !equipmentReady(equipped, before, { sourceSlot: requestedItem.slot, expectedItem: requestedItem }) || before.equipmentServerConfirmed === false || !item) throw new DiamondActionError('かまどをサーバーで確定した選択スロットへ移した確認が必要です。', 'INVENTORY_SWAP_REQUIRED')
      }
      if (!Number.isInteger(item.slot) || item.slot < 0) throw new DiamondActionError('設置する実スロットが不明です。', 'INVALID_SLOT')
      const data = { position: { ...decision.target }, slot: item.slot }
      const preview = await call('interactions', 'previewPlace', [data], context.signal)
      if (preview?.ready !== true || nameOf(preview.expectedBlock) !== 'minecraft:furnace' || !integerPoint(preview.position) || key(preview.position) !== key(decision.target)) throw new DiamondActionError('かまどの設置プレビューが成立しません。', 'PREVIEW_REJECTED')
      await read(context, before)
      context.cleanup = () => bestEffort('interactions', 'cancel', ['設置を中断しました。'])
      const response = await call('interactions', 'placeBlock', [data], context.signal)
      if (response?.phase !== 'completed') throw new DiamondActionError('設置の応答を確認できません。', 'PLACEMENT_NOT_CONFIRMED')
      await waitFor(async state => {
        const block = await blockAt(decision.target, context)
        return block?.known && FURNACES.has(nameOf(block.name)) && itemCount(state, 'minecraft:furnace') === itemCount(before, 'minecraft:furnace') - 1
      }, context, before)
      context.cleanup = null
      return complete({ serverConfirmed: true, confirmedBy: 'server_block_and_inventory', position: { ...decision.target }, item: 'minecraft:furnace', count: 1 })
    }),
    open_furnace: operation('open_furnace', async (decision, context) => {
      const before = await read(context)
      if (!integerPoint(decision.target)) throw new DiamondActionError('かまどの整数座標が必要です。', 'INVALID_TARGET')
      const block = await blockAt(decision.target, context)
      if (!block?.known || !FURNACES.has(nameOf(block.name)) || block.protected) throw new DiamondActionError('対象の実際のかまどを確認できません。', 'RESOURCE_CHANGED')
      const current = knownFurnace(before, decision.target)
      if (current) return complete({ serverConfirmed: true, confirmedBy: 'server_container_contents', window: structuredClone(current.window), alreadyOpen: true })
      if (before.crafting?.openContainer || before.furnace?.window) await request('POST', '/craft/close', {}, { signal: context.signal })
      await read(context, before)
      context.cleanup = () => bestEffort('interactions', 'cancel', ['かまどの使用を中断しました。'])
      const response = await call('interactions', 'openFurnace', [{ ...decision.target }, decision.slot], context.signal)
      if (response?.phase !== 'completed') throw new DiamondActionError('かまどを開いた応答がありません。', 'CONTAINER_NOT_CONFIRMED')
      const opened = await waitFor(state => knownFurnace(state, decision.target, response.windowId == null ? undefined : windowId(response.windowId)), context, before)
      context.cleanup = null
      return complete({ serverConfirmed: true, confirmedBy: 'server_container_contents', window: structuredClone(opened.window) })
    }),
    put_furnace_input: operation('put_furnace_input', (decision, context) => furnaceTransfer('input', decision, context)),
    put_furnace_fuel: operation('put_furnace_fuel', (decision, context) => furnaceTransfer('fuel', decision, context)),
    take_furnace_output: operation('take_furnace_output', (decision, context) => furnaceTransfer('take', decision, context)),
    tunnel: operation('tunnel', async (decision, context) => {
      if (typeof tunnel !== 'function') throw required('tunnel')
      const before = await read(context)
      const stone = decision.resource === 'stone'
      if (stone && typeof validateStoneAccess !== 'function') throw required('bounded_stone_access')
      if (stone) validateStoneAccess(decision, before)
      orePlan(decision, before, stone)
      const result = await tunnel(decision, context)
      const after = await read(context, before)
      if (stone) validateStoneAccess(decision, after)
      if (!result || result.ok === false || !['completed', 'predicted'].includes(result.phase)) throw new DiamondActionError('掘削経路の実行が完了していません。', 'TUNNEL_UNCONFIRMED')
      return { ...result, collected: false }
    })
  }
}

module.exports = { createDiamondActions, DiamondActionError }
