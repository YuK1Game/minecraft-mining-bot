'use strict'

const { performance } = require('node:perf_hooks')
const { isDeepStrictEqual } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const { evaluateThreats, threatRadius } = require('./threats')
const { guardedSecondaryMinimum } = require('./combat-policy')
const { resourceMinHealth } = require('./learning-health')

const { isAttackableHostileType } = require('./mob-catalog')
const FOOD_ANIMALS = new Set(['minecraft:cow', 'minecraft:pig', 'minecraft:sheep'])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const BOSSES = new Set(['minecraft:wither', 'minecraft:ender_dragon'])
const MELEE_TARGETS = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'drowned', 'spider', 'cave_spider'].map(name => `minecraft:${name}`))
const SWORDS = new Set(['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'].map(material => `minecraft:${material}_sword`))
const SIGHT_PLANTS = new Set([
  'leaf_litter', 'grass', 'short_grass', 'tall_grass', 'tallgrass', 'fern', 'large_fern',
  'deadbush', 'dead_bush', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass',
  'wildflowers', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'pink_petals'
].map(name => `minecraft:${name}`))
// Aim inside a known mob body rather than at its feet. These low aim heights
// also avoid assuming a full adult size when the tracker has no size metadata.
const BODY_AIM_HEIGHTS = new Map([
  ...['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'drowned', 'skeleton',
    'stray', 'bogged', 'wither_skeleton', 'creeper', 'witch', 'pillager', 'vindicator',
    'evocation_illager', 'piglin_brute', 'blaze', 'breeze', 'creaking'].map(name => [name, 0.9]),
  ['spider', 0.4], ['cave_spider', 0.2], ['silverfish', 0.15], ['endermite', 0.15],
  ['slime', 0.2], ['magma_cube', 0.2], ['vex', 0.3], ['phantom', 0.2],
  ['guardian', 0.4], ['elder_guardian', 0.6], ['cow', 0.6], ['sheep', 0.6], ['pig', 0.4], ['chicken', 0.3]
].map(([name, height]) => [`minecraft:${name}`, height]))
const finite = position => position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))
const copy = value => structuredClone(value)

function sightPassable (block) {
  if (block?.known !== true || block.extra?.length) return false
  if (AIR.has(block.name)) return true
  // Empty, received water does not obstruct a melee ray. Keep waterlogged
  // solids and unknown or non-empty collision shapes excluded.
  if (['minecraft:water', 'minecraft:flowing_water'].includes(block.name)) return block.boundingBox === 'empty'
  if (block.name === 'minecraft:torch') return block.boundingBox === 'empty'
  // An empty box alone is not enough: lava, portals and custom blocks must
  // not become an assumed clear line through unknown or unsupported geometry.
  return block.boundingBox === 'empty' && SIGHT_PLANTS.has(block.name)
}

