'use strict'

const { resourceMinHealth } = require('./learning-health')
const { selectStarterGearDrop } = require('./starter-gear')

const { planTreeAccess, placementTopVisible, planPlacementAccess } = require('./action-access')

// Pure bootstrap decisions. This module never sends packets, changes inventory,
// reads files, or treats a proposed action as completed. The executor must still
// validate its live mining/movement/crafting preview immediately before acting.
const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const WALK_THROUGH = new Set([...AIR, 'short_grass', 'fern', 'deadbush'])
const STONE = new Set(['stone', 'deepslate'])
const STONE_ITEMS = new Set(['cobblestone', 'cobbled_deepslate'])
const SOLID_SUPPORT = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite'])
const TOOL_TIERS = { wooden_pickaxe: 1, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }
const BUSY = new Set(['running', 'queued', 'mining', 'walking', 'crafting', 'opening', 'placing', 'collecting', 'awaiting_server_confirmation'])
const HAZARDS = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|dragon_egg|scaffolding)/
const NEIGHBOURS = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const nameOf = value => String(value ?? '').replace(/^minecraft:/, '')
const fullName = value => `minecraft:${nameOf(value)}`
const { pointKey: key } = require('./vec3')
const position = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
const integerPosition = value => position(value) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]))
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback
const amount = value => Number.isSafeInteger(value) && value > 0 ? value : 0
const distance = (eye, block) => Math.hypot(block.x + 0.5 - eye.x, block.y + 0.5 - eye.y, block.z + 0.5 - eye.z)
const isLog = name => name.endsWith('_log') && WOODS.has(name.slice(0, -4))
const isPlanks = name => name.endsWith('_planks') && WOODS.has(name.slice(0, -7))
const orderPosition = (a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z
const APPROACH_OFFSETS = [{ x: 0, z: 0 }, { x: 0.25, z: 0 }, { x: -0.25, z: 0 }, { x: 0, z: 0.25 }, { x: 0, z: -0.25 }, { x: 0.2, z: 0.2 }, { x: 0.2, z: -0.2 }, { x: -0.2, z: 0.2 }, { x: -0.2, z: -0.2 }]
const TREE_OFFSETS = []
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) TREE_OFFSETS.push({ x, y, z })

