'use strict'

const EYE_HEIGHT = 1.62
const milestoneStates = new Set(['done', 'active', 'pending', 'history'])
const workStates = new Set(['preparing', 'running', 'waiting', 'stopped', 'complete'])
const names = new Map(Object.entries({
  dirt: '土', grass_block: '草ブロック', cobblestone: '丸石', stone: '石', deepslate: '深層岩', cobbled_deepslate: '深層岩の丸石', stick: '棒', crafting_table: '作業台', chest: 'チェスト', furnace: 'かまど', coal: '石炭', charcoal: '木炭', raw_iron: '鉄の原石', iron_ingot: '鉄インゴット', diamond: 'ダイヤモンド', wheat_seeds: '小麦の種', leaf_litter: '落ち葉', torch: 'たいまつ', bread: 'パン', apple: 'リンゴ', golden_apple: '金のリンゴ', cooked_beef: 'ステーキ', beef: '生の牛肉', cooked_porkchop: '焼き豚', porkchop: '生の豚肉', cooked_chicken: '焼き鳥', chicken: '生の鶏肉', cooked_mutton: '焼いた羊肉', mutton: '生の羊肉', cooked_cod: '焼き鱈', cod: '生の鱈', cooked_salmon: '焼き鮭', salmon: '生の鮭', baked_potato: 'ベイクドポテト', potato: 'ジャガイモ', carrot: 'ニンジン', sweet_berries: 'スイートベリー', rotten_flesh: '腐った肉'
}))
const woods = { oak: 'オーク', spruce: 'トウヒ', birch: 'シラカバ', jungle: 'ジャングル', acacia: 'アカシア', dark_oak: 'ダークオーク', mangrove: 'マングローブ', cherry: 'サクラ', pale_oak: 'ペールオーク' }
const materials = { wooden: '木', stone: '石', iron: '鉄', golden: '金', diamond: 'ダイヤ', netherite: 'ネザライト' }
const tools = { sword: '剣', pickaxe: 'つるはし', axe: '斧', shovel: 'シャベル', hoe: 'クワ' }
const armorNames = { helmet: 'ヘルメット', chestplate: 'チェストプレート', leggings: 'レギンス', boots: 'ブーツ' }
const serverPositionSources = new Set(['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn', 'change_dimension'])

function text (value, maximum = 240) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum) : null
}
function timestamp (value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function number (value, minimum = 0, maximum = 2048) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null
}
function point (value) {
  return value && ['x', 'y', 'z'].every(axis => number(value[axis], -30000000, 30000000) !== null) ? { x: value.x, y: value.y, z: value.z } : null
}
function itemLabel (name) {
  const local = name.replace(/^minecraft:/, '')
  if (names.has(local)) return names.get(local)
  for (const [wood, label] of Object.entries(woods)) {
    if ([`${wood}_log`, `stripped_${wood}_log`, `${wood}_wood`].includes(local)) return `${label}の原木`
    if (local === `${wood}_planks`) return `${label}の板材`
    if (local === `${wood}_sapling`) return `${label}の苗木`
  }
  for (const [material, label] of Object.entries(materials)) for (const [tool, suffix] of Object.entries(tools)) if (local === `${material}_${tool}`) return `${label}の${suffix}`
  for (const [material, label] of Object.entries({ ...materials, leather: '革', chainmail: 'チェーン', turtle: 'カメ' })) for (const [piece, suffix] of Object.entries(armorNames)) if (local === `${material}_${piece}`) return `${label}の${suffix}`
  const extras = { bow: '弓', crossbow: 'クロスボウ', arrow: '矢', shield: '盾', trident: 'トライデント', elytra: 'エリトラ', shears: 'ハサミ', fishing_rod: '釣り竿', totem_of_undying: '不死のトーテム', water_bucket: '水入りバケツ', bucket: 'バケツ', enchanted_book: 'エンチャントの本', shulker_box: 'シュルカーボックス', undyed_shulker_box: 'シュルカーボックス' }
  if (extras[local]) return extras[local]
  const colors = { white: '白色', orange: '橙色', magenta: '赤紫色', light_blue: '空色', yellow: '黄色', lime: '黄緑色', pink: '桃色', gray: '灰色', light_gray: '薄灰色', cyan: '青緑色', purple: '紫色', blue: '青色', brown: '茶色', green: '緑色', red: '赤色', black: '黒色' }
  for (const [color, label] of Object.entries(colors)) if (local === `${color}_shulker_box`) return `${label}のシュルカーボックス`
  return name === 'unknown' ? '不明なアイテム' : name
}