function createCombat ({ client, getState, world, entities, crafting, getInput, verifyUnarmedBody = null, version = '1.26.60', cooldownMs = 750, engagementCooldownMs = 500, attackTimeoutMs = 800, isBusy = () => false, now = () => performance.now() }) {
  if (version !== '1.26.60') throw new Error('自衛操作は1.26.60専用です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof world?.getBlock !== 'function' || typeof entities?.snapshot !== 'function' || typeof entities?.nearby !== 'function' || typeof crafting?.rawItem !== 'function' || typeof getInput !== 'function') throw new Error('自衛操作には接続、地形、対象、持ち物、入力の観測が必要です。')
  if (!Number.isFinite(cooldownMs) || cooldownMs < 600 || cooldownMs > 5000 || !Number.isFinite(attackTimeoutMs) || attackTimeoutMs < 50 || attackTimeoutMs > 3000) throw new Error('自衛操作の待ち時間が不正です。')
  if (!Number.isSafeInteger(engagementCooldownMs) || engagementCooldownMs < 500 || engagementCooldownMs > 5000) throw new Error('剣の継続交戦間隔が不正です。')
  const engagementInterval = allowUnarmed => allowUnarmed ? Math.max(750, cooldownMs) : engagementCooldownMs
  const health = new Map()
  let busy = false
  let defending = false
  let engagement = null
  let engagementTask = null
  let epoch = 0
  let activeInput = null
  let activePurpose = null
  let activeCritical = false
  let pending = null
  let lastAttackAt = -Infinity
  let lastResult = null
  const providedClock = now
  now = () => {
    const time = providedClock()
    if (!Number.isFinite(time)) throw new Error('自衛操作の時刻を確認できません。')
    return time
  }
  now()
  // A runtime can attach fresh, validated terrain observations without
  // changing the entity tracker used to bind the actual attack target.
  const threatActors = state => Array.isArray(state.entities) ? state.entities : entities.snapshot({ kind: 'all' })

  // Quarry animal clearing (2026-11-13): only these ordinary passive animals.
  const ANIMAL_CLEAR_TARGETS = new Set(['minecraft:chicken', 'minecraft:cow', 'minecraft:pig', 'minecraft:sheep', 'minecraft:rabbit', 'minecraft:mooshroom', 'minecraft:fox', 'minecraft:frog', 'minecraft:armadillo'])
  function session (purpose = 'defense', { allowCritical = false } = {}) {
    const state = getState()
    if (state.dead === true || state.isDead === true || state.phase !== 'spawned' || !finite(state.position)) throw new Error('生存してワールドに参加している必要があります。')
    const minimumHealth = purpose === 'hunt' || purpose === 'emergency' && allowCritical ? 0 : ['engage', 'emergency'].includes(purpose) ? 6 : 10
    if (!Number.isFinite(state.health) || state.health <= minimumHealth) throw new Error(purpose === 'hunt' ? '生存と正の体力を確認してから食料のための狩りを行ってください。' : purpose === 'engage' ? '体力が6以下または不明のため交戦を中断します。' : '体力が10以下または不明です。攻撃せず回避してください。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('自衛操作はサバイバル専用です。')
    if (isBusy()) throw new Error('移動・採掘などの操作を止めてから自衛してください。')
    const inventory = crafting.snapshot()
    if (inventory.authority !== true) throw new Error('サーバー権威の持ち物情報を確認できません。')
    if (purpose === 'hunt' && (inventory.inventoryKnown === false || state.inventory?.known === false || state.inventory?.uncertain === true)) throw new Error('狩りに使う主手の持ち物をサーバーから取得してください。')
    if (['engage', 'emergency', 'water_creeper', 'animal'].includes(purpose) && (inventory.inventoryKnown !== true || state.inventory?.known !== true || state.inventory?.uncertain === true)) throw new Error('交戦にはサーバーで確定した持ち物が必要です。')
    if (purpose === 'water_creeper' && (state.health !== 20 || state.equipmentServerConfirmed === false)) throw new Error('水中の緊急自衛には体力と選択装備の確認が必要です。')
    if (inventory.openContainer) throw new Error('インベントリ画面を閉じてから自衛してください。')
    return state
  }
  function unarmedHand (state, slot, raw) {
    const snapshot = crafting.snapshot(); const held = state.inventory?.items?.find(item => item.slot === slot && item.count > 0)
    const actual = snapshot.inventory?.find(item => item.slot === slot && item.count > 0)
    if (state.equipmentServerConfirmed === false || state.inventory.items.some(item => item.count > 0 && SWORDS.has(item.name))) throw new Error('空手交戦中の選択装備を確認できません。')
    if (raw.network_id === 0) {
      if (raw.count !== 0 || raw.has_stack_id === true && raw.stack_id !== 0 || held || actual || state.heldItem) throw new Error('空の主手と確定した持ち物が一致しません。')
    } else if (held?.name !== 'minecraft:rotten_flesh' || state.heldItem?.name !== held.name || state.heldItem.count !== held.count || state.heldItem.slot != null && state.heldItem.slot !== slot || actual?.name !== held.name || actual.count !== held.count || actual.count !== raw.count || actual.stackId !== raw.stack_id || held.networkId !== raw.network_id) throw new Error('空手交戦は確定した空の主手または腐肉だけです。')
    return JSON.stringify([slot, raw, held ?? null, actual ?? null, state.heldItem ?? null])
  }
  function plan (runtimeId, purpose = 'defense', { maxDistance = 2.8, allowUnarmed = false, continuation = false, allowEmergencySpider = false, allowEmergencyCreeper = false, allowCritical = false } = {}) {
    if (typeof allowEmergencyCreeper !== 'boolean' || typeof allowCritical !== 'boolean') throw new Error('緊急自衛の指定が不正です。')
    const state = session(purpose, { allowCritical })
    const id = String(runtimeId)
    const entity = entities.snapshot({ kind: 'all' }).find(entity => entity.runtimeId === id)
    if (allowEmergencyCreeper && entity?.entityType !== 'minecraft:creeper') throw new Error('クリーパー自衛の対象が変わりました。')
    if (purpose === 'hunt') {
      const chicken = entity?.entityType === 'minecraft:chicken' && resourceMinHealth(state) === 0 && entity.isBaby !== true && entity.baby !== true && entity.uniqueId != null && entity.protected !== true && entity.natural !== false && entity.owned !== true && entity.tamed !== true && entity.isTamed !== true && entity.owner == null && entity.ownerId == null && entity.ownerUniqueId == null && entity.isNpc !== true && typeof entity.username !== 'string' && !entity.customName && !entity.nameTag
      if (!entity || entity.kind !== 'mob' || !(FOOD_ANIMALS.has(entity.entityType) || chicken) || entity.hostile !== false) throw new Error('食料目的の狩りは観測済みの対応する食用動物だけに限定しています。')
    } else if (purpose === 'animal') {
      if (!entity || entity.kind !== 'mob' || entity.hostile !== false || !ANIMAL_CLEAR_TARGETS.has(entity.entityType) || entity.uniqueId == null) throw new Error('動物の除去は許可した受動動物だけに限定しています。')
    } else if (!entity || entity.kind !== 'mob' || !entity.hostile || !isAttackableHostileType(entity.entityType) || BOSSES.has(entity.entityType)) throw new Error('攻撃対象は観測済みの既知の敵モブだけに限定し、ボスは除外しています。')
    if (purpose === 'engage' && (!MELEE_TARGETS.has(entity.entityType) || entity.uniqueId == null)) throw new Error('継続交戦は個体を確認したゾンビ・ハスク・ドラウンド・クモ類だけに限定しています。')
    if (purpose === 'water_creeper' && (entity.entityType !== 'minecraft:creeper' || entity.uniqueId == null || entity.charged !== false || typeof entity.primed !== 'boolean' || entity.primed && (!Number.isInteger(entity.fuseLength) || entity.fuseLength < 20))) throw new Error('水中のクリーパー個体・帯電・点火状態を確認できません。')
    if (purpose === 'emergency' && (!(entity.entityType === 'minecraft:zombie' || allowEmergencySpider && state.health > 10 && entity.entityType === 'minecraft:spider' || allowEmergencyCreeper && state.health > 6 && entity.entityType === 'minecraft:creeper' && threatRadius(entity) === 8) || entity.uniqueId == null)) throw new Error('緊急自衛は個体を確認した対象だけに限定しています。')
    if (entity.runtimeId === String(state.runtimeEntityId) || entity.entityType === 'minecraft:player') throw new Error('自分やプレイヤーは攻撃できません。')
    if (entity.alive !== true || entity.positionKnown !== true || !finite(entity.position) || entity.dimension !== state.dimension) throw new Error('対象の現在位置・生存状態・次元を確認できません。')
    const aimPoint = { ...entity.position, y: entity.position.y + (BODY_AIM_HEIGHTS.get(entity.entityType) ?? 0.3) }
    const distance = Math.hypot(aimPoint.x - state.position.x, aimPoint.y - state.position.y, aimPoint.z - state.position.z)
    if (distance > maxDistance) throw new Error(`対象が安全な近接範囲${maxDistance}ブロックの外にいます。`)
    const steps = Math.max(1, Math.ceil(distance / 0.05))
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps
      const x = Math.floor(state.position.x + (aimPoint.x - state.position.x) * ratio)
      const y = Math.floor(state.position.y + (aimPoint.y - state.position.y) * ratio)
      const z = Math.floor(state.position.z + (aimPoint.z - state.position.z) * ratio)
      const block = world.getBlock(x, y, z)
      if (!sightPassable(block)) throw new Error('対象への視線が遮られているか、地形が不明です。')
    }
    const slot = ['hunt', 'engage', 'emergency', 'water_creeper'].includes(purpose) ? state.rawServerSelectedSlot ?? state.rawSelectedSlot : state.selectedSlot
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('現在選択されているホットバースロットを確認できません。')
    const raw = crafting.rawItem(slot)
    if (!raw || !Number.isInteger(raw.network_id) || !Number.isInteger(raw.count) || raw.count < 0 || raw.network_id !== 0 && (raw.count < 1 || raw.has_stack_id !== true || !Number.isInteger(raw.stack_id) || raw.stack_id <= 0)) throw new Error('現在の主手の持ち物を確認できません。')
    if (purpose === 'hunt' && raw.network_id === 0 && (raw.count !== 0 || raw.has_stack_id === true && raw.stack_id !== 0)) throw new Error('空の主手と実アイテムの個数・スタックIDが一致しません。')
    let hand = null
    if (purpose === 'engage' && allowUnarmed) {
      if (entity.entityType !== 'minecraft:zombie' || typeof verifyUnarmedBody !== 'function' || verifyUnarmedBody(copy(state), { continuation }) !== true) throw new Error('空手交戦には単独ゾンビと既知の乾いた体勢が必要です。')
      hand = unarmedHand(state, slot, raw)
    } else if (['engage', 'emergency'].includes(purpose)) {
      const held = crafting.snapshot().inventory?.find(item => item.slot === slot)
      if (!held || !SWORDS.has(held.name) || raw.network_id === 0 || raw.count !== 1 || held.count !== raw.count || held.stackId !== raw.stack_id) throw new Error('継続交戦にはサーバーで確定した選択スロットの実際の剣が必要です。')
    }
    let waterParticipants = null
    if (purpose === 'water_creeper') {
      const held = state.inventory.items?.find(item => item.slot === slot && item.count > 0)
      const craftingHeld = crafting.snapshot().inventory?.find(item => item.slot === slot)
      if (raw.network_id === 0 ? raw.count !== 0 || raw.has_stack_id === true && raw.stack_id !== 0 || held || state.heldItem : held?.name !== 'minecraft:rotten_flesh' || state.heldItem?.name !== held.name || held.count !== raw.count || held.networkId !== raw.network_id || craftingHeld?.name !== held.name || craftingHeld.count !== raw.count || craftingHeld.stackId !== raw.stack_id) throw new Error('水中の緊急自衛は確認済みの空手または腐肉に限定します。')
      const foot = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }
      const water = world.getBlock(foot.x, foot.y, foot.z)
      const head = world.getBlock(Math.floor(state.position.x), Math.floor(state.position.y), Math.floor(state.position.z))
      if (water?.known !== true || !['minecraft:water', 'minecraft:flowing_water'].includes(water.name) || water.boundingBox !== 'empty' || water.extra?.length || head?.known !== true || !AIR.has(head.name) || head.extra?.length) throw new Error('足元の水と頭上の空気を確認できません。')
      const all = entities.snapshot({ kind: 'all' }); const threats = evaluateThreats(state, all, { observationRadius: 32 })
      if (threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length) throw new Error('水中の敵の位置を確認できません。')
      const others = threats.threats.filter(actor => actor.runtimeId !== entity.runtimeId)
      if (others.length > 1 || others.some(actor => { const other = all.find(value => value.runtimeId === actor.runtimeId); return actor.name !== 'minecraft:creeper' || actor.dangerRadius !== 8 || other?.uniqueId == null || other.charged !== false || other.primed !== false || Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z) < 5 })) throw new Error('別の敵が近いか状態を確認できません。')
      waterParticipants = others.map(actor => `${actor.runtimeId}:${all.find(value => value.runtimeId === actor.runtimeId).uniqueId}`).sort().join('|')
    }
    return { entity, aimPoint, slot, raw, distance, origin: copy(state.position), dimension: state.dimension, health: state.health, waterParticipants, hand, scope: JSON.stringify([state.profile ?? null, state.realm?.id ?? null, state.dimension, state.connectionId ?? null, state.runtimeEntityId]) }
  }
  function previewFor (runtimeId, purpose) {
    try {
      const target = plan(runtimeId, purpose)
      return { ready: true, target: { runtimeId: target.entity.runtimeId, name: target.entity.entityType, position: target.entity.position, aimPoint: target.aimPoint }, distance: target.distance, slot: target.slot, ...(purpose === 'hunt' ? { purpose: 'food', collected: false, ...(target.entity.entityType === 'minecraft:chicken' ? { yieldRisk: { foodYieldConfirmed: false, age: target.entity.isBaby === false || target.entity.baby === false ? 'observed_nonbaby' : 'unknown' } } : {}) } : {}), cooldownRemainingMs: Math.max(0, cooldownMs - (now() - lastAttackAt)) }
    } catch (error) { return { ready: false, errors: [error.message], recommendation: 'avoid' } }
  }
  const preview = runtimeId => previewFor(runtimeId, 'defense')
  const previewHunt = runtimeId => previewFor(runtimeId, 'hunt')
  function previewWaterCreeper (runtimeId) {
    try { const target = plan(runtimeId, 'water_creeper', { maxDistance: 3.2 }); return { ready: true, target: { runtimeId: target.entity.runtimeId, name: target.entity.entityType, position: target.entity.position, aimPoint: target.aimPoint }, distance: target.distance, cooldownRemainingMs: Math.max(0, cooldownMs - (now() - lastAttackAt)) } } catch (error) { return { ready: false, errors: [error.message], recommendation: 'avoid' } }
  }
  function previewEmergency (runtimeId, { allowDistantRanged = false, allowDistantZombie = false, allowGuardedGroup = false, allowCritical = false, allowEmergencyCreeper = false } = {}) {
    try { if (allowEmergencyCreeper && (allowDistantRanged || allowDistantZombie || allowGuardedGroup || allowCritical)) throw new Error('クリーパー自衛は単独対象のみです。'); const target = plan(runtimeId, 'emergency', { maxDistance: allowCritical ? 2.95 : 2.8, allowEmergencySpider: allowDistantZombie || allowGuardedGroup, allowEmergencyCreeper, allowCritical }); otherThreats(target.entity.runtimeId, { allowDistantRanged, allowDistantZombie, allowGuardedGroup, allowCritical }); return { ready: true, cooldownRemainingMs: Math.max(0, cooldownMs - (now() - lastAttackAt)) } } catch (error) { return { ready: false, errors: [error.message] } }
  }
  function otherThreats (targetId, { allowDistantRanged = false, allowDistantZombie = false, allowGuardedGroup = false, allowCritical = false } = {}) {
    if ([allowDistantRanged, allowDistantZombie, allowGuardedGroup, allowCritical].some(value => typeof value !== 'boolean') || Number(allowDistantRanged) + Number(allowDistantZombie) + Number(allowGuardedGroup) > 1 || allowCritical && (allowDistantZombie || allowGuardedGroup)) throw new Error('遠距離の敵の観測条件が不正です。')
    const state = getState(); const actors = threatActors(state)
    const evaluation = evaluateThreats(state, actors)
    if (evaluation.unknownPositions.some(entity => entity.classification === 'known_hostile')) throw new Error('位置が不明な敵を観測したため交戦を中断します。')
    const others = evaluation.threats.filter(entity => entity.runtimeId !== targetId)
    const allowed = (allowGuardedGroup ? others.length <= 3 && state.health > 10 : others.length <= 1) && others.every(entity => (allowDistantRanged && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(entity.name) && entity.distance >= (allowCritical ? 20 : 18) || allowDistantZombie && entity.name === 'minecraft:zombie' && entity.distance >= 8 && state.health > 10 || allowGuardedGroup && guardedSecondaryMinimum(entity) !== null && entity.distance >= guardedSecondaryMinimum(entity)) && actors.find(actor => actor.runtimeId === entity.runtimeId)?.uniqueId != null)
    const other = allowed ? null : others[0]
    if (other) throw new Error(`別の危険な敵 ${other.name} が接近しているため交戦を中断します。`)
    return others.map(entity => `${entity.runtimeId}:${actors.find(actor => actor.runtimeId === entity.runtimeId)?.uniqueId}`).sort().join('|')
  }
  function initialEngagement (runtimeId, { allowUnarmed = false } = {}) {
    if (typeof allowUnarmed !== 'boolean') throw new Error('空手交戦の指定が不正です。')
    session() // Entry keeps the ordinary health > 10 rule.
    const target = plan(runtimeId, 'engage', { allowUnarmed })
    if (allowUnarmed && target.health < 18) throw new Error('新しい空手交戦には体力18以上が必要です。')
    otherThreats(target.entity.runtimeId)
    if (allowUnarmed) {
      const state = getState(); const threats = evaluateThreats(state, threatActors(state), { observationRadius: 32 })
      if (threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length || threats.threats.some(actor => actor.runtimeId !== target.entity.runtimeId)) throw new Error('空手交戦は位置を確認した単独ゾンビだけです。')
    }
    return target
  }
  function previewEngage (runtimeId, options = {}) {
    try {
      const target = initialEngagement(runtimeId, options)
      return { ready: true, target: { runtimeId: target.entity.runtimeId, name: target.entity.entityType, position: target.entity.position, aimPoint: target.aimPoint }, distance: target.distance, slot: target.slot, maxDistanceWhileWaiting: 6, minimumContinuationHealth: 6, engagementCooldownMs: engagementInterval(options.allowUnarmed === true), cooldownRemainingMs: Math.max(0, engagementInterval(options.allowUnarmed === true) - (now() - lastAttackAt)) }
    } catch (error) { return { ready: false, errors: [error.message], recommendation: 'avoid' } }
  }
  function engagementTarget (run, maxDistance = 6) {
    const target = plan(run.entity.runtimeId, 'engage', { maxDistance, allowUnarmed: run.allowUnarmed, continuation: true })
    if (target.entity.uniqueId !== run.entity.uniqueId || target.entity.entityType !== run.entity.entityType || target.dimension !== run.dimension) throw new Error('交戦対象の個体・種類・次元が変わったため中断します。')
    const damage = run.lastHealth - target.health
    run.lastHealth = target.health
    if (damage >= 6) throw new Error('一度に6以上の大きなダメージを確認したため交戦を中断します。')
    otherThreats(target.entity.runtimeId)
    if (run.allowUnarmed) {
      const state = getState(); const threats = evaluateThreats(state, threatActors(state), { observationRadius: 32 })
      if (target.hand !== run.hand || target.scope !== run.scope || threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length || threats.threats.some(actor => actor.runtimeId !== run.entity.runtimeId)) throw new Error('空手交戦中の主手・接続・敵の観測が変わりました。')
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.onGround === false || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) {
        run.airborneSince ??= now()
        if (now() - run.airborneSince > 1000) throw new Error('空手交戦中の着地を時間内に確認できません。')
      } else run.airborneSince = null
    }
    return target
  }
  function result (phase, entity, reaction = null, purpose = 'defense') {
    return { phase, targetRuntimeId: entity.runtimeId, targetName: entity.entityType, reaction, botCausedDamage: null, attribution: 'unconfirmed', ...(purpose === 'hunt' ? { purpose: 'food', collected: false } : {}) }
  }
  function resolveReaction (reaction) {
    if (!pending) return
    const attempt = pending
    pending = null
    clearTimeout(attempt.timer)
    const observed = result('observed', attempt.entity, reaction, attempt.purpose)
    attempt.resolve(observed)
  }
  function cancel (reason = '自衛操作を停止しました。', code = 'cancelled') {
    epoch++
    if (engagement && !engagement.terminal && !engagement.cancelReason) { engagement.cancelReason = String(reason); engagement.code = code; engagement.controller.abort() }
    activeInput?.stop()
    if (pending) {
      const attempt = pending
      pending = null
      clearTimeout(attempt.timer)
      attempt.reject(new Error(reason))
    }
    if (busy || defending || engagement) lastResult = { phase: 'stopped', reason, recommendation: 'avoid' }
  }
  async function attackOnce (runtimeId, { internal = false, deadline = Infinity, purpose = 'defense', signal, allowDistantRanged = false, allowDistantZombie = false, allowGuardedGroup = false, allowCritical = false, allowEmergencyCreeper = false } = {}) {
    if (busy || (defending || engagement) && !internal) throw new Error('前の自衛操作が終了するまで待ってください。')
    if (now() - lastAttackAt < (purpose === 'engage' ? engagementInterval(engagement?.allowUnarmed === true) : cooldownMs)) throw new Error('連打を避けるため次の攻撃まで待ってください。')
    if (allowEmergencyCreeper && (purpose !== 'emergency' || allowDistantRanged || allowDistantZombie || allowGuardedGroup || allowCritical)) throw new Error('クリーパー自衛は単独対象のみです。')
    const original = purpose === 'engage' ? engagementTarget(engagement, 2.8) : plan(runtimeId, purpose, { maxDistance: purpose === 'water_creeper' ? 3.2 : purpose === 'emergency' && allowCritical ? 2.95 : 2.8, allowEmergencySpider: purpose === 'emergency' && (allowDistantZombie || allowGuardedGroup), allowEmergencyCreeper, allowCritical })
    const lifeScope = state => JSON.stringify([state.profile ?? null, state.realm?.id ?? null, state.dimension, state.connectionId ?? null, state.startedAt ?? null, String(state.runtimeEntityId), state.lifecycle?.deathId ?? state.deathId ?? null])
    const originalScope = lifeScope(getState())
    const secondaryIdentity = purpose === 'emergency' ? otherThreats(original.entity.runtimeId, { allowDistantRanged, allowDistantZombie, allowGuardedGroup, allowCritical }) : null
    const input = getInput()
    if (!input || typeof input.lookAt !== 'function' || typeof input.start !== 'function' || typeof input.stats !== 'function' || input.stats().running || input.stats().target) throw new Error('他の入力操作を止めてから自衛してください。')
    const generation = epoch
    busy = true
    activePurpose = purpose
    activeCritical = purpose === 'emergency' && allowCritical
    activeInput = input
    lastResult = { phase: 'turning', targetRuntimeId: original.entity.runtimeId }
    try {
      const before = input.stats()
      const inputTick = value => { try { return (typeof value === 'bigint' || typeof value === 'string' && /^\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value)) && BigInt(value) >= 0n ? BigInt(value) : null } catch { return null } }
      const beforeTick = inputTick(before.tick)
      if (!Number.isSafeInteger(before.sent) || before.sent < 0 || beforeTick === null) throw new Error('視線入力の送信数とtickを確認できません。')
      input.lookAt(original.aimPoint)
      input.start()
      // A healthy handoff cursor can be one tick ahead, so the first 50ms
      // callback may legitimately queue nothing. Wait for the actual normal
      // input receipt; never force an extra frame or alter sender limits.
      const aimEnd = Math.min(deadline, now() + 250), wallEnd = performance.now() + 250
      let target, state
      await delay(0, undefined, { signal })
      while (true) {
        if (generation !== epoch) throw new Error('自衛操作は取り消されました。')
        if (signal?.aborted) throw signal.reason ?? new Error('自衛操作を中断しました。')
        if (now() >= deadline) throw new Error('自衛の制限時間に達しました。')
        const receipt = input.stats()
        if (getInput() !== input || receipt.running !== true || receipt.target || receipt.lastError) throw new Error(receipt.lastError ?? '視線入力の送信が停止または別の操作へ変更されました。')
        target = purpose === 'engage' ? engagementTarget(engagement, 2.8) : plan(runtimeId, purpose, { maxDistance: purpose === 'water_creeper' ? 3.2 : purpose === 'emergency' && allowCritical ? 2.95 : 2.8, allowEmergencySpider: purpose === 'emergency' && (allowDistantZombie || allowGuardedGroup), allowEmergencyCreeper, allowCritical })
        state = session(purpose, { allowCritical })
        if (lifeScope(state) !== originalScope || state.lifecycle?.dead || state.spawnPending) throw new Error('視線入力中に接続・次元・プレイヤーの生存状態が変わりました。')
        if (target.entity.uniqueId !== original.entity.uniqueId || target.entity.entityType !== original.entity.entityType) throw new Error('視線入力中に対象の個体が変わりました。')
        if (target.slot !== original.slot || !isDeepStrictEqual(target.raw, original.raw)) throw new Error('視線入力中に選択スロットか実際の主手が変わりました。')
        if (target.dimension !== original.dimension || Math.hypot(state.position.x - original.origin.x, state.position.y - original.origin.y, state.position.z - original.origin.z) > 0.3) throw new Error('自分の位置が変わったため攻撃を中止しました。')
        if ((purpose === 'hunt' || purpose === 'animal' || purpose === 'water_creeper' || purpose === 'emergency' && (allowCritical || allowEmergencyCreeper)) && state.health < original.health) throw new Error('視線入力中に被ダメージを確認したため中断しました。')
        if (purpose === 'water_creeper' && target.waterParticipants !== original.waterParticipants) throw new Error('水中の緊急自衛中に敵の個体が変わりました。')
        if (purpose === 'emergency' && otherThreats(target.entity.runtimeId, { allowDistantRanged, allowDistantZombie, allowGuardedGroup, allowCritical }) !== secondaryIdentity) throw new Error('緊急自衛中に遠距離の敵の個体が変わりました。')
        const tick = inputTick(receipt.tick)
        if (!Number.isSafeInteger(receipt.sent) || receipt.sent < before.sent || tick === null) throw new Error('視線入力の送信数とtickを確認できません。')
        if (now() >= aimEnd || performance.now() >= wallEnd) throw new Error('視線を向ける入力tickの送信を確認できません。')
        if (receipt.sent > before.sent && tick > beforeTick) break
        await delay(Math.max(1, Math.min(10, wallEnd - performance.now())), undefined, { signal })
      }
      if (purpose === 'water_creeper' && (target.entity.uniqueId !== original.entity.uniqueId || target.waterParticipants !== original.waterParticipants || target.health < original.health)) throw new Error('水中の緊急自衛中に敵か体力が変わりました。')
      if (purpose === 'emergency') {
        if (target.entity.uniqueId !== original.entity.uniqueId || target.entity.entityType !== original.entity.entityType) throw new Error('緊急自衛の対象個体が変わりました。')
        if ((allowCritical || allowEmergencyCreeper) && target.health < original.health) throw new Error('緊急自衛の準備中に被ダメージを確認しました。')
        if (otherThreats(target.entity.runtimeId, { allowDistantRanged, allowDistantZombie, allowGuardedGroup, allowCritical }) !== secondaryIdentity) throw new Error('緊急自衛中に遠距離の敵の個体が変わりました。')
      }
      state = session(purpose, { allowCritical })
      if (target.dimension !== original.dimension || Math.hypot(state.position.x - original.origin.x, state.position.y - original.origin.y, state.position.z - original.origin.z) > 0.3) throw new Error('自分の位置が変わったため攻撃を中止しました。')
      if ((purpose === 'hunt' || purpose === 'animal') && (target.entity.entityType !== original.entity.entityType || target.entity.uniqueId !== original.entity.uniqueId)) throw new Error('狩りの対象の種類または個体が変わったため中止しました。')
      if ((purpose === 'hunt' || purpose === 'animal') && state.health < original.health) throw new Error('狩りの準備中に被ダメージを確認したため中断しました。')
      if (signal?.aborted) throw signal.reason ?? new Error('自衛操作を中断しました。')
      const timeout = Math.min(attackTimeoutMs, deadline - now())
      let abortPending = null
      const observed = new Promise((resolve, reject) => {
        pending = { entity: copy(target.entity), purpose, healthBefore: health.get(target.entity.runtimeId) ?? null, resolve, reject, timer: setTimeout(() => {
          if (!pending) return
          pending = null
          resolve(result('requested', target.entity, 'unconfirmed', purpose))
        }, timeout) }
        const attempt = pending
        if (signal) {
          abortPending = () => {
            if (pending !== attempt) return
            pending = null; clearTimeout(attempt.timer)
            reject(signal.reason instanceof Error ? signal.reason : new Error('自衛操作を中断しました。'))
          }
          signal.addEventListener('abort', abortPending, { once: true })
        }
      })
      const transaction = {
        legacy: { legacy_request_id: 0, legacy_transactions: null },
        transaction_type: 'item_use_on_entity',
        actions: [],
        transaction_data: { entity_runtime_id: BigInt(target.entity.runtimeId), action_type: 'attack', hotbar_slot: target.slot, hand: 'main_hand', held_item: copy(target.raw), player_pos: copy(state.position), click_pos: { x: 0, y: 0, z: 0 } }
      }
      try {
        client.queue('inventory_transaction', { transaction })
        if (purpose === 'engage' && engagement) engagement.hitsSent++
      } catch (error) {
        const attempt = pending; pending = null; clearTimeout(attempt.timer)
        attempt.reject(error)
      }
      lastAttackAt = now()
      lastResult = result('requested', target.entity, 'awaiting_server', purpose)
      let response
      try { response = await observed } finally { if (abortPending) signal.removeEventListener('abort', abortPending) }
      lastResult = response
      return copy(response)
    } catch (error) {
      lastResult = { phase: 'stopped', targetRuntimeId: original.entity.runtimeId, reason: error.message, recommendation: 'avoid' }
      throw error
    } finally {
      input.stop()
      activeInput = null
      activePurpose = null
      activeCritical = false
      busy = false
    }
  }
  async function defend ({ durationMs = 2000, maxHits = 3 } = {}) {
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 5000 || !Number.isInteger(maxHits) || maxHits < 1 || maxHits > 3) throw new Error('自衛は100〜5000ms、1〜3打以内で指定してください。')
    if (busy || defending || engagement) throw new Error('別の自衛操作が進行中です。')
    session()
    const generation = epoch
    const deadline = now() + durationMs
    const attempts = []
    let reason = 'duration_limit'
    let timedOut = false
    defending = true
    // A real timer also bounds the operation if an injected observation clock
    // stops advancing; finite game state must not create an endless defend loop.
    const timeout = setTimeout(() => {
      timedOut = true
      cancel('自衛の制限時間に達しました。')
    }, durationMs)
    try {
      while (now() < deadline && attempts.length < maxHits && generation === epoch) {
        session()
        // Broad-phase feet positions may lie beyond 2.8 while a body point is
        // in reach. The exact same 2.8 body/LOS preview remains the final gate.
        const candidates = entities.nearby(getState().position, { radius: 4, kind: 'hostile' }).filter(entity => preview(entity.runtimeId).ready)
        if (!candidates.length) { reason = 'no_reachable_hostile'; break }
        const wait = cooldownMs - (now() - lastAttackAt)
        if (wait > 0) {
          await delay(Math.min(wait, Math.max(1, deadline - now())))
          continue
        }
        attempts.push(await attackOnce(candidates[0].runtimeId, { internal: true, deadline }))
      }
      if (attempts.length >= maxHits) reason = 'hit_limit'
      if (generation !== epoch) reason = timedOut ? 'duration_limit' : 'cancelled'
    } catch (error) { reason = error.message }
    finally { clearTimeout(timeout); defending = false }
    if (timedOut) reason = 'duration_limit'
    lastResult = { phase: 'stopped', reason, attempts: copy(attempts), recommendation: 'avoid' }
    return copy(lastResult)
  }
  function engage (runtimeId, { durationMs = 6000, maxHits = 8, allowUnarmed = false, signal } = {}) {
    if (typeof allowUnarmed !== 'boolean' || !Number.isInteger(durationMs) || durationMs < 100 || durationMs > (allowUnarmed ? 30000 : 6000) || !Number.isInteger(maxHits) || maxHits < 1 || maxHits > (allowUnarmed ? 24 : 8)) return Promise.reject(new Error('継続交戦の制限時間または攻撃回数が不正です。'))
    if (busy || defending || engagement) return Promise.reject(new Error('別の自衛操作が進行中です。'))
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return Promise.reject(new Error('交戦の中断通知が不正です。'))
    if (signal?.aborted) return Promise.reject(new Error('交戦は取り消されました。'))
    let initial
    try { initial = initialEngagement(runtimeId, { allowUnarmed }) } catch (error) { return Promise.reject(error) }
    const run = { entity: copy(initial.entity), dimension: initial.dimension, allowUnarmed, hand: initial.hand, scope: initial.scope, lastHealth: initial.health, initialHealth: initial.health, deadline: now() + durationMs, durationMs, maxHits, hitsSent: 0, attempts: [], terminal: null, cancelReason: null, code: null, controller: new AbortController() }
    engagement = run
    const stop = () => cancel('交戦は中断通知により取り消されました。', 'aborted')
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const timeout = setTimeout(() => cancel('交戦の制限時間に達しました。', 'duration_limit'), durationMs)
    const task = (async () => {
      let reason = '交戦の制限時間に達しました。'
      let code = 'duration_limit'
      try {
        while (!run.cancelReason && !run.terminal && now() < run.deadline && run.hitsSent < maxHits) {
          const target = engagementTarget(run)
          const wait = engagementInterval(run.allowUnarmed) - (now() - lastAttackAt)
          if (target.distance > 2.8 || wait > 0) {
            lastResult = { phase: 'waiting', mode: 'engage', targetRuntimeId: run.entity.runtimeId, reason: target.distance > 2.8 ? '同じ相手が近接範囲へ戻るのを待っています。' : '次の攻撃まで待っています。', distance: target.distance }
            await delay(Math.min(100, Math.max(1, run.deadline - now()), wait > 0 ? wait : 100), undefined, { signal: run.controller.signal })
            continue
          }
          run.attempts.push(await attackOnce(run.entity.runtimeId, { internal: true, purpose: 'engage', deadline: run.deadline, signal: run.controller.signal }))
        }
        if (run.hitsSent >= maxHits) { reason = '交戦の攻撃回数上限に達しました。'; code = 'hit_limit' }
      } catch (error) {
        if (!run.terminal && !run.cancelReason) { reason = error.message; code = 'unsafe_observation' }
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', stop)
        run.controller.abort()
        if (engagement === run) engagement = null
      }
      if (run.cancelReason) { reason = run.cancelReason; code = run.code }
      if (run.terminal) { reason = run.terminal.reaction === 'target_removed' ? '対象が消えた通知をサーバーから確認しました。' : '対象の死亡をサーバーから確認しました。'; code = 'target_stopped_observed' }
      lastResult = { phase: run.terminal ? 'observed' : 'stopped', mode: 'engage', allowUnarmed: run.allowUnarmed, code, reason, targetRuntimeId: run.entity.runtimeId, targetName: run.entity.entityType, reaction: run.terminal?.reaction ?? null, targetStopped: !!run.terminal, targetState: run.terminal ? run.terminal.reaction === 'target_removed' ? 'removed' : 'dead' : 'unconfirmed', serverConfirmed: !!run.terminal, attempts: copy(run.attempts), hitsRequested: run.hitsSent, botCausedDamage: null, botCausedDeath: null, attribution: 'unconfirmed', healthAtStart: run.initialHealth, lastHealth: run.lastHealth, recommendation: run.terminal ? 'observe' : 'avoid' }
      return copy(lastResult)
    })()
    engagementTask = task
    void task.then(() => { if (engagementTask === task) engagementTask = null }, () => { if (engagementTask === task) engagementTask = null })
    return task
  }
  function observeTerminal (reaction) {
    const run = engagement
    if (!run || run.terminal) return
    run.terminal = { reaction }
    run.controller.abort()
  }
  function applyPacket (name, packet) {
    if (name === 'start_game' || name === 'change_dimension' || name === 'disconnect') { cancel('接続・次元が変わりました。'); health.clear(); return }
    if (busy || defending || engagement) {
      try { session(activePurpose ?? (engagement ? 'engage' : 'defense'), { allowCritical: activeCritical }) } catch (error) { cancel(error.message); return }
    }
    if (name === 'add_entity' || name === 'update_attributes') {
      const id = String(packet.runtime_id ?? packet.runtime_entity_id)
      for (const attribute of packet.attributes ?? []) {
        const value = name === 'add_entity' ? attribute.value : attribute.current
        if (attribute.name !== 'minecraft:health' || !Number.isFinite(value)) continue
        health.delete(id); health.set(id, value)
        while (health.size > 512) health.delete(health.keys().next().value)
        if (engagement?.entity.runtimeId === id && value === 0 && entities.snapshot({ kind: 'all' }).some(entity => entity.runtimeId === id && entity.uniqueId === engagement.entity.uniqueId)) observeTerminal('health_zero')
        if (pending?.entity.runtimeId === id && (value === 0 || pending.healthBefore !== null && value < pending.healthBefore)) resolveReaction(value === 0 ? 'health_zero' : 'health_decreased')
      }
    }
    if (name === 'entity_event' && pending?.entity.runtimeId === String(packet.runtime_entity_id)) {
      if (packet.event_id === 'hurt_animation' || packet.event_id === 2) resolveReaction('hurt_animation')
      if (packet.event_id === 'death_animation' || packet.event_id === 3) resolveReaction('death_animation')
    }
    if (name === 'entity_event' && engagement?.entity.runtimeId === String(packet.runtime_entity_id) && (packet.event_id === 'death_animation' || packet.event_id === 3) && entities.snapshot({ kind: 'all' }).some(entity => entity.runtimeId === engagement.entity.runtimeId && entity.uniqueId === engagement.entity.uniqueId)) observeTerminal('death_animation')
    if (name === 'remove_entity' && pending?.entity.uniqueId != null && pending.entity.uniqueId === String(packet.entity_id_self)) resolveReaction('target_removed')
    if (name === 'remove_entity' && engagement?.entity.uniqueId === String(packet.entity_id_self)) observeTerminal('target_removed')
    if (engagement && !engagement.terminal && !engagement.cancelReason) {
      try { engagementTarget(engagement) } catch (error) { cancel(error.message, 'unsafe_observation') }
    }
  }
  return { animalAttack: (runtimeId, options = {}) => attackOnce(runtimeId, { purpose: 'animal', signal: options.signal }), previewAnimal: runtimeId => previewFor(runtimeId, 'animal'), preview, previewHunt, previewEngage, previewEmergency, previewWaterCreeper, waterCreeperAttack: (runtimeId, options = {}) => attackOnce(runtimeId, { purpose: 'water_creeper', signal: options.signal }), emergencyAttack: (runtimeId, options = {}) => attackOnce(runtimeId, { purpose: 'emergency', allowDistantRanged: options.allowDistantRanged ?? false, allowDistantZombie: options.allowDistantZombie ?? false, allowGuardedGroup: options.allowGuardedGroup ?? false, allowCritical: options.allowCritical ?? false, allowEmergencyCreeper: options.allowEmergencyCreeper ?? false }), attack: runtimeId => attackOnce(runtimeId), hunt: runtimeId => attackOnce(runtimeId, { purpose: 'hunt' }), defend, engage, drain: () => engagementTask ?? Promise.resolve(), applyPacket, cancel, snapshot: () => ({ busy, defending, engaging: engagement !== null, purpose: activePurpose ?? (engagement ? 'engage' : null), engagedTargetRuntimeId: engagement?.entity.runtimeId ?? null, engagementCooldownMs, unarmedEngagementCooldownMs: engagementInterval(true), cooldownRemainingMs: Math.max(0, (engagement ? engagementInterval(engagement.allowUnarmed) : cooldownMs) - (now() - lastAttackAt)), pendingTargetRuntimeId: pending?.entity.runtimeId ?? null, lastResult: copy(lastResult) }) }
}

module.exports = { createCombat }
