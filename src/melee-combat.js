'use strict'

const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const { isDeepStrictEqual } = require('node:util')
const { selectMeleeWeapon } = require('./melee-weapons')

const { isAttackableHostileType } = require('./mob-catalog')
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const WATER = new Set(['minecraft:water', 'minecraft:flowing_water'])
const PLANTS = new Set(['torch', 'leaf_litter', 'grass', 'short_grass', 'tall_grass', 'tallgrass', 'fern', 'large_fern', 'deadbush', 'dead_bush', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass', 'wildflowers', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'pink_petals'].map(n => `minecraft:${n}`))
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000001)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const copy = value => structuredClone(value)
// Bounded wait for the next fresh modeled pose after an input handover.
const POSE_SETTLE_MS = 400
const MAX_POSE_RETRIES = 3
function id (value, signed = false) {
  if (value == null || typeof value === 'number' && !Number.isSafeInteger(value) || typeof value === 'string' && !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null
  try { const n = BigInt(value); return n >= (signed ? -(1n << 63n) : 0n) && n < 1n << (signed ? 63n : 64n) ? String(n) : null } catch { return null }
}
function failure (message, code) { return Object.assign(new Error(message), { code }) }
const logBinding = (state, target) => ({
  runtimeId: id(target.runtimeId), uniqueId: id(target.uniqueId, true),
  scope: { connectionId: String(state.connectionId).slice(0, 120), startedAt: String(state.startedAt).slice(0, 80), dimension: state.dimension, selfRuntimeId: id(state.runtimeEntityId) },
  life: state.lifecycle?.deathId ?? state.deathId ?? null
})
const EMERGENCY_REACH = 3.5 // cornered creeper, no approach path: swing from where the bot stands
function bodyAim (target) { return { ...target.position, y: target.position.y + (['minecraft:spider', 'minecraft:cave_spider', 'minecraft:silverfish', 'minecraft:endermite', 'minecraft:slime', 'minecraft:magma_cube', 'minecraft:vex', 'minecraft:phantom'].includes(target.entityType) ? 0.2 : 0.9) } }
function descendingCriticalFrame (movement, criticalHopId, { wallNow = Date.now(), workingPosition } = {}) {
  const m = movement; const p = m?.physicsState
  if (!m || m.criticalHopId == null || String(m.criticalHopId) !== String(criticalHopId) || m.route?.operation !== 'critical_hop' || m.phase !== 'moving' || m.running !== true || m.queuedReceiptConfirmed !== true || id(m.queuedTick ?? m.actualQueuedTick) === null || !Number.isFinite(m.queuedAt) || !Number.isFinite(wallNow) || wallNow - m.queuedAt < 0 || wallNow - m.queuedAt > 200) return false
  if (!finite(p?.position) || !finite(p?.velocity) || p.onGround !== false || m.onGround !== false || !Number.isFinite(m.velocity?.y) || p.velocity.y >= -0.001 || Math.abs(m.velocity.y - p.velocity.y) > 1e-6 || p.isInWater || p.isInLava || p.isInWeb || p.flying || p.elytraFlying || p.riding || p.swimmingPose || p.effects?.blindness) return false
  const pair = m.criticalHopQueuedPair
  if (!pair || String(pair.criticalHopId) !== String(criticalHopId) || !Number.isFinite(pair.deltaY) || pair.deltaY >= 0) return false
  const previous = pair.previous, current = pair.current
  for (const frame of [previous, current]) {
    if (!frame || String(frame.criticalHopId) !== String(criticalHopId) || frame.receiptConfirmed !== true || id(frame.tick) === null || !finite(frame.position) || !Number.isFinite(frame.packetY) || frame.packetY !== Math.fround(frame.position.y) || frame.onGround !== false || !Number.isFinite(frame.queuedAt) || wallNow - frame.queuedAt < 0 || wallNow - frame.queuedAt > 200) return false
  }
  if (BigInt(current.tick) !== BigInt(previous.tick) + 1n || String(current.tick) !== String(m.queuedTick ?? m.actualQueuedTick) || current.queuedAt !== m.queuedAt || current.queuedAt < previous.queuedAt || pair.deltaY !== current.packetY - previous.packetY) return false
  const eye = { ...p.position, y: p.position.y + 1.62 }
  if (distance(current.position, eye) > 1e-4) return false
  return finite(workingPosition) && distance(eye, workingPosition) <= 0.02
}

function createMeleeCombat ({ log = () => {}, client, getState, getRawState, world, entities, crafting, equip, cancelEquip = null, getInput, previewHop = null, startHop = null, getMovement = null, stopHop = null, getItemComponents = null, getTargetWet = null, isBusy = () => false, version = '1.26.60', reach = 3.0, cooldownMs = 100, now = () => performance.now(), wallNow = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }) }) {
  if (version !== '1.26.60') throw new Error('Melee combat supports Bedrock 1.26.60 only')
  if ([getState, getRawState, equip, getInput, isBusy, now, wallNow, sleep].some(f => typeof f !== 'function') || typeof client?.queue !== 'function' || typeof world?.getBlock !== 'function' || typeof entities?.snapshot !== 'function' || typeof crafting?.snapshot !== 'function' || typeof crafting?.rawItem !== 'function') throw new Error('Melee combat requires authoritative/working poses, terrain, actors, confirmed equipment and input')
  if ([cancelEquip, previewHop, startHop, getMovement, stopHop, getItemComponents, getTargetWet].some(f => f != null && typeof f !== 'function') || !(reach > 0 && reach <= 3.0) || !(cooldownMs >= 50 && cooldownMs <= 750)) throw new Error('Invalid melee callbacks, reach or Bedrock cooldown')
  if ([previewHop, startHop, getMovement].some(Boolean) && ![previewHop, startHop, getMovement, stopHop].every(f => typeof f === 'function')) throw new Error('Native hop requires preview/start/snapshot and ID-matched stop callbacks')
  let run = null; let task = null; let lastResult = null; let lastAttack = -Infinity; let lifeEpoch = 0
  const clock = () => { const t = now(); if (!Number.isFinite(t)) throw new Error('Invalid melee clock'); return t }
  const baseScope = s => JSON.stringify([s?.profile, s?.realm?.id == null ? null : String(s.realm.id), s?.dimension, s?.connectionId, s?.startedAt, id(s?.runtimeEntityId)])
  const fullScope = s => JSON.stringify([baseScope(s), s?.lifecycle?.deathId ?? s?.deathId ?? null, lifeEpoch])
  clock()

  const poseStamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  function currentPose (state, rawPosition) {
    if (state.positionSource === 'client_prediction') {
      const p = state.predicted, physical = p?.physicsState
      const updatedAt = poseStamp(p?.updatedAt), stateUpdatedAt = poseStamp(state.positionUpdatedAt), wall = wallNow()
      if (!finite(p?.position) || !finite(physical?.position) || !finite(physical?.velocity) || !finite(p?.velocity) || distance(p.position, state.position) > 1e-4 || distance({ ...physical.position, y: physical.position.y + 1.62 }, state.position) > 1e-4 || distance(p.velocity, physical.velocity) > 1e-6 || p.feetPosition != null && (!finite(p.feetPosition) || distance(p.feetPosition, physical.position) > 1e-4) || typeof physical.onGround !== 'boolean' || p.onGround !== physical.onGround || !['survival', 0].includes(physical.gameMode) || p.source !== 'client_prediction' || p.serverConfirmed === true || state.positionServerConfirmed === true || !Number.isFinite(updatedAt) || !Number.isFinite(stateUpdatedAt) || updatedAt !== stateUpdatedAt || !Number.isFinite(wall) || wall - updatedAt < 0 || wall - updatedAt > 200) throw failure('Current modeled pose is missing, mismatched or stale', 'POSE_UNTRUSTED')
      return { kind: 'current_model', source: state.positionSource, updatedAt: p.updatedAt, ageMs: wall - updatedAt, predictionOnly: true }
    }
    if (!['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(state.positionSource) || state.positionServerConfirmed === false || distance(state.position, rawPosition) > 1e-4) throw failure('Current received pose does not match its authoritative anchor', 'POSE_UNTRUSTED')
    // A stationary received pose needs no heartbeat. Only model frames carry
    // the existing 200ms freshness requirement; neither kind fabricates an ACK.
    return { kind: 'received_pose', source: state.positionSource, updatedAt: state.positionUpdatedAt ?? null, ageMs: null, predictionOnly: false }
  }
  function session (includeInventory = true) {
    const state = getState(); const raw = getRawState()
    const inventory = !includeInventory && typeof crafting.status === 'function' ? crafting.status() : typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot()
    if (state?.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || !(Number.isFinite(state.health) && state.health > 0) || state.lifecycle?.dead || raw?.dead || raw?.isDead || raw?.lifecycle?.dead || raw?.spawnPending || raw?.phase !== 'spawned' || !(Number.isFinite(raw?.health) && raw.health > 0)) throw failure('Attacker must be alive in the spawned world', 'NOT_ALIVE')
    if (!['survival', 0].includes(state.gameMode)) throw failure('Melee combat requires survival mode', 'GAME_MODE')
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || id(state.realm.id) === null || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !['overworld', 'nether', 'end'].includes(state.dimension) || id(state.runtimeEntityId) === null || baseScope(state) !== baseScope(raw)) throw failure('Authoritative and working session scopes must agree', 'SCOPE_UNKNOWN')
    const life = state.lifecycle?.deathId ?? state.deathId, rawLife = raw.lifecycle?.deathId ?? raw.deathId
    if (!Number.isSafeInteger(life) || life < 0 || life !== rawLife) throw failure('Authoritative and working life scopes must agree', 'SCOPE_UNKNOWN')
    const rawPosition = raw.rawServerPosition ?? raw.position
    if (!finite(state.position) || !finite(rawPosition)) throw failure('Both the raw anchor and current working eye positions are required', 'POSITION_UNKNOWN')
    const pose = currentPose(state, rawPosition)
    if (inventory.authority !== true || inventory.inventoryKnown !== true || state.inventory?.known !== true || state.inventory.uncertain || inventory.pendingRequestId != null) throw failure('Server-confirmed inventory required', 'INVENTORY_UNKNOWN')
    const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    if (!Number.isInteger(selected) || selected < 0 || selected > 8) throw failure('Server-selected hotbar slot required', 'SELECTED_SLOT_UNKNOWN')
    return { state, raw, rawPosition, pose, inventory, selected, scope: fullScope(state) }
  }
  function passable (p) {
    const b = world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    return b?.known === true && !b.extra?.length && (AIR.has(b.name) || b.boundingBox === 'empty' && (WATER.has(b.name) || PLANTS.has(b.name)))
  }
  function sight (from, to) {
    const axes = ['x', 'y', 'z']; const cell = {}; const step = {}; const next = {}; const delta = {}
    const check = p => { if (!passable(p)) throw failure('Melee sight line is blocked or unknown', 'LOS_BLOCKED') }
    for (const k of axes) { cell[k] = Math.floor(from[k]); const d = to[k] - from[k]; step[k] = Math.sign(d); delta[k] = d ? 1 / Math.abs(d) : Infinity; next[k] = d ? (cell[k] + Number(d > 0) - from[k]) / d : Infinity }
    check(cell)
    for (let count = 0; count < 64; count++) {
      const crossing = Math.min(...axes.map(k => next[k])); if (crossing > 1) return
      const crossed = axes.filter(k => Math.abs(next[k] - crossing) < 1e-10)
      for (let mask = 1; mask < 1 << crossed.length; mask++) { const p = { ...cell }; crossed.forEach((k, i) => { if (mask & 1 << i) p[k] += step[k] }); check(p) }
      for (const k of crossed) { cell[k] += step[k]; next[k] += delta[k] }
    }
    throw failure('Melee sight traversal bound reached', 'LOS_BLOCKED')
  }
  function actorGuards (s, target, aim, all) {
    for (const e of all) {
      if (id(e.runtimeId) === id(target.runtimeId) || id(e.runtimeId) === id(s.state.runtimeEntityId) || e.alive === false || e.kind === 'item' || e.entityType === 'minecraft:arrow' || e.dimension != null && e.dimension !== s.state.dimension) continue
      if (e.positionKnown !== true || !finite(e.position)) throw failure('Another actor position is unknown', 'ACTOR_UNKNOWN')
      const player = e.kind === 'player' || e.entityType === 'minecraft:player'
      if (player && (e.dimension !== s.state.dimension || id(e.runtimeId) === null)) throw failure('Another player identity or world scope is unknown', 'ACTOR_UNKNOWN')
      if (e.hostile === true && !player) continue
      const center = { ...e.position, y: e.position.y + 0.9 }; const v = { x: aim.x - s.state.position.x, y: aim.y - s.state.position.y, z: aim.z - s.state.position.z }; const length = distance(s.state.position, aim)
      const t = ((center.x - s.state.position.x) * v.x + (center.y - s.state.position.y) * v.y + (center.z - s.state.position.z) * v.z) / (length * length)
      if (t < 0 || t > 1) continue
      const p = { x: s.state.position.x + v.x * t, y: s.state.position.y + v.y * t, z: s.state.position.z + v.z * t }
      if (Math.hypot(center.x - p.x, center.z - p.z) <= 0.7 && Math.abs(center.y - p.y) <= 1.5) throw failure('A friendly actor intersects the melee aim', 'FRIENDLY_IN_PATH')
    }
  }
  // reachLimit: a per-call working reach (never below the normal reach, at most
  // EMERGENCY_REACH) for a cornered creeper that has no approach path.
  const limitOf = value => Number.isFinite(value) ? Math.min(EMERGENCY_REACH, Math.max(reach, value)) : null
  function plan (runtimeId, expected = null, { allowHopHeight = false, hopTracking = false, reachLimit = null } = {}) {
    const limit = limitOf(reachLimit) ?? run?.reachLimit ?? reach
    const s = session(); const targetId = id(runtimeId); const all = entities.snapshot({ kind: 'all' })
    const target = targetId === null ? null : all.find(e => id(e.runtimeId) === targetId)
    if (!target || target.kind !== 'mob' || target.hostile !== true || !isAttackableHostileType(target.entityType) || target.alive !== true || target.positionKnown !== true || !finite(target.position) || target.dimension !== s.state.dimension || id(target.uniqueId, true) === null || id(target.runtimeId) === id(s.state.runtimeEntityId) || target.positionSource === 'client_prediction') throw failure('Only a known living hostile NPC may be attacked', 'INVALID_TARGET')
    if (expected && (id(target.runtimeId) !== id(expected.runtimeId) || id(target.uniqueId, true) !== id(expected.uniqueId, true) || target.entityType !== expected.entityType)) throw failure('The bound target identity changed', 'TARGET_CHANGED')
    const aimPoint = bodyAim(target); const workingDistance = distance(s.state.position, aimPoint); const rawDistance = distance(s.rawPosition, aimPoint)
    const tracking = hopTracking && run && expected && (run.hopId != null || run.hopStarting === true) && id(expected.runtimeId) === id(run.target.runtimeId) && id(expected.uniqueId, true) === id(run.target.uniqueId, true)
    const diagnostics = { distance: workingDistance, rawDistance, currentPose: copy(s.pose), rawAnchor: { position: copy(s.rawPosition), updatedAt: s.raw.rawServerPositionUpdatedAt ?? s.raw.positionUpdatedAt ?? null, source: s.raw.positionSource ?? null, usedForCurrentGeometry: false } }
    if (!tracking && !allowHopHeight && workingDistance > limit) throw Object.assign(failure('Target is outside current working melee reach', 'OUT_OF_REACH'), { diagnostics })
    sight(s.state.position, aimPoint); actorGuards(s, target, aimPoint, all)
    const block = world.getBlock(Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z))
    const targetWet = getTargetWet ? getTargetWet(target, s.state) === true : block?.known === true && WATER.has(block.name)
    const weapon = selectMeleeWeapon({ items: s.inventory.inventory ?? [], rawItem: crafting.rawItem, selectedSlot: s.selected, target, targetWet, getItemComponents })
    if (!weapon.ready) throw failure('No proven weapon or real empty hotbar hand is available', 'WEAPON_UNKNOWN')
    return { ...s, target: copy(target), aimPoint, workingDistance, rawDistance, inReach: workingDistance <= limit, hopAimTrackable: !tracking || workingDistance <= 16, diagnostics, weapon }
  }
  function preview (runtimeId, { critical = true, reachLimit = null } = {}) {
    try { if (run || isBusy({ criticalHopId: null })) throw failure('Another action owns melee input', 'BUSY'); const p = plan(runtimeId, null, { reachLimit }); const hop = critical === false ? { ready: false, reason: 'Critical hop disabled' } : previewHop ? previewHop({ aimPoint: p.aimPoint }) : { ready: false, reason: 'Native hop unavailable' }; return { ready: true, targetRuntimeId: p.target.runtimeId, targetUniqueId: p.target.uniqueId, ...copy(p.diagnostics), reach, weapon: p.weapon, criticalHop: copy(hop), cooldownRemainingMs: Math.max(0, cooldownMs - (clock() - lastAttack)) } } catch (error) { return { ready: false, code: error.code ?? 'UNSAFE', outcome: error.code === 'OUT_OF_REACH' ? 'out_of_reach' : 'unsafe', ...copy(error.diagnostics ?? {}), errors: [error.message] } }
  }
  function assertRun (r) {
    if (run !== r || r.cancelReason) throw failure(r.cancelReason ?? 'Melee cancelled', r.code ?? 'CANCELLED')
    if (r.terminal) throw failure('Target stopped', 'TARGET_STOPPED')
    if (clock() >= r.deadline) throw failure('Melee duration limit reached', 'DURATION_LIMIT')
    const s = session(false)
    if (s.scope !== r.scope) throw failure('Connection, dimension or life changed', 'SESSION_CHANGED')
    if (isBusy({ criticalHopId: r.hopId, ordinaryInput: r.input !== null })) throw failure('Another action took input ownership', 'BUSY')
    return s
  }
  function endHop (r, reason) {
    if (r.hopId == null) return
    const hopId = r.hopId
    try { const m = getMovement?.(); if (m?.route?.operation === 'critical_hop' && String(m.criticalHopId) === String(hopId)) stopHop?.(reason, hopId) } catch {}
    r.hopId = null
  }
  function cancel (reason = 'Melee cancelled', code = 'CANCELLED') {
    if (!run || run.cancelReason) return
    const r = run; r.cancelReason = String(reason); r.code = code
    r.input?.stop(); endHop(r, reason)
    if (r.equipping) { try { cancelEquip?.(reason) } catch {} }
    r.controller.abort()
  }
  async function waitFor (r, check, timeoutMs) {
    const end = Math.min(r.deadline, clock() + timeoutMs)
    while (!check()) { assertRun(r); if (clock() >= end) throw failure('Melee observation timed out', 'OBSERVATION_TIMEOUT'); await sleep(25, r.controller.signal) }
    assertRun(r)
  }
  function heldWeapon (p) {
    const chosen = p.weapon
    if (chosen.slot !== p.selected || p.state.equipmentServerConfirmed === false || !isDeepStrictEqual(crafting.rawItem(p.selected), chosen.raw)) throw failure('The strongest proven weapon is not the confirmed real held stack', 'WEAPON_CHANGED')
    // An equip that moved the weapon via the inventory screen can leave it
    // open; close it now so the next slice can attack (the close is a request).
    if (p.inventory.openContainer) { try { crafting.closeContainer?.() } catch { /* pending craft */ } throw failure('Inventory must be closed before attacking', 'CONTAINER_OPEN') }
    return chosen
  }
  async function ensureWeapon (r) {
    let p = plan(r.target.runtimeId, r.target)
    if (p.weapon.slot !== p.selected) {
      r.equipping = true; r.phase = 'equipping'
      try {
        if (p.weapon.raw.network_id === 0) {
          const slot = p.weapon.slot
          client.queue('mob_equipment', { runtime_entity_id: BigInt(p.state.runtimeEntityId), item: copy(p.weapon.raw), slot, selected_slot: slot, window_id: 'inventory' })
          await waitFor(r, () => session(false).selected === slot, 2000)
        } else {
          const result = await equip(p.weapon.slot)
          assertRun(r)
          // A hotbar selection is an input request, not a server ACK. It may
          // prepare an attack only while the same observed stack is selected.
          const selectionReady = result?.phase === 'completed' && result.selectionSent === true &&
            result.sourceSlot === p.weapon.slot && result.slot === p.weapon.slot && p.weapon.slot >= 0 && p.weapon.slot <= 8 &&
            session(false).selected === p.weapon.slot && isDeepStrictEqual(crafting.rawItem(p.weapon.slot), p.weapon.raw)
          if (result?.serverConfirmed !== true && !selectionReady) throw failure('Melee weapon equip has no confirmed swap or matching hotbar selection', 'EQUIP_UNCONFIRMED')
        }
      } finally { r.equipping = false }
      p = plan(r.target.runtimeId, r.target)
    }
    heldWeapon(p); return p
  }
  function requestAttack (r, p, { critical = false, queuedTick = null, hopId = null } = {}) {
    assertRun(r); const weapon = heldWeapon(p)
    if (!p.inReach) throw failure('Target moved outside real melee reach', 'OUT_OF_REACH')
    if (clock() - lastAttack < cooldownMs) throw failure('Bedrock invulnerability/cooldown interval has not elapsed', 'COOLDOWN')
    const transaction = { legacy: { legacy_request_id: 0, legacy_transactions: null }, transaction_type: 'item_use_on_entity', actions: [], transaction_data: { entity_runtime_id: BigInt(p.target.runtimeId), action_type: 'attack', hotbar_slot: p.selected, hand: 'main_hand', held_item: copy(weapon.raw), player_pos: copy(p.state.position), click_pos: { x: 0, y: 0, z: 0 } } }
    client.queue('inventory_transaction', { transaction })
    const gap = Number.isFinite(lastAttack) ? Math.round(clock() - lastAttack) : null
    lastAttack = clock(); r.hitsRequested++
    try { log(`剣で攻撃: target=${String(p.target.entityType).replace('minecraft:', '')} gap=${gap ?? '-'}ms critical=${critical} hit=${r.hitsRequested} context=${JSON.stringify(logBinding(p.state, p.target))}`) } catch { /* logging only */ }
    const attempt = { targetRuntimeId: p.target.runtimeId, targetUniqueId: p.target.uniqueId, weapon: weapon.name, provenNormalDamage: weapon.damage, damageSource: weapon.source, damageKnown: weapon.damageKnown, weaponWarnings: copy(weapon.warnings), unknownWeaponCandidates: copy(weapon.unknownCandidates), selectionBasis: weapon.selectionBasis, enchantmentBonus: weapon.enchantmentBonus, criticalAttempt: critical, criticalHitConfirmed: false, queuedTick, criticalHopId: hopId, serverConfirmed: false, hitConfirmed: false }
    r.attempts.push(attempt); r.phase = 'cooldown'
  }
  async function ordinary (r) {
    const p = plan(r.target.runtimeId, r.target); heldWeapon(p); assertRun(r)
    if (r.hopId != null) throw failure('Ordinary input cannot own an active native hop', 'INPUT_BUSY')
    if (getMovement?.()?.running === true) throw failure('Native movement still owns the input', 'INPUT_BUSY')
    const input = getInput()
    if (!input || ['lookAt', 'start', 'stop', 'stats'].some(k => typeof input[k] !== 'function') || input.stats().running || input.stats().target || !Number.isFinite(input.stats().sent)) throw failure('Exclusive aimed normal input required', 'INPUT_BUSY')
    r.input = input; r.phase = 'aiming'
    try {
      const before = input.stats(); input.lookAt(p.aimPoint); input.start()
      const end = Math.min(r.deadline, clock() + 250), wallEnd = performance.now() + 250
      let latest, sent
      // A queued release can leave the shared cursor one tick ahead. Only a
      // new actual normal-input receipt proves aim; the sender keeps its own
      // 200ms/four-tick limits and is never forced to manufacture a frame.
      await sleep(0, r.controller.signal)
      while (true) {
        assertRun(r)
        sent = input.stats()
        if (getInput() !== input || sent.running !== true || sent.target || sent.lastError) throw failure(sent.lastError ?? 'Aimed input stopped or changed owner', 'INPUT_UNCONFIRMED')
        latest = plan(r.target.runtimeId, r.target); heldWeapon(latest)
        if (latest.selected !== p.selected || !isDeepStrictEqual(latest.weapon.raw, p.weapon.raw)) throw failure('Held stack changed during aim', 'WEAPON_CHANGED')
        if (!Number.isSafeInteger(sent.sent) || sent.sent < before.sent) throw failure('Aimed input receipt counter is invalid', 'INPUT_UNCONFIRMED')
        if (clock() >= end || performance.now() >= wallEnd) throw failure('No actual aimed input tick was queued within 250ms', 'INPUT_UNCONFIRMED')
        if (sent.sent > before.sent && id(sent.tick) !== null && (id(before.tick) === null || BigInt(sent.tick) > BigInt(before.tick))) break
        await sleep(Math.max(1, Math.min(10, end - clock(), wallEnd - performance.now())), r.controller.signal)
      }
      requestAttack(r, latest, { queuedTick: sent.tick })
      // Keep this same owned neutral producer alive during an ongoing normal
      // cooldown. Otherwise a valid model pose would age out before the next
      // aim could produce its required real input receipt. No extra hit occurs.
      while (r.hitsRequested < r.maxHits && clock() - lastAttack < cooldownMs) {
        assertRun(r)
        const current = plan(r.target.runtimeId, r.target); heldWeapon(current)
        if (getInput() !== input || input.stats().running !== true || input.stats().lastError) throw failure('Owned cooldown input stopped or changed', 'INPUT_UNCONFIRMED')
        await sleep(Math.min(25, cooldownMs - (clock() - lastAttack)), r.controller.signal)
      }
    } finally { input.stop(); r.input = null }
  }
  // Forecast whether the bound target will still be inside real reach on at
  // least one descending (critical) tick of the predicted hop, using its
  // received walking motion. A hop that cannot land a falling hit only delays
  // the strike, so such a target gets an immediate ordinary hit instead.
  function hopReachForecast (p, preview) {
    if (!Array.isArray(preview?.heights) || !Number.isInteger(preview.firstDescendingTick) || preview.firstDescendingTick < 1 || typeof entities.motion !== 'function') return { known: false }
    let observed = null
    try { observed = entities.motion(p.target.runtimeId) } catch { return { known: false } }
    const v = observed?.velocity
    if (!finite(v)) return { known: false }
    const eye = p.state.position
    // The last height is the landing tick, which is no longer airborne.
    for (let tick = preview.firstDescendingTick; tick < preview.heights.length; tick++) {
      const lead = tick + 1
      const body = { x: p.aimPoint.x + v.x * lead, y: p.aimPoint.y, z: p.aimPoint.z + v.z * lead }
      if (distance({ x: eye.x, y: eye.y + preview.heights[tick - 1], z: eye.z }, body) <= reach) return { known: true, reachable: true, tick }
    }
    return { known: true, reachable: false }
  }
  async function critical (r, p) {
    let preview = previewHop?.({ aimPoint: p.aimPoint })
    if (preview?.ready !== true) { r.lastHopReason = preview?.reason ?? 'Native hop unavailable'; return false }
    const descentDelay = Number.isInteger(preview.firstDescendingTick) && preview.firstDescendingTick >= 1 && preview.firstDescendingTick <= 32 ? (preview.firstDescendingTick - 1) * 50 : 0
    const wait = Math.max(0, cooldownMs - (clock() - lastAttack) - descentDelay)
    if (wait > 0) {
      await sleep(wait, r.controller.signal); assertRun(r)
      p = plan(r.target.runtimeId, r.target); heldWeapon(p)
      preview = previewHop({ aimPoint: p.aimPoint })
      if (preview?.ready !== true) { r.lastHopReason = preview?.reason ?? 'Native hop unavailable after cooldown scheduling'; return false }
    }
    const forecast = hopReachForecast(p, preview)
    if (forecast.known && !forecast.reachable) { r.lastHopReason = 'Target is forecast to leave reach before the critical descent'; return false }
    let lastHopAim = copy(p.aimPoint)
    const trackOwnedHopTarget = () => {
      if (r.hopStarting && r.hopId == null) {
        const admitted = getMovement?.()
        if (admitted?.phase === 'moving' && admitted.route?.operation === 'critical_hop' && admitted.criticalHopId != null) r.hopId = admitted.criticalHopId
      }
      assertRun(r)
      const current = plan(r.target.runtimeId, r.target, { allowHopHeight: true, hopTracking: true })
      heldWeapon(current)
      if (current.selected !== p.selected || current.weapon.name !== p.weapon.name || current.weapon.raw.network_id !== p.weapon.raw.network_id) throw failure('Owned-hop weapon changed', 'WEAPON_CHANGED')
      // Beyond the private aim bound, hold the last validated near aim and
      // finish the stationary hop. No far aim update or attack is permitted.
      if (current.hopAimTrackable) lastHopAim = copy(current.aimPoint)
      return { ...current, aimPoint: copy(lastHopAim) }
    }
    let snapshot
    r.hopStarting = true
    try { snapshot = await startHop({ aimPoint: p.aimPoint, getAim: () => trackOwnedHopTarget().aimPoint }) } catch (error) { r.lastHopReason = error.message; if (getMovement?.()?.running) throw failure('Another movement remains active after hop admission failure', 'INPUT_BUSY'); return false } finally { r.hopStarting = false }
    if (snapshot?.criticalHopId == null || snapshot.route?.operation !== 'critical_hop') throw failure('Native hop admission did not provide a bound hop ID', 'HOP_UNCONFIRMED')
    r.hopId = snapshot.criticalHopId; r.phase = 'critical_hop'
    const end = Math.min(r.deadline, clock() + 2000); let attacked = false; let airborne = false
    try {
      while (clock() < end) {
        assertRun(r)
        const m = getMovement()
        if (String(m?.criticalHopId) !== String(r.hopId) || m?.route?.operation !== 'critical_hop') throw failure('Owned critical hop identity changed', 'HOP_INTERRUPTED')
        if (['failed', 'stopped', 'idle', 'replan_required'].includes(m.phase)) { r.lastHopReason = m.reason ?? 'Native hop interrupted'; return attacked }
        const latest = trackOwnedHopTarget()
        airborne ||= m.physicsState?.onGround === false
        if (!attacked && latest.inReach && clock() - lastAttack >= cooldownMs && descendingCriticalFrame(m, r.hopId, { wallNow: wallNow(), workingPosition: latest.state.position })) {
          requestAttack(r, latest, { critical: true, queuedTick: String(m.queuedTick ?? m.actualQueuedTick), hopId: r.hopId }); attacked = true
        }
        if (airborne && m.physicsState?.onGround === true || m.phase === 'awaiting_server_confirmation') return attacked
        await sleep(25, r.controller.signal)
      }
      r.lastHopReason = 'Native hop did not provide a complete fresh descending/landing window'; return attacked
    } finally { endHop(r, 'Melee native hop cycle finished') }
  }
  // A modeled pose is fresh for 200ms. Right after another owner (escape, hop,
  // equip) hands input over, the next real frame can arrive a tick late; wait
  // briefly for it instead of abandoning a near fight. The freshness rule
  // itself is unchanged and a pose that never refreshes still stops the run.
  async function settlePose (signal, maxMs = POSE_SETTLE_MS) {
    // Keep pose waiting on the same monotonic clock as the engagement deadline.
    const end = clock() + maxMs
    while (true) {
      try { session(false); return } catch (error) { if (error.code !== 'POSE_UNTRUSTED' || clock() >= end) throw error }
      await sleep(25, signal)
    }
  }
  function stoppedOutOfReach (error) { return { phase: 'stopped', code: error.code, outcome: 'out_of_reach', reason: error.message, targetDead: false, serverConfirmed: false, hitsRequested: 0, attempts: [], botCausedDamage: null, botCausedDeath: null, attribution: 'unconfirmed' } }
  function engage (runtimeId, { signal, durationMs = 120000, maxHits = 128, critical: useCritical = true, poseSettled = false, reachLimit = null } = {}) {
    if (run || isBusy({ criticalHopId: null })) return Promise.reject(failure('Another melee engagement is active', 'BUSY'))
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 120000 || !Number.isInteger(maxHits) || maxHits < 1 || maxHits > 256 || typeof useCritical !== 'boolean' || signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return Promise.reject(failure('Invalid melee engagement bounds', 'INVALID_OPTIONS'))
    if (signal?.aborted) return Promise.reject(failure('Melee cancelled', 'CANCELLED'))
    let initial
    try { initial = plan(runtimeId, null, { reachLimit }) } catch (error) {
      if (error.code === 'POSE_UNTRUSTED' && !poseSettled) return settlePose(signal).then(() => engage(runtimeId, { signal, durationMs, maxHits, critical: useCritical, poseSettled: true, reachLimit }))
      return error.code === 'OUT_OF_REACH' ? Promise.resolve(stoppedOutOfReach(error)) : Promise.reject(error)
    }
    const r = run = { reachLimit: limitOf(reachLimit), target: initial.target, scope: initial.scope, deadline: clock() + durationMs, maxHits, controller: new AbortController(), input: null, hopId: null, hopStarting: false, equipping: false, phase: 'starting', hitsRequested: 0, attempts: [], terminal: null, cancelReason: null, code: null, lastHopReason: null }
    const onAbort = () => cancel('Melee cancelled by signal', 'CANCELLED'); signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => cancel('Melee duration limit reached', 'DURATION_LIMIT'), durationMs)
    task = (async () => {
      let code = 'HIT_LIMIT'; let reason = 'Melee hit request limit reached'
      try {
        let poseRetries = 0
        while (r.hitsRequested < maxHits) {
          const hitsBefore = r.hitsRequested
          try {
            assertRun(r)
            const p = await ensureWeapon(r)
            let attacked = false
            if (useCritical && previewHop) {
              try { attacked = await critical(r, p) } catch (error) { if (!['HOP_INTERRUPTED', 'HOP_UNCONFIRMED', 'WEAPON_CHANGED'].includes(error.code)) throw error; r.lastHopReason = error.message; endHop(r, error.message); await sleep(100, r.controller.signal); continue }
            }
            if (!attacked) {
              const wait = cooldownMs - (clock() - lastAttack)
              if (wait > 0) await sleep(wait, r.controller.signal)
              await ordinary(r)
            }
          } catch (error) {
            // A hop landing or cooldown gap can leave the model a tick stale.
            if (error.code !== 'POSE_UNTRUSTED' || r.cancelReason || r.terminal || poseRetries >= MAX_POSE_RETRIES) throw error
            poseRetries++; await settlePose(r.controller.signal); continue
          }
          if (r.hitsRequested > hitsBefore) poseRetries = 0
        }
      } catch (error) { code = error.code ?? 'UNSAFE_OBSERVATION'; reason = error.message }
      finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); r.input?.stop(); endHop(r, 'Melee engagement ended'); if (run === r) run = null }
      if (r.cancelReason) { code = r.code; reason = r.cancelReason }
      if (r.terminal) { code = r.terminal.dead ? 'TARGET_DEAD' : 'TARGET_REMOVED'; reason = r.terminal.dead ? 'Server confirmed the bound hostile target death' : 'Bound target removed; death unconfirmed' }
      lastResult = { phase: r.terminal?.dead ? 'completed' : 'stopped', code, outcome: code === 'OUT_OF_REACH' ? 'out_of_reach' : r.terminal?.dead ? 'target_dead' : 'stopped', reason, targetRuntimeId: r.target.runtimeId, targetUniqueId: r.target.uniqueId, targetName: r.target.entityType, targetDead: r.terminal?.dead === true, targetRemoved: r.terminal?.removed === true, serverConfirmed: r.terminal?.dead === true, confirmedBy: r.terminal?.by ?? null, hitsRequested: r.hitsRequested, attempts: copy(r.attempts), lastHopReason: r.lastHopReason, botCausedDamage: null, botCausedDeath: null, attribution: 'unconfirmed' }
      return copy(lastResult)
    })()
    const current = task; void current.then(() => { if (task === current) task = null }, () => { if (task === current) task = null })
    return current
  }
  function applyPacket (name, packet) {
    if (['start_game', 'change_dimension', 'disconnect', 'respawn'].includes(name)) { lifeEpoch++; cancel('Connection, dimension or life changed', 'SESSION_CHANGED'); return }
    const r = run; if (!r) return
    const state = getState()
    if (fullScope(state) !== r.scope) { cancel('Attacker scope changed', 'SESSION_CHANGED'); return }
    if (state.dead || state.isDead || !(state.health > 0) || name === 'entity_event' && id(packet.runtime_entity_id) === id(state.runtimeEntityId) && ['death_animation', 3].includes(packet.event_id)) { cancel('Attacker died', 'NOT_ALIVE'); return }
    const current = typeof entities.get === 'function' ? entities.get(id(r.target.runtimeId)) : entities.snapshot({ kind: 'all' }).find(e => id(e.runtimeId) === id(r.target.runtimeId))
    const bound = current && id(current.uniqueId, true) === id(r.target.uniqueId, true) && current.entityType === r.target.entityType
    let by = null
    if (bound && name === 'entity_event' && id(packet.runtime_entity_id) === id(r.target.runtimeId) && ['death_animation', 3].includes(packet.event_id)) by = 'server_death_animation'
    if (bound && ['add_entity', 'update_attributes'].includes(name) && id(packet.runtime_id ?? packet.runtime_entity_id) === id(r.target.runtimeId) && (packet.attributes ?? []).some(a => a.name === 'minecraft:health' && (name === 'add_entity' ? a.value : a.current) === 0)) by = 'server_health_zero'
    if (by) { r.terminal = { dead: true, by }; r.input?.stop(); endHop(r, 'Bound target death observed'); r.controller.abort(); return }
    if (name === 'remove_entity' && id(packet.entity_id_self, true) === id(r.target.uniqueId, true)) { r.terminal = { dead: false, removed: true, by: 'server_remove_unique_id' }; r.input?.stop(); endHop(r, 'Target removed'); r.controller.abort() }
  }
  return { preview, engage, applyPacket, cancel, drain: () => task ?? Promise.resolve(), snapshot: () => ({ busy: run !== null, engaging: run !== null, phase: run?.phase ?? 'idle', targetRuntimeId: run?.target.runtimeId ?? null, criticalHopId: run?.hopId ?? null, hitsRequested: run?.hitsRequested ?? 0, lastHopReason: run?.lastHopReason ?? null, lastResult: copy(lastResult) }) }
}

module.exports = { createMeleeCombat, descendingCriticalFrame }