function inventoryItems (items, known, cached = false) {
  if (!known || !Array.isArray(items)) return []
  const combined = new Map()
  for (const item of items.slice(0, 128)) {
    if (!item || !Number.isSafeInteger(item.count) || item.count <= 0 || item.count > 65535 || item.source === 'client_prediction' || item.serverConfirmed === false) continue
    const name = text(item.name, 120) || 'unknown'
    const durable = cached || item.durabilityKnown === true
    const remaining = durable ? number(item.durabilityRemaining, 0, 1000000) : null
    const maximum = durable ? number(item.maxDurability, 1, 1000000) : null
    const durabilityRemaining = remaining !== null && (maximum === null || remaining <= maximum) ? remaining : null
    const key = JSON.stringify([name, durabilityRemaining, maximum])
    const row = combined.get(key)
    if (row) row.count = Math.min(65535, row.count + item.count)
    else combined.set(key, { name, label: itemLabel(name), count: item.count, durabilityRemaining, maxDurability: maximum })
  }
  return [...combined.values()].slice(0, 72)
}

function sanitizeMission (input) {
  if (!input || input.version !== 1) return null
  const work = input.work && typeof input.work === 'object' ? {
    title: text(input.work.title, 160), detail: text(input.work.detail, 1200),
    state: workStates.has(input.work.state) ? input.work.state : 'waiting',
    updatedAt: timestamp(input.work.updatedAt), next: text(input.work.next, 600)
  } : null
  const milestones = Array.isArray(input.milestones) ? input.milestones.slice(0, 24).filter(row => row && text(row.id, 80) && text(row.label, 160)).map(row => ({ id: text(row.id, 80), label: text(row.label, 160), status: milestoneStates.has(row.status) ? row.status : 'pending', detail: text(row.detail, 1000) })) : []
  const recentEvents = Array.isArray(input.recentEvents) ? input.recentEvents.slice(-24).filter(row => row && text(row.title, 160)).map(row => ({ at: timestamp(row.at), title: text(row.title, 160), detail: text(row.detail, 1000) })) : []
  return { version: 1, work, milestones, recentEvents }
}

// Public dashboard views are allowlists. Raw NBT, stack identities, session
// details and arbitrary runtime fields never leave the local Bot API.
const integer = (value, min = 0, max = 1000000000) => Number.isSafeInteger(value) && value >= min && value <= max ? value : null
const unknownSlot = slot => ({ slot, known: false, empty: false, name: null, count: null })

function inspectSlots (input, size, known, depth = 0) {
  const indexed = new Map()
  for (const item of Array.isArray(input) ? input.slice(0, size) : []) if (item && integer(item.slot, 0, size - 1) !== null && !indexed.has(item.slot)) indexed.set(item.slot, item)
  return Array.from({ length: size }, (_, slot) => {
    const item = indexed.get(slot)
    // Nested container nulls explicitly denote an observed empty slot.
    if (known && Array.isArray(input) && input.length === size && input[slot] === null) return { slot, known: true, empty: true, name: null, count: 0 }
    if (!known || !item || item.known !== true || item.serverConfirmed === false || item.source === 'client_prediction') return unknownSlot(slot)
    if (item.empty === true && item.count === 0) return { slot, known: true, empty: true, name: null, count: 0 }
    const count = integer(item.count, 1, 65535)
    if (count === null) return unknownSlot(slot)
    const name = text(item.name, 120)
    const maximum = integer(item.maxDurability, 1, 1000000)
    const remaining = item.durabilityKnown === true && maximum !== null ? integer(item.durabilityRemaining, 0, maximum) : null
    const row = {
      slot, known: true, empty: false, name, label: name ? itemLabel(name) : '不明なアイテム', count,
      identityKnown: name !== null && item.identityKnown !== false,
      displayName: text(item.displayName, 160), metadata: integer(item.metadata, 0, 2147483647),
      lore: (Array.isArray(item.lore) ? item.lore : []).slice(0, 8).map(line => text(line, 256)).filter(line => line !== null),
      maxStackSize: integer(item.maxStackSize, 1, 65535), durabilityApplicable: item.durabilityApplicable === true || maximum !== null,
      durabilityKnown: remaining !== null && maximum !== null, durabilityRemaining: remaining, maxDurability: maximum,
      durabilityUsed: remaining !== null && maximum !== null ? maximum - remaining : null,
      enchantmentsKnown: item.enchantmentsKnown === true,
      enchantments: (Array.isArray(item.enchantments) ? item.enchantments : []).slice(0, 32).filter(e => e && integer(e.id, 0, 65535) !== null && integer(e.level, 1, 32767) !== null).map(e => ({ id: e.id, name: text(e.name, 80), label: text(e.label, 100) ?? '不明なエンチャント', level: e.level })),
      unbreakable: typeof item.unbreakable === 'boolean' ? item.unbreakable : null, repairCost: integer(item.repairCost, 0, 2147483647)
    }
    if (depth < 1 && item.container) row.container = inspectContainer(item.container, true, depth + 1)
    if (['helmet', 'chestplate', 'leggings', 'boots'].includes(item.piece)) row.piece = item.piece
    return row
  })
}

