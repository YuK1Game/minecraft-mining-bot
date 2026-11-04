'use strict'

const { resourceMinHealth } = require('./learning-health')

const { stationVisibleFace } = require('./action-access')
const { bedVisibleFace, bedFingerprint, BED_HEIGHT } = require('./portable-bed')

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const HAZARD = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|scaffolding)/
const PLANKS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo', 'crimson', 'warped'].map(wood => `minecraft:${wood}_planks`))
const PLACEABLE = new Set(['minecraft:crafting_table', 'minecraft:furnace', 'minecraft:chest', 'minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:dirt', 'minecraft:torch', ...PLANKS])
const GROUND = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite'].map(name => `minecraft:${name}`))
const CONTAINERS = { chest: { blocks: ['minecraft:chest'], types: ['container', 0] }, workbench: { blocks: ['minecraft:crafting_table'], types: ['workbench', 1] }, furnace: { blocks: ['minecraft:furnace', 'minecraft:lit_furnace'], types: ['furnace', 2] } }
const FACE = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
const emptyExtra = () => ({ has_nbt: 'false', can_place_on: [], can_destroy: [] })
const airItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: emptyExtra() })
const samePosition = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z
const inventoryWindow = id => id === 0 || id === 'inventory'
const containerWindow = id => id === 'first' || id === 'last' || Number.isInteger(id) && id > 0 && id <= 100
const copy = value => structuredClone(value)

function integerPosition (position) {
  if (!position || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis]) && Math.abs(position[axis]) <= 30000000)) throw new Error('対象座標は範囲内の整数で指定してください。')
  return { x: position.x, y: position.y, z: position.z }
}
function finitePosition (position) { return position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis])) }
function validItem (raw) { return Boolean(raw && Number.isInteger(raw.network_id) && Number.isInteger(raw.count) && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)) }
function placedBlockMatches (block, expected) {
  if (expected === 'minecraft:bed') { const bed = bedFingerprint(block); return bed && [false, 0].includes(bed.properties.head_piece_bit) && [false, 0].includes(bed.properties.occupied_bit) }
  if (expected === 'minecraft:torch') return block.name === expected && block.boundingBox === 'empty' && !block.extra?.length && block.properties?.torch_facing_direction === 'top'
  return block.name === expected || expected === 'minecraft:furnace' && block.name === 'minecraft:lit_furnace'
}
const sightPassable = block => block?.known === true && !block.extra?.length && (AIR.has(block.name) || block.name === 'minecraft:torch' && block.boundingBox === 'empty')
function overlapsPlayer (block, position, conservative = false) {
  const bottom = position.y - 1.62
  const top = conservative ? position.y + 1.8 : bottom + 1.8
  return block.x < position.x + 0.3 && block.x + 1 > position.x - 0.3 && block.z < position.z + 0.3 && block.z + 1 > position.z - 0.3 && block.y < top && block.y + 1 > bottom
}

