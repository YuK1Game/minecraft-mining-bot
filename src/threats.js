'use strict'

const { terrainOcclusionApplies } = require('./terrain-threats')
const { knownUnreachable, MELEE_REACH } = require('./threat-reachability')

// These are avoidance-policy radii, not claims about an entity's current target
// or guaranteed projectile limits. Values deliberately include observation and
// retreat margins. Behaviour packs, equipment and difficulty can change combat.
const SOURCE = 'https://raw.githubusercontent.com/Mojang/bedrock-samples/main/behavior_pack/entities/'
const profile = (radius, severity, category, file, basis) => Object.freeze({ radius, severity, category, evidenceUrl: `${SOURCE}${file}.json`, basis })
const MELEE = profile(12, 2, 'melee', 'zombie', '近接回避用の12ブロック方針。zombieの索敵within_radius=25/max_dist=35とは別の値。')
const SKELETON = profile(24, 3, 'ranged', 'skeleton', 'サンプルの遠隔attack_range.max=15に観測・退避の余裕9を加えた方針。')
const POLICIES = new Map()
// Explicit early-learning decision thresholds. These accept actual exposure
// and possible deaths; they are NOT vanilla attack ranges or safe distances.
const LEARNING_MELEE = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider'].map(type => `minecraft:${type}`))
const LEARNING_RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'drowned'].map(type => `minecraft:${type}`))
// Skeleton-family archers retain the existing 18-block ranged policy (sample
// attack range 15 plus 3 for observation/retreat), including while learning.
const LEARNING_ARCHER = new Set(['skeleton', 'stray', 'bogged'].map(type => `minecraft:${type}`))
for (const type of [
  'zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'wither_skeleton',
  'spider', 'cave_spider', 'slime', 'magma_cube', 'silverfish', 'endermite',
  'vindicator', 'ravager', 'vex', 'piglin_brute', 'hoglin', 'zoglin', 'creaking'
]) POLICIES.set(`minecraft:${type}`, MELEE)
for (const type of ['skeleton', 'stray', 'bogged']) POLICIES.set(`minecraft:${type}`, SKELETON)
POLICIES.set('minecraft:creeper', profile(8, 5, 'explosive', 'creeper', 'swell開始2.5/停止6に対して、停止距離の外側へ余裕2を取る方針。'))
POLICIES.set('minecraft:witch', profile(20, 3, 'ranged', 'witch', 'サンプルのattack_radius=10に退避の余裕10を加えた方針。'))
POLICIES.set('minecraft:pillager', profile(24, 3, 'ranged', 'pillager', 'attack_radius=8、索敵within_radius=16を踏まえ余裕8を取る方針。'))
POLICIES.set('minecraft:drowned', profile(24, 3, 'ranged_possible', 'drowned', '低体力・標準設定では標的選択max_dist=20に余裕4を取る保守的方針。通常の射撃開始range上限は10。武器の有無は推測しない。'))
POLICIES.set('minecraft:breeze', profile(32, 3, 'ranged', 'breeze', 'attack_range.max=16、target within_radius=24に余裕8を取る方針。'))
POLICIES.set('minecraft:blaze', profile(56, 3, 'ranged', 'blaze', 'サンプルのattack_range.max=48に余裕8を取る方針。'))
POLICIES.set('minecraft:ghast', profile(72, 4, 'ranged', 'ghast', 'サンプルのattack_radius=64に余裕8を取る方針。'))
POLICIES.set('minecraft:guardian', profile(16, 3, 'ranged', 'guardian', 'サンプルのtarget max_dist=8に余裕8を取る方針。'))
POLICIES.set('minecraft:elder_guardian', profile(24, 4, 'ranged', 'guardian', 'guardian系の保守的回避方針。エルダー固有効果の上限距離を表す値ではない。'))
POLICIES.set('minecraft:evocation_illager', profile(28, 4, 'ranged', 'evocation_illager', 'サンプルのtarget max_dist=20に余裕8を取る方針。'))
POLICIES.set('minecraft:phantom', profile(32, 3, 'flying', 'phantom', '索敵within_radius/max_dist=64の飛行モブに対する近傍退避方針。索敵範囲全体ではない。'))
for (const type of ['warden', 'wither', 'ender_dragon']) POLICIES.set(`minecraft:${type}`, profile(32, 5, 'boss', type, '未装備Botは交戦せず、観測時に退避する32ブロック方針。全攻撃の上限距離ではない。'))