function naturalLogCandidates (logs, getBlock) {
  // Keep every known physical log in the component. Deleting a protected base
  // here would incorrectly promote its upper log to the next "bottom" target.
  const eligible = [...logs].sort(orderPosition)
  // Full component traversal stays bounded. Oversized components are rejected
  // as a whole, rather than accidentally treating their unvisited tail as a tree.
  if (eligible.length > 2048) return []
  const indexed = new Map(eligible.map(block => [key(block.position), block]))
  const visited = new Set()
  const natural = []
  for (const seed of eligible) {
    if (visited.has(key(seed.position))) continue
    const logName = nameOf(seed.name)
    const species = logName.slice(0, -4)
    const component = [seed]
    visited.add(key(seed.position))
    for (let index = 0; index < component.length; index++) {
      const point = component[index].position
      for (const offset of TREE_OFFSETS) {
        const neighbourKey = key({ x: point.x + offset.x, y: point.y + offset.y, z: point.z + offset.z })
        const neighbour = indexed.get(neighbourKey)
        if (!neighbour || visited.has(neighbourKey) || nameOf(neighbour.name) !== logName) continue
        visited.add(neighbourKey)
        component.push(neighbour)
      }
    }
    const stumpSoil = component.length === 1 && species === 'acacia' ? getBlock({ ...seed.position, y: seed.position.y - 1 }) : null
    const groundedStump = component.length === 1 && species === 'acacia' && seed.known === true && seed.boundingBox === 'block' && !seed.extra?.length && !seed.protectionSource && stumpSoil?.known === true && ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'].includes(nameOf(stumpSoil.name)) && stumpSoil.boundingBox === 'block' && !stumpSoil.extra?.length && stumpSoil.protected !== true && !stumpSoil.protectionSource && stumpSoil.natural !== false && (stumpSoil.shapes == null || Array.isArray(stumpSoil.shapes) && stumpSoil.shapes.some(shape => Array.isArray(shape) && shape.length === 6 && shape.every((v, i) => v === (i < 3 ? 0 : 1))))
    if (component.length < 2 && !groundedStump || component.length > 128) continue
    if (component.some(block => block.protected === true || block.natural === false)) continue
    const points = new Set(component.map(block => key(block.position)))
    const verticalTrunk = component.some(block => points.has(key({ ...block.position, y: block.position.y + 1 })))
    const top = Math.max(...component.map(block => block.position.y))
    const bottom = Math.min(...component.map(block => block.position.y))
    const span = axis => Math.max(...component.map(block => block.position[axis])) - Math.min(...component.map(block => block.position[axis]))
    if (top - bottom > 24 || span('x') > 12 || span('z') > 12) continue
    const branchedCanopy = component.length >= 4 && top - bottom >= 2 && component.some(block => TREE_OFFSETS.filter(offset => points.has(key({ x: block.position.x + offset.x, y: block.position.y + offset.y, z: block.position.z + offset.z }))).length >= 3)
    if (!verticalTrunk && !branchedCanopy && !groundedStump) continue
    let canopy = null
    for (const branch of component.filter(block => block.position.y >= top - 3).sort(orderPosition)) {
      for (let x = branch.position.x - 3; x <= branch.position.x + 3; x++) {
        for (let z = branch.position.z - 3; z <= branch.position.z + 3; z++) {
          for (let y = Math.max(top - 1, branch.position.y - 1); y <= Math.min(top + 4, branch.position.y + 4); y++) {
            const leaf = getBlock({ x, y, z })
            if (!leaf || nameOf(leaf.name) !== `${species}_leaves` || leaf.protected === true || leaf.natural === false) continue
            if (groundedStump && (leaf.known !== true || leaf.extra?.length || leaf.protectionSource || ![0, false].includes(leaf.properties?.persistent_bit))) continue
            const separation = (x - branch.position.x) ** 2 + (y - branch.position.y) ** 2 + (z - branch.position.z) ** 2
            if (!canopy || separation < canopy.separation || separation === canopy.separation && (orderPosition(leaf, canopy.leaf) < 0 || orderPosition(leaf, canopy.leaf) === 0 && orderPosition(branch, canopy.branch) < 0)) canopy = { leaf, branch, separation }
          }
        }
      }
    }
    if (!canopy) continue
    const evidence = { species, leafPosition: { ...canopy.leaf.position }, trunkTop: top, componentBottom: bottom, componentSize: component.length, componentLogPositions: [...component].sort(orderPosition).map(log => ({ ...log.position })), canopyBranchPosition: { ...canopy.branch.position }, structure: verticalTrunk ? 'vertical_trunk' : groundedStump ? 'grounded_canopy_remnant' : 'branched_canopy', ...(groundedStump ? { groundSupportPosition: { ...seed.position, y: seed.position.y - 1 }, nonPersistentCanopy: true } : {}), detection: 'connected_logs', harvestOrder: 'bottom_up' }
    // Canopy evidence still uses the entire graph, but harvesting starts only
    // at the lowest remaining layer so drops cannot land on intact lower logs.
    for (const log of component) if (log.position.y === bottom) natural.push({ ...log, evidence })
  }
  return natural
}

const CAPABILITIES = {
  break_block: ['break_block', 'mining', 'dig'],
  move: ['move', 'movement', 'walking'],
  scan_blocks: ['scan_blocks', 'scan', 'world_scan'],
  craft: ['craft', 'crafting'],
  place_block: ['place_block', 'placement', 'place'],
  use_table: ['use_table', 'interaction', 'interactions'],
  equip: ['equip', 'equipment', 'inventory_operations'],
  collect_drops: ['collect_drops', 'pickup', 'collection']
}

function inventoryCounts (items) {
  const counts = { logs: 0, planks: 0, sticks: 0, craftingTables: 0, stone: 0 }
  for (const item of items) {
    const name = nameOf(item.name)
    const count = amount(item.count)
    if (isLog(name)) counts.logs += count
    if (isPlanks(name)) counts.planks += count
    if (name === 'stick') counts.sticks += count
    if (name === 'crafting_table') counts.craftingTables += count
    if (STONE_ITEMS.has(name)) counts.stone += count
  }
  return counts
}