function createInteractions ({ client, getState, world, crafting, getInput, version = '1.26.60', timeoutMs = 8000, onInventory = () => {}, allocateLegacyId, onUncertain = () => {} }) {
  if (version !== '1.26.60') throw new Error('設置・使用操作は1.26.60専用です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof crafting?.rawItem !== 'function' || typeof crafting?.snapshot !== 'function' || typeof crafting?.applyPacket !== 'function' || typeof getInput !== 'function') throw new Error('設置・使用操作には接続、持ち物、入力の取得機能が必要です。')
  if (allocateLegacyId !== undefined && typeof allocateLegacyId !== 'function') throw new Error('allocateLegacyIdは関数で指定してください。')
  if (typeof onUncertain !== 'function') throw new Error('onUncertainは関数で指定してください。')
  const players = new Map()
  let nextLegacyId = -2
  let pending = null
  let selected = { requestedSlot: null, confirmedSlot: null }
  let lastResult = null

  function notifyUncertain (request, reason) {
    if (request.kind !== 'place' || !request.wireSent || request.serverRejected || request.serverConfirmed || request.uncertaintyNotified) return
    request.uncertaintyNotified = true
    try { onUncertain({ requestId: request.id, reason: String(reason) }) } catch { /* Reporting cannot prevent operation cleanup. */ }
  }

  function session (bedOnly = false) {
    const state = getState()
    if (state.dead === true || state.isDead === true || state.health === 0 || state.phase === 'dead') throw new Error('死亡状態では設置・使用操作できません。')
    if (state.phase !== 'spawned' || !finitePosition(state.position)) throw new Error('ワールドへの参加と位置取得が必要です。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('サバイバルモード専用です。')
    if (!Number.isFinite(state.health) || state.health <= (bedOnly ? 0 : resourceMinHealth(state))) throw new Error('体力を確認できないか、体力が少ないため停止します。')
    if (crafting.snapshot().authority !== true) throw new Error('サーバー権威の持ち物情報を確認できません。')
    return state
  }
  function slotItem (slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('操作する道具はホットバーの0〜8スロットに置いてください。')
    const raw = crafting.rawItem(slot)
    if (!raw) throw new Error('対象スロットの持ち物をまだ取得できていません。')
    if (!validItem(raw)) throw new Error('有効なアイテムのスタックIDがありません。')
    return raw
  }
  function equip (slot, bedRequest = false) {
    if (pending && pending.plan.slot !== slot) throw new Error('設置・使用操作中に別のスロットへ変更できません。')
    const state = session(bedRequest === true && pending?.plan.expectedBlock === 'minecraft:bed' && ['place', 'bed_use'].includes(pending.kind))
    const raw = slotItem(slot)
    client.queue('mob_equipment', { runtime_entity_id: BigInt(state.runtimeEntityId), item: raw, slot, selected_slot: slot, window_id: 'inventory' })
    selected = { requestedSlot: slot, confirmedSlot: null }
    // A local hotbar selection has no guaranteed server echo. Keep it requested
    // until a server packet or successful item use confirms the relevant state.
    return { phase: 'requested', slot }
  }
  function lineOfSight (point, clicked, bedOnly = false) {
    const eye = session(bedOnly).position
    const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
    if (distance > 4.5) throw new Error('操作対象が手の届く範囲外です。')
    const steps = Math.max(1, Math.ceil(distance / 0.05))
    for (let step = 0; step < steps; step++) {
      const ratio = step / steps
      const pos = { x: Math.floor(eye.x + (point.x - eye.x) * ratio), y: Math.floor(eye.y + (point.y - eye.y) * ratio), z: Math.floor(eye.z + (point.z - eye.z) * ratio) }
      if (samePosition(pos, clicked)) continue
      const block = world.getBlock(pos.x, pos.y, pos.z)
      if (!sightPassable(block)) throw new Error('操作対象への視線が遮られているか、未取得です。')
    }
  }
  function placementPlan ({ position, slot, face }, requiredBlock = null) {
    const state = session(requiredBlock === 'minecraft:bed')
    const target = integerPosition(position)
    const raw = slotItem(slot)
    const observed = crafting.snapshot()
    if (observed.inventoryKnown === false || state.inventory?.known === false || !Array.from({ length: 36 }, (_, index) => crafting.rawItem(index)).every(validItem)) throw new Error('設置前にサーバーの持ち物全体を確認してください。')
    const description = observed.inventory.find(item => item.slot === slot)
    const expectedBlock = description?.name
    const explicitBed = requiredBlock === 'minecraft:bed' && expectedBlock === 'minecraft:bed'
    if ((!PLACEABLE.has(expectedBlock) && !explicitBed) || raw.count < 1 || description.count !== raw.count || description.stackId != null && description.stackId !== raw.stack_id) throw new Error('指定スロットの実アイテムは設置に対応していません。')
    if (requiredBlock && expectedBlock !== requiredBlock) throw new Error(requiredBlock === 'minecraft:bed' ? '指定スロットにベッドがありません。' : '指定スロットに作業台がありません。')
    if (explicitBed) {
      const actual = state.inventory.items?.find(item => item.slot === slot)
      if (!Number.isInteger(raw.metadata) || raw.metadata < 0 || raw.metadata > 15 || actual?.name !== 'minecraft:bed' || actual.metadata !== raw.metadata) throw new Error('Bedrock bed colour metadata and the received item must match')
      for (const offset of [{ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }]) {
        const head = { x: target.x + offset.x, y: target.y, z: target.z + offset.z }
        const space = world.getBlock(head.x, head.y, head.z), above = world.getBlock(head.x, head.y + 1, head.z), below = world.getBlock(head.x, head.y - 1, head.z)
        if (space?.known !== true || !AIR.has(space.name) || space.extra?.length || above?.known !== true || !AIR.has(above.name) || above.extra?.length || below?.known !== true || below.boundingBox !== 'block' || (!GROUND.has(below.name) && !PLANKS.has(below.name)) || below.extra?.length || overlapsPlayer(head, state.position) || [...players.values()].some(player => overlapsPlayer(head, player.position, true))) throw new Error('All possible server-selected bed head cells need received empty space and stable support')
      }
    }
    if (expectedBlock === 'minecraft:torch') {
      if (face != null && face !== 1) throw new Error('松明は通常の床の上面だけに設置できます。')
      if (observed.inventoryKnown !== true || state.inventory?.known !== true || description.stackId !== raw.stack_id) throw new Error('松明の実際の持ち物・個数・スタックIDを確認してください。')
    }
    const existing = world.getBlock(target.x, target.y, target.z)
    if (!existing.known || !AIR.has(existing.name) || existing.extra?.length) throw new Error('設置先は取得済みの空気ブロックである必要があります。')
    if (overlapsPlayer(target, state.position)) throw new Error('自分に重なる場所には設置できません。')
    for (const player of players.values()) if (overlapsPlayer(target, player.position, true)) throw new Error('他のプレイヤーに重なる可能性があります。')
    const supportPosition = { x: target.x, y: target.y - 1, z: target.z }
    const support = world.getBlock(supportPosition.x, supportPosition.y, supportPosition.z)
    if (!support.known || support.boundingBox !== 'block' || HAZARD.test(support.name) || support.extra?.length || !GROUND.has(support.name) && !PLANKS.has(support.name)) throw new Error('設置先の下に安全な通常の地面ブロックが必要です。')
    for (const offset of FACE) {
      const neighbour = world.getBlock(target.x + offset.x, target.y + offset.y, target.z + offset.z)
      if (!neighbour.known || HAZARD.test(neighbour.name) || neighbour.extra?.length) throw new Error('設置先の周囲に未取得領域・液体・落下ブロックがあります。')
    }
    const point = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
    lineOfSight(point, supportPosition, explicitBed)
    return { target, clicked: supportPosition, face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, point, blockRuntimeId: support.runtimeId, expectedBlock, slot, raw }
  }
  // Quarry seal/plug/stair placement (quarry spec §12.1): the cell may hold
  // air or a plain fluid; the clicked block is any adjacent received full block
  // and the ray may pass through fluid, never through solids or unknown cells.
  const QUARRY_MATERIALS = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'blackstone', 'oak_planks', 'spruce_planks', 'birch_planks'].map(name => `minecraft:${name}`))
  const QUARRY_FLUID = /^minecraft:(?:flowing_)?(?:water|lava)$/
  function quarryPlacementPlan ({ position, slot, clicked, face }) {
    const state = session()
    const target = integerPosition(position)
    const click = integerPosition(clicked)
    if (!Number.isInteger(face) || face < 0 || face > 5) throw new Error('クリックする面を0〜5で指定してください。')
    const normal = FACE[face]
    if (click.x + normal.x !== target.x || click.y + normal.y !== target.y || click.z + normal.z !== target.z) throw new Error('クリック面が設置先に向いていません。')
    const raw = slotItem(slot)
    const observed = crafting.snapshot()
    if (observed.inventoryKnown === false || state.inventory?.known === false) throw new Error('設置前にサーバーの持ち物全体を確認してください。')
    const description = observed.inventory.find(item => item.slot === slot)
    const expectedBlock = description?.name
    if (!QUARRY_MATERIALS.has(expectedBlock) || raw.count < 1 || description.count !== raw.count || description.stackId != null && description.stackId !== raw.stack_id) throw new Error('指定スロットに止水・足場用のブロックがありません。')
    const existing = world.getBlock(target.x, target.y, target.z)
    if (!existing.known || !(AIR.has(existing.name) || QUARRY_FLUID.test(existing.name)) || existing.extra?.length) throw new Error('設置先は取得済みの空気か液体だけのセルである必要があります。')
    if (overlapsPlayer(target, state.position)) throw new Error('自分に重なる場所には設置できません。')
    for (const player of players.values()) if (overlapsPlayer(target, player.position, true)) throw new Error('他のプレイヤーに重なる可能性があります。')
    const support = world.getBlock(click.x, click.y, click.z)
    if (!support.known || support.boundingBox !== 'block' || QUARRY_FLUID.test(support.name) || support.extra?.length) throw new Error('クリックする面は取得済みの通常ブロックである必要があります。')
    const point = { x: click.x + 0.5 + normal.x * 0.5, y: click.y + 0.5 + normal.y * 0.5, z: click.z + 0.5 + normal.z * 0.5 }
    const eye = state.position
    const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
    if (distance > 4.5) throw new Error('操作対象が手の届く範囲外です。')
    const steps = Math.max(1, Math.ceil(distance / 0.05))
    for (let step = 0; step < steps; step++) {
      const ratio = step / steps
      const pos = { x: Math.floor(eye.x + (point.x - eye.x) * ratio), y: Math.floor(eye.y + (point.y - eye.y) * ratio), z: Math.floor(eye.z + (point.z - eye.z) * ratio) }
      if (samePosition(pos, click)) continue
      const block = world.getBlock(pos.x, pos.y, pos.z)
      if (!(sightPassable(block) || block?.known === true && QUARRY_FLUID.test(block.name) && !block.extra?.length)) throw new Error('操作対象への視線が遮られているか、未取得です。')
    }
    return { target, clicked: click, face, clickPos: { x: 0.5 + normal.x * 0.5, y: 0.5 + normal.y * 0.5, z: 0.5 + normal.z * 0.5 }, point, blockRuntimeId: support.runtimeId, expectedBlock, slot, raw }
  }
  const interactionScope = state => JSON.stringify([state.profile ?? null, state.realm?.id ?? null, state.dimension, state.connectionId ?? null, state.startedAt ?? null, state.runtimeEntityId ?? null, state.lifecycle?.deathId ?? null])
  function openPlan (position, requestedSlot, container = 'workbench') {
    const state = session()
    const target = integerPosition(position)
    const block = world.getBlock(target.x, target.y, target.z)
    const expected = CONTAINERS[container]
    if (!block.known || !expected.blocks.includes(block.name)) throw new Error(container === 'furnace' ? '対象のかまどを確認できません。' : '対象の作業台を確認できません。')
    const slot = requestedSlot ?? state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
    const raw = slotItem(slot)
    if (container === 'workbench') {
      const visible = stationVisibleFace({ eye: state.position, target, world })
      if (!visible) throw Object.assign(new Error('作業台への既知の視線がありません。安全な足場から再確認してください。'), { code: 'INTERACTION_ACCESS_REQUIRED' })
      return { target, clicked: target, face: visible.face, clickPos: visible.clickPos, point: visible.point, blockRuntimeId: block.runtimeId, expectedBlock: block.name, container, slot, raw }
    }
    const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
    const dx = state.position.x - center.x
    const dy = state.position.y - center.y
    const dz = state.position.z - center.z
    const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? (dy > 0 ? 1 : 0) : Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
    const offset = FACE[face]
    const point = { x: center.x + offset.x * 0.5, y: center.y + offset.y * 0.5, z: center.z + offset.z * 0.5 }
    lineOfSight(point, target)
    return { target, clicked: target, face, clickPos: { x: 0.5 + offset.x * 0.5, y: 0.5 + offset.y * 0.5, z: 0.5 + offset.z * 0.5 }, point, blockRuntimeId: block.runtimeId, expectedBlock: block.name, container, slot, raw }
  }
  function bedUsePlan (position, requestedSlot) {
    const state = session(true), target = integerPosition(position), block = world.getBlock(target.x, target.y, target.z), bed = bedFingerprint(block)
    if (state.dimension !== 'overworld' || !bed || ![false, 0].includes(bed.properties.occupied_bit)) throw new Error('A received unoccupied Overworld bed is required')
    const visible = bedVisibleFace({ eye: state.position, target, world })
    if (!visible) throw new Error('The real bed shape has no known visible face within normal reach')
    const slot = requestedSlot ?? state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot, raw = slotItem(slot)
    const clickPos = { x: visible.hit.x - target.x, y: visible.hit.y - target.y, z: visible.hit.z - target.z }
    if (clickPos.y > BED_HEIGHT + 1e-7) throw new Error('Bed click is above its received collision shape')
    return { target, clicked: target, face: visible.face, point: visible.point, clickPos, blockRuntimeId: block.runtimeId, expectedBlock: block.name, slot, raw }
  }
  function wakeBed (position) {
    const state = session(true), target = integerPosition(position)
    if (state.dimension !== 'overworld' || !bedFingerprint(world.getBlock(target.x, target.y, target.z))) throw new Error('A received Overworld bed is required to request normal wake-up')
    client.queue('player_action', { runtime_entity_id: BigInt(state.runtimeEntityId), action: 'stop_sleeping', position: target, result_position: { ...target }, face: -1 })
    return { phase: 'requested', operation: 'wake_bed', serverConfirmed: false }
  }
  function packedTransaction (plan, id, placing) {
    const data = { action_type: 'click_block', trigger_type: 'player_input', block_position: plan.clicked, face: plan.face, hotbar_slot: plan.slot, hand: 'main_hand', held_item: copy(plan.raw), player_pos: copy(session(plan.expectedBlock === 'minecraft:bed').position), click_pos: plan.clickPos, block_runtime_id: plan.blockRuntimeId, client_prediction: 'success', client_cooldown_state: 'off' }
    return { legacy: { legacy_request_id: id, legacy_transactions: placing ? [{ container_id: 12, changed_slots: [{ slot_id: plan.slot }] }] : null }, actions: placing ? [{ source_type: 'container', window_id: 0, flags: null, slot: plan.slot, old_item: copy(plan.raw), new_item: plan.raw.count > 1 ? { ...copy(plan.raw), count: plan.raw.count - 1 } : airItem() }] : [], data }
  }
  function publishItem (slot, raw) {
    const input = Array.from({ length: 36 }, (_, index) => crafting.rawItem(index))
    if (!input.every(validItem)) throw new Error('実際の持ち物全体が不明なため設置結果を保存できません。')
    input[slot] = copy(raw)
    crafting.applyPacket('inventory_slot', { window_id: 'inventory', slot, item: raw })
    onInventory({ window_id: 'inventory', input, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: airItem() })
  }
  function finish (result) {
    const request = pending
    if (!request) return
    request.serverConfirmed = true
    pending = null
    clearTimeout(request.timeout)
    clearInterval(request.poll)
    if (request.startedInput) request.input.stop()
    lastResult = result
    request.resolve(copy(result))
  }
  function cancel (reason = '設置・使用操作を停止しました。') {
    const request = pending
    if (!request) return
    pending = null
    request.cancelled = true
    clearTimeout(request.timeout)
    clearInterval(request.poll)
    if (request.startedInput) request.input.stop()
    notifyUncertain(request, reason)
    lastResult = { phase: 'failed', operation: request.kind, reason }
    request.reject(new Error(reason))
  }
  function check () {
    if (!pending) return
    try {
      const state = session(pending.plan.expectedBlock === 'minecraft:bed' && ['place', 'bed_use'].includes(pending.kind))
      if (pending.scope !== interactionScope(state) || state.dimension !== pending.dimension || Math.hypot(state.position.x - pending.origin.x, state.position.y - pending.origin.y, state.position.z - pending.origin.z) > 0.3) throw new Error('プレイヤー位置・次元が変わりました。')
      if (pending.kind === 'place') {
        if (!pending.wireSent) return
        if (crafting.snapshot().inventoryKnown === false || state.inventory?.known === false) throw new Error('設置結果の持ち物が不明になりました。')
        const block = world.getBlock(pending.plan.target.x, pending.plan.target.y, pending.plan.target.z)
        const raw = crafting.rawItem(pending.plan.slot)
        const consumed = validItem(raw) && (raw.network_id === 0 && raw.count === 0 && pending.plan.raw.count === 1 || raw.network_id === pending.plan.raw.network_id && raw.count === pending.plan.raw.count - 1)
        if (block.known && placedBlockMatches(block, pending.plan.expectedBlock) && consumed) {
          selected.confirmedSlot = pending.plan.slot
          finish({ phase: 'completed', operation: 'place', position: pending.plan.target, blockName: block.name, expectedBlock: pending.plan.expectedBlock, confirmedBy: 'server_block_and_inventory' })
        }
      }
    } catch (error) { cancel(error.message) }
  }
  function begin (kind, plan) {
    if (pending) throw new Error('前の設置・使用操作の結果を待っています。')
    const input = getInput()
    if (!input || typeof input.sendTransaction !== 'function') throw new Error('入力ストリームのitem-use送信機能が必要です。')
    if (input.stats().target) throw new Error('採掘を停止してから操作してください。')
    const bedRequest = plan.expectedBlock === 'minecraft:bed' && ['place', 'bed_use'].includes(kind)
    const state = session(bedRequest)
    const id = kind === 'place' ? (allocateLegacyId ? allocateLegacyId() : nextLegacyId) : 0
    if (kind === 'place' && (!Number.isInteger(id) || id >= 0 || id < -2147483648 || id % 2 !== 0)) throw new Error('Legacy要求IDは32ビット範囲の負の偶数である必要があります。')
    if (kind === 'place' && !allocateLegacyId) nextLegacyId -= 2
    return new Promise((resolve, reject) => {
      const request = pending = { kind, plan, id, input, origin: copy(state.position), dimension: state.dimension, scope: interactionScope(state), startedInput: !input.stats().running, resolve, reject, wireSent: false, serverRejected: false, serverConfirmed: false, uncertaintyNotified: false, cancelled: false }
      pending.timeout = setTimeout(() => cancel('サーバーから設置・使用の完了を確認できませんでした。'), timeoutMs)
      pending.poll = setInterval(check, 100)
      lastResult = { phase: 'requesting', operation: kind, position: plan.target }
      try {
        equip(plan.slot, bedRequest)
        input.lookAt(plan.point)
        input.start()
        input.sendTransaction(packedTransaction(plan, id, kind === 'place'), { onSent: () => {
          request.wireSent = true
          if (request.cancelled) notifyUncertain(request, '停止後に設置要求の送信が確認されました。')
          if (kind === 'bed_use' && !request.cancelled && pending === request) {
            pending = null; clearTimeout(request.timeout); clearInterval(request.poll)
            if (request.startedInput) request.input.stop()
            lastResult = { phase: 'requested', operation: 'bed_use', position: plan.target, confirmedBy: 'queued_item_use', serverConfirmed: false }
            request.resolve(copy(lastResult))
          }
        } })
      } catch (error) { cancel(error.message) }
    })
  }
  function applyPacket (name, packet) {
    const state = getState()
    if (pending) {
      try {
        const current = session(pending.plan.expectedBlock === 'minecraft:bed' && ['place', 'bed_use'].includes(pending.kind))
        if (pending.scope !== interactionScope(current)) throw new Error('操作中に接続またはlifeが変わりました。')
        if (pending.kind === 'open') {
          const block = world.getBlock(pending.plan.target.x, pending.plan.target.y, pending.plan.target.z)
          if (block?.known !== true || block.name !== pending.plan.expectedBlock) throw new Error('操作対象のブロックが変わりました。')
        }
      } catch (error) { cancel(error.message) }
    }
    if (name === 'start_game' || name === 'change_dimension') { cancel('接続・次元が変わりました。'); players.clear(); selected = { requestedSlot: null, confirmedSlot: null } }
    if (name === 'add_player' && String(packet.runtime_id) !== state.runtimeEntityId && finitePosition(packet.position)) players.set(String(packet.runtime_id), { uniqueId: String(packet.unique_id), position: copy(packet.position) })
    if (name === 'move_player' && players.has(String(packet.runtime_id)) && finitePosition(packet.position)) players.get(String(packet.runtime_id)).position = copy(packet.position)
    if (name === 'remove_entity') for (const [id, player] of players) if (player.uniqueId === String(packet.entity_id_self)) players.delete(id)
    if (name === 'mob_equipment' && String(packet.runtime_entity_id) === state.runtimeEntityId && inventoryWindow(packet.window_id) && packet.selected_slot === selected.requestedSlot) selected.confirmedSlot = packet.selected_slot
    if (name === 'player_hotbar' && inventoryWindow(packet.window_id) && packet.selected_slot === selected.requestedSlot) selected.confirmedSlot = packet.selected_slot
    if (name === 'item_stack_response' && pending?.kind === 'place') {
      for (const response of packet.responses ?? []) {
        if (response.request_id !== pending?.id) continue
        if (response.status !== 'ok' && response.status !== 0) { pending.serverRejected = true; cancel('サーバーが設置による持ち物変更を拒否しました。'); break }
        const request = pending
        for (const container of response.containers ?? []) {
          if (!['inventory', 'hotbar', 'hotbar_and_inventory', 12, 28, 29].includes(container.slot_type?.container_id) || container.slot_type?.dynamic_container_id != null) continue
          const slot = container.slots?.find(slot => slot.slot === request.plan.slot && slot.count === request.plan.raw.count - 1)
          if (!slot || slot.count > 0 && (!Number.isInteger(slot.item_stack_id) || slot.item_stack_id <= 0)) continue
          try { publishItem(request.plan.slot, slot.count ? { ...copy(request.plan.raw), count: slot.count, has_stack_id: true, stack_id: slot.item_stack_id } : airItem()) } catch (error) { cancel(error.message); return }
        }
      }
    }
    if (name === 'container_open' && pending?.kind === 'open' && pending.wireSent && containerWindow(packet.window_id) && CONTAINERS[pending.plan.container].types.includes(packet.window_type) && samePosition(packet.coordinates, pending.plan.target)) {
      selected.confirmedSlot = pending.plan.slot
      finish({ phase: 'completed', operation: 'open', position: pending.plan.target, windowId: packet.window_id, windowType: packet.window_type, blockName: pending.plan.expectedBlock, confirmedBy: 'server_container_open' })
    }
    check()
  }
  function previewPlace (options) {
    try { const plan = placementPlan(options); return { ready: true, position: plan.target, clicked: plan.clicked, face: plan.face, slot: plan.slot, expectedBlock: plan.expectedBlock } } catch (error) { return { ready: false, errors: [error.message] } }
  }
  const openWorkbench = (position, slot) => begin('open', openPlan(position, slot, 'workbench'))
  const previewQuarryPlace = options => { try { const plan = quarryPlacementPlan(options); return { ready: true, position: plan.target, clicked: plan.clicked, face: plan.face, slot: plan.slot, expectedBlock: plan.expectedBlock } } catch (error) { return { ready: false, errors: [error.message] } } }
  return { equip, previewPlace, previewQuarryPlace, placeQuarryBlock: options => begin('place', quarryPlacementPlan(options)), placeBed: options => begin('place', placementPlan(options, 'minecraft:bed')), previewPlaceBed: options => { try { const plan = placementPlan(options, 'minecraft:bed'); return { ready: true, position: plan.target, expectedBlock: plan.expectedBlock } } catch (error) { return { ready: false, errors: [error.message] } } }, useBed: (position, slot) => begin('bed_use', bedUsePlan(position, slot)), previewUseBed: (position, slot) => { try { const plan = bedUsePlan(position, slot); return { ready: true, position: plan.target, face: plan.face } } catch (error) { return { ready: false, errors: [error.message] } } }, wakeBed, previewOpenCraftingTable: (position, slot) => { try { const plan = openPlan(position, slot, 'workbench'); return { ready: true, position: plan.target, face: plan.face, point: plan.point } } catch (error) { return { ready: false, code: error.code ?? null, errors: [error.message] } } }, placeBlock: options => begin('place', placementPlan(options)), placeCraftingTable: options => begin('place', placementPlan(options, 'minecraft:crafting_table')), openCraftingTable: openWorkbench, openWorkbench, openFurnace: (position, slot) => begin('open', openPlan(position, slot, 'furnace')), openChest: (position, slot) => begin('open', openPlan(position, slot, 'chest')), previewOpenChest: (position, slot) => { try { const plan = openPlan(position, slot, 'chest'); return { ready: true, position: plan.target, face: plan.face, point: plan.point } } catch (error) { return { ready: false, errors: [error.message] } } }, applyPacket, cancel, snapshot: () => ({ equipment: copy(selected), pendingOperation: pending?.kind ?? null, lastResult: copy(lastResult), trackedPlayers: players.size }) }
}

module.exports = { createInteractions }