function inspectContainer (input, parentKnown = true, depth = 1) {
  const size = integer(input?.slotCount, 1, 54) ?? 27
  const candidate = parentKnown && input?.known === true && Array.isArray(input.slots) && input.slots.length === size
  const slots = candidate ? inspectSlots(input.slots, size, true, depth) : null
  const known = !!slots && slots.every(slot => slot.known)
  return { known, slotCount: size, slots: known ? slots : null, reason: known ? null : text(input?.reason, 160) ?? 'CONTENTS_UNOBSERVED' }
}

function inventoryDetails (input, inventoryKnown) {
  const trustworthy = !!input && inventoryKnown && input.uncertain !== true
  const slots = inspectSlots(input?.slots, 36, trustworthy)
  const equipment = (value, size) => ({ known: value?.known === true, observedAt: timestamp(value?.observedAt), slots: inspectSlots(value?.slots, size, value?.known === true) })
  const armor = equipment(input?.armor, 4), offhand = equipment(input?.offhand, 1)
  armor.known = armor.known && armor.slots.every(slot => slot.known)
  offhand.known = offhand.known && offhand.slots.every(slot => slot.known)
  // Derive carried containers from the same slots; a separate summary may
  // never resurrect a box that disappeared from the observed inventory.
  const containers = slots.filter(item => item.container).map(item => ({ id: `inventory:${item.slot}`, kind: 'shulker', name: item.displayName ?? item.label, location: 'inventory', sourceSlot: item.slot, observedAt: timestamp(input?.observedAt), ...item.container }))
  const open = input?.openContainer
  const openContainer = open && ['chest', 'single_chest', 'double_chest', 'shulker', 'shulker_box', 'ender_chest', 'barrel'].includes(open.kind) ? { id: text(open.id, 80), kind: open.kind, name: text(open.name, 160), position: point(open.position), observedAt: timestamp(open.observedAt), ...inspectContainer(open) } : null
  return { known: trustworthy && slots.every(slot => slot.known), uncertain: input?.uncertain === true || !inventoryKnown, observedAt: timestamp(input?.observedAt), selectedSlot: integer(input?.selectedSlot, 0, 8), selectedSlotSource: text(input?.selectedSlotSource, 80), slotCount: 36, slots, armor, offhand, containers, openContainer }
}

