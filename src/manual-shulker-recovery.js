'use strict'

const { isDeepStrictEqual } = require('node:util')
const { readContainerContents, readShulkerContents } = require('./shulker-contents')
const { isShulkerBox, isShulkerBlock, sameWindowId, storageContainerType, storageWindowMatches } = require('./container-types')
const { isCurrentBlockedGroundProof } = require('./ground-access-proof')

const copy = value => structuredClone(value)
const fail = code => Object.assign(new Error(code), { code })
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)
const same = (a, b) => point(a) && point(b) && ['x', 'y', 'z'].every(k => a[k] === b[k])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const UNSAFE = /water|lava|fire|magma|cactus|campfire|sand$|gravel$|concrete_powder|anvil|scaffolding|powder_snow|dripstone/
const DURABLE = /_(?:pickaxe|shovel|axe|hoe|sword)$|^minecraft:(?:bow|crossbow|shears|trident|fishing_rod|flint_and_steel)$/
const rawKnown = r => r && Number.isInteger(r.network_id) && Number.isInteger(r.count) && (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.count <= 127 && r.has_stack_id === true && Number.isSafeInteger(r.stack_id) && r.stack_id > 0)
const scopeOf = s => {
  const life = s?.lifecycle?.deathId ?? s?.deathId
  if (!s?.profile || s.realm?.id == null || !s.dimension || !s.connectionId || !s.startedAt || s.runtimeEntityId == null || !Number.isSafeInteger(life) || life < 0) throw fail('MANUAL_RECOVERY_SCOPE_UNKNOWN')
  return { profile: s.profile, realmId: String(s.realm.id), dimension: s.dimension, connectionId: s.connectionId, startedAt: s.startedAt, runtimeEntityId: String(s.runtimeEntityId), life }
}

function validateRecoveryDocument (input) {
  const d = copy(input)
  if (!d || d.version !== 1 || d.authority !== 'user_authorized_existing_box' || !/^[A-Za-z0-9_-]{1,80}$/.test(d.id ?? '') || d.operationId !== `manual_shulker:${d.id}` || !point(d.position) || !isShulkerBlock(d.name) || !d.world?.profile || typeof d.world.realmId !== 'string' || !d.world.realmId || !d.world.dimension || !Number.isFinite(Date.parse(d.authorizedAt)) || !['prepared', 'verified', 'breaking', 'awaiting_recovery', 'completed'].includes(d.stage)) throw fail('MANUAL_RECOVERY_DOCUMENT_INVALID')
  const expected = d.expectedContents
  if (expected?.known !== true || expected.slotCount !== 27 || !Array.isArray(expected.slots) || expected.slots.length !== 27 || Buffer.byteLength(JSON.stringify(expected)) > 131072) throw fail('MANUAL_RECOVERY_EXPECTED_CONTENTS_INVALID')
  for (let slot = 0; slot < 27; slot++) {
    const item = expected.slots[slot]
    if (item == null) continue
    if (item.slot !== slot || !/^minecraft:[a-z0-9_]+$/.test(item.name ?? '') || item.name === 'minecraft:air' || !Number.isInteger(item.count) || item.count < 1 || item.count > 127 || !Number.isInteger(item.metadata) || item.metadata < 0 || item.metadata > 65535 || item.tag != null && (item.tag.type !== 'compound' || !item.tag.value || typeof item.tag.value !== 'object' || Array.isArray(item.tag.value))) throw fail('MANUAL_RECOVERY_EXPECTED_CONTENTS_INVALID')
  }
  if (d.stage !== 'prepared' && !d.scope || ['breaking', 'awaiting_recovery', 'completed'].includes(d.stage) && (!Number.isSafeInteger(d.runtimeId) || d.runtimeId < 0 || d.runtimeId > 4294967295 || !Array.isArray(d.baseline?.boxes) || !Number.isSafeInteger(d.baseline?.count))) throw fail('MANUAL_RECOVERY_DOCUMENT_INVALID')
  if (d.baseline && (d.baseline.boxes.some(i => !isShulkerBox(i.name) || i.count !== 1 || !Number.isSafeInteger(i.stackId) || i.stackId < 1) || new Set(d.baseline.boxes.map(i => i.stackId)).size !== d.baseline.boxes.length || d.baseline.count !== d.baseline.boxes.length)) throw fail('MANUAL_RECOVERY_DOCUMENT_INVALID')
  if (d.stage === 'breaking' && (d.intent?.type !== 'break' || d.intent.mayHaveBeenSent !== true) || ['prepared', 'verified', 'awaiting_recovery', 'completed'].includes(d.stage) && d.intent != null) throw fail('MANUAL_RECOVERY_DOCUMENT_INVALID')
  if (d.stage === 'completed') {
    const r = d.receipt
    if (r?.confirmedBy !== 'received_air_and_new_inventory_box_with_exact_contents' || r.authority !== d.authority || r.operationId !== d.operationId || !same(r.position, d.position) || !isDeepStrictEqual(r.scope, d.scope) || r.name !== d.name || !Number.isInteger(r.slot) || r.slot < 0 || r.slot >= 36 || !Number.isSafeInteger(r.stackId) || r.stackId < 1 || d.baseline.boxes.some(i => i.stackId === r.stackId) || r.beforeBoxCount !== d.baseline.count || r.afterBoxCount !== d.baseline.count + 1 || !Number.isFinite(Date.parse(r.receivedAt))) throw fail('MANUAL_RECOVERY_DOCUMENT_INVALID')
  } else if (d.receipt != null) throw fail('MANUAL_RECOVERY_DOCUMENT_INVALID')
  return d
}

