'use strict'

const { serialize, deserialize } = require('node:v8')
const { isDeepStrictEqual } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const { keepPlan, maxStack, carriedContainerKey } = require('./quarry-inventory')
const { isShulkerBox, isShulkerBlock } = require('./container-types')
const { readContainerContents, compareShulkerContents } = require('./shulker-contents')

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const GROUND = /^(?:minecraft:)?(?:dirt|grass_block|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|[a-z_]+_planks)$/
const HAZARD = /water|lava|fire|magma|cactus|campfire|sand$|gravel$|powder|anvil$|scaffolding|dripstone/
const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const copy = value => structuredClone(value)
const fullName = name => typeof name === 'string' ? name.startsWith('minecraft:') ? name : `minecraft:${name}` : null
const key = p => `${p.x},${p.y},${p.z}`
const point = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]) && Math.abs(p[axis]) <= 30000000)
const samePoint = (a, b) => point(a) && point(b) && key(a) === key(b)
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
const validRaw = r => r && Number.isInteger(r.network_id) && Number.isInteger(r.count) && (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.has_stack_id === true && Number.isInteger(r.stack_id) && r.stack_id > 0)
const rawIdentity = r => ({ network_id: r.network_id, metadata: r.metadata, block_runtime_id: r.block_runtime_id, extra: r.extra })
const pack = value => serialize(value).toString('base64')
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const matches = (raw, identity) => validRaw(raw) && isDeepStrictEqual(rawIdentity(raw), unpack(identity))
const failure = (code, message = code) => Object.assign(new Error(message), { code })
const scopeOf = state => {
  const life = state?.lifecycle?.deathId ?? state?.deathId
  if (!state?.profile || state.realm?.id == null || !state.connectionId || !state.startedAt || state.runtimeEntityId == null || !state.dimension || !Number.isSafeInteger(life) || life < 0) throw failure('STORAGE_SCOPE_UNKNOWN')
  return { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), life }
}