const finitePosition = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
const dimensionName = value => ['overworld', 'nether', 'end'][value] ?? value ?? null
function identifier (entity) {
  const value = typeof entity === 'string' ? entity : entity?.entityType ?? entity?.entity_type ?? entity?.identifier ?? entity?.type ?? entity?.name
  if (typeof value !== 'string' || !value.trim()) return null
  return value.includes(':') ? value.trim() : `minecraft:${value.trim()}`
}
function nonCombatRole (entity, type) {
  if (entity?.kind === 'player' || type === 'minecraft:player' || typeof entity?.username === 'string') return 'player'
  if (entity?.kind === 'npc' || entity?.isNpc === true || type === 'minecraft:npc') return 'npc'
  if (entity?.kind === 'item' || type === 'minecraft:item') return 'item'
  return null
}
function selectedPolicy (entity) {
  const type = identifier(entity)
  if (nonCombatRole(entity, type)) return null
  const base = POLICIES.get(type)
  if (!base) return null
  if (type === 'minecraft:creeper') {
    const event = entity?.lastEvent?.event
    if (entity?.charged === true || entity?.isCharged === true) return { ...base, radius: 16, basis: `${base.basis} 帯電を明示的に観測したため16へ拡張（サンプルexplode powerは通常3/帯電6）。` }
    if (entity?.primed === true || entity?.exploding === true || entity?.primed !== false && (event === 'creeper_prime_fuse' || event === 32)) return { ...base, radius: 12, basis: `${base.basis} 起爆準備を観測したため12へ拡張。` }
  }
  return base
}
function threatRadius (entity) { return selectedPolicy(entity)?.radius ?? null }
function safeId (value) {
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === 'string' && /^-?\d+$/.test(value) ? value : null
}

