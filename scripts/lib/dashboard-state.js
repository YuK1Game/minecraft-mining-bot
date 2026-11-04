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

function depotState (input) {
  if (!input || typeof input.enabled !== 'boolean') return null
  const policy = input.policy ?? input
  const deposited = Number.isSafeInteger(policy.deposited) && policy.deposited >= 0 && policy.deposited <= 1000000 ? policy.deposited : 0
  return { enabled: input.enabled, busy: input.busy === true, phase: text(input.phase, 64) ?? 'unknown', policyPhase: text(input.policy ? policy.phase : input.policyPhase ?? input.phase, 64), deposited, secured: input.policy ? policy.depositConfirmedForCurrentLife === true : input.secured === true, baseKnown: input.policy ? Boolean(policy.base && typeof policy.base === 'object') : input.baseKnown === true, chestKnown: input.policy ? Boolean(policy.chest && typeof policy.chest === 'object') : input.chestKnown === true, lastError: text(input.lastError, 200), resource: ['logs','stone','iron','food'].includes(input.lastIntent?.resource ?? input.resource) ? input.lastIntent?.resource ?? input.resource : null }
}
function depotDisplay (base, depot, diamondCount) {
  const phase = depot.phase
  const titles = { return_surface: 'ダイヤを地上へ持ち帰る', establish_base: '拠点を整える', ensure_chest: 'チェストを準備する', deposit_diamond: 'ダイヤをチェストへ保管', observe_storage: 'チェストを確認する', observe_inventory: '所持品を確認する', safety: '周囲の安全を確認', work: '拠点から継続作業', maintain: '装備と食料を整える' }
  const next = { return_surface: '拠点づくり', establish_base: 'チェストの準備', ensure_chest: 'ダイヤの保管', deposit_diamond: '保管を確認して継続', observe_storage: '保管を確認して継続', observe_inventory: '確認後に再判断', safety: '安全を確認して再開', work: '採集・補充を継続', maintain: '整えたら継続' }
  const secured = base.online && base.inventoryKnown && depot.secured && depot.deposited >= 1
  const work = { title: !depot.enabled ? '自動作業は停止中' : !base.online && !base.stale ? '復帰を待っています' : depot.lastError ? '作業を再確認しています' : titles[phase] ?? '次の作業を確認', detail: depot.lastError ?? (phase === 'return_surface' && base.position ? '足元 Y ' + base.position.y.toFixed(1) : ''), state: !depot.enabled ? 'stopped' : !base.online || depot.lastError || ['safety','observe_inventory','observe_storage'].includes(phase) ? 'waiting' : 'running', updatedAt: base.observedAt, next: next[phase] ?? '現在の状態から再判断' }
  const active = {return_surface:2,establish_base:3,ensure_chest:4,deposit_diamond:5,observe_storage:5,work:6,maintain:6}[phase]
  const rows = [
    {id:'prepare',label:'準備',status:base.online?'done':'history'},
    {id:'diamond',label:'ダイヤ',status:base.inventoryKnown&&diamondCount>=1||secured?'done':depot.deposited>0?'history':'pending'},
    {id:'return',label:'帰還',status:depot.baseKnown?'history':'pending'},
    {id:'base',label:'拠点',status:depot.baseKnown?'history':'pending'},
    {id:'chest',label:'チェスト',status:secured?'done':depot.chestKnown?'history':'pending'},
    {id:'deposit',label:'保管',status:secured?'done':depot.deposited>0?'history':'pending'},
    {id:'continuous',label:'継続',status:'pending'}
  ]
  if (depot.enabled && base.online && Number.isInteger(active) && (active !== 6 || secured)) rows[active].status = 'active'
  if (base.stale || !base.online) for (const row of rows) if (row.status === 'done' || row.status === 'active') row.status = 'history'
  return {work,milestones:rows}
}