function nextBootstrapAction (snapshot, observations = {}, options = {}) {
  snapshot = snapshot ?? {}
  const goal = { logs: 0, stone: positive(options.stoneCount, 16) }
  const items = Array.isArray(snapshot.inventory?.items) ? snapshot.inventory.items : []
  const counts = inventoryCounts(items)
  const progress = observations.progress ?? {}
  const excludedResources = Array.isArray(progress.excludedResources) ? progress.excludedResources : []
  const excludedDropIds = new Set((Array.isArray(progress.excludedDropIds) ? progress.excludedDropIds : []).map(String))
  const excludedResource = (block, resource) => excludedResources.some(entry => {
    if (typeof entry === 'string') return entry === key(block.position) || entry === `${resource}:${key(block.position)}`
    const point = entry?.position ?? entry?.target ?? entry
    return integerPosition(point) && (entry.resource == null || entry.resource === resource) && key(point) === key(block.position)
  })
  const result = (type, stage, reason, data = {}) => ({ type, stage, reason, goal: { ...goal }, counts: { ...counts }, ...data })
  const capability = name => {
    const aliases = CAPABILITIES[name] ?? [name]
    for (const source of [observations.capabilities, snapshot.capabilities]) {
      for (const alias of aliases) {
        if (source && Object.hasOwn(source, alias)) return source[alias] === true || source[alias]?.available === true
      }
    }
    if (name === 'craft') return observations.crafting?.available === true
    if (name === 'scan_blocks') return observations.canScan === true
    return false
  }
  const requireCapability = (name, action) => capability(name) ? action : result('capability_required', action.stage, `次の工程には未実装の機能が必要です: ${name}`, { capability: name, proposedAction: action })

  if (Number.isFinite(snapshot.health) && snapshot.health <= resourceMinHealth(snapshot, options.minHealth ?? 6)) return result('stop', 'safety', '体力が少ないため作業を停止します。', { code: 'low_health' })
  if (snapshot.phase !== 'spawned') return result('wait', 'connection', 'ワールドへの参加完了を待ちます。', { code: 'not_spawned' })
  if (snapshot.gameMode != null && snapshot.gameMode !== 'survival' && snapshot.gameMode !== 0) return result('stop', 'safety', 'この計画はサバイバル用です。', { code: 'unsupported_game_mode' })
  if (!Number.isFinite(snapshot.health)) return result('wait', 'observation', '体力の取得を待ちます。', { code: 'health_unknown' })
  if (!snapshot.inventory?.known) return result('wait', 'observation', '持ち物の一覧取得を待ちます。', { code: 'inventory_unknown' })
  const occupied = new Set(items.filter(item => amount(item.count) && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot))
  if (snapshot.inventory.full === true || occupied.size >= 36) return result('stop', 'safety', '持ち物が満杯です。', { code: 'inventory_full' })
  if (snapshot.version && snapshot.world?.version && snapshot.version !== snapshot.world.version) return result('stop', 'safety', '通信と地形データのバージョンが一致しません。', { code: 'world_version_mismatch' })
  if (observations.worldLoaded === false || snapshot.world?.initialized === false || snapshot.world?.loadedSections === 0) return result('wait', 'observation', '周囲の地形の読み込みを待ちます。', { code: 'world_not_loaded' })
  const tasks = [observations.task, snapshot.task, snapshot.mining, snapshot.walking, snapshot.crafting, observations.crafting]
  if (tasks.some(task => task?.busy === true || BUSY.has(task?.phase))) return result('wait', 'task', '進行中の処理の結果を待ちます。', { code: 'task_in_progress' })
  if (counts.stone >= goal.stone) return result('complete', 'complete', '目標の石材を持ち物で確認しました。')
  if (!position(snapshot.position)) return result('wait', 'observation', 'プレイヤー位置の取得を待ちます。', { code: 'position_unknown' })

  const blocks = Array.isArray(observations.blocks) ? observations.blocks : Array.isArray(observations.world?.blocks) ? observations.world.blocks : []
  const known = blocks.filter(block => block?.known === true && integerPosition(block.position))
  const blockMap = new Map(known.map(block => [key(block.position), block]))
  const getBlock = point => blockMap.get(key(point))
  const eye = snapshot.position
  const reach = Number.isFinite(options.reach) && options.reach > 0 && options.reach <= 4.5 ? options.reach : 4.5
  const feet = { x: Math.floor(eye.x), y: Math.floor(eye.y - 1.62 + 0.001), z: Math.floor(eye.z) }
  const scan = (resource, reason) => requireCapability('scan_blocks', result('scan_blocks', resource, reason, { resource, center: { ...feet }, rejectUnknown: true }))
  const safe = block => block.protected !== true && block.natural !== false && !block.extra?.some(extra => !AIR.has(nameOf(extra.name))) && NEIGHBOURS.every(offset => {
    const neighbour = getBlock({ x: block.position.x + offset.x, y: block.position.y + offset.y, z: block.position.z + offset.z })
    return neighbour && !HAZARDS.test(nameOf(neighbour.name)) && !neighbour.extra?.some(extra => HAZARDS.test(nameOf(extra.name)))
  })
  const lineClearFrom = (from, target) => {
    const cell = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) }
    const direction = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, target[axis] + 0.5 - from[axis]]))
    const step = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.sign(direction[axis])]))
    const delta = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, direction[axis] === 0 ? Infinity : Math.abs(1 / direction[axis])]))
    const crossing = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, direction[axis] === 0 ? Infinity : ((step[axis] > 0 ? cell[axis] + 1 : cell[axis]) - from[axis]) / direction[axis]]))
    const clearCell = point => key(point) === key(target) || AIR.has(nameOf(getBlock(point)?.name))
    // Visit every intersected voxel, including edge/corner-touching neighbours.
    // Fixed 0.1-block sampling can skip the thin intersection that appears when
    // a real player stops a few centimetres off the ideal centre point.
    for (let count = 0; count < 128; count++) {
      if (key(cell) === key(target)) return true
      if (!clearCell(cell)) return false
      const next = Math.min(crossing.x, crossing.y, crossing.z)
      if (!Number.isFinite(next) || next > 1) return false
      const axes = ['x', 'y', 'z'].filter(axis => Math.abs(crossing[axis] - next) < 1e-10)
      for (let mask = 1; mask < (1 << axes.length); mask++) {
        const touched = { ...cell }
        axes.forEach((axis, index) => { if (mask & (1 << index)) touched[axis] += step[axis] })
        if (!clearCell(touched)) return false
      }
      for (const axis of axes) { cell[axis] += step[axis]; crossing[axis] += delta[axis] }
    }
    return false
  }
  const lineClear = target => lineClearFrom(eye, target)
  const approachLimit = Number.isFinite(options.maxApproachDistance) && options.maxApproachDistance > 0 ? options.maxApproachDistance : Number.isFinite(observations.radius) && observations.radius > 0 ? observations.radius : 12
  const bodyOpen = block => block && WALK_THROUGH.has(nameOf(block.name)) && block.boundingBox !== 'block' && !block.extra?.length
  const standingClear = point => {
    for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) {
      for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
        const support = getBlock({ x, y: point.y - 1, z })
        if (!support || !SOLID_SUPPORT.has(nameOf(support.name)) || support.boundingBox === 'empty' || support.extra?.length) return false
        if (!bodyOpen(getBlock({ x, y: point.y, z })) || !bodyOpen(getBlock({ x, y: point.y + 1, z }))) return false
      }
    }
    return true
  }
  const standPoints = known.flatMap(support => {
    if (!SOLID_SUPPORT.has(nameOf(support.name)) || support.boundingBox === 'empty' || support.extra?.length) return []
    const footCell = { x: support.position.x, y: support.position.y + 1, z: support.position.z }
    if (!bodyOpen(getBlock(footCell)) || !bodyOpen(getBlock({ ...footCell, y: footCell.y + 1 }))) return []
    const target = { x: footCell.x + 0.5, y: footCell.y, z: footCell.z + 0.5 }
    const travel = Math.hypot(target.x - eye.x, target.z - eye.z)
    if (travel > approachLimit) return []
    const samples = APPROACH_OFFSETS.map(offset => ({ x: target.x + offset.x, y: target.y, z: target.z + offset.z }))
    // Preserve normal standing clearance at the intended foot position. The
    // surrounding samples test view/reach tolerance, not an extra requirement
    // for a perfectly flat 3x3 patch (which would reject ordinary forest slopes).
    if (!standingClear(target)) return []
    return [{ target, eye: { ...target, y: target.y + 1.62 }, samples: samples.map(point => ({ ...point, y: point.y + 1.62 })), cost: travel + Math.abs(target.y - feet.y) * 2 }]
  })
  // A visible high trunk is useful only if its mining stance connects to our
  // known ground. A dry platform under its crown may still be an isolated ledge.
  let connectedLogStands = null
  const logStandConnected = stand => {
    if (!connectedLogStands) {
      const cells = new Map(standPoints.map(point => [key({ x: Math.floor(point.target.x), y: point.target.y, z: Math.floor(point.target.z) }), point]))
      connectedLogStands = new Set()
      const originKey = key(feet)
      const groundedOrigin = Math.abs(eye.y - 1.62 - feet.y) <= 0.05 && standingClear({ x: eye.x, y: feet.y, z: eye.z })
      const queue = groundedOrigin && cells.has(originKey) ? [feet] : []
      if (queue.length) connectedLogStands.add(originKey)
      for (let index = 0; index < queue.length && index < 2048; index++) {
        const from = queue[index]
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
          const next = { x: from.x + dx, y: from.y + dy, z: from.z + dz }
          const id = key(next)
          if (connectedLogStands.has(id) || !cells.has(id)) continue
          const raisedFeet = Math.max(from.y, next.y)
          if (dy !== 0 && [from, next].some(cell => [raisedFeet, raisedFeet + 1].some(y => !bodyOpen(getBlock({ ...cell, y }))))) continue
          if (queue.length >= 2048) continue
          connectedLogStands.add(id)
          queue.push(next)
        }
      }
    }
    return connectedLogStands.has(key({ x: Math.floor(stand.target.x), y: stand.target.y, z: Math.floor(stand.target.z) }))
  }
  const chooseResource = (candidates, resource, count, metadata = {}) => {
    // Rejected resource positions remain in the observed tree graph: they may
    // be structural evidence connecting other, still usable log candidates.
    candidates = [...candidates].filter(block => !excludedResource(block, resource) && safe(block)).sort((a, b) => distance(eye, a.position) - distance(eye, b.position) || orderPosition(a, b))
    const reachable = candidates.find(block => distance(eye, block.position) <= reach && lineClear(block.position) && !(block.position.x === feet.x && block.position.z === feet.z && block.position.y <= feet.y))
    if (reachable) return requireCapability('break_block', result(resource === 'logs' ? 'gather_logs' : 'mine_stone', resource, resource === 'logs' ? '幹と葉を確認した木から、不足する原木を集めます。' : '必要な石材を集めます。', { target: { ...reachable.position }, block: fullName(reachable.name), count, ...metadata, requiresLivePreview: true }))
    const approaches = candidates.flatMap(block => {
      const stand = standPoints.filter(point => {
        if (resource === 'logs' && point.target.y > eye.y - 1.62 + 0.05 && !logStandConnected(point)) return false
        if (Math.hypot(point.target.x - eye.x, point.target.y - (eye.y - 1.62), point.target.z - eye.z) <= 0.4) return false
        if (distance(point.eye, block.position) > Math.max(0, reach - 0.5)) return false
        if (Math.floor(point.target.x) === block.position.x && Math.floor(point.target.z) === block.position.z && block.position.y <= point.target.y) return false
        return point.samples.every(sample => distance(sample, block.position) <= Math.max(0, reach - 0.2) && lineClearFrom(sample, block.position))
      }).sort((a, b) => a.cost - b.cost || a.target.x - b.target.x || a.target.y - b.target.y || a.target.z - b.target.z)[0]
      return stand ? [{ block, stand }] : []
    }).sort((a, b) => a.stand.cost - b.stand.cost || distance(eye, a.block.position) - distance(eye, b.block.position) || orderPosition(a.block, b.block))
    if (approaches.length) {
      const selected = approaches[0]
      return requireCapability('move', result('move_to', resource, '位置が少しずれても採取できる地面の位置へ近づきます。', { target: { ...selected.stand.target }, resourceTarget: { ...selected.block.position }, block: fullName(selected.block.name), resource, ...metadata, stance: { positionTolerance: 0.25, testedPoints: selected.stand.samples.length, centerDistance: distance(selected.stand.eye, selected.block.position), worstDistance: Math.max(...selected.stand.samples.map(point => distance(point, selected.block.position))) }, requiresLivePreview: true }))
    }
    if (resource === 'logs' && capability('break_block') && capability('move')) {
      const preparations = candidates.flatMap(block => standPoints.flatMap(stand => {
        if (stand.target.y > eye.y - 1.62 + 0.05 && !logStandConnected(stand)) return []
        if (distance(stand.eye, block.position) > reach - 0.5) return []
        const accessPreparation = planTreeAccess({ state: snapshot, observedState: observations.state, tree: block, standpoint: stand.target, getBlock, reach })
        return accessPreparation ? [{ block, stand, accessPreparation }] : []
      })).sort((a, b) => a.stand.cost - b.stand.cost || distance(eye, a.block.position) - distance(eye, b.block.position) || orderPosition(a.block, b.block))
      if (preparations.length) {
        const selected = preparations[0]
        return result('move_to', resource, '確認した自然木へ手が届く足場から、視線を遮る乾いた植物を一つだけ片付けます。', { target: { ...selected.stand.target }, resourceTarget: { ...selected.block.position }, block: fullName(selected.block.name), resource, ...metadata, accessPreparation: selected.accessPreparation, stance: { positionTolerance: 0.25, testedPoints: selected.stand.samples.length }, requiresLivePreview: true })
      }
    }
    return scan(resource, '既知の通常の地面から採取できる対象がないため、地形を追加で調べます。')
  }
  const collectDrops = (matches, stage, count) => {
    const drops = (Array.isArray(observations.drops) ? observations.drops : []).filter(drop => drop.known === true && matches(nameOf(drop.name)) && position(drop.position) && drop.protected !== true && !excludedDropIds.has(String(drop.entityId ?? drop.runtimeEntityId ?? drop.runtimeId ?? drop.id))).sort((a, b) => Math.hypot(a.position.x - eye.x, a.position.y - eye.y, a.position.z - eye.z) - Math.hypot(b.position.x - eye.x, b.position.y - eye.y, b.position.z - eye.z))
    if (!drops.length) return null
    return requireCapability('collect_drops', result('collect_drops', stage, 'すでに落ちている必要な資材を先に回収します。', { count, targets: drops.slice(0, count).map(drop => ({ entityId: drop.entityId ?? drop.runtimeEntityId ?? drop.runtimeId ?? drop.id, name: fullName(drop.name), count: amount(drop.count), position: { ...drop.position } })) }))
  }

  const tools = items.filter(item => amount(item.count) && TOOL_TIERS[nameOf(item.name)]).sort((a, b) => TOOL_TIERS[nameOf(b.name)] - TOOL_TIERS[nameOf(a.name)] || (a.slot ?? 99) - (b.slot ?? 99))
  if (tools.length) {
    const droppedStone = collectDrops(name => STONE_ITEMS.has(name), 'stone', goal.stone - counts.stone)
    if (droppedStone) return droppedStone
    const tool = tools[0]
    const equipped = nameOf(snapshot.heldItem?.name) === nameOf(tool.name) && (snapshot.heldItem?.slot == null || snapshot.heldItem.slot === tool.slot)
    if (!equipped) return requireCapability('equip', result('equip', 'tool', '持っているツルハシを選択します。', { item: fullName(tool.name), slot: tool.slot }))
    const stone = known.filter(block => STONE.has(nameOf(block.name)))
    return chooseResource(stone, 'stone', goal.stone - counts.stone)
  }

  const starterPick = options.starterGearPickup === false ? null : selectStarterGearDrop(snapshot, observations, { kind: 'pickaxe' })
  if (starterPick) return requireCapability('collect_drops', result('collect_drops', 'wooden_pickaxe', '近くで確認したツルハシを先に回収します。', { resource: 'starter_gear', count: 1, targets: [starterPick], requiresLivePreview: true, requiresServerInventory: true }))

  const nearbyTable = known.filter(block => nameOf(block.name) === 'crafting_table' && block.protected !== true && distance(eye, block.position) <= reach && block.usable !== false).sort((a, b) => distance(eye, a.position) - distance(eye, b.position) || orderPosition(a, b))[0]
  const observedTable = observations.craftingTable
  const tablePosition = observedTable?.known === true && observedTable.usable === true && integerPosition(observedTable.position) && distance(eye, observedTable.position) <= reach ? observedTable.position : nearbyTable?.position
  const tableAvailable = Boolean(tablePosition)
  const tableOwned = tableAvailable || counts.craftingTables > 0

  function craft (output, times, stage) {
    const action = result('craft', stage, `${nameOf(output)}をサーバーのレシピで作成します。`, { output: fullName(output), times, requiresLivePreview: true })
    if (!capability('craft')) return requireCapability('craft', action)
    const previews = observations.crafting?.previews
    const entries = Array.isArray(previews) ? previews : previews && typeof previews === 'object' ? Object.entries(previews).map(([name, preview]) => ({ ...preview, _outputName: name })) : []
    const preview = entries.find(entry => nameOf(entry.output?.name ?? entry.output ?? entry._outputName) === nameOf(output) && (entry.times == null || entry.times === times))
    if (!preview) return result('preview_craft', stage, '最新の持ち物とレシピでクラフト可能か確認します。', { output: fullName(output), times })
    if (preview.ready !== true) {
      if (preview.needsCraftingTable && tableAvailable) return requireCapability('use_table', result('open_crafting_table', stage, '設置済みの作業台を開きます。', { target: { ...tablePosition } }))
      if (preview.capabilityRequired) return requireCapability(preview.capabilityRequired, action)
      return result('wait', stage, 'クラフトの事前確認がまだ成立していません。', { code: 'craft_preview_not_ready', errors: Array.isArray(preview.errors) ? [...preview.errors] : [preview.reason ?? '最新のレシピ・材料の確認が必要です。'], output: fullName(output), times })
    }
    return { ...action, recipeNetworkId: preview.recipeNetworkId, expectedOutputCount: preview.output?.count }
  }

  // Work backwards from a pickaxe. Existing boards/sticks/table are progress,
  // not raw logs; consuming logs must not reset the plan to its initial stage.
  const neededPlanks = (tableOwned ? 0 : 4) + (counts.sticks >= 2 ? 0 : 2) + 3
  if (counts.planks < neededPlanks) {
    const log = items.filter(item => amount(item.count) && isLog(nameOf(item.name))).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))[0]
    if (!log) return result('wait', 'materials', '手持ちの木材が不足しています。木の採取や探索は行いません。', { code: 'wood_harvest_disabled', missingMaterials: { planks: neededPlanks - counts.planks }, woodCollectionDisabled: true })
    const times = Math.min(amount(log.count), 16, Math.ceil((neededPlanks - counts.planks) / 4))
    return craft(`${nameOf(log.name).slice(0, -4)}_planks`, times, 'planks')
  }
  if (!tableOwned) return craft('crafting_table', 1, 'crafting_table')
  if (!tableAvailable) {
    const placementGeometry = block => {
      if (!block || !AIR.has(nameOf(block.name)) || block.position.y !== feet.y || block.protected === true || block.extra?.length || distance(eye, block.position) > reach) return false
      if (Math.hypot(block.position.x + 0.5 - eye.x, block.position.z + 0.5 - eye.z) < 1.3) return false
      const below = getBlock({ ...block.position, y: block.position.y - 1 })
      return below && SOLID_SUPPORT.has(nameOf(below.name)) && below.extra?.length !== undefined && below.extra.length === 0 && safe(block)
    }
    const supplied = observations.tablePlacement
    const suppliedBlock = supplied?.ready === true && integerPosition(supplied.position) ? getBlock(supplied.position) : null
    const candidates = known.filter(placementGeometry).sort((a, b) => distance(eye, a.position) - distance(eye, b.position) || orderPosition(a, b))
    const canSee = block => placementTopVisible({ state: snapshot, target: block.position, getBlock })
    const target = placementGeometry(suppliedBlock) && canSee(suppliedBlock) ? suppliedBlock.position : candidates.find(canSee)?.position
    if (!target) {
      const access = planPlacementAccess({ state: snapshot, targets: candidates.map(block => block.position), blocks: known, getBlock })
      if (access) return requireCapability('move', result('move_to', 'crafting_table', '作業台の設置面を確認できる既知の足場へ近づきます。', { target: { ...access.standpoint }, placementTarget: { ...access.target }, placementPurpose: 'crafting_table', requiresReobservation: true, resource: 'crafting_table', allowWater: false, stance: { positionTolerance: access.positionTolerance, testedPoints: access.testedPoints }, requiresLivePreview: true }))
    }
    if (!target) return scan('crafting_table', '作業台を置ける既知の場所を探します。')
    return requireCapability('place_block', result('place_crafting_table', 'crafting_table', '持っている作業台を安全な場所へ設置します。', { target: { ...target }, item: 'minecraft:crafting_table', requiresLivePreview: true }))
  }
  if (counts.sticks < 2) return craft('stick', 1, 'sticks')
  return craft('wooden_pickaxe', 1, 'wooden_pickaxe')
}

module.exports = { nextBootstrapAction, inventoryCounts, naturalLogCandidates }
