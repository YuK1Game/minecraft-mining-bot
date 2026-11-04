'use strict'

const { resourceMinHealth } = require('./learning-health')

const { selectVisibleBlockFace, traceBlockFace } = require('./aim')
const { isDryAccessPlant } = require('./action-access')
const { bedVisibleFace } = require('./portable-bed')

const AIR = new Set(['air', 'cave_air', 'void_air'])
// Keep processed wood out of automatic harvesting. The caller must still select
// an actual tree: a log's block type cannot identify whether a player placed it.
const TREE_LOGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar'].map(tree => `${tree}_log`)
// Explicit vanilla canopy blocks from the supported Bedrock registry. The
// caller selects the natural tree; a leaf name does not prove ownership.
const TREE_LEAVES = ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves', 'azalea_leaves', 'azalea_leaves_flowered', 'orange_poplar_leaves', 'red_poplar_leaves', 'yellow_poplar_leaves']
const HAND = new Set(['dirt', 'grass_block', 'grass', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'leaf_litter', 'vine', ...TREE_LOGS, ...TREE_LEAVES])
const PICK = new Map([
  ...['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'netherrack', 'coal_ore', 'deepslate_coal_ore', 'nether_quartz_ore'].map(name => [name, 1]),
  ...['iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'lapis_ore', 'deepslate_lapis_ore'].map(name => [name, 2]),
  ...['gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore'].map(name => [name, 3])
])
const HAZARDS = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|dragon_egg|scaffolding)/
const QUARRY_HAZARDS = /(?:water|lava|bubble_column)/
const { blockRule: quarryRule, toolOf: quarryTool } = require('./quarry-rules')
const blockName = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const key = position => `${position.x},${position.y},${position.z}`
const adjacent = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]

function targetList (targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) throw new Error('targetsには1〜8個の座標を指定してください。')
  const result = targets.map(position => {
    if (!position || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis]) && Math.abs(position[axis]) <= 30000000)) {
      throw new Error('採掘座標のx/y/zは範囲内の整数で指定してください。')
    }
    const target = { x: position.x, y: position.y, z: position.z }
    if (position.accessPreparation === 'owned_bed') {
      if (position.expectedName !== 'minecraft:bed' || typeof position.ownershipKey !== 'string' || !position.ownershipKey.length || position.ownershipKey.length > 200) throw new Error('Owned-bed mining requires an exact ownership key')
      Object.assign(target, { accessPreparation: 'owned_bed', expectedName: 'minecraft:bed', ownershipKey: position.ownershipKey })
    } else if (position.accessPreparation === 'quarry') {
      // Quarry targets: the quarry planner already chose the block, the tool
      // and checked falling/fluid dependencies; mining re-checks them live.
      const rt = position.requiredTool
      if (typeof position.expectedName !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(position.expectedName) || quarryRule(position.expectedName).kind !== 'dig' || position.expectedRuntimeId != null && !Number.isSafeInteger(position.expectedRuntimeId) || rt != null && (!['pickaxe', 'shovel', 'axe', 'hoe', 'shears'].includes(rt.kind) || !Number.isSafeInteger(rt.tier) || rt.tier < 0 || rt.tier > 4)) throw new Error('Quarry mining needs an expected diggable block and a valid tool requirement')
      Object.assign(target, { accessPreparation: 'quarry', expectedName: position.expectedName, expectedRuntimeId: position.expectedRuntimeId ?? null, requiredTool: rt ? { kind: rt.kind, tier: rt.tier } : null })
    } else if (position.accessPreparation != null || position.expectedName != null) {
      if (position.accessPreparation !== 'tree_access' || !['minecraft:leaf_litter', 'minecraft:vine'].includes(position.expectedName)) throw new Error('植物の準備採掘には許可された対象名が必要です。')
      Object.assign(target, { accessPreparation: 'tree_access', expectedName: position.expectedName })
    }
    return target
  })
  if (new Set(result.map(key)).size !== result.length) throw new Error('同じ採掘座標を重複して指定できません。')
  return result
}

function pickTier (state) {
  if (!Number.isInteger(state.selectedSlot) || !state.heldItem?.name) return 0
  const name = state.heldItem.name.replace(/^minecraft:/, '')
  return { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 4 }[name] ?? 0
}