function createRecoveryDocument ({ id, world, position, name = 'minecraft:undyed_shulker_box', expectedContents, authorizedAt = new Date().toISOString() }) {
  return validateRecoveryDocument({ version: 1, id, operationId: `manual_shulker:${id}`, authority: 'user_authorized_existing_box', world: copy(world), position: copy(position), name, expectedContents: copy(expectedContents), authorizedAt, stage: 'prepared', scope: null, intent: null, receipt: null })
}

function createManualShulkerRecovery ({ getState, getBlock, crafting, chest, refreshInventory, prepareHand, mine, getMining, stopMining, moveTo, getEntities, canAct, getGroundAccessProof = null, captureActionOwner = null, runActionOwned = null, cancelAction = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if ([getState, getBlock, refreshInventory, prepareHand, mine, getMining, stopMining, moveTo, getEntities, canAct, cancelAction].some(fn => typeof fn !== 'function') || typeof crafting?.rawItem !== 'function' || typeof crafting?.itemNameOf !== 'function' || typeof chest?.open !== 'function' || typeof chest?.rawItem !== 'function' || typeof chest?.snapshot !== 'function') throw new Error('Manual recovery requires observed normal-action ports')
  if ((captureActionOwner !== null || runActionOwned !== null) && (typeof captureActionOwner !== 'function' || typeof runActionOwned !== 'function')) throw new Error('Manual recovery ownership ports must be paired')
  if (getGroundAccessProof !== null && typeof getGroundAccessProof !== 'function') throw new Error('Manual recovery ground proof must be a read-only callback')
  let active = null, lastResult = null
  const read = p => getBlock(p.x, p.y, p.z)
  const air = p => { const b = read(p); return b?.known === true && AIR.has(b.name) && !b.extra?.length }
  const safeCell = p => { const floor = read({ ...p, y: p.y - 1 }); return air(p) && air({ ...p, y: p.y + 1 }) && floor?.known === true && floor.boundingBox === 'block' && !floor.extra?.length && !UNSAFE.test(floor.name ?? '') }
  const craftState = () => crafting.inventorySnapshot?.() ?? crafting.snapshot()
  function inventory () {
    const observed = craftState(), s = getState()
    if (s.inventory?.known !== true || s.inventory.uncertain || observed.inventoryKnown !== true || observed.authority !== true || observed.pendingRequestId != null) throw fail('MANUAL_RECOVERY_INVENTORY_UNKNOWN')
    const items = []
    for (let slot = 0; slot < 36; slot++) {
      const raw = crafting.rawItem(slot)
      if (!rawKnown(raw)) throw fail('MANUAL_RECOVERY_INVENTORY_UNKNOWN')
      if (!raw.count) continue
      const name = crafting.itemNameOf(raw.network_id)
      if (typeof name !== 'string') throw fail('MANUAL_RECOVERY_ITEM_UNKNOWN')
      items.push({ slot, name, count: raw.count, stackId: raw.stack_id, raw })
    }
    if (new Set(items.map(i => i.stackId)).size !== items.length) throw fail('MANUAL_RECOVERY_INVENTORY_UNKNOWN')
    return items
  }
  function guard (proposedPosition = null) {
    if (!active) throw fail('MANUAL_RECOVERY_NOT_ACTIVE')
    if (active.failure) throw active.failure
    active.signal?.throwIfAborted()
    const actual = getState(), s = proposedPosition ? { ...actual, position: proposedPosition } : actual, scope = scopeOf(s), d = active.doc
    if (s.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || s.spawnPending || !(s.health >= 14) || !['survival', 0].includes(s.gameMode)) throw fail('MANUAL_RECOVERY_NOT_SAFE')
    if (!isDeepStrictEqual(scope, active.scope) || d.scope && !isDeepStrictEqual(scope, d.scope) || scope.profile !== d.world.profile || scope.realmId !== d.world.realmId || scope.dimension !== d.world.dimension) throw fail('MANUAL_RECOVERY_SCOPE_CHANGED')
    if (canAct(s) !== true) throw fail('MANUAL_RECOVERY_CONTROL_CHANGED')
    const actors = getEntities()
    if (!Array.isArray(actors) || actors.some(e => {
      if (e.alive === false || String(e.runtimeId) === scope.runtimeEntityId || e.kind !== 'mob' || e.hostile === false) return false
      if (e.positionKnown !== true || !e.position || !['x', 'y', 'z'].every(k => Number.isFinite(e.position[k]))) return true
      const distance = Math.hypot(e.position.x - s.position.x, e.position.y - s.position.y + 1.62, e.position.z - s.position.z)
      if (distance > 16) return false
      if (distance <= 3 || e.primed === true || !getGroundAccessProof) return true
      try {
        const proof = getGroundAccessProof(copy(e), copy(s))
        const latest = getState()
        if (!isDeepStrictEqual(scopeOf(latest), scope) || latest.worldRevision !== s.worldRevision || !isDeepStrictEqual(latest.position, actual.position)) return true
        return !isCurrentBlockedGroundProof(proof, e, s, now())
      } catch { return true }
    })) throw fail('MANUAL_RECOVERY_DANGER')
    if (!s.position || !['x', 'y', 'z'].every(k => Number.isFinite(s.position[k]))) throw fail('MANUAL_RECOVERY_POSITION_UNKNOWN')
    const feet = { x: Math.floor(s.position.x), y: Math.floor(s.position.y - 1.62 + 0.001), z: Math.floor(s.position.z) }
    if (Math.abs(s.position.y - 1.62 - feet.y) > 0.06 || !safeCell(feet)) throw fail('MANUAL_RECOVERY_UNSAFE_STANCE')
    if (Math.hypot(s.position.x - d.position.x - 0.5, s.position.y - 1.62 - d.position.y, s.position.z - d.position.z - 0.5) > 6) throw fail('MANUAL_RECOVERY_OUT_OF_REACH')
    return s
  }
  function cancelCurrent (reason) {
    const a = active?.action
    if (!a || a.cancelled) return
    a.cancelled = true
    try { cancelAction(a.kind, reason, a.owner) } catch {}
    if (a.kind === 'mining') { try { stopMining(reason, a.owner) } catch {} }
  }
  function cancel (reason = 'MANUAL_RECOVERY_ABORTED') { if (active) { active.failure ??= fail(reason); cancelCurrent(reason) } return snapshot() }
  function beforeInput (frame) {
    if (active) {
      guard()
      // Native movement predicts feet; a stationary mining frame can omit it.
      const feet = frame?.predictedState?.position
      if (feet) {
        if (!['x', 'y', 'z'].every(k => Number.isFinite(feet[k]))) throw fail('MANUAL_RECOVERY_POSITION_UNKNOWN')
        guard({ x: feet.x, y: feet.y + 1.62, z: feet.z })
      }
    }
    return true
  }
  function ownsShulker (state, target, block) {
    try {
      guard()
      const d = active.doc
      return ['breaking', 'awaiting_recovery'].includes(d.stage) && isDeepStrictEqual(scopeOf(state), d.scope) && target?.accessPreparation === 'owned_shulker' && target.ownershipKey === d.operationId && same(target, d.position) && target.expectedName === d.name && target.expectedRuntimeId === d.runtimeId && block?.known === true && !block.extra?.length && (AIR.has(block.name) || block.name === d.name && block.runtimeId === d.runtimeId)
    } catch { return false }
  }
  function snapshot () {
    const d = active?.doc
    return { busy: !!active, phase: d?.stage ?? lastResult?.checkpoint?.stage ?? 'idle', id: d?.id ?? null, operationId: d?.operationId ?? null, position: d?.position ?? null, scope: d?.scope ?? null, target: d ? { ...d.position, accessPreparation: 'owned_shulker', ownershipKey: d.operationId, expectedName: d.name, expectedRuntimeId: d.runtimeId } : null, lastResult: copy(lastResult) }
  }
  async function run (document, { signal, onCheckpoint } = {}) {
    if (active) return { status: 'blocked', reason: 'MANUAL_RECOVERY_BUSY', serverConfirmed: false, checkpoint: copy(document) }
    let d = validateRecoveryDocument(document), durable = copy(d)
    if (typeof onCheckpoint !== 'function') throw fail('MANUAL_RECOVERY_PERSISTENCE_REQUIRED')
    const execution = active = { doc: d, scope: scopeOf(getState()), signal, action: null, failure: null }
    const save = async () => { try { await onCheckpoint(copy(d)); durable = copy(d) } catch { d = copy(durable); execution.doc = d; throw fail('MANUAL_RECOVERY_PERSISTENCE_FAILED') } }
    const action = async (kind, fn) => {
      guard(); const a = { kind, owner: captureActionOwner?.(kind, { jobId: d.id, operationId: d.operationId }) ?? null }; execution.action = a
      try { return await (runActionOwned ? runActionOwned(a.owner, fn) : fn()) } finally { if (execution.action === a) execution.action = null }
    }
    const wait = async (predicate, limit, code) => { const until = now() + limit; for (;;) { guard(); const found = predicate(); if (found) return found; if (now() >= until) throw fail(code); await sleep(50) } }
    const result = (status, reason) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status === 'completed', checkpoint: copy(d), ...(d.receipt ? { receipt: copy(d.receipt) } : {}) })
    const abort = () => cancel('MANUAL_RECOVERY_ABORTED')
    signal?.addEventListener('abort', abort, { once: true })
    const monitor = setInterval(() => { try { guard() } catch (error) { execution.failure ??= error; cancelCurrent(error.code ?? error.message) } }, 25)
    try {
      guard()
      if (d.stage === 'completed') { if (!d.receipt) throw fail('MANUAL_RECOVERY_RECEIPT_MISSING'); return lastResult = result('completed') }
      if (await action('inventory', () => refreshInventory({ signal })) !== true) throw fail('MANUAL_RECOVERY_FRESH_MAIN_REQUIRED')
      guard(); let items = inventory()
      if (items.length >= 36) throw fail('MANUAL_RECOVERY_FREE_SLOT_REQUIRED')
      if (['prepared', 'verified'].includes(d.stage)) {
        const b = read(d.position)
        if (b?.known !== true || b.name !== d.name || !Number.isSafeInteger(b.runtimeId) || b.runtimeId < 0 || b.runtimeId > 4294967295 || b.extra?.length) throw fail('MANUAL_RECOVERY_TARGET_CHANGED')
        const oldOpen = craftState().openContainer
        if (oldOpen) {
          const w = chest.snapshot().window
          if (!same(oldOpen.coordinates, d.position) || !same(w?.position, d.position) || !sameWindowId(oldOpen.id, w?.id) || !isDeepStrictEqual(w?.scope, execution.scope) || !storageWindowMatches(oldOpen.type, storageContainerType(d.name))) throw fail('MANUAL_RECOVERY_FOREIGN_WINDOW')
          crafting.closeContainer()
        }
        const priorEpoch = chest.snapshot().window?.epoch ?? -1
        const opened = await action('chest', () => chest.open(copy(d.position), undefined, { expectedSlots: 27 }))
        guard(); const observed = chest.snapshot(), w = observed.window, open = craftState().openContainer
        if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !same(opened.position, d.position) || observed.contentsKnown !== true || observed.slotCount !== 27 || w?.replayed || !(w?.epoch > priorEpoch) || !same(w.position, d.position) || !isDeepStrictEqual(w.scope, execution.scope) || !same(open?.coordinates, d.position) || !sameWindowId(open?.id, opened.windowId)) throw fail('MANUAL_RECOVERY_FRESH_CONTENTS_REQUIRED')
        const contents = readContainerContents(Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot)), { resolveName: id => crafting.itemNameOf(id) })
        if (!contents.known || !isDeepStrictEqual(contents.slots, d.expectedContents.slots)) throw fail('MANUAL_RECOVERY_CONTENTS_CHANGED')
        d.scope = copy(execution.scope); d.runtimeId = b.runtimeId; d.stage = 'verified'; d.verifiedAt = new Date(now()).toISOString(); await save(); guard()
        guard(); const latestWindow = chest.snapshot().window, latestOpen = craftState().openContainer
        if (!latestOpen || !sameWindowId(latestOpen.id, opened.windowId) || !same(latestOpen.coordinates, d.position) || latestWindow?.epoch !== w.epoch || !isDeepStrictEqual(latestWindow?.scope, d.scope)) throw fail('MANUAL_RECOVERY_WINDOW_CHANGED')
        crafting.closeContainer()
        if (await action('equip', () => prepareHand({ signal })) === false) throw fail('MANUAL_RECOVERY_HAND_UNCONFIRMED')
        guard(); if (craftState().openContainer) throw fail('MANUAL_RECOVERY_FOREIGN_WINDOW')
        items = inventory()
        const boxes = items.filter(i => isShulkerBox(i.name))
        d.baseline = { count: boxes.reduce((n, i) => n + i.count, 0), boxes: boxes.map(({ name, count, stackId }) => ({ name, count, stackId })) }
        d.stage = 'breaking'; d.intent = { type: 'break', mayHaveBeenSent: true }; await save(); guard()
        await action('mining', async () => {
          const s = guard(), held = crafting.rawItem(s.rawServerSelectedSlot ?? s.rawSelectedSlot ?? s.selectedSlot)
          if (!rawKnown(held) || held.count && (typeof crafting.itemNameOf(held.network_id) !== 'string' || DURABLE.test(crafting.itemNameOf(held.network_id)))) throw fail('MANUAL_RECOVERY_HAND_UNCONFIRMED')
          const current = read(d.position)
          if (current?.known !== true || current.name !== d.name || current.runtimeId !== d.runtimeId || current.extra?.length) throw fail('MANUAL_RECOVERY_TARGET_CHANGED')
          await mine({ ...d.position, accessPreparation: 'owned_shulker', ownershipKey: d.operationId, expectedName: d.name, expectedRuntimeId: d.runtimeId }, { signal })
          await wait(() => { if (air(d.position)) return true; const mining = getMining(); if (['failed', 'stopped'].includes(mining?.phase)) throw fail('MANUAL_RECOVERY_BREAK_FAILED'); return false }, 20000, 'MANUAL_RECOVERY_BREAK_TIMEOUT')
        })
      } else if (!air(d.position)) throw fail('MANUAL_RECOVERY_BREAK_UNCONFIRMED')
      guard(); if (!air(d.position)) throw fail('MANUAL_RECOVERY_AIR_UNCONFIRMED')
      d.stage = 'awaiting_recovery'; d.intent = null; await save()
      const baselineIds = new Set(d.baseline.boxes.map(i => i.stackId))
      const recovered = () => {
        const boxes = inventory().filter(i => isShulkerBox(i.name))
        if (boxes.reduce((n, i) => n + i.count, 0) !== d.baseline.count + 1) return null
        if (d.baseline.boxes.some(before => !boxes.some(i => i.stackId === before.stackId && i.name === before.name && i.count === before.count))) return null
        const added = boxes.filter(i => !baselineIds.has(i.stackId))
        if (added.length !== 1 || added[0].name !== d.name || added[0].count !== 1) return null
        const contents = readShulkerContents(added[0].raw, { resolveName: id => crafting.itemNameOf(id) })
        return contents.known && isDeepStrictEqual(contents.slots, d.expectedContents.slots) ? added[0] : null
      }
      let box = recovered()
      if (!box) {
        if (!safeCell(d.position)) throw fail('MANUAL_RECOVERY_UNSAFE_PICKUP')
        await action('movement', () => moveTo(copy(d.position), { signal, beforeInput }))
        box = await wait(recovered, 10000, 'MANUAL_RECOVERY_PICKUP_UNCONFIRMED')
      }
      guard()
      d.receipt = { confirmedBy: 'received_air_and_new_inventory_box_with_exact_contents', authority: d.authority, operationId: d.operationId, position: copy(d.position), scope: copy(d.scope), name: box.name, slot: box.slot, stackId: box.stackId, beforeBoxCount: d.baseline.count, afterBoxCount: d.baseline.count + 1, receivedAt: new Date(now()).toISOString() }
      d.stage = 'completed'; await save()
      return lastResult = result('completed')
    } catch (error) { cancelCurrent(error.code ?? error.message); return lastResult = result('blocked', error.code ?? String(error.message ?? error)) } finally { clearInterval(monitor); signal?.removeEventListener('abort', abort); if (active === execution) active = null }
  }
  return { run, snapshot, cancel, beforeInput, ownsShulker }
}

module.exports = { createRecoveryDocument, validateRecoveryDocument, createManualShulkerRecovery }