function numericFields (input, fields) {
  return Object.fromEntries(fields.map(key => [key, integer(input?.[key])]))
}
const quarryStates = new Set(['STOPPING', 'IDLE', 'PREFLIGHT', 'SURVEY', 'PLAN', 'MOVE', 'MINE', 'COLLECT', 'RETURN', 'DEPOSIT', 'PORTABLE_STORAGE', 'RESTOCK', 'HAZARD', 'RECOVER', 'SUSPEND_FOR_COMBAT', 'COMBAT', 'COMBAT_SETTLE', 'RECOVER_AFTER_COMBAT', 'RECONCILE', 'FINAL_CHECK', 'EGRESS_PREPARE', 'EGRESS', 'DISCONNECTED', 'PAUSED', 'FINISHED'])
function quarryEgress (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const column = input.column && integer(input.column.x, -30000000, 30000000) !== null && integer(input.column.z, -30000000, 30000000) !== null ? { x: input.column.x, z: input.column.z } : null
  return {
    mode: ['adjacent_pillar', 'legacy_stair'].includes(input.mode) ? input.mode : null,
    phase: ['planned', 'running', 'blocked', 'completed'].includes(input.phase) ? input.phase : null,
    miningCompleted: typeof input.miningCompleted === 'boolean' ? input.miningCompleted : null,
    surfaceReturned: typeof input.surfaceReturned === 'boolean' ? input.surfaceReturned : null,
    migrationFloorY: integer(input.migrationFloorY, -2048, 2048), column,
    entry: point(input.entry), landing: point(input.landing), startFeet: point(input.startFeet), targetFeetY: integer(input.targetFeetY, -2048, 2048),
    ...numericFields(input, ['requiredDirt', 'reserveDirt', 'totalDirt', 'reservedDirt', 'dirtAvailable', 'dirtMissing', 'estimatedDirtMissing']),
    reason: text(input.reason, 160), checkpointStage: text(input.checkpointStage, 80), operationId: text(input.operationId, 160)
  }
}
function quarryState (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const result = input.result && typeof input.result === 'object' ? { type: text(input.result.type, 80), reason: text(input.result.reason, 160), at: timestamp(input.result.at) } : null
  return {
    state: quarryStates.has(input.state) ? input.state : 'UNKNOWN', jobId: text(input.jobId, 120), loaded: input.loaded !== false,
    draining: input.draining === true,
    persistence: input.persistence ? { status: ['saved', 'failed'].includes(input.persistence.status) ? input.persistence.status : 'unknown', savedAt: timestamp(input.persistence.savedAt), error: text(input.persistence.error, 300), fileSynced: input.persistence.fileSynced === true, directorySynced: input.persistence.directorySynced === true } : null,
    userRunIntent: ['running', 'paused', 'stopped', 'cancelled', 'finished'].includes(input.userRunIntent) ? input.userRunIntent : null,
    result, pauseReason: text(input.pauseReason, 240), error: text(input.error, 240),
    chunks: (Array.isArray(input.chunks) ? input.chunks : []).slice(0, 64).filter(c => c && integer(c.x, -1875000, 1875000) !== null && integer(c.z, -1875000, 1875000) !== null).map(c => ({ x: c.x, z: c.z })),
    yTop: integer(input.yTop, -2048, 2048), yBottom: integer(input.yBottom, -2048, 2048), currentY: integer(input.currentY, -2048, 2048),
    counts: input.counts ? numericFields(input.counts, ['remaining', 'unknown', 'reserved', 'deferred']) : null,
    ledger: input.ledger ? numericFields(input.ledger, ['minedBlocks', 'picked', 'loot', 'deposited', 'placedTemporary', 'placedSeal', 'reminedTemporary', 'lost', 'unaccounted', 'startInventory']) : null,
    pendingDrops: integer(input.pendingDrops), freeSlots: integer(input.freeSlots, 0, 36), deferredCount: integer(input.deferredCount),
    deaths: Array.isArray(input.deaths) ? input.deaths.slice(-1000).map(d => ({ at: timestamp(d?.at), whilePaused: d?.whilePaused === true })) : [],
    portableStorage: input.portableStorage ? { kind: text(input.portableStorage.kind, 80), stage: text(input.portableStorage.stage, 80), why: text(input.portableStorage.why, 80) } : null,
    egress: quarryEgress(input.egress),
    events: (Array.isArray(input.events) ? input.events : []).slice(-15).filter(e => e && typeof e === 'object').map(e => ({ at: timestamp(e.at), type: text(e.type, 80), state: text(e.state, 80), reason: text(e.reason, 200) }))
  }
}

function decorate (base) {
  const q = base.quarry
  const labels = { STOPPING: '作業の停止と状態保存を確認中', IDLE: '露天掘りの計画を待っています', PREFLIGHT: '開始前の確認', SURVEY: '採掘範囲を確認中', PLAN: '次の採掘を計画中', MOVE: '採掘位置へ移動中', MINE: '露天掘りを実行中', COLLECT: 'ドロップを回収中', RETURN: '搬入先へ移動中', DEPOSIT: 'アイテムを搬入中', PORTABLE_STORAGE: '携帯収納へ搬入中', RESTOCK: '道具・資材を補充中', HAZARD: '水・溶岩に対処中', RECOVER: '体力の回復を待っています', SUSPEND_FOR_COMBAT: '戦闘へ切り替え中', COMBAT: '戦闘中', COMBAT_SETTLE: '戦闘後の安全を確認中', RECOVER_AFTER_COMBAT: '採掘への復帰を確認中', RECONCILE: '保存された作業を確認中', FINAL_CHECK: '掘り残しと搬入を確認中', DISCONNECTED: '再接続を待っています', PAUSED: '露天掘りを一時停止中', FINISHED: '露天掘りのジョブが終了しました' }
  labels.EGRESS_PREPARE = '地上への脱出を準備中'
  labels.EGRESS = '土柱で地上へ移動中'
  const exitConfirmed = q?.egress?.mode !== 'adjacent_pillar' || (q.egress.miningCompleted === true && q.egress.surfaceReturned === true)
  const completed = q?.state === 'FINISHED' && ['COMPLETED', 'COMPLETED_WITH_EXCEPTIONS'].includes(q.result?.type) && exitConfirmed
  const waiting = !base.online || !q || !q.loaded || ['IDLE', 'STOPPING', 'PAUSED', 'DISCONNECTED', 'UNKNOWN'].includes(q.state)
  const title = q ? completed ? q.result.type === 'COMPLETED_WITH_EXCEPTIONS' ? '露天掘り完了（保留箇所あり）' : '露天掘り完了' : labels[q.state] ?? '露天掘りの状態を確認中' : '露天掘りの計画を待っています'
  const detail = base.stale ? '最終確認時の情報です。現在の状態は未確認です。' : (q?.persistence?.status === 'failed' ? '状態保存に失敗しています。自動再開は禁止されています。' : q?.draining && q?.state === 'PAUSED' ? '入力は停止済みです。処理と保存の完了を確認しています。' : null) ?? q?.pauseReason ?? q?.egress?.reason ?? q?.error ?? (q?.currentY != null ? `作業層 Y ${q.currentY}` : 'サーバーから確認できた情報を表示します。')
  return { ...base, goal: 'quarry', work: { title, detail, state: base.stale ? 'waiting' : completed ? 'complete' : waiting ? 'waiting' : q.state === 'FINISHED' ? 'stopped' : 'running', updatedAt: base.observedAt, next: null }, milestones: [], recentEvents: q?.events ?? [] }
}

