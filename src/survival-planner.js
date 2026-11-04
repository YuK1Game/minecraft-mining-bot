'use strict'

const { resourceMinHealth } = require('./learning-health')
const { selectStarterGearDrop } = require('./starter-gear')

const { nextBootstrapAction, inventoryCounts } = require('./planner')
const { evaluateThreats } = require('./threats')
const { planStationAccess, placementTopVisible, planPlacementAccess } = require('./action-access')

const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar'])
const STONE = new Set(['cobblestone', 'cobbled_deepslate'])
const SWORDS = new Set(['stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword'])
const SUPPORT = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const HAZARD = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|fire|cactus|magma|scaffolding)/
const nameOf = value => String(value ?? '').replace(/^minecraft:/, '')
const fullName = value => `minecraft:${nameOf(value)}`
const amount = value => Number.isSafeInteger(value) && value > 0 ? value : 0
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const key = point => `${point.x},${point.y},${point.z}`
const isLog = name => name.endsWith('_log') && WOODS.has(name.slice(0, -4))
const range = (eye, block) => Math.hypot(eye.x - block.x - 0.5, eye.y - block.y - 0.5, eye.z - block.z - 0.5)
const copy = value => structuredClone(value)
const neighbours = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]

// Preparation decisions only. A finished prerequisite returns null so the real
// diamond planner still owns the material goal. Memo/preview plans never stand
// in for received blocks, consumed dirt or a sword in current server inventory.
function nextSurvivalAction (state = {}, observations = {}, options = {}) {
  const items = Array.isArray(state.inventory?.items) ? state.inventory.items : []
  const count = predicate => items.reduce((sum, item) => sum + (predicate(nameOf(item.name)) ? amount(item.count) : 0), 0)
  const inventoryKnown = state.inventory?.known === true && state.inventory.uncertain !== true && state.inventory.serverConfirmed !== false && state.inventory.source !== 'client_prediction'
  const firstWoodenSwordOnly = options.firstWoodenSwordOnly === true
  if (firstWoodenSwordOnly && inventoryKnown && items.some(item => amount(item.count) && /^(?:minecraft:)?(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))) return null
  const diamondCount = Number.isSafeInteger(options.diamondCount) && options.diamondCount > 0 ? options.diamondCount : 1
  if (inventoryKnown && count(name => name === 'diamond') >= diamondCount) return null
  const counts = { ...inventoryCounts(items), swords: count(name => SWORDS.has(name)), woodenSwords: count(name => name === 'wooden_sword'), diamond: count(name => name === 'diamond') }
  const goal = { diamond: diamondCount }
  const result = (type, stage, reason, data = {}) => ({ type, stage, reason, goal: { ...goal }, counts: { ...counts }, ...data })
  const wait = (code, reason, stage = 'survival', data = {}) => result('wait', stage, reason, { code, ...data })
  const has = (name, aliases = []) => {
    for (const source of [observations.capabilities, state.capabilities]) for (const alias of [name, ...aliases]) if (source && Object.hasOwn(source, alias)) return source[alias] === true || source[alias]?.available === true
    return name === 'craft' && observations.crafting?.available === true
  }
  const required = (name, action, aliases = []) => has(name, aliases) ? action : result('capability_required', action.stage, `この準備には未実装の機能が必要です: ${name}`, { capability: name, proposedAction: action })
  if (state.dead || state.isDead || state.lifecycle?.dead || state.health === 0) return required('respawn', result('respawn', 'safety', '死亡を確認したため、拠点準備より復帰を優先します。'))
  if (state.phase !== 'spawned') return wait('not_spawned', '参加完了を待ちます。')
  if (!Number.isFinite(state.health)) return wait('health_unknown', '体力の受信を待ちます。')
  if (state.health <= resourceMinHealth(state, options.minHealth ?? 6)) return result('stop', 'safety', '準備作業を休止し、安全判断へ戻ります。', { code: 'low_health' })
  if (state.gameMode !== 'survival' && state.gameMode !== 0) return result('stop', 'safety', '通常のサバイバル操作だけを計画します。', { code: 'unsupported_game_mode' })
  if (!inventoryKnown) return wait('inventory_unknown', 'サーバーで確定した持ち物を待ちます。')
  if (!finite(state.position)) return wait('position_unknown', '現在位置の受信を待ちます。')
  if (state.world?.initialized === false || state.world?.loadedSections === 0 || observations.worldLoaded === false) return wait('world_not_loaded', '周辺地形の観測を待ちます。')
  if (state.version && state.world?.version && state.version !== state.world.version) return result('stop', 'safety', '接続と地形の版が一致しません。', { code: 'world_version_mismatch' })
  if (state.inventory.full || new Set(items.filter(item => amount(item.count) && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot)).size >= 36) return result('stop', 'safety', '持ち物が満杯です。', { code: 'inventory_full' })
  const pending = task => task?.busy === true || task?.pendingOperation != null || task?.pendingRequestId != null || task?.running === true
  const busyPhases = new Set(['mining', 'moving', 'walking', 'settling', 'crafting', 'placing', 'opening', 'collecting', 'requesting', 'building'])
  if ([state.mining, state.movement, state.walking, state.crafting, state.interactions, state.shelter, observations.task, observations.shelter?.status].some(task => pending(task) || busyPhases.has(task?.phase))) return wait('task_in_progress', '進行中の操作が終了するまで待ちます。')

  const shelter = observations.shelter ?? {}
  const preview = shelter.preview ?? null
  const status = shelter.status ?? state.shelter ?? null
  const memo = shelter.memo ?? status?.memo ?? null
  const sameSession = value => !value || ['dimension', 'startedAt', 'connectionId'].every(field => value[field] == null || state[field] == null || value[field] === state[field])
  const verified = value => value?.usable === true && value.closed === true && value.serverConfirmed === true && sameSession(value)
  // Only current executor/preview evidence can verify a remembered site.
  const established = value => value?.established === true && (value.structureIntact === true || value.geometryVerified === true) && value.serverConfirmed === true && sameSession(value)
  const shelterReady = verified(status) || verified(preview) || established(status) || established(preview)
  // Runtime supplies the current known-body/actor proof. This explicit local
  // work mode defers optional construction; it never grants shelter or cover.
  const deferOptionalShelter = options.deferOptionalShelter === true && resourceMinHealth(state) === 0 && status?.inside !== true && preview?.inside !== true
  if (!firstWoodenSwordOnly && !deferOptionalShelter && !shelterReady) {
    if (preview?.ready === true || preview?.resumeReady === true || preview?.canResume === true) {
      return required('build_shelter', result('build_shelter', 'shelter', '確認済みの土の斜面に、実際の掘削と土の設置で避難場所を作ります。', { plan: copy(preview), site: copy(preview.site ?? preview), requiresLivePreview: true, requiresServerBlocks: true, ...(memo ? { memo: copy(memo) } : {}) }), ['shelter'])
    }
    if (preview?.code === 'APPROACH_REQUIRED' && finite(preview.approach?.target ?? preview.proposal?.target)) {
      return required('move', result('move_to', 'shelter', '確認済みの拠点候補の外側へ、安全な経路で近づきます。', { target: copy(preview.approach?.target ?? preview.proposal.target), resource: 'shelter', allowWater: false, requiresLivePreview: true, candidateId: preview.id ?? preview.approach?.candidateId }), ['movement', 'walking'])
    }
    // A restored shelter is only history until its blocks are revalidated.
    // When clearly far outside it, don't make an unloaded old site prevent
    // gathering nearby materials. Preserve its memo and require reconciliation
    // for any pending placement; this never grants shelter or protection.
    const rememberedAnchor = memo?.site?.center ?? memo?.site?.entry ?? memo?.site?.outsideStandpoint
    const farFromRememberedSite = finite(rememberedAnchor) && Math.hypot(state.position.x - rememberedAnchor.x, state.position.z - rememberedAnchor.z) > 16 && status?.inside !== true && !memo?.pendingPlacement
    if (memo?.site && sameSession(memo) && !farFromRememberedSite && preview?.code !== 'NO_KNOWN_SOIL_HILL' && preview?.code !== 'SITE_INVALID') return wait('shelter_revalidation_required', '記憶した拠点を現物で確認してから再開します。', 'shelter')
  }

  const preparedSword = items.some(item => SWORDS.has(nameOf(item.name)) && amount(item.count) && !(item.durabilityKnown === true && Number.isFinite(item.durabilityRemaining) && item.durabilityRemaining <= 0))
  const earlySword = items.some(item => nameOf(item.name) === 'wooden_sword' && amount(item.count) && !(item.durabilityKnown === true && Number.isFinite(item.durabilityRemaining) && item.durabilityRemaining <= 0))
  const confirmedShelter = verified(status) || established(status) ? status : preview
  if (!firstWoodenSwordOnly && shelterReady && confirmedShelter?.inside === true && confirmedShelter.entranceClosed === true) {
    return required('leave_shelter', result('leave_shelter', 'shelter', '外の資材を集めるため、入口の土を正規に掘って拠点から出ます。', { ...(memo ? { memo: copy(memo), site: copy(memo.site) } : {}), requiresLivePreview: true, requiresServerBlocks: true }))
  }
  if (shelterReady && preparedSword) return null

  const starterSword = selectStarterGearDrop(state, observations, { kind: 'sword' })
  if (starterSword) return required('collect_drops', result('collect_drops', 'wooden_sword', '近くで確認した剣を先に回収します。', { resource: 'starter_gear', count: 1, targets: [starterSword], requiresLivePreview: true, requiresServerInventory: true }), ['pickup', 'collection'])

  const minimumStone = Number.isSafeInteger(options.survivalStoneCount) && options.survivalStoneCount >= 2 && options.survivalStoneCount <= 16 ? options.survivalStoneCount : 5
  // Existing stone materials can make the stronger weapon immediately. Fresh
  // starts get a separate two-log wooden-sword budget before any pickaxe work.
  const earlyPreparation = firstWoodenSwordOnly || !preparedSword && !earlySword && counts.stone < minimumStone
  const preparationStage = earlyPreparation ? 'wooden_sword' : 'stone_sword'
  const wrap = (action, name) => ({ ...action, goal: { ...goal }, counts: { ...counts }, preparation: name, subgoal: { ...(action.subgoal ?? {}), name, stone: minimumStone } })
  const inactiveMotion = task => task?.phase === 'awaiting_server_confirmation' && task.running !== true && task.busy !== true
  const bootstrapState = { ...state, walking: inactiveMotion(state.walking) ? null : state.walking, movement: inactiveMotion(state.movement) ? null : state.movement }
  const bootstrap = () => nextBootstrapAction(bootstrapState, observations, { ...options, logCount: 3, stoneCount: minimumStone })
  const blocks = (Array.isArray(observations.blocks) ? observations.blocks : []).filter(block => integer(block?.position))
  const map = new Map(blocks.map(block => [key(block.position), block]))
  const known = blocks.filter(block => block.known === true)
  const scan = resource => required('scan_blocks', result('scan_blocks', resource, '準備に必要な資材や作業場所を既知の範囲で調べます。', { resource, rejectUnknown: true, center: { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) } }), ['scan', 'world_scan'])

  function table () {
    const supplied = [observations.craftingTable, observations.stations?.craftingTable, observations.stations?.table].filter(value => value?.known === true && integer(value.position))
    for (const value of [...supplied, ...known.filter(block => nameOf(block.name) === 'crafting_table')].sort((a, b) => range(state.position, a.position) - range(state.position, b.position))) {
      const current = map.get(key(value.position))
      // A location remembered from another life remains history until this
      // observation proves both the current table and usable known access.
      if (value.protected || value.usable === false || current?.known !== true || nameOf(current.name) !== 'crafting_table') continue
      const access = planStationAccess({ state, observedState: observations.state ?? state, target: value.position, blocks, getBlock: position => map.get(key(position)) })
      if (access.ready) return { ready: true, position: { ...value.position }, scope: access.scope }
      if (access.standpoint) return { ready: false, position: { ...value.position }, scope: access.scope, action: required('move', result('move_to', preparationStage, '作業台への視線と足場を確認した位置へ近づきます。', { target: copy(access.standpoint), interactionTarget: copy(value.position), interactionScope: access.scope, resource: 'crafting_table', allowWater: false, requiresLivePreview: true }), ['movement', 'walking']) }
      // An inaccessible station cannot fund the local material budget. Try
      // other observed stations, then retain the ordinary new-table plan.
    }
    return null
  }
  const station = table()
  function craft (output, times = 1) {
    const proposal = result('craft', preparationStage, `${nameOf(output)}を実際の材料と受信済みのレシピで作ります。`, { output: fullName(output), times, requiresLivePreview: true })
    if (!has('craft', ['crafting'])) return required('craft', proposal, ['crafting'])
    const entries = observations.crafting?.previews
    const previews = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? Object.entries(entries).map(([name, value]) => ({ ...value, _output: name })) : []
    const live = previews.find(value => nameOf(value.output?.name ?? value.output ?? value._output) === nameOf(output) && (value.times == null || value.times === times))
    if (!live) return result('preview_craft', preparationStage, '最新の材料と受信レシピでクラフトできるか確認します。', { output: fullName(output), times })
    if (!live.ready) {
      if (live.needsCraftingTable && station?.ready) return required('use_table', result('open_crafting_table', preparationStage, '確認済みの作業台を開いて剣を準備します。', { target: copy(station.position), interactionScope: station.scope }), ['interaction', 'interactions'])
      if (live.capabilityRequired) return required(live.capabilityRequired, proposal)
      return wait('craft_preview_not_ready', '材料やレシピの確認がまだ成立していません。', preparationStage, { output: fullName(output), times, errors: copy(live.errors ?? []) })
    }
    return { ...proposal, recipeNetworkId: live.recipeNetworkId, expectedOutputCount: live.output?.count }
  }
  function planks (needed) {
    if (counts.planks >= needed) return null
    const logs = items.filter(item => isLog(nameOf(item.name)) && amount(item.count)).sort((a, b) => a.slot - b.slot)
    if (logs.length) return craft(`${nameOf(logs[0].name).slice(0, -4)}_planks`, Math.min(logs[0].count, 16, Math.ceil((needed - counts.planks) / 4)))
    // Reuse natural-tree selection without letting existing stone/tools hide a
    // real wood shortage. This decision view does not mutate host inventory.
    const woodView = { ...bootstrapState, heldItem: null, inventory: { ...state.inventory, items: items.filter(item => !/_pickaxe$/.test(nameOf(item.name)) && !STONE.has(nameOf(item.name))) } }
    const missingLogs = Math.ceil((needed - counts.planks) / 4)
    let action = nextBootstrapAction(woodView, observations, { ...options, starterGearPickup: false, logCount: Math.max(1, missingLogs), stoneCount: 1 })
    if (action.type === 'gather_logs' || action.type === 'collect_drops' && action.resource === 'logs') action = { ...action, count: missingLogs }
    else if (action.type === 'capability_required' && action.proposedAction?.type === 'gather_logs') action = { ...action, proposedAction: { ...action.proposedAction, count: missingLogs } }
    return wrap(action, earlyPreparation ? 'wooden_sword_wood' : 'sword_wood')
  }
  function prepareTable () {
    if (station?.action) return station.action
    if (!station) {
      if (counts.craftingTables < 1) return planks(4) ?? craft('crafting_table')
      const placementGeometry = block => {
        const p = block?.position
        if (block?.known !== true || !integer(p) || !AIR.has(nameOf(block.name)) || p.y !== Math.round(state.position.y - 1.62) || block.extra?.length || block.protected || range(state.position, p) > 4 || Math.hypot(p.x + 0.5 - state.position.x, p.z + 0.5 - state.position.z) < 1.3) return false
        const below = map.get(key({ ...p, y: p.y - 1 }))
        return below?.known === true && SUPPORT.has(nameOf(below.name)) && below.boundingBox === 'block' && !below.extra?.length && neighbours.every(offset => { const neighbour = map.get(key({ x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z })); return neighbour?.known === true && !HAZARD.test(nameOf(neighbour.name)) && !neighbour.extra?.length })
      }
      const supplied = observations.tablePlacement
      const suppliedBlock = supplied?.ready === true && integer(supplied.position) ? map.get(key(supplied.position)) : null
      const candidates = known.filter(placementGeometry).sort((a, b) => range(state.position, a.position) - range(state.position, b.position))
      const canSee = block => placementTopVisible({ state, target: block.position, getBlock: position => map.get(key(position)) })
      const target = placementGeometry(suppliedBlock) && canSee(suppliedBlock) ? suppliedBlock.position : candidates.find(canSee)?.position
      if (!target) {
        const access = planPlacementAccess({ state, targets: candidates.map(block => block.position), blocks, getBlock: position => map.get(key(position)) })
        if (access) return required('move', result('move_to', preparationStage, '作業台の設置面を確認できる既知の足場へ近づきます。', { target: copy(access.standpoint), placementTarget: copy(access.target), placementPurpose: 'crafting_table', requiresReobservation: true, resource: 'crafting_table', allowWater: false, stance: { positionTolerance: access.positionTolerance, testedPoints: access.testedPoints }, requiresLivePreview: true }), ['movement', 'walking'])
      }
      return target ? required('place_block', result('place_crafting_table', preparationStage, '持っている作業台を確認済みの場所へ設置します。', { target: copy(target), item: 'minecraft:crafting_table', requiresLivePreview: true }), ['placement']) : scan('crafting_table')
    }
    return null
  }
  function woodenSwordPreparation () {
    const tableOwned = !!station || counts.craftingTables > 0
    const neededPlanks = (tableOwned ? 0 : 4) + (counts.sticks >= 1 ? 0 : 2) + 2
    if (counts.planks < neededPlanks) return planks(neededPlanks)
    const setup = prepareTable()
    if (setup) return setup
    if (counts.sticks < 1) return craft('stick')
    return craft('wooden_sword')
  }
  if (earlyPreparation) {
    const action = woodenSwordPreparation()
    return { ...action, preparation: 'wooden_sword', subgoal: { name: 'wooden_sword', requiresServerInventory: true }, goal: { ...goal }, counts: { ...counts } }
  }
  function swordPreparation () {
    if (preparedSword) return null
    if (counts.stone < minimumStone) {
      const action = bootstrap()
      if (action.type !== 'complete') return wrap(action, 'sword_bootstrap')
    }
    const setup = prepareTable()
    if (setup) return setup
    if (counts.sticks < 1) return planks(2) ?? craft('stick')
    return craft('stone_sword')
  }
  const preparation = swordPreparation()
  if (preparation) return preparation
  if (shelterReady || deferOptionalShelter) return null

  const progress = observations.progress ?? {}
  const attempts = amount(progress.shelterExplorationAttempts ?? progress.explorationAttempts)
  const limit = Number.isSafeInteger(options.maxShelterExplorations) && options.maxShelterExplorations > 0 && options.maxShelterExplorations <= 64 ? options.maxShelterExplorations : 8
  if (attempts >= limit) {
    // A missing optional shelter must not terminate an otherwise prepared
    // diamond run. The caller still applies its food/night/health safety
    // policy before this planner, and every resource action rechecks danger.
    const diamondTool = items.some(item => ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(nameOf(item.name)) && item.count === 1 && item.durabilityKnown === true && Number.isSafeInteger(item.durabilityRemaining) && item.durabilityRemaining >= 5 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
    const actors = [state.entities, observations.entities, observations.state?.entities].find(Array.isArray)
    const evaluation = evaluateThreats(state, actors, { observationRadius: 32 })
    if (options.objective === 'diamond' && state.threatPolicy === 'online_learning') {
      const life = state.lifecycle?.deathId
      const scopedLife = resourceMinHealth(state) === 0 && typeof state.profile === 'string' && !!state.profile && state.realm?.id != null && typeof state.connectionId === 'string' && !!state.connectionId && typeof state.startedAt === 'string' && !!state.startedAt && /^\d+$/.test(String(state.runtimeEntityId)) && Number.isSafeInteger(life) && life >= 0 && state.lifecycle?.phase === 'alive'
      if (scopedLife) {
        // The shelter search stays exhausted. Delegate only actual resource
        // planning, never a new shelter search or a claim of cover/standing.
        if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length) return wait('threat_observation_unknown', '周囲の相手を確認してから、拠点探索とは別の採掘工程へ戻ります。', 'safety', { requiresObservation: true })
        if (evaluation.threats.length) return wait('nearby_threat', '近くの敵への通常の安全判断を優先します。', 'safety', { threat: copy(evaluation.threats[0]) })
        const feetY = state.position.y - 1.62
        const foot = Math.round(feetY)
        const physical = state.predicted?.physicsState ?? state.physicsState
        let bodyKnown = Math.abs(feetY - foot) <= 1e-4 && !(physical?.onGround === false || physical?.isInWater || physical?.isInLava) && !(state.positionSource === 'client_prediction' && physical?.onGround !== true)
        if (physical?.position && (!finite(physical.position) || Math.hypot(physical.position.x - state.position.x, physical.position.y - feetY, physical.position.z - state.position.z) > 1e-3)) bodyKnown = false
        for (let x = Math.floor(state.position.x - 0.3 + 1e-6); bodyKnown && x <= Math.floor(state.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6); bodyKnown && z <= Math.floor(state.position.z + 0.3 - 1e-6); z++) {
          const floor = map.get(`${x},${foot - 1},${z}`)
          if (floor?.known !== true || floor.boundingBox !== 'block' || !SUPPORT.has(nameOf(floor.name)) || floor.extra?.length) { bodyKnown = false; break }
          for (const y of [foot, foot + 1]) {
            const block = map.get(`${x},${y},${z}`)
            if (block?.known !== true || block.boundingBox !== 'empty' || block.extra?.length || !(AIR.has(nameOf(block.name)) || ['short_grass', 'fern', 'deadbush', 'leaf_litter', 'torch'].includes(nameOf(block.name)))) bodyKnown = false
          }
        }
        return bodyKnown ? null : scan('body')
      }
      return result('stop', 'shelter', '拠点候補を探す回数の上限に達したため停止します。', { code: 'shelter_search_limit', attempts, limit })
    }
    if (options.objective === 'diamond' && preparedSword && diamondTool && state.health > 14 && !evaluation.requiresObservation && evaluation.threats.length === 0 && !(state.entityStats?.unknownPositions > evaluation.unknownPositions.length)) return null
    return result('stop', 'shelter', '拠点候補を探す回数の上限に達したため停止します。', { code: 'shelter_search_limit', attempts, limit })
  }
  const coverage = observations.coverage
  const fullyKnown = coverage?.unknown === 0 && coverage.expected > 0 && coverage.known >= coverage.expected
  if (!fullyKnown) return scan('shelter')
  return required('explore', result('explore', 'shelter', '既知の安全な足場を通って別の場所へ移り、土の拠点候補を探します。', { resource: 'shelter', attempt: attempts + 1, maxAttempts: limit, allowWater: false, requiresKnownTerrain: true, requiresLivePreview: true }), ['movement_exploration'])
}

module.exports = { nextSurvivalAction }
