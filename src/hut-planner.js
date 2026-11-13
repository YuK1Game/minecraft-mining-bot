'use strict'

// A construction proposal only. Future dirt in the timeline is not a received
// block or an inventory receipt; every executor operation needs a live preview.
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLOOR = new Set(['grass_block', 'dirt', 'stone'])
const OWN_SOIL = new Set(['dirt', 'grass_block'])
const DIRECTIONS = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const UNSAFE = /(?:water|lava|sand$|gravel$|concrete_powder|anvil|fire|cactus|magma|powder_snow|cobweb|scaffolding|_log$|_wood$|_leaves$|planks|brick|crafting_table|furnace|chest|barrel|glass|concrete|wool|_stairs|_slab|_door|_trapdoor|_fence|torch|lantern|_bed|command_block|structure_block)/
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const { pointKey: key } = require('./vec3')
const clone = value => structuredClone(value)
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000000)
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const centerOf = point => ({ x: point.x + 0.5, y: point.y, z: point.z + 0.5 })
const safe = block => block?.known === true && block.protected !== true && !block.extra?.length && !UNSAFE.test(nameOf(block))
const air = block => safe(block) && AIR.has(nameOf(block))
const solid = block => safe(block) && block.boundingBox === 'block'
const cardinal = direction => direction && Number.isInteger(direction.x) && Number.isInteger(direction.z) && Math.abs(direction.x) + Math.abs(direction.z) === 1
function freeze (value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }

function planHut (state, observations = {}, options = {}) {
  const radius = options.radius ?? 6
  if (!Number.isInteger(radius) || radius < 0 || radius > 10) return { ready: false, code: 'INVALID_RADIUS', errors: ['小屋の探索半径は0〜10の整数で指定してください。'] }
  if (state?.phase !== 'spawned' || state.dead === true || state.isDead === true || !Number.isFinite(state.health) || state.health <= 0 || !finite(state.position)) return { ready: false, code: 'PLAYER_NOT_READY', errors: ['生存・接続・現在位置を確認できません。'] }
  const memo = options.memo ?? observations.memo ?? null
  if (memo?.pendingPlacement?.requiresReconciliation === true) return { ready: false, code: 'PLACEMENT_UNCERTAIN', errors: ['未確認の設置を現物と持ち物で照合する必要があります。'] }
  const scope = memo?.scope
  if (scope && (scope.dimension !== state.dimension || scope.realmId != null && String(scope.realmId) !== String(state.realm?.id))) return { ready: false, code: 'SITE_SCOPE_CHANGED', errors: ['保存した小屋と現在のワールドが一致しません。'] }
  const indexed = new Map((observations.blocks ?? []).filter(block => integer(block?.position)).map(block => [key(block.position), block]))
  const source = typeof observations.getBlock === 'function' ? observations.getBlock : (x, y, z) => indexed.get(`${x},${y},${z}`) ?? { known: false }
  const cache = new Map()
  const read = point => { const id = key(point); if (!cache.has(id)) cache.set(id, source(point.x, point.y, point.z)); return cache.get(id) }
  const feet = { ...state.position, y: state.position.y - 1.62 }
  const ownCell = { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) }
  const origin = { position: clone(state.position), positionSource: state.positionSource ?? 'unknown', positionUpdatedAt: state.positionUpdatedAt ?? null, dimension: state.dimension ?? null, connectionId: state.connectionId ?? null, observedAt: observations.observedAt ?? null }
  // Drops and dead actors do not have a living collision body. Apply this
  // classification before checking positions so unknown item/corpse positions
  // cannot prevent revalidating an otherwise received, intact hut.
  const actors = [...(observations.players ?? []), ...(observations.entities ?? []), ...(state.players ?? [])].filter(actor => actor && actor.kind !== 'item' && actor.entityType !== 'minecraft:item' && actor.alive !== false && !actor.dead && actor.isDead !== true && actor.health !== 0 && (state.runtimeEntityId == null || String(actor.runtimeId ?? actor.runtimeEntityId) !== String(state.runtimeEntityId)) && (actor.dimension == null || actor.dimension === state.dimension))
  if (actors.some(actor => !finite(actor.position) || actor.positionKnown === false)) return { ready: false, code: 'ACTOR_POSITION_UNKNOWN', errors: ['生存している可能性のある相手の位置が不明なため、小屋の衝突を確認できません。'], origin, observedAt: origin.observedAt }
  const receiptKeys = new Set((memo?.placements ?? []).filter(item => item?.serverConfirmed === true && item.item === 'minecraft:dirt' && item.count === 1 && integer(item.position) && key(memo?.pendingPlacement?.position ?? {}) !== key(item.position)).map(item => key(item.position)))
  const observed = position => { const block = read(position); return { position: clone(position), known: block?.known === true, observedName: block?.name ?? null, runtimeId: block?.runtimeId ?? null } }

  function inspect (outsideFootCell, forward, remembered = false) {
    const side = { x: -forward.z, z: forward.x }
    const center = { x: outsideFootCell.x + forward.x * 2, y: outsideFootCell.y, z: outsideFootCell.z + forward.z * 2 }
    const cell = (depth, lateral = 0, height = 0) => ({ x: center.x + forward.x * depth + side.x * lateral, y: center.y + height, z: center.z + forward.z * depth + side.z * lateral })
    const footprint = []
    for (const depth of [-1, 0, 1]) for (const lateral of [-1, 0, 1]) footprint.push(cell(depth, lateral))
    const walls = [...[-1, 0, 1].map(lateral => ({ foot: cell(1, lateral), stage: 'far_wall' })), ...[-1, 1].map(lateral => ({ foot: cell(0, lateral), stage: 'side_walls' })), { foot: cell(-1, 1), stage: 'front_corners' }, { foot: cell(-1, -1), stage: 'front_corners' }]
    const wallCells = walls.flatMap(column => [column.foot, { ...column.foot, y: center.y + 1 }])
    const temporaryPillar = [cell(0), cell(0, 0, 1)]
    const roof = cell(0, 0, 2)
    const doorCells = [cell(-1), cell(-1, 0, 1)]
    const buildCells = [...wallCells, roof, ...doorCells]
    const ownedBuildCells = [...buildCells, ...temporaryPillar]
    const plannedKeys = new Set(ownedBuildCells.map(key))
    // Grass can spread onto our dirt without invalidating its full-cube shell.
    // Its ownership still comes only from the exact confirmed dirt receipt.
    const allowedOwned = point => receiptKeys.has(key(point)) && plannedKeys.has(key(point)) && solid(read(point)) && OWN_SOIL.has(nameOf(read(point)))
    const shell = new Set(ownedBuildCells.map(key))
    const floor = footprint.map(point => ({ ...point, y: point.y - 1 }))
    for (const point of floor) {
      const block = read(point)
      if (!solid(block) || !FLOOR.has(nameOf(block)) || block.natural === false) return null
    }
    for (const foot of footprint) for (let height = 0; height < 3; height++) {
      const point = { ...foot, y: foot.y + height }
      if (!air(read(point)) && !allowedOwned(point)) return null
      if (read(point)?.natural === false && !allowedOwned(point)) return null
    }
    for (const point of ownedBuildCells) {
      for (const [x, y, z] of FACES) if (!safe(read({ x: point.x + x, y: point.y + y, z: point.z + z }))) return null
      if (actors.some(actor => Math.abs(actor.position.x - (point.x + 0.5)) < 0.8 && Math.abs(actor.position.z - (point.z + 0.5)) < 0.8 && actor.position.y > point.y - 0.2 && actor.position.y < point.y + 3.3)) return null
    }
    // Reconstruct only the proposed construction timeline. Received blocks stay
    // untouched and are reported separately as observed/alreadyPlaced fields.
    const virtual = new Map()
    for (const point of ownedBuildCells) if (allowedOwned(point)) virtual.set(key(point), { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
    const at = point => virtual.get(key(point)) ?? read(point)
    const isStandpoint = point => {
      if (!finite(point) || !Number.isInteger(point.y)) return false
      for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
        const support = at({ x, y: point.y - 1, z })
        if (!solid(support) || !FLOOR.has(nameOf(support)) || support.natural === false && !shell.has(`${x},${point.y - 1},${z}`)) return false
        for (const y of [point.y, point.y + 1]) if (!air(at({ x, y, z }))) return false
      }
      return !actors.some(actor => Math.hypot(actor.position.x - point.x, actor.position.z - point.z) < 0.9 && Math.abs(actor.position.y - (point.y + 0.9)) < 2)
    }
    const sight = (stance, point, ignored = null) => {
      const eye = { ...stance, y: stance.y + 1.62 }
      const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
      if (distance > 4.25) return false
      const steps = Math.max(1, Math.ceil(distance / 0.05))
      for (let i = 0; i < steps; i++) {
        const t = i / steps
        const p = { x: Math.floor(eye.x + (point.x - eye.x) * t), y: Math.floor(eye.y + (point.y - eye.y) * t), z: Math.floor(eye.z + (point.z - eye.z) * t) }
        if (ignored && key(p) === key(ignored)) continue
        if (!air(at(p))) return false
      }
      return true
    }
    const outside = centerOf(outsideFootCell)
    if (!isStandpoint(outside)) return null
    const groundStances = []
    for (let depth = -2; depth <= 2; depth++) for (let lateral = -2; lateral <= 2; lateral++) if (Math.abs(depth) === 2 || Math.abs(lateral) === 2 || depth === -1 && lateral === 0) groundStances.push(centerOf(cell(depth, lateral)))
    let preferred = outside
    const steps = []
    const simulatedDirt = { known: true, name: 'minecraft:dirt', boundingBox: 'block', extra: [], natural: false }
    function place (position, stage, kind, restrictedStances = null) {
      const support = { ...position, y: position.y - 1 }
      if (!air(at(position)) || !solid(at(support)) || !FLOOR.has(nameOf(at(support)))) return false
      const point = { x: position.x + 0.5, y: position.y, z: position.z + 0.5 }
      const standpoints = (restrictedStances ?? groundStances).filter(stance => isStandpoint(stance) && stance.y + 1.62 > point.y + 0.01 && !(Math.abs(stance.x - point.x) < 0.8 && Math.abs(stance.z - point.z) < 0.8 && stance.y < position.y + 1 && stance.y + 1.8 > position.y) && sight(stance, point))
      standpoints.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y, a.z - preferred.z) - Math.hypot(b.x - preferred.x, b.y - preferred.y, b.z - preferred.z) || a.x - b.x || a.z - b.z)
      if (!standpoints.length) return false
      steps.push({ type: 'place', kind, stage, position: clone(position), item: 'minecraft:dirt', count: 1, support, face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, point, standpoints, alreadyPlaced: allowedOwned(position), observed: observed(position), requiresLivePreview: true, requireServerBlockAndInventory: true })
      preferred = standpoints[0]
      virtual.set(key(position), simulatedDirt)
      return true
    }
    function move (target, stage) {
      if (!isStandpoint(target)) return false
      steps.push({ type: 'move', stage, target: clone(target), requiresLivePreview: true, requireGrounded: true })
      preferred = target
      return true
    }
    function mine (position) {
      const point = { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 }
      const standpoints = groundStances.filter(stance => isStandpoint(stance) && sight(stance, point, position))
      standpoints.sort((a, b) => Math.hypot(a.x - outside.x, a.z - outside.z) - Math.hypot(b.x - outside.x, b.z - outside.z))
      if (!standpoints.length) return false
      steps.push({ type: 'mine', kind: 'temporary_pillar', stage: 'remove_temporary_pillar', position: clone(position), item: 'minecraft:dirt', standpoints, ownReceiptRequired: true, alreadyClear: allowedOwned(roof) && air(read(position)), requiresLivePreview: true, requireReceivedAir: true })
      virtual.set(key(position), { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
      return true
    }
    // The last front upper wall remains open as a one-block staircase. With all
    // walls two blocks high there is no supported one-block route up or down.
    const deferredUpper = { ...walls[6].foot, y: center.y + 1 }
    for (const [index, column] of walls.entries()) {
      if (!place(column.foot, column.stage, 'wall')) return null
      if (index !== 6 && !place({ ...column.foot, y: center.y + 1 }, column.stage, 'wall')) return null
    }
    if (!place(temporaryPillar[0], 'temporary_pillar', 'temporary_pillar')) return null
    const climbOutside = centerOf(cell(-2, -1))
    const stair = { ...centerOf(cell(-1, -1)), y: center.y + 1 }
    const elevated = { ...centerOf(cell(0, -1)), y: center.y + 2 }
    if (!move(climbOutside, 'approach_stair') || !move(stair, 'climb_one_block') || !move(elevated, 'climb_wall')) return null
    if (!place(temporaryPillar[1], 'temporary_pillar', 'temporary_pillar', [elevated]) || !place(roof, 'roof', 'roof', [elevated])) return null
    if (!move(stair, 'descend_one_block') || !move(climbOutside, 'descend_to_ground')) return null
    if (!place(deferredUpper, 'finish_front_corner', 'wall')) return null
    if (!mine(temporaryPillar[1]) || !mine(temporaryPillar[0])) return null
    const insideStandpoint = centerOf(center)
    if (!move(outside, 'approach_entrance') || !move(centerOf(cell(-1)), 'enter_doorway') || !move(insideStandpoint, 'enter_hut')) return null
    steps.push({ type: 'wait_material', stage: 'recover_temporary_pillar', item: 'minecraft:dirt', count: 2, requireServerInventory: true, requiresActualRecovery: true })
    for (const door of doorCells) if (!place(door, 'close_entrance', 'door', [insideStandpoint])) return null
    const placements = steps.filter(step => step.type === 'place')
    const actualDirt = (state.inventory?.items ?? []).filter(item => nameOf(item) === 'dirt' && Number.isInteger(item.count) && item.count > 0).reduce((sum, item) => sum + item.count, 0)
    const inside = Math.hypot(feet.x - insideStandpoint.x, feet.z - insideStandpoint.z) <= 0.2 && Math.abs(feet.y - insideStandpoint.y) <= 1e-4
    return {
      ready: true, type: 'soil_hut', contractVersion: 1, id: `soil-hut:${key(center)}:${forward.x},${forward.z}`, origin, observedAt: origin.observedAt,
      center, forward: clone(forward), outsideFootCell: clone(outsideFootCell), outsideStandpoint: outside, insideStandpoint, innerStandpoint: insideStandpoint,
      footprint, preserved: { floor: floor.map(position => ({ ...observed(position), preserve: true, needsMining: false })) },
      walls: wallCells, wallCells, temporaryPillar, tempCells: temporaryPillar, roof, doorCells, buildCells, ownedBuildCells,
      staircase: { deferredUpper, outsideStandpoint: climbOutside, lowerStandpoint: stair, elevatedStandpoint: elevated, requiresOneBlockJumps: true },
      steps: steps.map((step, index) => ({ index, ...step })),
      stages: ['far_wall', 'side_walls', 'front_corners', 'temporary_pillar', 'climb_wall', 'roof', 'descend_to_ground', 'finish_front_corner', 'remove_temporary_pillar', 'enter_hut', 'recover_temporary_pillar', 'close_entrance'],
      materials: { name: 'minecraft:dirt', initialRequired: 17, walls: 14, roof: 1, temporaryPillar: 2, recoveredForDoor: 2, door: 2, totalPlacements: placements.length, finalPlaced: 17, requireActualInventory: true, observedDirt: actualDirt, initialAvailable: state.inventory?.known === true && actualDirt >= 17 },
      materialBudget: { initial: 17, maximumBeforeRecovery: 17, requiredRecovery: 2, final: 17, item: 'minecraft:dirt', requireServerInventory: true },
      constructionState: { inside, existingOwnedPlacements: placements.filter(step => step.alreadyPlaced).length, roofPresent: allowedOwned(roof), doorClosed: doorCells.every(allowedOwned) },
      resumed: remembered, requiresLivePreview: true, serverConfirmed: false, usable: false
    }
  }

  const site = options.site ?? memo?.site
  let plan = null
  if (site) {
    if (site.type !== 'soil_hut' || !integer(site.outsideFootCell) || !cardinal(site.forward)) return { ready: false, code: 'INVALID_SITE', errors: ['保存した小屋の位置と向きが不正です。'] }
    plan = inspect(site.outsideFootCell, site.forward, true)
    if (!plan || plan.id !== site.id) return { ready: false, code: 'SITE_CHANGED', errors: ['小屋の地形・自分が置いた土・足場を再確認できません。'] }
  } else {
    const candidates = []
    for (let x = ownCell.x - radius; x <= ownCell.x + radius; x++) for (let z = ownCell.z - radius; z <= ownCell.z + radius; z++) {
      const distance = Math.hypot(x + 0.5 - feet.x, z + 0.5 - feet.z)
      if (distance > radius + 1e-6) continue
      for (const offset of [0, 1, -1]) candidates.push({ position: { x, y: ownCell.y + offset, z }, score: distance + Math.abs(offset) * 2 })
    }
    candidates.sort((a, b) => a.score - b.score || a.position.x - b.position.x || a.position.z - b.position.z)
    for (const candidate of candidates.slice(0, 256)) {
      for (const direction of DIRECTIONS) { plan = inspect(candidate.position, direction); if (plan) break }
      if (plan) break
    }
  }
  if (!plan) return { ready: false, code: 'NO_KNOWN_FLAT_SITE', errors: ['既知の平床・空間・施工足場を備えた土小屋の場所が見つかりません。'], observedAt: origin.observedAt, origin, requiresLivePreview: true }
  const atOutside = Math.hypot(feet.x - plan.outsideStandpoint.x, feet.z - plan.outsideStandpoint.z) <= 0.25 && Math.abs(feet.y - plan.outsideStandpoint.y) <= 1e-4
  if (site || atOutside) return freeze(plan)
  return freeze({ ready: false, code: 'APPROACH_REQUIRED', candidate: plan, candidateId: plan.id, approach: { target: plan.outsideStandpoint, candidateId: plan.id, hutVerified: true, requiresLivePreview: true }, proposal: { type: 'move_to', target: plan.outsideStandpoint, resource: 'hut', requiresLivePreview: true }, origin, observedAt: origin.observedAt })
}

function createHutPlanner ({ world, getState, getEntities = () => [], clock = () => new Date().toISOString() }) {
  if (typeof world?.getBlock !== 'function' || typeof getState !== 'function' || typeof getEntities !== 'function' || typeof clock !== 'function') throw new Error('小屋計画には地形・現在位置の読取が必要です。')
  return { preview: (options = {}) => planHut(getState(), { getBlock: (x, y, z) => world.getBlock(x, y, z), entities: getEntities(), memo: options.memo, observedAt: clock() }, options) }
}

module.exports = { createHutPlanner, planHut }