function decorate (base, mission, fallbackWork = null) {
  const current = sanitizeMission(mission)
  const observation = base.stale ? '最終確認時の所持品' : 'サーバーの所持品'
  const inventory = base.inventoryKnown ? base.inventory : []
  const diamondCount = inventory.filter(row => row.name === 'minecraft:diamond').reduce((sum, row) => sum + row.count, 0)
  const work = current?.work ?? fallbackWork ?? { title: base.apiAvailable ? base.online ? 'Botの状態を確認しています' : 'Botは接続中です' : 'Botはオフラインです', detail: base.observedAt ? '最後に確認した情報を表示しています。' : 'まだ状態を確認できていません。', state: base.online ? 'running' : base.apiAvailable ? 'waiting' : 'stopped', updatedAt: base.observedAt, next: null }
  if (work.state === 'complete' && diamondCount < 1) { work.state = 'waiting'; work.detail = `${work.detail ?? ''}\nダイヤのサーバー所持確認はまだ完了していません。`.trim().slice(0, 1200) }
  const milestones = (current?.milestones ?? []).filter(row => row.id !== 'diamond')
  for (const row of milestones) {
    const tool = ['sword', 'pick', 'pickaxe'].includes(row.id) ? row.id === 'sword' ? /_sword$/ : /_pickaxe$/ : null
    if (tool && inventory.some(item => tool.test(item.name))) { row.status = 'done'; row.detail = `${observation}で確認しています。${base.stale ? '現在の所持状況は未確認です。' : ''}` }
    else if (tool && row.status === 'done' && base.inventoryKnown) { row.status = 'history'; row.detail = `${row.detail ?? ''} 作成・所持の実績です。表示中の所持品にはありません。`.trim().slice(0, 1000) }
  }
  const requestedDiamond = current?.milestones.find(row => row.id === 'diamond')
  milestones.push({ id: 'diamond', label: requestedDiamond?.label ?? 'ダイヤを1個採取', status: diamondCount >= 1 ? 'done' : 'pending', detail: diamondCount >= 1 ? `${observation}で${diamondCount}個を確認しました。${base.stale ? '過去の実確認値です。' : ''}` : base.inventoryKnown ? `${observation}にダイヤはまだありません。` : '所持品が未確認のため、達成とは判定しません。' })
  const depot = base.depotMission ? depotDisplay(base, base.depotMission, diamondCount) : null
  return { ...base, work: depot?.work ?? work, milestones: depot?.milestones ?? milestones, recentEvents: current?.recentEvents ?? [] }
}

function sanitizeStatus (raw, { observedAt = new Date().toISOString(), checkedAt = observedAt, apiAvailable = true, mission = null } = {}) {
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
  const hut = raw.hut ?? raw.shelter
  const knownHut = !!(hut?.geometryVerified && hut.serverConfirmed)
  const hutPosition = point(hut?.position ?? hut?.memo?.site?.center ?? hut?.memo?.site?.innerStandpoint)
  const base = { version: 1, apiAvailable: apiAvailable === true, online: apiAvailable === true && alive, stale: apiAvailable !== true, checkedAt: timestamp(checkedAt), observedAt: timestamp(observedAt), phase: apiAvailable !== true ? 'offline' : actualPhase === 'spawned' && (health === 0 || raw.dead || raw.isDead || raw.lifecycle?.dead) ? 'dead' : actualPhase, playerName: text(raw.playerName, 80), realmName: text(raw.realm?.name ?? raw.realmName, 160), health, hunger, position, inventoryKnown, inventory: inventoryItems(raw.inventory?.items, inventoryKnown), hut: { inside: knownHut ? hut.inside === true : null, closed: knownHut ? hut.closed === true || hut.entranceClosed === true : null, usable: knownHut ? hut.usable === true : null, known: apiAvailable === true && knownHut, position: hutPosition }, connectionId: text(raw.connectionId, 80) }
  base.depotMission = depotState(raw.depotMission)
  if (base.depotMission && !alive) base.depotMission.secured = false
  return decorate(base, mission)
}

function sanitizeCachedStatus (input, { checkedAt = new Date().toISOString(), apiAvailable = false, mission = null } = {}) {
  if (!input || input.version !== 1 || !timestamp(input.observedAt)) return null
  const inventoryKnown = input.inventoryKnown === true && Array.isArray(input.inventory)
  const cachedPosition = point(input.position)
  const cachedMission = sanitizeMission({ version: 1, work: input.work, milestones: input.milestones, recentEvents: input.recentEvents })
  const base = { version: 1, apiAvailable: apiAvailable === true, online: apiAvailable === true && input.online === true, stale: apiAvailable !== true, checkedAt: timestamp(checkedAt), observedAt: timestamp(input.observedAt), phase: apiAvailable === true ? text(input.phase, 64) ?? 'unknown' : 'offline', playerName: text(input.playerName, 80), realmName: text(input.realmName, 160), health: number(input.health), hunger: number(input.hunger, 0, 20), position: cachedPosition ? { ...cachedPosition, source: text(input.position.source, 80) ?? 'unknown', confirmed: input.position.confirmed === true } : null, inventoryKnown, inventory: inventoryItems(input.inventory, inventoryKnown, true), hut: { inside: typeof input.hut?.inside === 'boolean' ? input.hut.inside : null, closed: typeof input.hut?.closed === 'boolean' ? input.hut.closed : null, usable: typeof input.hut?.usable === 'boolean' ? input.hut.usable : null, known: apiAvailable === true && input.hut?.known === true, position: point(input.hut?.position) }, connectionId: text(input.connectionId, 80) }
  base.depotMission = depotState(input.depotMission)
  return decorate(base, mission ?? cachedMission, cachedMission?.work)
}

module.exports = { sanitizeStatus, sanitizeCachedStatus, sanitizeMission, itemLabel }