function sanitizeStatus (raw, { observedAt = new Date().toISOString(), checkedAt = observedAt, apiAvailable = true } = {}) {
  raw = raw && typeof raw === 'object' ? raw : {}
  const health = number(raw.health)
  const inventoryKnown = raw.inventory?.known === true && !raw.inventory.uncertain && raw.inventoryConfidence?.known !== false && !raw.inventoryConfidence?.unresolved && Array.isArray(raw.inventory.items)
  const actualPhase = text(raw.phase, 64) ?? 'unknown'
  const alive = actualPhase === 'spawned' && health !== null && health > 0 && !raw.dead && !raw.isDead && !raw.lifecycle?.dead
  const source = text(raw.positionSource, 80) ?? 'unknown'
  const eye = point(raw.position)
  const position = eye ? { x: eye.x, y: eye.y - EYE_HEIGHT, z: eye.z, source, confirmed: raw.positionServerConfirmed !== false && serverPositionSources.has(source) } : null
  const hungerEntry = raw.vitals?.hunger ?? raw.food?.hunger ?? raw.hunger
  const hunger = hungerEntry?.source === 'client_prediction' ? null : number(typeof hungerEntry === 'object' ? hungerEntry?.value : hungerEntry, 0, 20)
  return decorate({ version: 1, apiAvailable: apiAvailable === true, online: apiAvailable === true && alive, stale: apiAvailable !== true, checkedAt: timestamp(checkedAt), observedAt: timestamp(observedAt), phase: apiAvailable !== true ? 'offline' : actualPhase === 'spawned' && (health === 0 || raw.dead || raw.isDead || raw.lifecycle?.dead) ? 'dead' : actualPhase, playerName: text(raw.playerName, 80), realmName: text(raw.realm?.name ?? raw.realmName, 160), health, hunger, position, inventoryKnown, inventory: inventoryItems(raw.inventory?.items, inventoryKnown), inventoryDetails: inventoryDetails(raw.inventoryDetails, inventoryKnown), quarry: quarryState(raw.quarry), connectionId: text(raw.connectionId, 80) })
}

function sanitizeCachedStatus (input, { checkedAt = new Date().toISOString(), apiAvailable = false } = {}) {
  if (!input || input.version !== 1 || !timestamp(input.observedAt)) return null
  const inventoryKnown = input.inventoryKnown === true && Array.isArray(input.inventory)
  const cachedPosition = point(input.position)
  return decorate({ version: 1, apiAvailable: apiAvailable === true, online: apiAvailable === true && input.online === true, stale: apiAvailable !== true, checkedAt: timestamp(checkedAt), observedAt: timestamp(input.observedAt), phase: apiAvailable === true ? text(input.phase, 64) ?? 'unknown' : 'offline', playerName: text(input.playerName, 80), realmName: text(input.realmName, 160), health: number(input.health), hunger: number(input.hunger, 0, 20), position: cachedPosition ? { ...cachedPosition, source: text(input.position.source, 80) ?? 'unknown', confirmed: input.position.confirmed === true } : null, inventoryKnown, inventory: inventoryItems(input.inventory, inventoryKnown, true), inventoryDetails: inventoryDetails(input.inventoryDetails, inventoryKnown), quarry: quarryState(input.quarry), connectionId: text(input.connectionId, 80) })
}

module.exports = { sanitizeStatus, sanitizeCachedStatus, sanitizeMission, itemLabel }