function createQuarryPortableStorage ({ getState, getBlock, crafting, chest, interactions, equip, moveTo, previewMove = null, mine, getMining, stopMining, getEntities, cancelAction = () => {}, now = Date.now, sleep = ms => delay(ms) }) {
  if ([getState, getBlock, equip, moveTo, mine, getMining, stopMining, getEntities, cancelAction, now, sleep].some(fn => typeof fn !== 'function') || typeof crafting?.rawItem !== 'function' || typeof crafting?.closeContainer !== 'function' || typeof chest?.open !== 'function' || typeof chest?.depositItem !== 'function' || typeof chest?.rawItem !== 'function' || typeof interactions?.placeBlock !== 'function') throw new Error('Portable storage requires observed inventory, containers and owned normal actions')
  if (previewMove !== null && typeof previewMove !== 'function') throw new Error('Portable storage movement preview must be a function')
  let active = null
  const read = p => getBlock(p.x, p.y, p.z)
  const air = p => { const b = read(p); return b?.known === true && AIR.has(b.name) && !b.extra?.length }
  const support = p => { const b = read({ ...p, y: p.y - 1 }); return b?.known === true && b.boundingBox === 'block' && GROUND.test(b.name) && !HAZARD.test(b.name) && !b.extra?.length }
  const craftState = () => typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot()
  function observe (cp = null) {
    const state = getState(), scope = scopeOf(state), observed = craftState()
    if (cp && !isDeepStrictEqual(scope, cp.scope)) throw failure('STORAGE_SCOPE_CHANGED')
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !['survival', 0].includes(state.gameMode)) throw failure('STORAGE_NOT_ALIVE')
    if (!finite(state.position) || state.inventory?.known !== true || state.inventory.uncertain || observed.authority !== true || observed.inventoryKnown !== true || observed.pendingRequestId != null) throw failure('STORAGE_INVENTORY_UNKNOWN')
    const items = []
    for (let slot = 0; slot < 36; slot++) {
      const raw = crafting.rawItem(slot)
      if (!validRaw(raw)) throw failure('STORAGE_INVENTORY_UNKNOWN')
      if (!raw.count) continue
      const name = fullName(crafting.itemNameOf?.(raw.network_id) ?? observed.inventory?.find(item => item.slot === slot)?.name ?? state.inventory.items?.find(item => item.slot === slot)?.name)
      if (!name) throw failure('STORAGE_ITEM_UNKNOWN')
      items.push({ slot, name, count: raw.count, stackId: raw.stack_id, networkId: raw.network_id, metadata: raw.metadata ?? 0, raw })
    }
    return { state, scope, observed, items }
  }
  function placedCurrent (cp, receipt) {
    const block = read(receipt.position)
    return receipt.confirmedBy === 'server_block_and_inventory' && block?.known === true && block.name === receipt.name && block.runtimeId === receipt.runtimeId
  }
  function ownsShulker (state, target, block) {
    try {
      const cp = active?.checkpoint
      if (!cp || cp.kind !== 'shulker' || cp.recovered || !isDeepStrictEqual(scopeOf(state), cp.scope) || state.dead || !(state.health > 0) || target?.accessPreparation !== 'owned_shulker' || target.ownershipKey !== cp.operationId) return false
      const receipt = cp.placed.find(p => samePoint(p.position, target))
      return !!receipt && receipt.confirmedBy === 'server_block_and_inventory' && isShulkerBlock(receipt.name) && target.expectedName === receipt.name && target.expectedRuntimeId === receipt.runtimeId && block?.known === true && (AIR.has(block.name) || block.name === receipt.name && block.runtimeId === receipt.runtimeId)
    } catch { return false }
  }
  function overlaps (p, actor) {
    if (!finite(actor.position)) return true
    const bottom = actor.kind === 'player' || actor.self ? actor.position.y - 1.62 : actor.position.y
    return Math.abs(actor.position.x - (p.x + 0.5)) < 0.81 && Math.abs(actor.position.z - (p.z + 0.5)) < 0.81 && bottom < p.y + 2 && bottom + 1.8 > p.y
  }
  function clearCell (p, state, allowed, ownPositions = []) {
    if (!point(p) || allowed(p) !== true || !air(p) || !air({ ...p, y: p.y + 1 }) || !support(p) || overlaps(p, { self: true, position: state.position })) return false
    const actors = getEntities()
    if (!Array.isArray(actors)) return false
    if (actors.some(actor => ['mob', 'player'].includes(actor.kind) && actor.alive !== false && String(actor.runtimeId) !== String(state.runtimeEntityId) && (actor.positionKnown === false || overlaps(p, actor)))) return false
    for (const [dx, dz] of DIRECTIONS) {
      const neighbour = { x: p.x + dx, y: p.y, z: p.z + dz }, block = read(neighbour)
      if (block?.known !== true || block.extra?.length || HAZARD.test(block.name ?? '') || /(?:trapped_)?chest$/.test(block.name ?? '') && !ownPositions.some(other => samePoint(other, neighbour))) return false
    }
    return true
  }
  function heading (eye, p) {
    const dx = p.x + 0.5 - eye.x, dz = p.z + 0.5 - eye.z
    if (Math.abs(Math.abs(dx) - Math.abs(dz)) < 0.2) return null
    return Math.abs(dx) > Math.abs(dz) ? `x:${Math.sign(dx)}` : `z:${Math.sign(dz)}`
  }
  function planSite (state, kind, allowed) {
    const y = Math.round(state.position.y - 1.62), origin = { x: Math.floor(state.position.x), y, z: Math.floor(state.position.z) }
    const stands = []
    for (const dy of [0, 1, -1, 2, -2]) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.hypot(dx, dz) <= 3) stands.push({ x: origin.x + dx, y: y + dy, z: origin.z + dz })
    stands.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) - Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z))
    nextStand: for (const stand of stands) {
      if (!air(stand) || !air({ ...stand, y: stand.y + 1 }) || !support(stand) || allowed(stand) !== true) continue
      const eye = { x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }
      for (const [dx, dz] of DIRECTIONS) for (const side of [1, -1]) {
        const first = { x: stand.x + dx * 2, y: stand.y, z: stand.z + dz * 2 }
        const positions = kind === 'double_chest' ? [first, { x: first.x - dz * side, y: stand.y, z: first.z + dx * side }] : [first]
        if (!positions.every(p => clearCell(p, state, allowed)) || positions.some(p => Math.hypot(p.x + 0.5 - eye.x, p.y - eye.y, p.z + 0.5 - eye.z) > 4.5)) continue
        if (positions.length === 2 && (!heading(eye, first) || heading(eye, first) !== heading(eye, positions[1]))) continue
        if (previewMove) {
          try { if (previewMove(copy(stand))?.ready !== true) continue nextStand } catch { continue nextStand }
        }
        return { stand, positions }
      }
    }
    throw failure('STORAGE_SITE_UNOBSERVED', 'No nearby known storage footprint and standing cell')
  }

  async function storeCarried (request, { signal, onCheckpoint, canPlace = () => true } = {}) {
    if (active) return { status: 'blocked', reason: 'STORAGE_BUSY', serverConfirmed: false, deposited: [], checkpoint: copy(request?.checkpoint ?? null) }
    let cp = null, action = null
    const run = active = { checkpoint: null }
    const guard = () => { if (signal?.aborted) throw failure('STORAGE_ABORTED'); return observe(cp) }
    const save = async () => { if (typeof onCheckpoint !== 'function') throw failure('STORAGE_PERSISTENCE_REQUIRED'); try { await onCheckpoint(copy(cp)) } catch (error) { throw failure('STORAGE_PERSISTENCE_FAILED', error.message) } }
    const cancel = () => { if (!action) return; try { Promise.resolve(cancelAction(action, 'Portable storage interrupted')).catch(() => {}) } catch {} ; if (action === 'mining') { try { stopMining('Portable storage interrupted') } catch {} } }
    const perform = async (kind, fn) => {
      guard(); action = kind
      let aborted
      const stopped = new Promise((resolve, reject) => { aborted = () => reject(failure('STORAGE_ABORTED')); signal?.addEventListener('abort', aborted, { once: true }) })
      try { return await Promise.race([Promise.resolve().then(() => { guard(); return fn() }), stopped]) } finally { signal?.removeEventListener('abort', aborted); action = null }
    }
    const wait = async (predicate, limitMs, reason) => {
      const until = now() + limitMs
      for (;;) { guard(); const result = predicate(); if (result) return result; if (now() >= until) throw failure(reason); await sleep(50) }
    }
    const result = (status, reason = null) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status !== 'blocked', deposited: copy(cp?.deposited ?? []), ...(cp?.kind === 'shulker' ? { recovered: !!cp.recovered, ...(status === 'full' && cp.recovered ? { exhaustedShulkerKeys: [cp.recovered.key] } : {}) } : { storage: cp?.opened && point(cp.positions?.[0]) ? [{ position: copy(cp.positions[0]), ...(cp.kind === 'double_chest' ? { pairedPositions: copy(cp.positions) } : {}), stand: copy(cp.stand), slotCount: cp.kind === 'double_chest' ? 54 : 27 }] : [] }), checkpoint: copy(cp) })
    const close = () => {
      const current = observe(cp), open = current.observed.openContainer
      if (open && cp.windowId != null && String(open.id) !== String(cp.windowId)) throw failure('STORAGE_WINDOW_CHANGED')
      if (open) crafting.closeContainer()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const initial = guard(), selection = request?.selection
      if (!request?.jobId || typeof request.operationId !== 'string' || !request.operationId.length || request.operationId.length > 200 || !['shulker', 'double_chest', 'single_chest'].includes(selection?.kind) || !Array.isArray(selection.sources)) throw failure('STORAGE_REQUEST_INVALID')
      cp = request.checkpoint ? copy(request.checkpoint) : null
      if (cp) {
        if (cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || cp.kind !== selection.kind || cp.selectionKey !== selection.key || !Array.isArray(cp.positions) || cp.positions.length !== (cp.kind === 'double_chest' ? 2 : 1) || !cp.positions.every(point) || !point(cp.stand) || !Array.isArray(cp.placed) || !Array.isArray(cp.plan) || !Array.isArray(cp.sourceIdentities) || !Array.isArray(cp.deposited)) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (new Set(cp.positions.map(key)).size !== cp.positions.length || cp.placed.some(p => !cp.positions.some(position => samePoint(p.position, position)) || p.confirmedBy !== 'server_block_and_inventory' || !Number.isInteger(p.runtimeId) || (cp.kind === 'shulker' ? !isShulkerBlock(p.name) : p.name !== 'minecraft:chest')) || new Set(cp.placed.map(p => key(p.position))).size !== cp.placed.length || cp.plan.some(p => typeof p.name !== 'string' || typeof p.identity !== 'string' || !Number.isSafeInteger(p.count) || p.count < 1 || !Number.isSafeInteger(p.transferred) || p.transferred < 0 || p.transferred > p.count)) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.kind === 'double_chest' && (cp.positions[0].y !== cp.positions[1].y || Math.abs(cp.positions[0].x - cp.positions[1].x) + Math.abs(cp.positions[0].z - cp.positions[1].z) !== 1)) throw failure('STORAGE_CHECKPOINT_INVALID')
        observe(cp)
      } else {
        const sourceIdentities = selection.sources.map(source => {
          if (!Number.isSafeInteger(source.count) || source.count < 1) throw failure('STORAGE_SOURCE_COUNT')
          const item = initial.items.find(item => item.slot === source.slot && item.name === fullName(source.name) && item.count >= source.count && (source.stackId == null || item.stackId === source.stackId))
          if (!item || selection.kind === 'shulker' && !isShulkerBlock(item.name) || selection.kind !== 'shulker' && item.name !== 'minecraft:chest') throw failure('STORAGE_SOURCE_CHANGED')
          return { name: item.name, count: source.count, identity: pack(rawIdentity(item.raw)) }
        })
        if (sourceIdentities.reduce((n, item) => n + item.count, 0) !== (selection.kind === 'double_chest' ? 2 : 1)) throw failure('STORAGE_SOURCE_COUNT')
        const plan = (request.deposits ?? []).map(deposit => {
          const item = initial.items.find(item => item.slot === deposit.slot && item.name === fullName(deposit.name))
          if (!item || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > item.count || isShulkerBox(item.name)) throw failure('STORAGE_DEPOSIT_CHANGED')
          return { name: item.name, count: deposit.count, identity: pack(rawIdentity(item.raw)), transferred: 0 }
        })
        if (!plan.length) throw failure('STORAGE_NO_DEPOSITS')
        cp = { version: 1, operationId: request.operationId, jobId: request.jobId, scope: initial.scope, kind: selection.kind, selectionKey: selection.key, stage: 'planned', ...planSite(initial.state, selection.kind, canPlace), sourceIdentities, plan, placed: [], deposited: [], intent: null, full: false }
        run.checkpoint = cp; await save()
      }
      run.checkpoint = cp
      if (cp.intent && cp.intent.type !== 'break') throw failure('STORAGE_ACTION_UNCONFIRMED', 'A saved placement or transfer intent has no persisted server receipt')
      if (cp.stage === 'completed') {
        if (!cp.opened || cp.placed.length !== cp.positions.length) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.kind === 'shulker') {
          const current = guard(), item = current.items.find(item => carriedContainerKey(item) === cp.recovered?.key)
          if (!air(cp.positions[0]) || !item || !cp.expectedContents || !compareShulkerContents(item.raw, unpack(cp.expectedContents), { resolveName: id => crafting.itemNameOf?.(id) }).matches) throw failure('STORAGE_RECOVERY_UNCONFIRMED')
        } else if (cp.placed.some(p => !placedCurrent(cp, p))) throw failure('STORAGE_OWNED_BLOCK_CHANGED')
        return result(cp.full ? 'full' : 'completed')
      }
      const recovering = ['breaking', 'awaiting_recovery'].includes(cp.stage)
      for (const placed of cp.placed) if (!placedCurrent(cp, placed) && !(recovering && cp.kind === 'shulker' && air(placed.position))) throw failure('STORAGE_OWNED_BLOCK_CHANGED')

      if (!recovering) {
        let current = guard()
        if (!samePoint({ x: Math.floor(current.state.position.x), y: Math.round(current.state.position.y - 1.62), z: Math.floor(current.state.position.z) }, cp.stand)) await perform('movement', () => moveTo(copy(cp.stand), { signal }))
        current = guard()
        if (Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.y - 1.62 - cp.stand.y, current.state.position.z - cp.stand.z - 0.5) > 0.7 || !support(cp.stand)) throw failure('STORAGE_STAND_UNCONFIRMED')
        if (cp.positions.length === 2 && heading(current.state.position, cp.positions[0]) !== heading(current.state.position, cp.positions[1])) throw failure('STORAGE_DOUBLE_FACING')
        for (const position of cp.positions) {
          if (cp.placed.some(placed => samePoint(placed.position, position))) continue
          current = guard()
          if (!clearCell(position, current.state, canPlace, cp.placed.map(p => p.position))) throw failure('STORAGE_SITE_CHANGED')
          let item = current.items.find(item => cp.sourceIdentities.some(source => source.name === item.name && matches(item.raw, source.identity)))
          if (!item) throw failure('STORAGE_SOURCE_CHANGED')
          if (current.observed.openContainer) close()
          if (item.slot > 8) {
            const before = item, equipped = await perform('equip', () => equip(item.slot, { signal }))
            current = guard()
            const slot = equipped?.slot ?? current.state.rawServerSelectedSlot ?? current.state.rawSelectedSlot ?? current.state.selectedSlot
            item = current.items.find(candidate => candidate.slot === slot && candidate.name === before.name && candidate.count === before.count && isDeepStrictEqual(rawIdentity(candidate.raw), rawIdentity(before.raw)))
            if (!item || !(equipped?.serverConfirmed === true || equipped?.selectionSent === true && equipped.slot === item.slot && equipped.sourceSlot === item.slot)) throw failure('STORAGE_EQUIP_UNCONFIRMED')
            if (current.observed.openContainer) close()
          }
          const source = copy(item.raw)
          cp.stage = 'placing'; cp.intent = { type: 'place', position: copy(position), name: item.name, slot: item.slot, source: pack(source) }; await save(); guard()
          const receipt = await perform('interaction', () => interactions.placeBlock({ position: copy(position), slot: item.slot, face: 1, ...(cp.kind === 'double_chest' ? { alignFacing: true } : {}) }))
          observe(cp)
          const block = read(position), after = crafting.rawItem(item.slot)
          if (receipt?.phase !== 'completed' || receipt.confirmedBy !== 'server_block_and_inventory' || !samePoint(receipt.position, position) || block?.known !== true || block.name !== item.name || !Number.isInteger(block.runtimeId) || !validRaw(after) || source.count - after.count !== 1 || after.count && !isDeepStrictEqual(rawIdentity(source), rawIdentity(after))) throw failure('STORAGE_PLACE_UNCONFIRMED')
          cp.placed.push({ position: copy(position), name: item.name, runtimeId: block.runtimeId, confirmedBy: 'server_block_and_inventory' })
          cp.intent = null; cp.stage = 'placed'; await save()
        }
        const slots = cp.kind === 'double_chest' ? 54 : 27
        close(); guard()
        const opened = await perform('chest', () => chest.open(copy(cp.positions[0]), undefined, { expectedSlots: slots }))
        const window = chest.snapshot()
        if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== slots || !samePoint(opened.position, cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== slots || !samePoint(window.window?.position, cp.positions[0])) throw failure('STORAGE_OPEN_UNCONFIRMED')
        cp.windowId = opened.windowId; cp.opened = true; cp.stage = 'depositing'; await save()
        for (let index = 0; index < cp.plan.length && !cp.full; index++) {
          const entry = cp.plan[index]
          while (entry.transferred < entry.count) {
            current = guard()
            const kept = keepPlan(current.items, request.inventoryPolicy).keep
            const item = current.items.find(item => item.name === entry.name && matches(item.raw, entry.identity) && item.count > (kept.get(item.slot) ?? 0))
            if (!item) throw failure('STORAGE_SURPLUS_CHANGED')
            const known = chest.snapshot()
            if (known.contentsKnown !== true || known.slotCount !== slots || !samePoint(known.window?.position, cp.positions[0])) throw failure('STORAGE_CONTENTS_UNKNOWN')
            const destinations = Array.from({ length: slots }, (_, slot) => ({ slot, raw: chest.rawItem(slot) }))
            if (destinations.some(d => !validRaw(d.raw))) throw failure('STORAGE_CONTENTS_UNKNOWN')
            const compatible = d => d.raw.count === 0 || isDeepStrictEqual(rawIdentity(d.raw), rawIdentity(item.raw))
            const target = destinations.find(d => d.raw.count > 0 && compatible(d) && d.raw.count < maxStack(item.name)) ?? destinations.find(d => d.raw.count === 0)
            if (!target) { cp.full = true; await save(); break }
            const count = Math.min(entry.count - entry.transferred, item.count - (kept.get(item.slot) ?? 0), maxStack(item.name) - target.raw.count)
            cp.intent = { type: 'deposit', index, name: item.name, count, sourceSlot: item.slot, chestSlot: target.slot, source: pack(item.raw), destination: pack(target.raw) }; await save(); guard()
            const receipt = await perform('chest', () => chest.depositItem({ sourceSlot: item.slot, count, chestSlot: target.slot, expectedName: item.name }))
            observe(cp)
            const after = crafting.rawItem(item.slot), destination = chest.rawItem(target.slot)
            if (receipt?.serverConfirmed !== true || receipt.inventoryConfirmed !== true || receipt.containerConfirmed !== true || receipt.operation !== 'deposit_item' || receipt.count !== count || receipt.item !== item.name || !samePoint(receipt.position, cp.positions[0]) || !validRaw(after) || after.count !== item.count - count || after.count && !isDeepStrictEqual(rawIdentity(after), rawIdentity(item.raw)) || !validRaw(destination) || destination.count !== target.raw.count + count || !isDeepStrictEqual(rawIdentity(destination), rawIdentity(item.raw))) throw failure('STORAGE_DEPOSIT_UNCONFIRMED')
            entry.transferred += count
            const total = cp.deposited.find(d => d.name === item.name); if (total) total.count += count; else cp.deposited.push({ name: item.name, count })
            cp.intent = null; await save()
          }
        }
        if (cp.kind !== 'shulker') { close(); cp.stage = 'completed'; await save(); guard(); return result(cp.full ? 'full' : 'completed') }
        const rawSlots = Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot))
        if (chest.snapshot().contentsKnown !== true || !readContainerContents(rawSlots, { resolveName: id => crafting.itemNameOf?.(id) }).known) throw failure('STORAGE_CONTENTS_UNKNOWN')
        cp.expectedContents = pack(rawSlots); cp.stage = 'packed'; await save(); close()
        current = guard()
        cp.recoveryBaseline = current.items.filter(item => isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId }))
        cp.stage = 'breaking'; cp.intent = { type: 'break', position: copy(cp.positions[0]) }; await save()
      }
      guard()
      if (!cp.expectedContents || !Array.isArray(cp.recoveryBaseline) || cp.placed.length !== 1) throw failure('STORAGE_RECOVERY_UNOBSERVED')
      const owned = cp.placed[0], expected = unpack(cp.expectedContents)
      if (!air(owned.position)) {
        if (!placedCurrent(cp, owned)) throw failure('STORAGE_OWNED_BLOCK_CHANGED')
        const current = guard()
        if (!air(cp.stand) || !air({ ...cp.stand, y: cp.stand.y + 1 }) || !support(cp.stand) || canPlace(cp.stand) !== true) throw failure('STORAGE_STAND_UNCONFIRMED')
        if (Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.y - 1.62 - cp.stand.y, current.state.position.z - cp.stand.z - 0.5) > 0.7) await perform('movement', () => moveTo(copy(cp.stand), { signal }))
        close()
        await perform('mining', async () => {
          await mine({ ...copy(owned.position), accessPreparation: 'owned_shulker', ownershipKey: cp.operationId, expectedName: owned.name, expectedRuntimeId: owned.runtimeId }, { signal })
          await wait(() => { if (air(owned.position)) return true; const progress = getMining(); if (['failed', 'stopped'].includes(progress?.phase)) throw failure('STORAGE_BREAK_FAILED', progress.reason); return false }, 20000, 'STORAGE_BREAK_TIMEOUT')
        })
      }
      if (!air(owned.position)) throw failure('STORAGE_BREAK_UNCONFIRMED')
      cp.stage = 'awaiting_recovery'; cp.intent = null; await save()
      const oldIds = new Set(cp.recoveryBaseline.map(item => item.stackId)), beforeCount = cp.recoveryBaseline.reduce((n, item) => n + item.count, 0)
      const recovered = () => {
        const current = observe(cp), boxes = current.items.filter(item => isShulkerBox(item.name))
        if (boxes.reduce((n, item) => n + item.count, 0) !== beforeCount + 1) return null
        const candidates = boxes.filter(item => item.name === owned.name && item.count === 1 && !oldIds.has(item.stackId) && compareShulkerContents(item.raw, expected, { resolveName: id => crafting.itemNameOf?.(id) }).matches === true)
        return candidates.length === 1 ? candidates[0] : null
      }
      let box = recovered()
      if (!box) {
        guard()
        if (!air(owned.position) || !air({ ...owned.position, y: owned.position.y + 1 }) || !support(owned.position)) throw failure('STORAGE_PICKUP_STAND_UNKNOWN')
        await perform('movement', () => moveTo(copy(owned.position), { signal }))
        box = await wait(recovered, 10000, 'STORAGE_RECOVERY_UNCONFIRMED')
      }
      cp.recovered = { name: box.name, slot: box.slot, stackId: box.stackId, key: carriedContainerKey(box), confirmedBy: 'received_air_and_new_inventory_box_with_exact_contents' }
      cp.stage = 'completed'; await save(); guard()
      return result(cp.full ? 'full' : 'completed')
    } catch (error) {
      cancel()
      return result('blocked', error.code ?? String(error.message ?? error))
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (active === run) active = null
    }
  }
  return { storeCarried, ownsShulker }
}

module.exports = { createQuarryPortableStorage }