function evaluateThreats (state, entities, { extraMargin = 0, observationRadius = null, maxEntities = 1024, now = Date.now, maxTerrainAgeMs = 1500 } = {}) {
  if (!Number.isFinite(extraMargin) || extraMargin < 0 || extraMargin > 16 || !Number.isInteger(maxEntities) || maxEntities < 1 || maxEntities > 4096) throw new Error('危険評価の余裕距離・観測上限が不正です。')
  if (typeof now !== 'function' || !Number.isFinite(maxTerrainAgeMs) || maxTerrainAgeMs < 0 || maxTerrainAgeMs > 3000) throw new Error('地形遮蔽の観測時刻・有効期限が不正です。')
  if (observationRadius !== null && (!Number.isFinite(observationRadius) || observationRadius <= 0 || observationRadius > 256)) throw new Error('観測距離は0より大きい256以下の値で指定してください。')
  const ownPosition = finitePosition(state?.position) ? state.position : null
  const inputKnown = Array.isArray(entities)
  const values = inputKnown ? entities.slice(0, maxEntities) : []
  const threats = []
  const outsideDanger = []
  const suppressedByTerrain = []
  const unreachable = []
  const unclassified = []
  const unknownPositions = []
  const ignored = []
  const coverageWarnings = []
  const ownId = safeId(state?.runtimeEntityId)
  for (const entity of values) {
    const type = identifier(entity)
    const runtimeId = safeId(entity?.runtimeId ?? entity?.runtimeEntityId ?? entity?.entityId ?? entity?.id)
    const role = nonCombatRole(entity, type)
    const point = finitePosition(entity?.position) && entity?.positionKnown !== false ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null
    const measured = ownPosition && point ? Math.hypot(point.x - ownPosition.x, point.y - ownPosition.y, point.z - ownPosition.z) : null
    const observed = { entityId: runtimeId, runtimeId, name: type, kind: role ?? entity?.kind ?? 'entity', position: point, positionKnown: point !== null, distance: Number.isFinite(measured) ? measured : null }
    if (runtimeId !== null && runtimeId === ownId) { ignored.push({ ...observed, reason: 'self' }); continue }
    if (entity?.alive === false || entity?.dead === true || entity?.health === 0) { ignored.push({ ...observed, reason: 'dead' }); continue }
    if (state?.dimension != null && entity?.dimension != null && dimensionName(state.dimension) !== dimensionName(entity.dimension)) { ignored.push({ ...observed, reason: 'different_dimension' }); continue }
    const policy = selectedPolicy(entity)
    if (!policy) {
      const entry = { ...observed, classification: role ?? 'unclassified', dangerous: null, dangerRadius: null, score: null, reason: role ? 'プレイヤー・NPC・アイテムを敵だとは断定しません。' : '明示した既知敵一覧にないため敵・安全のどちらとも断定しません。' }
      unclassified.push(entry)
      if (!point) unknownPositions.push({ ...entry, reason: 'actorの位置が不明なため近接関係を評価できません。敵や安全のどちらとも断定しません。' })
      continue
    }
    const learningOnline = state?.threatPolicy === 'online_learning' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead
    const healthyMining = learningOnline || state?.threatPolicy === 'balanced_mining' && Number.isFinite(state.health) && state.health >= 14
    const rangedEscapeHealth = learningOnline || state?.threatPolicy === 'balanced_mining' && Number.isFinite(state.health) && state.health >= 12
    const balancedRadius = learningOnline && type === 'minecraft:witch' ? 14 : healthyMining && type === 'minecraft:drowned' ? 14 : rangedEscapeHealth && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(type) ? 18 : null
    const legacyRadius = (balancedRadius ?? policy.radius) + extraMargin
    const learningRadius = learningOnline ? LEARNING_ARCHER.has(type) ? 18 : LEARNING_MELEE.has(type) ? 5 : LEARNING_RANGED.has(type) ? 10 : null : null
    const radius = (learningRadius ?? balancedRadius ?? policy.radius) + extraMargin
    const acceptedRisk = learningRadius !== null && radius < legacyRadius
    const riskMetadata = acceptedRisk ? { riskAccepted: true, legacyRadius } : {}
    if (observationRadius !== null && radius > observationRadius) coverageWarnings.push({ runtimeId, name: type, observationRadius, dangerRadius: radius, reason: 'この種類の回避方針は現在の観測距離より広いため、未観測領域の安全を確認できません。' })
    if (!ownPosition || !point || observed.distance === null) {
      unknownPositions.push({ ...observed, classification: 'known_hostile', hostile: true, dangerous: null, dangerRadius: radius, ...riskMetadata, score: null, reason: !ownPosition ? 'Botの位置が不明なため敵との距離を評価できません。' : '既知敵の位置が不明です。遠い・安全とは判断できません。' })
      continue
    }
    const primed = type === 'minecraft:creeper' && policy.radius >= 12
    const proximity = Math.max(0, 1 - observed.distance / radius)
    const score = Math.round((proximity * 70 + policy.severity * 10 + (observed.distance <= 4 ? 20 : 0) + (primed ? 40 : 0)) * 100) / 100
    const balancedBasis = learningOnline
      ? type === 'minecraft:drowned' ? '接続維持・通常リスポーンで学習する方針。射撃開始range10に余裕4を取る14ブロックを生存中は維持し、武器不明でも遠隔攻撃を想定する。' : type === 'minecraft:witch' ? '接続維持・通常リスポーンで学習する方針。通常attack_radius10に余裕4を取る14ブロックを生存中は維持する。' : '接続維持・通常リスポーンで学習する方針。通常遠隔attack range15に余裕3を取る18ブロックを生存中は維持する。'
      : type === 'minecraft:drowned' ? '体力14以上ではv1.26.60.5の射撃開始range10に余裕4を取る14ブロック方針。標的選択距離20と区別し、武器不明でも遠隔攻撃を想定する。' : '体力12以上では通常遠隔attack range15に余裕3を取る18ブロック方針。体力低下時は24へ戻す。'
    const learningBasis = acceptedRisk ? `通常プレイを続ける初期学習の許容リスクとして、退避判断を従来${legacyRadius - extraMargin}から${learningRadius}ブロックへ変更。実際の攻撃・索敵範囲ではなく、${learningRadius}ブロックを超えても${LEARNING_RANGED.has(type) ? '矢・投射物や' : ''}追跡・被弾があり得る。位置不明や実際の被ダメージ、UID・地形・操作所有権の検証は緩和しない。` : null
    const entry = { ...observed, classification: 'known_hostile', hostile: true, dangerous: observed.distance <= radius, dangerRadius: radius, ...riskMetadata, category: policy.category, score: observed.distance <= radius ? score : 0, reason: `${type}を${observed.distance.toFixed(2)}ブロックで観測。${acceptedRisk ? '許容リスクの退避判断' : '回避方針'}${radius}ブロック${observed.distance <= radius ? '以内のため作業より退避を優先します。' : 'の外側ですが、追跡や飛来物がない保証ではありません。'}`, policyBasis: learningBasis ?? (balancedRadius != null ? balancedBasis : policy.basis), evidenceUrl: type === 'minecraft:drowned' ? 'https://raw.githubusercontent.com/Mojang/bedrock-samples/15701fa9c13923f12662984c32c124327e40e3d3/behavior_pack/entities/drowned.json' : policy.evidenceUrl }
    if (entry.dangerous && terrainOcclusionApplies(state, entity, { now, maxAgeMs: maxTerrainAgeMs })) {
      suppressedByTerrain.push({ ...entry, dangerous: false, score: 0, occludedNow: true, terrainOcclusion: structuredClone(entity.terrainOcclusion), reason: '大きな高度差と最新の既知地形で、全body raysに3ブロック以上の連続した通常固体を確認したため、この位置では退避開始を抑制します。接近・地形変化・時間経過のたびに再評価し、安全や将来の到達不能を保証しません。' })
    } else if (entry.dangerous && type !== 'minecraft:creeper' && observed.distance > MELEE_REACH && knownUnreachable(state, entity, now())) {
      // Creepers are never suppressed: their blast does not need a full walk
      // route, so they always keep normal danger evaluation and escape.
      // An in-radius hostile with no walk route is kept out of threats and of
      // every avoidance list (a bot inside its circle could otherwise never
      // move). Outside hostiles keep their ordinary avoidance corridor.
      unreachable.push({ ...entry, dangerous: false, score: 0, unreachableNow: true, reason: `${type}への移動ルートを現在の位置から算出できないため、戦闘・退避・回避をせず通常作業（探索）を続けます。移動・地形変化のたびに再評価します。` })
    } else if (entry.dangerous) threats.push(entry)
    else outsideDanger.push(entry)
  }
  threats.sort((a, b) => b.score - a.score || a.distance - b.distance || String(a.runtimeId).localeCompare(String(b.runtimeId)))
  outsideDanger.sort((a, b) => a.distance - b.distance || String(a.runtimeId).localeCompare(String(b.runtimeId)))
  const truncated = inputKnown && entities.length > maxEntities
  const requiresObservation = !ownPosition || !inputKnown || truncated || unknownPositions.length > 0
  return {
    threats, outsideDanger, suppressedByTerrain, unreachable, unclassified, unknownPositions, ignored,
    playerPositionKnown: ownPosition !== null, entityListKnown: inputKnown, truncated,
    evaluatedCount: values.length, requiresObservation, observationRadius, coverageWarnings,
    recommendation: threats.length ? 'avoid' : requiresObservation ? 'observe' : 'continue_observing',
    reason: threats[0]?.reason ?? (requiresObservation ? '位置や観測情報が不足しているため、安全とは判断できません。' : '観測済みの既知敵は回避方針の内側にいません。未分類・未観測領域まで安全だと保証する判断ではありません。')
  }
}

module.exports = { threatRadius, evaluateThreats }