function createMining ({ getState, world, getInput, verifyOwnedBed = null, getRawItem = null, isProtected = () => false, now = Date.now, blockTimeoutMs = 15000 }) {
  if (getRawItem !== null && typeof getRawItem !== 'function' || typeof isProtected !== 'function') throw new Error('Clearance inventory/protection readers must be functions')
  if (verifyOwnedBed !== null && typeof verifyOwnedBed !== 'function') throw new Error('Owned-bed verification must be an explicit callback')
  let timer = null
  let activeInput = null
  let expected = null
  let origin = null
  let dimension = null
  let ownedScope = null
  let accessPin = null
  const bedScope = state => JSON.stringify([state.profile ?? null, state.realm?.id ?? null, state.connectionId ?? null, state.startedAt ?? null, String(state.runtimeEntityId ?? ''), state.lifecycle?.deathId ?? null])
  let startedBlockAt = 0
  let status = { phase: 'idle', activeTarget: null, completed: [], remaining: [], reason: null }

  function clearanceScope (state) {
    const life = state.lifecycle?.deathId
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !state.connectionId || !state.startedAt || !Number.isFinite(Date.parse(state.startedAt)) || ! /^[1-9]\d*$/.test(String(state.runtimeEntityId ?? '')) || state.dimension == null || !Number.isSafeInteger(life) || life < 0 || state.lifecycle?.dead || state.spawnPending) throw new Error('Stone clearance requires actual current connection and life')
    return JSON.stringify([state.profile,String(state.realm.id),state.connectionId,state.startedAt,String(state.runtimeEntityId),state.dimension,life])
  }
  function clearanceEquipment (state) {
    const scope = clearanceScope(state), slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const raw = typeof getRawItem === 'function' && Number.isInteger(slot) ? getRawItem(slot) : null
    if (state.phase !== 'spawned' || state.dead || state.isDead || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state) || state.inventory?.known !== true || !Number.isInteger(slot) || slot < 0 || slot > 8 || state.selectedSlot !== slot || state.inventory?.uncertain || state.heldItem != null || state.inventory?.items?.some(item => item.slot === slot && item.count > 0) || !raw || raw.network_id !== 0 || raw.count !== 0 || raw.has_stack_id === true && raw.stack_id !== 0) throw new Error('Stone clearance requires an actual server-selected empty hand')
    if (accessPin && status.operation === 'access_clearance' && status.phase === 'mining' && (scope !== accessPin.scope || slot !== accessPin.slot || state.health < accessPin.health)) throw new Error('Stone clearance life, empty hand or health changed')
    return { scope, slot, health: state.health }
  }
  function clearanceTarget (options) {
    if (!options || Array.isArray(options) || options.targets != null || !options.position || Object.keys(options.position).some(k => !['x','y','z'].includes(k)) || !Number.isSafeInteger(options.expectedRuntimeId) || options.expectedRuntimeId < 0 || options.expectedRuntimeId > 4294967295) throw new Error('Stone clearance needs one exact position and received runtime ID')
    return { ...targetList([options.position])[0], accessPreparation:'stone_clearance', expectedName:'minecraft:stone', expectedRuntimeId:options.expectedRuntimeId }
  }
  function validate (target, state, removed = new Set(), previousAim = null) {
    if (state.phase !== 'spawned' || !state.position) throw new Error('ワールドへの参加と位置取得が必要です。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('サバイバルモード専用です。')
    const clearance = target.accessPreparation === 'stone_clearance'
    if (clearance) clearanceEquipment(state)
    const ownedBedAttempt = target.accessPreparation === 'owned_bed' && target.expectedName === 'minecraft:bed'
    if (state.dead || state.isDead || !Number.isFinite(state.health) || state.health <= (ownedBedAttempt ? 0 : resourceMinHealth(state))) throw new Error('体力を確認できないか、体力が少ないため停止します。')
    if (!state.inventory.known) throw new Error('持ち物の一覧をまだ取得できていません。')
    if (state.inventory.items.filter(item => item.slot < 36).length >= 36) throw new Error('持ち物が満杯です。')
    const feet = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
    const feetY = state.position.y - 1.62
    const support = world.getBlock(feet.x, feet.y - 1, feet.z)
    if (Math.abs(feetY - Math.round(feetY)) > 0.05 || !support.known || AIR.has(blockName(support)) || HAZARDS.test(blockName(support))) {
      throw new Error('通常の地面に静止していることを確認できません。')
    }
    if (target.x === feet.x && target.z === feet.z && target.y <= feet.y) throw new Error('自分の足元は掘れません。')
    const block = world.getBlock(target.x, target.y, target.z)
    if (!block.known) throw new Error('対象ブロックをまだ読み取れていません。')
    const name = blockName(block)
    if (target.accessPreparation === 'tree_access' && (!isDryAccessPlant(block) || block.name !== target.expectedName)) throw new Error('準備採掘の植物が変更されたか、乾いた未保護の植物ではありません。')
    const ownedBed = target.accessPreparation === 'owned_bed' && name === 'bed' && block.name === target.expectedName && typeof verifyOwnedBed === 'function' && verifyOwnedBed(state, target, block) === true
    if (target.accessPreparation === 'owned_bed' && !ownedBed) throw new Error('This bed lacks the current portable-bed ownership proof')
    const quarry = target.accessPreparation === 'quarry'
    if (quarry) {
      if (block.name !== target.expectedName || target.expectedRuntimeId != null && block.runtimeId !== target.expectedRuntimeId) throw new Error('露天掘りの対象ブロックが計画時から変わりました。')
      if (block.protected === true || block.protectionSource || isProtected(target, state, block)) throw new Error('保護されたブロックは露天掘りでも壊しません。')
      if (target.requiredTool) {
        const held = quarryTool(state.heldItem?.name)
        if (!held || held.kind !== target.requiredTool.kind || held.tier < target.requiredTool.tier) throw new Error(`回収に必要な道具を手に持っていません: ${name}`)
      }
    }
    if (!quarry && !HAND.has(name) && !PICK.has(name) && !ownedBed) throw new Error(`このブロックは自動採掘の対象外です: ${name}`)
    if (clearance && (block.name !== 'minecraft:stone' || block.runtimeId !== target.expectedRuntimeId || block.protected === true || block.protectionSource || block.natural === false || isProtected(target, state, block))) throw new Error('Stone clearance target changed or is protected')
    if (!clearance && !quarry && PICK.has(name) && pickTier(state) < PICK.get(name)) throw new Error(`適切なツルハシの装備を確認できません: ${name}`)
    if (block.extra?.some(layer => !AIR.has(blockName(layer)))) throw new Error('対象に水などの追加レイヤーがあります。')
    for (const offset of adjacent) {
      const neighbour = world.getBlock(target.x + offset.x, target.y + offset.y, target.z + offset.z)
      if (!neighbour.known) throw new Error('対象の周辺に未取得のブロックがあります。')
      // Quarry: falling neighbours are ordered by the planner (top-down); fluids
      // and unknown cells still stop the dig.
      const hazards = quarry ? QUARRY_HAZARDS : HAZARDS
      if (hazards.test(blockName(neighbour)) || neighbour.extra?.some(layer => hazards.test(blockName(layer)))) {
        throw new Error('対象の隣に液体・落下ブロックなどがあります。')
      }
    }
    // The centre can be hidden by the cell above a stair target while its near
    // side remains visible. Aim at a proven visible face, including its actual
    // ray-entry side and reach, and retain that exact point for later checks.
    const options = { eye: state.position, target, world, maxReach: 4.5, removed }
    const aim = ownedBed ? bedVisibleFace({ ...options, previousAim }) : previousAim ? traceBlockFace({ ...options, point: previousAim.point }) : selectVisibleBlockFace(options)
    if (!aim || previousAim && aim.face !== previousAim.face) throw new Error('射程内の採掘面への視線が遮られているか、未取得です。')
    return { position: target, name: block.name, runtimeId: block.runtimeId, distance: Number(aim.distance.toFixed(2)), aim }
  }

  function preview (targets) { return previewChecked(targetList(targets)) }
  function previewAccessClearance (options) { return { ...previewChecked([clearanceTarget(options)]), operation:"access_clearance", willDrop:false, collected:false } }
  function previewChecked (targets) {
    const state = getState()
    const checked = []
    const errors = []
    const removed = new Set()
    if (!getInput()) errors.push('現在の接続では採掘入力を利用できません。')
    for (const target of targets) {
      try {
        checked.push(validate(target, state, removed))
        removed.add(key(target))
      } catch (error) {
        errors.push(`${key(target)}: ${error.message}`)
      }
    }
    return { ready: errors.length === 0, targets: checked, errors, movement: false }
  }

  function stop (reason = '停止しました。', phase = 'stopped') {
    if (timer) clearInterval(timer)
    timer = null
    activeInput?.stop()
    activeInput = null
    status.phase = phase
    status.reason = reason
    status.activeTarget = null
    return snapshot()
  }

  function beginNext () {
    if (!status.remaining.length) {
      stop('指定されたブロックの破壊をサーバーから確認しました。', 'completed')
      return
    }
    const target = status.remaining[0]
    expected = validate(target, getState())
    status.activeTarget = { ...target }
    startedBlockAt = now()
    activeInput.lookAt(expected.aim.point)
    activeInput.start()
    activeInput.sendAction('start_break', target, expected.aim.face, { hitPoint: expected.aim.hit })
  }

  function check () {
    if (status.phase !== 'mining' || !status.activeTarget || !activeInput) return
    try {
      const state = getState()
      if (state.phase !== 'spawned' || state.dimension !== dimension || !state.position || Math.hypot(state.position.x - origin.x, state.position.y - origin.y, state.position.z - origin.z) > 0.3) {
        throw new Error('接続・次元・プレイヤー位置が変わったため停止しました。')
      }
      const target = status.activeTarget
      if (ownedScope && (ownedScope !== bedScope(state) || state.dead || state.isDead || !(state.health > 0))) throw new Error('Owned-bed mining changed player life or connection')
      if (target.accessPreparation === 'stone_clearance') clearanceEquipment(state)
      const block = world.getBlock(target.x, target.y, target.z)
      if (target.accessPreparation === 'stone_clearance' && (block.protected === true || block.protectionSource || isProtected(target, state, block))) throw new Error('Stone clearance target became protected')
      if (block.known && AIR.has(blockName(block))) {
        activeInput.stop()
        status.completed.push(status.remaining.shift())
        if (status.operation === 'access_clearance') { status.blockCleared = true; status.confirmedBy = 'received_block_air'; status.serverConfirmed = true }
        beginNext()
        return
      }
      const current = validate(target, state, new Set(), expected.aim)
      if (current.runtimeId !== expected.runtimeId) throw new Error('対象ブロックが変更されたため停止しました。')
      if (now() - startedBlockAt >= blockTimeoutMs) throw new Error('制限時間内にブロック破壊を確認できませんでした。')
      if (!activeInput.stats().running) throw new Error('入力送信が停止しました。')
    } catch (error) { stop(error.message, 'failed') }
  }

  // Called after the host has applied received terrain to the world reader.
  // Coalesce a packet burst without waiting for the 100ms watchdog. The
  // packet is only a wake-up: received world state remains the completion proof.
  let pendingObservation = null
  function applyPacket (name, packet) {
    if (status.phase !== 'mining' || !status.activeTarget) return
    const target = status.activeTarget
    const touches = entry => entry?.position && ['x', 'y', 'z'].every(axis => entry.position[axis] === target[axis])
    if (name === 'update_block') { if (!touches(packet)) return }
    else if (name === 'update_subchunk_blocks') { if (![...(packet.blocks ?? []), ...(packet.extra ?? [])].some(touches)) return }
    else if (name !== 'subchunk' && name !== 'level_chunk') return
    const run = status
    if (pendingObservation === run) return
    pendingObservation = run
    queueMicrotask(() => {
      if (pendingObservation === run) pendingObservation = null
      if (status === run && status.phase === 'mining') check()
    })
  }

  function start (targets) { return startChecked(targetList(targets), false) }
  function startAccessClearance (options) { return startChecked([clearanceTarget(options)], true) }
  function startChecked (targets, clearance) {
    if (status.phase === 'mining') throw new Error('すでに採掘中です。先に停止してください。')
    const plan = previewChecked(targets)
    if (!plan.ready) throw new Error(plan.errors.join('\n'))
    accessPin = clearance ? clearanceEquipment(getState()) : null
    activeInput = getInput()
    origin = { ...getState().position }
    dimension = getState().dimension
    ownedScope = targets.some(target => target.accessPreparation === 'owned_bed') ? bedScope(getState()) : null
    status = { phase: 'mining', activeTarget: null, completed: [], remaining: structuredClone(targets), reason: null, ...(clearance ? {operation:'access_clearance',willDrop:false,collected:false,blockCleared:false,serverConfirmed:false} : {}) }
    try {
      beginNext()
      timer = setInterval(check, 100)
    } catch (error) {
      stop(error.message, 'failed')
      throw error
    }
    return snapshot()
  }
  function snapshot () { return structuredClone(status) }
  return { preview, start, previewAccessClearance, startAccessClearance, stop, snapshot, applyPacket }
}

module.exports = { createMining }
