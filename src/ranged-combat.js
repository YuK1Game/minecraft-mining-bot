'use strict'

const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const { isDeepStrictEqual } = require('node:util')
const { solveBowAim, trajectoryPoints, BOW_DEFAULTS } = require('./bow-ballistics')

const VERSION = '1.26.60'
// Bounded wait for a bow-draw cancel slot to settle without a server echo.
const CLEANUP_SETTLE_MIN_MS = 100
const STRAFING_ARCHERS = new Set(['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:parched', 'minecraft:pillager'])
// The server never echoes our own cancel-slot switch, so this bound is what
// actually ends a cleanup; the next draw re-sends the bow selection anyway.
const CLEANUP_SETTLE_MAX_MS = 250
const HOSTILES = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'magma_cube', 'silverfish', 'endermite', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'phantom', 'pillager', 'vindicator', 'evocation_illager', 'ravager', 'vex', 'piglin_brute', 'hoglin', 'zoglin', 'breeze'].map(name => `minecraft:${name}`))
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000001)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const inventoryWindow = value => value === 0 || value === 'inventory'
const id = (value, signed = false) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value) || value == null) return null
  try { const n = BigInt(value); return n >= (signed ? -(1n << 63n) : 0n) && n < (1n << (signed ? 63n : 64n)) ? String(n) : null } catch { return null }
}
const validRaw = raw => raw && Number.isInteger(raw.network_id) && raw.network_id >= -32768 && raw.network_id <= 32767 && Number.isInteger(raw.count) && (raw.network_id === 0 ? raw.count === 0 : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)
const logBinding = (state, target) => ({
  runtimeId: id(target.runtimeId), uniqueId: id(target.uniqueId, true),
  scope: { connectionId: String(state.connectionId).slice(0, 120), startedAt: String(state.startedAt).slice(0, 80), dimension: state.dimension, selfRuntimeId: id(state.runtimeEntityId) },
  life: state.lifecycle?.deathId ?? state.deathId ?? null
})
function failure (message, code) { return Object.assign(new Error(message), { code }) }

function confirmedInfinity (raw, infinity) {
  if (!['true', true, 65535].includes(raw?.extra?.has_nbt) || !Number.isInteger(infinity?.id)) return false
  const root = raw.extra.nbt?.nbt ?? raw.extra.nbt
  const ench = root?.type === 'compound' && root.value?.ench
  if (ench?.type !== 'list' || ench.value?.type !== 'compound' || !Array.isArray(ench.value.value)) return false
  let found = false
  for (const entry of ench.value.value) {
    const value = entry?.type === 'compound' ? entry.value : entry
    if (!['short', 'int'].includes(value?.id?.type) || !['short', 'int'].includes(value?.lvl?.type) || !Number.isInteger(value.id.value) || !Number.isInteger(value.lvl.value)) return false
    if (value.id.value !== infinity.id) continue
    if (found || value.lvl.value !== 1 || infinity.maxLevel !== 1) return false
    found = true
  }
  return found
}

function bowBodyAim (eye, entity) {
  if (!finite(eye) || !finite(entity?.position)) throw failure('Known finite shooter and target positions required', 'POSITION_UNKNOWN')
  const low = ['minecraft:spider', 'minecraft:cave_spider', 'minecraft:silverfish', 'minecraft:endermite', 'minecraft:slime', 'minecraft:magma_cube', 'minecraft:phantom', 'minecraft:vex'].includes(entity.entityType)
  const point = { ...entity.position, y: entity.position.y + (low ? 0.2 : 0.9) }
  const dx = point.x - eye.x; const dy = point.y - eye.y; const dz = point.z - eye.z
  const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
  const pitch = Math.max(-90, Math.min(90, -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI))
  return { point, yaw, pitch, distance: distance(eye, point), mode: 'body_los', ballisticHitConfirmed: false }
}

// Mojang's player-arrow sample specifies power 3 and gravity .05; its native
// shooter scales draw power. This minimum controller deliberately uses a body
// sight line, not an unvalidated Java trajectory or a claim that a shot hit.
// https://github.com/Mojang/bedrock-samples/blob/main/behavior_pack/entities/arrow.json
// https://learn.microsoft.com/minecraft/creator/reference/content/itemreference/examples/itemcomponents/minecraft_shooter
// The local 1.26.60 schema provides click_air and item_release/release. The
// primary Bedrock PMMP handler maps those to useHeldItem/releaseHeldItem, and
// Bow.php reaches normal full draw at 20 ticks, with no synthetic consume action.
function createRangedCombat ({ client, getState, world, entities, crafting, equip, cancelEquip = null, onSelectionSent = null, getInput, getSelfUniqueId, isBusy = () => false, onUncertain = () => {}, version = VERSION, minDistance = 4, maxDistance = 32, cooldownMs = 50, shotTimeoutMs = 2500, fullDrawTicks = 20, fullDrawMs = 1000, latencyTicks = BOW_DEFAULTS.latencyTicks, ballistic = true, now = () => performance.now(), sleep = (ms, signal) => delay(ms, undefined, { signal }), log = () => {} }) {
  if (version !== VERSION) throw new Error('Ranged combat supports Bedrock 1.26.60 only')
  if ([getState, equip, getInput, getSelfUniqueId, isBusy, onUncertain, now, sleep].some(f => typeof f !== 'function') || typeof client?.queue !== 'function' || typeof world?.getBlock !== 'function' || typeof entities?.snapshot !== 'function' || typeof crafting?.snapshot !== 'function' || typeof crafting?.rawItem !== 'function' || cancelEquip != null && typeof cancelEquip !== 'function') throw new Error('Ranged combat requires live state, terrain, actors, confirmed equipment and normal input')
  if (!(minDistance >= 3.2 && maxDistance > minDistance && maxDistance <= 40) || !(cooldownMs >= 50 && cooldownMs <= 5000) || !(shotTimeoutMs >= 500 && shotTimeoutMs <= 10000)) throw new Error('Invalid ranged combat limits')
  // Bedrock reaches full bow draw at 20 input ticks (the final aim tick adds one more before release). The owned BDS fixture shows such arrows carry the critical flag, which each shot now records.
  if (!Number.isInteger(fullDrawTicks) || fullDrawTicks < 20 || fullDrawTicks > 40 || !(fullDrawMs >= 1000 && fullDrawMs <= 2000) || !(latencyTicks >= 0 && latencyTicks <= 10) || typeof ballistic !== 'boolean') throw new Error('Invalid bow draw or ballistic settings')
  const infinity = require('minecraft-data')(`bedrock_${version}`).enchantmentsByName.infinity
  // The server never echoes our own mob_equipment, so after a cancel-slot
  // switch the local model can still show the bow selected while the server
  // holds the cancel slot. The next draw re-sends the bow selection first.
  let selectionDirty = false
  let run = null; let task = null; let lastResult = null; let lastRelease = -Infinity; let inventoryRevision = 0; let cleanup = null; let recentShot = null; let observedArrowSpeed = null
  // A temporary send trace once wrapped client.queue on the live client; keep it disarmed.
  try { if (client.__selTraceHook) client.__selTraceHook = null } catch {}
  const clock = () => { const value = now(); if (!Number.isFinite(value)) throw new Error('Invalid ranged combat clock'); return value }
  clock()

  function scopeOf (state) { return JSON.stringify([state.profile, String(state.realm?.id), state.dimension, state.connectionId, state.startedAt, String(state.runtimeEntityId), id(getSelfUniqueId(), true), state.lifecycle?.deathId ?? state.deathId ?? null]) }
  function session (includeInventory = true) {
    const state = getState()
    const observed = !includeInventory && typeof crafting.status === 'function' ? crafting.status() : typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot()
    if (state?.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || !Number.isFinite(state.health) || state.health <= 0 || !finite(state.position)) throw failure('Shooter must be alive in the current spawned world', 'NOT_ALIVE')
    if (!['survival', 0].includes(state.gameMode)) throw failure('Bow use requires survival mode', 'GAME_MODE')
    if (typeof state.profile !== 'string' || state.realm?.id == null || typeof state.connectionId !== 'string' || typeof state.startedAt !== 'string' || !['overworld', 'nether', 'end'].includes(state.dimension) || id(state.runtimeEntityId) === null || id(getSelfUniqueId(), true) === null) throw failure('Complete live shooter scope and unique ID required', 'SCOPE_UNKNOWN')
    if (observed.authority !== true || observed.inventoryKnown !== true || state.inventory?.known !== true || state.inventory.uncertain || observed.pendingRequestId != null) throw failure('Server-confirmed inventory required', 'INVENTORY_UNKNOWN')
    const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    if (!Number.isInteger(selected) || selected < 0 || selected > 8) throw failure('Server-selected hotbar slot required', 'SELECTED_SLOT_UNKNOWN')
    const scope = scopeOf(state)
    return { state, observed, selected, scope }
  }
  function inventory () {
    const s = session(); const items = s.observed.inventory ?? []
    for (const item of items) {
      const raw = crafting.rawItem(item.slot)
      if (!Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35 || !validRaw(raw) || raw.count !== item.count || raw.stack_id !== item.stackId || typeof item.name !== 'string') throw failure('Inventory description and real stack disagree', 'STACK_UNKNOWN')
    }
    const bows = items.filter(x => x.name === 'minecraft:bow' && x.count === 1)
    const bow = bows.find(x => x.slot === s.selected) ?? bows[0]
    // Bedrock uses the same arrow item for plain and tipped metadata variants.
    const arrows = items.filter(x => x.name === 'minecraft:arrow' && Number.isSafeInteger(crafting.rawItem(x.slot).metadata) && crafting.rawItem(x.slot).metadata >= 0)
    return { ...s, bow, arrows: arrows.reduce((sum, x) => sum + x.count, 0), plainArrows: arrows.filter(x => crafting.rawItem(x.slot).metadata === 0).reduce((sum, x) => sum + x.count, 0), infinity: !!bow && confirmedInfinity(crafting.rawItem(bow.slot), infinity) }
  }
  function passable (point) {
    const b = world.getBlock(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))
    // Arrows fly through blocks without a collision box (grass, flowers, leaf
    // litter, torches); liquids and unknown terrain still block the shot.
    return b?.known === true && !b.extra?.length && (AIR.has(b.name) || b.boundingBox === 'empty' && !/water|lava|bubble|powder_snow|cobweb|portal/.test(String(b.name)))
  }
  function lineClear (from, to) {
    const axes = ['x', 'y', 'z']; const cell = {}; const step = {}; const next = {}; const delta = {}
    const check = p => { if (!passable(p)) throw failure('Bow sight line includes blocked, wet or unknown terrain', 'LOS_BLOCKED') }
    for (const k of axes) { cell[k] = Math.floor(from[k]); const d = to[k] - from[k]; step[k] = Math.sign(d); delta[k] = d ? 1 / Math.abs(d) : Infinity; next[k] = d ? (cell[k] + Number(d > 0) - from[k]) / d : Infinity }
    check(cell)
    for (let count = 0; count < 128; count++) {
      const crossing = Math.min(...axes.map(k => next[k]))
      if (crossing > 1) return
      const crossed = axes.filter(k => Math.abs(next[k] - crossing) < 1e-10)
      for (let mask = 1; mask < 1 << crossed.length; mask++) { const touched = { ...cell }; crossed.forEach((k, i) => { if (mask & 1 << i) touched[k] += step[k] }); check(touched) }
      for (const k of crossed) { cell[k] += step[k]; next[k] += delta[k] }
    }
    throw failure('Bow sight traversal limit reached', 'LOS_BLOCKED')
  }
  function guards (s, target, aim, all) {
    const origin = s.state.position
    const length = distance(origin, aim.point)
    const direction = { x: (aim.point.x - origin.x) / length, y: (aim.point.y - origin.y) / length, z: (aim.point.z - origin.z) / length }
    for (const other of all) {
      if (other.runtimeId === target.runtimeId || other.runtimeId === String(s.state.runtimeEntityId) || other.alive === false || other.kind === 'item' || /^minecraft:(?:arrow|xp_orb|experience_orb|xp_bottle|item)$/.test(other.entityType ?? '')) continue // experience orbs are not intercepting actors
      const player = other.kind === 'player' || other.entityType === 'minecraft:player'
      if (player && (!['overworld', 'nether', 'end'].includes(other.dimension) || id(other.runtimeId) === null)) throw failure('Another player has unknown identity or world scope', 'ACTOR_UNKNOWN')
      if (other.dimension != null && other.dimension !== s.state.dimension) continue
      if (other.positionKnown !== true || !finite(other.position)) throw failure('Another actor has unknown position', 'ACTOR_UNKNOWN')
      const d = distance(origin, other.position)
      const center = { ...other.position, y: other.position.y + 0.9 }
      // The same broad corridor protects players in front of or behind the
      // target. Also keep the launch area clear, including just behind the
      // shooter. A known player farther to the side does not intersect it.
      if (player && Math.hypot(center.x - origin.x, center.z - origin.z) <= 1.25 && Math.abs(center.y - origin.y) <= 2.5) throw failure('Another player is within the arrow launch area', 'OTHER_PLAYER')
      if (other.hostile === true && d <= 3.2) throw failure('Another hostile is already within melee range', 'SECONDARY_MELEE_THREAT')
      // Protect friends/passives/unknown types behind the target too: a missed
      // arrow can continue. The broad vertical corridor also covers arrow drop.
      const projection = (center.x - origin.x) * direction.x + (center.y - origin.y) * direction.y + (center.z - origin.z) * direction.z
      if (projection < 0 || projection > maxDistance + 4) continue
      const p = { x: origin.x + direction.x * projection, y: origin.y + direction.y * projection, z: origin.z + direction.z * projection }
      // Another hostile mob in the corridor (two zombies walking in together)
      // only takes the arrow instead of the target; players, passives and
      // unknown types stay protected.
      if (!player && other.hostile === true && other.kind === 'mob') continue
      if (Math.hypot(center.x - p.x, center.z - p.z) <= 1.25 && Math.abs(center.y - p.y) <= 2.5) throw failure(player ? 'Another player could intercept the shot' : `Another actor could intercept the shot: ${other.entityType ?? other.kind ?? '?'} at ${projection.toFixed(1)}m`, player ? 'OTHER_PLAYER' : 'ACTOR_IN_SHOT_PATH')
    }
    if (s.state.entityStats?.unknownPositions > all.filter(e => e.positionKnown !== true).length) throw failure('Untracked actors have unknown positions', 'ACTOR_UNKNOWN')
  }
  // Full-draw ballistic aim: compensates arrow drop and leads a walking target
  // using its received motion. The body sight line stays the range reference.
  function bowAim (eye, target) {
    const body = bowBodyAim(eye, target)
    if (!ballistic) return { ...body, lookPoint: copy(body.point), bodyPoint: copy(body.point) }
    let velocity = null
    try { velocity = typeof entities.motion === 'function' ? entities.motion(target.runtimeId)?.velocity ?? null : null } catch { velocity = null }
    // Skeleton-type archers strafe and reverse during the ~0.4s flight: measured
    // misses at 16-20m sat 0.8-1.5m to both sides with a full lead, so they get
    // half the lead (smallest error whether they keep going or turn back).
    const leadScale = STRAFING_ARCHERS.has(target.entityType) ? 0.5 : 1
    if (velocity && leadScale !== 1) velocity = { x: velocity.x * leadScale, y: velocity.y * leadScale, z: velocity.z * leadScale }
    const solution = solveBowAim({ eye, point: body.point, velocity, speed: observedArrowSpeed ?? BOW_DEFAULTS.speed, latencyTicks })
    if (!solution) throw failure('No full-draw arrow trajectory reaches the target', 'RANGE')
    return { point: solution.intercept, bodyPoint: copy(body.point), lookPoint: solution.lookPoint, yaw: solution.yaw, pitch: solution.pitch, distance: body.distance, interceptDistance: distance(eye, solution.intercept), flightTicks: solution.flightTicks, leadTicks: solution.leadTicks, lead: solution.lead, origin: solution.origin, speed: solution.speed, mode: 'ballistic_lead', ballisticHitConfirmed: false }
  }
  function trajectoryClear (eye, aim) {
    if (aim.mode !== 'ballistic_lead') return lineClear(eye, aim.point)
    const points = trajectoryPoints({ origin: aim.origin, yaw: aim.yaw, pitch: aim.pitch, speed: aim.speed, horizontal: Math.hypot(aim.point.x - aim.origin.x, aim.point.z - aim.origin.z) })
    lineClear(eye, points[0])
    for (let i = 1; i < points.length; i++) lineClear(points[i - 1], points[i])
  }
  function plan (runtimeId, expected = null, requireAmmo = true) {
    const s = inventory(); const all = entities.snapshot({ kind: 'all' })
    if (id(runtimeId) === null) throw failure('Valid target runtime ID required', 'INVALID_TARGET')
    const target = all.find(e => id(e.runtimeId) === id(runtimeId))
    if (!target || target.kind !== 'mob' || target.hostile !== true || !HOSTILES.has(target.entityType) || target.alive !== true || target.positionKnown !== true || !finite(target.position) || target.dimension !== s.state.dimension || id(target.uniqueId, true) === null || id(target.runtimeId) === String(s.state.runtimeEntityId)) throw failure('Only an identified live hostile mob may be targeted', 'INVALID_TARGET')
    if (expected && (target.runtimeId !== expected.runtimeId || id(target.uniqueId, true) !== id(expected.uniqueId, true) || target.entityType !== expected.entityType)) throw failure('Target runtime/unique identity changed', 'TARGET_CHANGED')
    const aim = bowAim(s.state.position, target)
    if (aim.distance <= minDistance || aim.distance > maxDistance || Math.abs(aim.pitch) > 80) throw failure('Target must remain beyond melee reach and within the bow sight range', 'RANGE')
    if (!s.bow) throw failure('No owned bow in the server inventory', 'NO_BOW')
    if (requireAmmo && s.arrows < 1) throw failure('No owned arrows remain', 'NO_AMMO')
    trajectoryClear(s.state.position, aim); guards(s, target, aim, all)
    const cancelSlot = Array.from({ length: 9 }, (_, slot) => slot).find(slot => slot !== s.selected && validRaw(crafting.rawItem(slot)) && !s.observed.inventory.some(x => x.slot === slot && x.name === 'minecraft:bow'))
    if (cancelSlot == null) throw failure('A known alternate hotbar slot is required to cancel a draw safely', 'NO_CANCEL_SLOT')
    return { ...s, target: copy(target), aim, cancelSlot }
  }
  function readiness (runtimeId, ignoreExternalBusy) {
    settleCleanup()
    try { if (cleanup) throw failure('Server confirmation of draw cancellation is pending', 'CLEANUP_PENDING'); if (run || !ignoreExternalBusy && isBusy()) throw failure('Another action owns the input', 'BUSY'); const p = plan(runtimeId); return { ready: true, targetRuntimeId: p.target.runtimeId, targetUniqueId: p.target.uniqueId, targetName: p.target.entityType, bowSlot: p.bow.slot, selectedSlot: p.selected, arrows: p.arrows, infinity: p.infinity, requiresEquip: p.bow.slot !== p.selected, aim: p.aim, cooldownRemainingMs: Math.max(0, cooldownMs - (clock() - lastRelease)) } } catch (error) { return { ready: false, code: error.code ?? 'UNSAFE', errors: [error.message] } }
  }
  function preview (runtimeId) { return readiness(runtimeId, false) }
  function survey (runtimeId) { return readiness(runtimeId, true) }
  function assertRun (r) {
    if (run !== r || r.cancelReason) throw failure(r.cancelReason ?? 'Ranged engagement cancelled', r.code ?? 'CANCELLED')
    if (r.terminal) throw failure('Target stopped', 'TARGET_STOPPED')
    if (clock() >= r.deadline) throw failure('Ranged engagement duration limit reached', 'DURATION_LIMIT')
    const s = session(false)
    if (s.scope !== r.scope) throw failure('Shooter connection, world or life changed', 'SESSION_CHANGED')
    if (distance(s.state.position, r.origin) > 0.35) throw failure('Shooter moved during the draw', 'SHOOTER_MOVED')
    if (isBusy()) throw failure('Another action took ownership', 'BUSY')
    return s
  }
  function cancelDraw (r) {
    r.input?.stop()
    const shot = r.shot
    if (!shot?.startSent || shot.released || shot.cancelRequested) return
    shot.cancelRequested = true
    try {
      const s = session()
      if (s.scope !== r.scope) return
      // Cancel-slot preference: a sword (the next weapon if the fight turns to
      // melee), then an empty hand, then any other item. Never an arrow or a
      // bow: an arrow-holding hotbar slot was seen left selected after a
      // cancel, so a later draw had no bow in hand and fired nothing.
      const nameAt = n => s.observed.inventory.find(x => x.slot === n)?.name ?? null
      const eligible = Array.from({ length: 9 }, (_, n) => n).filter(n => n !== s.selected && validRaw(crafting.rawItem(n)) && !/^minecraft:(?:bow|crossbow|arrow|spectral_arrow|tipped_arrow)$/.test(nameAt(n) ?? ''))
      const rank = n => /_sword$/.test(nameAt(n) ?? '') ? 0 : nameAt(n) == null ? 1 : 2
      const slot = eligible.sort((a, b) => rank(a) - rank(b) || a - b)[0]
      if (slot == null) { r.cleanupUnconfirmed = true; return }
      const raw = crafting.rawItem(slot)
      // Selecting a different real hotbar slot cancels item use without firing.
      // A release on cancellation would instead shoot into a newly unsafe ray.
      r.cancelSlot = slot; r.cleanupUnconfirmed = true; cleanup = { scope: r.scope, slot, at: clock() }
      client.queue('mob_equipment', { runtime_entity_id: BigInt(s.state.runtimeEntityId), item: copy(raw), slot, selected_slot: slot, window_id: 'inventory' })
      selectionDirty = true
      // The server does not echo our own selection: record it locally so the
      // next equip (e.g. the quarry's pickaxe) sees the slot the server holds.
      try { onSelectionSent?.(slot) } catch {}
    } catch { /* A dead or replaced session must never receive cleanup packets. */ }
  }
  function cancel (reason = 'Ranged engagement cancelled', code = 'CANCELLED') {
    if (!run || run.cancelReason) return
    run.cancelReason = String(reason); run.code = code
    if (run.equipping) { try { cancelEquip?.(reason) } catch {} }
    cancelDraw(run); run.controller.abort()
  }
  async function waitFor (r, condition, limit, verify = null) {
    const end = Math.min(r.deadline, clock() + limit)
    while (!condition()) {
      assertRun(r); verify?.()
      if (clock() >= end) throw failure('Ranged shot observation timed out', 'SHOT_UNCONFIRMED')
      await sleep(50, r.controller.signal)
    }
    assertRun(r)
  }
  function currentBow (p) {
    if (p.observed.openContainer) { try { crafting.closeContainer?.() } catch { /* pending craft */ } throw failure('Close the inventory before drawing', 'CONTAINER_OPEN') }
    const held = p.observed.inventory.find(x => x.slot === p.selected)
    const raw = crafting.rawItem(p.selected)
    if (held?.name !== 'minecraft:bow' || held.count !== 1 || !validRaw(raw) || raw.count !== 1 || raw.stack_id !== held.stackId || p.state.equipmentServerConfirmed === false) throw failure('Selected bow is not server confirmed', 'BOW_NOT_EQUIPPED')
    return copy(raw)
  }
  async function shoot (r) {
    const p = plan(r.target.runtimeId, r.target); assertRun(r)
    const raw = currentBow(p); const input = r.input
    // The input stream stays ours across consecutive shots (no stop/start gap).
    if (input.stats().target || input.stats().running && !r.inputHeld) throw failure('Another input stream is running', 'INPUT_BUSY')
    recentShot = null
    const shot = r.shot = { scope: r.scope, origin: copy(p.state.position), raw, slot: p.selected, arrows: p.arrows, infinity: p.infinity && p.plainArrows > 0, ammoSlots: p.observed.inventory.filter(i => i.name === 'minecraft:arrow').map(i => i.slot), candidates: new Map(), phase: 'aiming', startSent: null, startedAt: null, released: false, ownArrow: null, inventoryAfterRelease: false, inventoryConfirmed: false, arrowsAfter: null, attempt: null }
    if (selectionDirty) {
      client.queue('mob_equipment', { runtime_entity_id: BigInt(p.state.runtimeEntityId), item: copy(raw), slot: p.selected, selected_slot: p.selected, window_id: 'inventory' })
      selectionDirty = false
      try { onSelectionSent?.(p.selected) } catch {}
      await sleep(100, r.controller.signal); assertRun(r)
    }
    input.lookAt(p.aim.lookPoint); const before = input.stats().sent
    if (!input.stats().running) { input.start(); r.inputHeld = true }
    const revalidate = () => {
      const latest = plan(r.target.runtimeId, r.target)
      // The previous arrow's durability update re-sends the bow (new damage and
      // stack id) during the next draw; only another item or slot is a change.
      const nowRaw = crafting.rawItem(shot.slot)
      if (latest.selected !== shot.slot || nowRaw?.network_id !== shot.raw.network_id || !(nowRaw?.count > 0)) throw failure('Bow stack or selected slot changed during draw', 'BOW_CHANGED')
      shot.raw = copy(nowRaw)
      if (shot.serverDrawEnded) throw failure('The server ended the draw right after it started', 'DRAW_REJECTED')
      if (!input.stats().running || input.stats().lastError) throw failure(input.stats().lastError ?? 'Input stopped during draw', 'INPUT_FAILED')
      // The aim follows the target every poll of the draw, so the release
      // needs no extra settling tick.
      input.lookAt(latest.aim.lookPoint)
      return latest
    }
    await waitFor(r, () => input.stats().sent > before, 1000, revalidate)
    shot.phase = 'starting'
    input.sendTransaction({ legacy: { legacy_request_id: 0, legacy_transactions: null }, actions: [], data: { action_type: 'click_air', trigger_type: 'player_input', block_position: { x: 0, y: 0, z: 0 }, face: 0, hotbar_slot: shot.slot, hand: 'main_hand', held_item: copy(raw), player_pos: copy(p.state.position), click_pos: { x: 0, y: 0, z: 0 }, block_runtime_id: 0, client_prediction: 'success', client_cooldown_state: 'off' } }, { onSent: () => { shot.startedAt = clock(); shot.startSent = input.stats().sent + 1; shot.phase = 'charging'; if (r.cancelReason || run !== r) cancelDraw(r) } })
    // Release on the tick the draw reaches full charge (20 sent input ticks);
    // the server counts the same ticks.
    // Sleep exactly to full charge instead of polling past it (polling added
    // up to 50ms per shot), keeping the aim updated on the way.
    await waitFor(r, () => shot.startSent !== null, 1000, revalidate)
    for (let left = fullDrawMs - (clock() - shot.startedAt); left > 0; left = fullDrawMs - (clock() - shot.startedAt)) { await sleep(Math.min(left, 50), r.controller.signal); assertRun(r); revalidate() }
    await waitFor(r, () => shot.startSent !== null && clock() - shot.startedAt >= fullDrawMs && input.stats().sent >= shot.startSent + fullDrawTicks, 4000, revalidate)
    const latest = revalidate(); assertRun(r)
    shot.released = true; shot.phase = 'awaiting_fire'; shot.aim = latest.aim; shot.releaseRevision = inventoryRevision; shot.releasedAt = clock(); lastRelease = clock(); r.shotsRequested++
    shot.target = copy(latest.target); shot.logContext = logBinding(latest.state, latest.target); shot.number = r.shotsRequested; r.lastReleasedShot = shot
    // Ammo baseline at release: the previous arrow's inventory delta has long
    // arrived during this 1s draw.
    // Only while an earlier arrow is still unconfirmed: its delta may land
    // after this draw started. Otherwise the draw-start count is the baseline.
    if (r.pending.length) { try { shot.arrows = inventory().arrows } catch { /* keep the draw-start count */ } }
    try { log(`矢を発射: target=${String(latest.target.entityType).replace('minecraft:', '')} distance=${distance(latest.state.position, latest.target.position).toFixed(1)}m aim=${latest.aim.mode ?? latest.aim.aimMode ?? '?'} shot=${r.shotsRequested} draw=${Math.round(shot.releasedAt - shot.startedAt)}ms context=${JSON.stringify(logBinding(latest.state, latest.target))}`) } catch { /* Logging only. */ }
    client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0, legacy_transactions: null }, transaction_type: 'item_release', actions: [], transaction_data: { action_type: 'release', hotbar_slot: shot.slot, held_item: copy(currentBow(latest)), head_pos: copy(latest.state.position), hand: 'main_hand' } } })
    // Confirmation (own arrow spawn + ammo delta) runs in parallel: the next
    // draw starts right away instead of waiting ~100ms for the server echo.
    r.pending.push(shot)
    shot.confirmation = confirmShot(r, shot)
  }
  async function confirmShot (r, shot) {
    // The ammo packet can reach this controller before the shared inventory
    // model applies it, so the delta is re-read from the live model.
    const liveAmmo = () => { if (shot.inventoryConfirmed || !shot.inventoryAfterRelease) return shot.inventoryConfirmed; try { const after = inventory().arrows; if (after === shot.arrows - 1) { shot.arrowsAfter = after; shot.inventoryConfirmed = true } } catch {} return shot.inventoryConfirmed }
    const end = clock() + shotTimeoutMs
    while (!(shot.ownArrow !== null && (liveAmmo() || shot.infinity))) {
      if (clock() >= end) { shot.phase = 'unconfirmed'; r.unconfirmedShots = (r.unconfirmedShots ?? 0) + 1; r.pending = r.pending.filter(s => s !== shot); return false }
      try { await sleep(25) } catch { break }
    }
    r.shotsConfirmed++; shot.phase = 'confirmed'; r.unconfirmedShots = 0; r.pending = r.pending.filter(s => s !== shot)
    shot.attempt = { arrowRuntimeId: shot.ownArrow, serverConfirmed: true, confirmedBy: shot.inventoryConfirmed ? 'own_arrow_spawn_and_server_inventory_delta' : 'own_arrow_spawn_with_confirmed_infinity', arrowsBefore: shot.arrows, arrowsAfter: shot.arrowsAfter, ammoConsumed: shot.inventoryConfirmed ? 1 : null, ammoConsumedConfirmed: shot.inventoryConfirmed, hitConfirmed: false, drawTicks: fullDrawTicks, fullChargeConfirmed: shot.fullCharge ?? null, arrowSpeed: shot.arrowSpeed ?? null, aimMode: shot.aim.mode, launchPitch: shot.aim.pitch, flightTicks: shot.aim.flightTicks ?? null, leadTicks: shot.aim.leadTicks ?? null }
    r.attempts.push(shot.attempt)
    if (shot.infinity && !shot.inventoryConfirmed) recentShot = shot
    return true
  }
  function engage (runtimeId, { signal, durationMs = 120000, maxShots = 64 } = {}) {
    settleCleanup()
    if (cleanup) return Promise.reject(failure('Server confirmation of draw cancellation is pending', 'CLEANUP_PENDING'))
    if (run || isBusy()) return Promise.reject(failure('Another action owns ranged combat', 'BUSY'))
    if (!Number.isInteger(durationMs) || durationMs < 1200 || durationMs > 120000 || !Number.isInteger(maxShots) || maxShots < 1 || maxShots > 128 || signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return Promise.reject(failure('Invalid ranged engagement limits', 'INVALID_OPTIONS'))
    if (signal?.aborted) return Promise.reject(failure('Ranged engagement cancelled', 'CANCELLED'))
    let p; let input
    try {
      p = plan(runtimeId); input = getInput()
      if (!input || ['start', 'stop', 'stats', 'lookAt', 'sendTransaction'].some(k => typeof input[k] !== 'function') || input.stats().running || input.stats().target || !Number.isFinite(input.stats().sent)) throw failure('Exclusive normal item-use input required', 'INPUT_BUSY')
    } catch (error) { return Promise.reject(error) }
    const r = run = { pending: [], inputHeld: false, unconfirmedShots: 0, scope: p.scope, origin: copy(p.state.position), target: p.target, input, controller: new AbortController(), deadline: clock() + durationMs, shotsRequested: 0, shotsConfirmed: 0, attempts: [], seenArrows: new Set(), terminal: null, cancelReason: null, code: null, shot: null, cleanupUnconfirmed: false, equipping: true }
    const onAbort = () => cancel('Ranged engagement cancelled by signal', 'CANCELLED')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => cancel('Ranged engagement duration limit reached', 'DURATION_LIMIT'), durationMs)
    task = (async () => {
      let code = 'SHOT_LIMIT'; let reason = 'Ranged shot limit reached'
      try {
        const requestedBow = copy(crafting.rawItem(p.bow.slot))
        const result = await equip(p.bow.slot)
        r.equipping = false; assertRun(r)
        // Selection transmission alone confirms no equipment or shot. Keep
        // the exact server-observed stack and current selected slot checks.
        const selectionReady = result?.phase === 'completed' && result.selectionSent === true &&
          result.sourceSlot === p.bow.slot && result.slot === p.bow.slot && p.bow.slot >= 0 && p.bow.slot <= 8 &&
          session(false).selected === p.bow.slot && isDeepStrictEqual(crafting.rawItem(p.bow.slot), requestedBow)
        if (result?.serverConfirmed !== true && !selectionReady) throw failure('Bow equip has no confirmed swap or matching hotbar selection', 'EQUIP_UNCONFIRMED')
        currentBow(inventory())
        while (!r.terminal && r.shotsRequested < maxShots) {
          // Re-anchor between shots only (never during a draw): knockback or
          // a small drift after the last shot must not end the engagement.
          // Movement during a draw still cancels that shot (SHOOTER_MOVED).
          try { r.origin = copy(session(false).state.position) } catch { /* assertRun reports it */ }
          // Two releases in a row without an own arrow: the server is not firing.
          if (r.unconfirmedShots >= 2) throw failure('Ranged shot observation timed out', 'SHOT_UNCONFIRMED')
          assertRun(r)
          if (inventory().arrows < 1) { code = 'NO_AMMO'; reason = 'No owned arrows remain'; break }
          const wait = cooldownMs - (clock() - lastRelease)
          if (wait > 0) await sleep(wait, r.controller.signal)
          await shoot(r)
        }
      } catch (error) { code = error.code ?? 'UNSAFE_OBSERVATION'; reason = error.message }
      finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', onAbort)
        cancelDraw(r)
        // Arrows already released still get their confirmation (bounded).
        { const until = clock() + shotTimeoutMs + 100; while (r.pending.length && clock() < until) { try { await sleep(25) } catch { break } } }
        if (r.shot?.released && !r.shot.inventoryAfterRelease && !(r.shot.infinity && r.shot.ownArrow !== null)) { try { onUncertain({ operation: 'ranged_shot', targetRuntimeId: r.target.runtimeId, reason: 'No fresh server inventory after released bow shot' }) } catch {} }
        if (run === r) run = null
      }
      // The last released arrow was never seen: report that, not the shot limit.
      if (code === 'SHOT_LIMIT' && r.shotsConfirmed < r.shotsRequested && r.shot?.phase === 'unconfirmed') { code = 'SHOT_UNCONFIRMED'; reason = 'Ranged shot observation timed out' }
      if (r.cancelReason) { code = r.code; reason = r.cancelReason }
      if (r.terminal) { code = r.terminal.dead ? 'TARGET_DEAD' : 'TARGET_REMOVED'; reason = r.terminal.dead ? 'Server confirmed the bound target death' : 'Bound target removed; death and attribution unconfirmed' }
      lastResult = { phase: r.terminal?.dead ? 'completed' : 'stopped', code, reason, targetRuntimeId: r.target.runtimeId, targetUniqueId: r.target.uniqueId, targetName: r.target.entityType, targetDead: r.terminal?.dead === true, targetRemoved: r.terminal?.removed === true, serverConfirmed: r.terminal?.dead === true, confirmedBy: r.terminal?.by ?? null, shotsRequested: r.shotsRequested, shotsConfirmed: r.shotsConfirmed, attempts: copy(r.attempts), cleanupUnconfirmed: r.cleanupUnconfirmed, botCausedDamage: null, botCausedDeath: null, attribution: 'unconfirmed' }
      return copy(lastResult)
    })()
    const current = task
    void current.then(() => { if (task === current) task = null }, () => { if (task === current) task = null })
    return current
  }
  // Nearest other hostile (creepers only beyond their shot distance) whose
  // full ranged plan is ready right now.
  function retargetCandidate (r) {
    try {
      const s = session(false), all = entities.snapshot({ kind: 'all' })
      const options = all.filter(e => e.runtimeId !== r.target.runtimeId && e.kind === 'mob' && e.hostile === true && e.alive === true && e.positionKnown === true && HOSTILES.has(e.entityType) && finite(e.position) && e.dimension === s.state.dimension)
        .map(e => ({ e, d: distance(s.state.position, e.position) })).filter(({ e, d }) => d > 6 && d <= maxDistance && (e.entityType !== 'minecraft:creeper' || d >= 8)).sort((a, b) => a.d - b.d)
      for (const { e } of options.slice(0, 4)) { try { const p = plan(e.runtimeId); if (p?.aim) return copy(p.target) } catch { /* not shootable now */ } }
    } catch { /* no candidate */ }
    return null
  }
  function observeAmmo (name, packet, shot) {
    if (!shot?.released || !(name === 'inventory_content' || name === 'inventory_slot' && shot.ammoSlots.includes(packet.slot)) || !inventoryWindow(packet.window_id)) return
    if (scopeOf(getState()) !== shot.scope || clock() - shot.releasedAt > shotTimeoutMs) return
    inventoryRevision++
    if (inventoryRevision <= shot.releaseRevision) return
    shot.inventoryAfterRelease = true
    try {
      const after = inventory().arrows
      shot.arrowsAfter = after
      if (after === shot.arrows - 1) shot.inventoryConfirmed = true
      for (const attempt of [shot.attempt, ...(lastResult?.attempts ?? []).filter(a => a.arrowRuntimeId === shot.ownArrow)]) {
        if (!attempt) continue
        attempt.arrowsAfter = after
        if (shot.inventoryConfirmed) { attempt.ammoConsumed = 1; attempt.ammoConsumedConfirmed = true; attempt.confirmedBy = 'own_arrow_spawn_and_server_inventory_delta' }
      }
    } catch { /* An invalid inventory cannot supply consumption evidence. */ }
  }
  // null = malformed metadata (never proof); [] = no owner entry yet.
  const ownersIn = metadata => (metadata != null && !Array.isArray(metadata)) || (metadata ?? []).some(e => !e || typeof e !== 'object' || ['owner_eid', 'arrow_shooter_id', 5, 139].includes(e.key) && e.value == null) ? null : (metadata ?? []).filter(e => ['owner_eid', 'arrow_shooter_id', 5, 139].includes(e.key) && ['long', 7].includes(e.type)).map(e => id(e.value, true)).filter(v => v !== null && v !== '-1' && v !== '0')
  // Bedrock marks a fully drawn arrow with the actor `critical` flag.
  function criticalFlag (metadata) {
    const flags = (metadata ?? []).find(e => e?.key === 'flags' || e?.key === 0)
    const value = flags?.value
    return value && typeof value === 'object' && typeof value.critical === 'boolean' ? value.critical : null
  }
  function ownArrow (r, shot, candidate) {
    shot.ownArrow = candidate.runtimeId; r.seenArrows.add(candidate.runtimeId)
    if (candidate.critical != null) shot.fullCharge = candidate.critical
    if (Number.isFinite(candidate.speed)) shot.arrowSpeed = candidate.speed
    // Learn the real full-draw launch speed from our own critical arrows.
    if (candidate.critical === true && candidate.speed > 2 && candidate.speed < 4.5) observedArrowSpeed = observedArrowSpeed == null ? candidate.speed : observedArrowSpeed * 0.7 + candidate.speed * 0.3
    if (!shot.missTracked) { shot.missTracked = true; trackMiss(r, shot, candidate) }
  }
  // Accuracy measurement: follow our own arrow and log, once, where it passed
  // the target's horizontal distance relative to the target body centre
  // (dy = high/low, side = right/left of the line of fire, + = right).
  function trackMiss (r, shot, candidate) {
    const origin = copy(candidate.origin), targetId = (shot.target ?? r.target).runtimeId, startedAt = clock(), aim = shot.aim
    // The drawn bow can retarget while an earlier arrow is still flying.
    // Keep that arrow's diagnostic bound to its original observed target.
    const targetBinding = copy(shot.target ?? r.target), binding = copy(shot.logContext ?? logBinding(getState(), targetBinding))
    const bodyY = String(targetBinding.entityType).includes('spider') ? 0.45 : 0.9
    let last = null, prev = null, polls = 0, still = 0
    const timer = setInterval(() => {
      try {
        if (++polls > 60) { clearInterval(timer); return }
        const all = typeof entities.get === 'function' ? null : entities.snapshot({ kind: 'all' })
        const arrow = all ? all.find(e => e.runtimeId === candidate.runtimeId) : entities.get(candidate.runtimeId)
        const target = all ? all.find(e => e.runtimeId === targetId) : entities.get(targetId)
        const done = reason => { clearInterval(timer); if (!last) return; try { log(`矢の誤差: target=${String(targetBinding.entityType).replace('minecraft:', '')} distance=${last.dt.toFixed(1)}m dy=${last.dy.toFixed(2)} side=${last.side.toFixed(2)} along=${last.along.toFixed(2)} lead=${aim?.lead ? Math.hypot(aim.lead.x, aim.lead.z).toFixed(3) : '0'} by=${reason} context=${JSON.stringify({ ...binding, arrowRuntimeId: id(candidate.runtimeId) })}`) } catch {} }
        if (scopeOf(getState()) !== r.scope) return done('scope_changed')
        if (target && id(target.uniqueId, true) !== id(targetBinding.uniqueId, true)) return done('target_changed')
        if (!arrow || !target || !finite(arrow.position) || !finite(target.position)) return done('lost')
        const a = arrow.position, t = { ...target.position, y: target.position.y + bodyY }
        const da = Math.hypot(a.x - origin.x, a.z - origin.z), dt = Math.hypot(t.x - origin.x, t.z - origin.z)
        const ux = (t.x - origin.x) / dt, uz = (t.z - origin.z) / dt
        const at = p => ({ dt, dy: p.y - t.y, side: (p.x - t.x) * -uz + (p.z - t.z) * ux, along: (p.x - t.x) * ux + (p.z - t.z) * uz })
        // An arrow that stops moving is stuck in a block: report where it stuck.
        still = prev && Math.hypot(a.x - prev.x, a.y - prev.y, a.z - prev.z) < 0.01 ? still + 1 : 0
        if (da >= dt) {
          // Interpolate to the exact target distance instead of reporting a
          // sample up to one tick (~3 blocks) past it.
          const dp = prev ? Math.hypot(prev.x - origin.x, prev.z - origin.z) : da
          const f = prev && da > dp ? (dt - dp) / (da - dp) : 1
          last = at(prev ? { x: prev.x + (a.x - prev.x) * f, y: prev.y + (a.y - prev.y) * f, z: prev.z + (a.z - prev.z) * f } : a)
          return done('passed')
        }
        last = at(a); prev = { ...a }
        if (still >= 3) return done('stuck')
        if (clock() - startedAt > 3000) return done('timeout')
      } catch { clearInterval(timer) }
    }, 50)
    timer.unref?.()
  }
  function observeArrow (r, shot, name, packet) {
    if (clock() - shot.releasedAt > shotTimeoutMs) return
    if (name === 'add_entity') {
      const runtimeId = id(packet.runtime_id), uniqueId = id(packet.unique_id, true)
      if (runtimeId !== null) shot.candidates.delete(runtimeId)
      if (packet.entity_type !== 'minecraft:arrow' || !finite(packet.position) || distance(packet.position, shot.origin) > 2 || runtimeId === null || uniqueId === null || r.seenArrows.has(runtimeId)) return
      const v = packet.velocity; const speed = finite(v) ? Math.hypot(v.x, v.y, v.z) : 0
      const aim = shot.aim.lookPoint ?? shot.aim.point; const length = distance(shot.origin, aim)
      if (!(speed > 0) || ((aim.x - shot.origin.x) * v.x + (aim.y - shot.origin.y) * v.y + (aim.z - shot.origin.z) * v.z) / (length * speed) < 0.9) return
      const owners = ownersIn(packet.metadata)
      if (owners === null || owners.some(owner => owner !== id(getSelfUniqueId(), true))) return
      const candidate = { runtimeId, uniqueId, origin: copy(packet.position), releasedAt: shot.releasedAt, spawnedAt: clock(), speed, critical: criticalFlag(packet.metadata) }
      shot.candidates.set(runtimeId, candidate)
      while (shot.candidates.size > 8) shot.candidates.delete(shot.candidates.keys().next().value)
      if (owners.length) ownArrow(r, shot, candidate)
    } else if (name === 'set_entity_data') {
      const runtimeId = id(packet.runtime_entity_id), candidate = shot.candidates.get(runtimeId)
      if (!candidate || candidate.releasedAt !== shot.releasedAt || candidate.spawnedAt < shot.releasedAt || distance(candidate.origin, shot.origin) > 2) return
      const entity = typeof entities.get === 'function' ? entities.get(runtimeId) : entities.snapshot({ kind: 'all' }).find(e => id(e.runtimeId) === runtimeId)
      if (!entity || entity.entityType !== 'minecraft:arrow' || id(entity.uniqueId, true) !== candidate.uniqueId || entity.dimension !== getState().dimension || entity.alive === false) { shot.candidates.delete(runtimeId); return }
      const owners = ownersIn(packet.metadata)
      if (owners === null || owners.some(owner => owner !== id(getSelfUniqueId(), true))) { shot.candidates.delete(runtimeId); return }
      if (owners.length) ownArrow(r, shot, { ...candidate, critical: candidate.critical ?? criticalFlag(packet.metadata) })
    } else if (name === 'remove_entity') {
      for (const [runtimeId, candidate] of shot.candidates) if (candidate.uniqueId === id(packet.entity_id_self, true)) shot.candidates.delete(runtimeId)
    }
  }
  // Bedrock does not reliably echo the client's own cancel-slot selection, so
  // waiting only for that echo left combat blocked for the whole life (melee
  // included) while a hostile kept hitting. The cancel slot is settled once
  // the server-selected slot matches it, or after a bounded wait since the
  // cancel was queued; nothing is ever released or fired by this path.
  function settleCleanup () {
    if (!cleanup) return
    try {
      const s = getState()
      if (scopeOf(s) !== cleanup.scope) { cleanup = null; return }
      if ((s.rawServerSelectedSlot ?? s.rawSelectedSlot) === cleanup.slot && clock() - cleanup.at >= CLEANUP_SETTLE_MIN_MS) { cleanup = null; return }
    } catch { return }
    if (Number.isFinite(cleanup.at) && clock() - cleanup.at >= CLEANUP_SETTLE_MAX_MS) cleanup = null
  }
  function applyPacket (name, packet) {
    settleCleanup()
    if (cleanup) {
      if (scopeOf(getState()) !== cleanup.scope || ['start_game', 'change_dimension', 'disconnect', 'respawn'].includes(name)) cleanup = null
      else if ((name === 'mob_equipment' && id(packet.runtime_entity_id) === id(getState().runtimeEntityId) || name === 'player_hotbar') && inventoryWindow(packet.window_id) && packet.selected_slot === cleanup.slot) cleanup = null
    }
    const r = run
    if (recentShot && recentShot !== r?.shot) {
      if (scopeOf(getState()) !== recentShot.scope || clock() - recentShot.releasedAt > shotTimeoutMs) recentShot = null
      else observeAmmo(name, packet, recentShot)
    }
    if (!r) return
    if (scopeOf(getState()) !== r.scope) { cancel('Shooter scope changed', 'SESSION_CHANGED'); return }
    if (getState().dead || getState().isDead || !(getState().health > 0)) { cancel('Shooter died', 'NOT_ALIVE'); return }
    if (['start_game', 'change_dimension', 'disconnect'].includes(name)) { cancel('Connection or dimension changed', 'SESSION_CHANGED'); return }
    if (name === 'respawn' || name === 'entity_event' && id(packet.runtime_entity_id) === id(getState().runtimeEntityId) && ['death_animation', 3].includes(packet.event_id)) { cancel('Shooter died or respawned', 'NOT_ALIVE'); return }
    const current = typeof entities.get === 'function' ? entities.get(r.target.runtimeId) : entities.snapshot({ kind: 'all' }).find(e => e.runtimeId === r.target.runtimeId)
    const bound = current && id(current.uniqueId, true) === id(r.target.uniqueId, true) && current.entityType === r.target.entityType
    let dead = false; let by = null
    if (bound && name === 'entity_event' && id(packet.runtime_entity_id) === id(r.target.runtimeId) && ['death_animation', 3].includes(packet.event_id)) { dead = true; by = 'server_death_animation' }
    if (bound && ['add_entity', 'update_attributes'].includes(name) && id(packet.runtime_id ?? packet.runtime_entity_id) === id(r.target.runtimeId) && (packet.attributes ?? []).some(a => a.name === 'minecraft:health' && (name === 'add_entity' ? a.value : a.current) === 0)) { dead = true; by = 'server_health_zero' }
    if (dead) {
      // Mid-draw kill (an earlier arrow landed): keep the drawn bow and swing to
      // another shootable hostile within range; with none, cancel the draw so
      // no arrow is spent.
      const next = r.shot && r.shot.startSent != null && !r.shot.released ? retargetCandidate(r) : null
      if (next) { r.kills = (r.kills ?? 0) + 1; r.retargets = (r.retargets ?? 0) + 1; try { log(`引き絞りを保ったまま標的を切替: ${String(r.target.entityType).replace('minecraft:', '')} → ${String(next.entityType).replace('minecraft:', '')} context=${JSON.stringify({ ...logBinding(getState(), r.target), nextRuntimeId: id(next.runtimeId), nextUniqueId: id(next.uniqueId, true) })}`) } catch {} r.target = next; return }
      r.terminal = { dead: true, by }; cancelDraw(r); r.controller.abort(); return
    }
    if (name === 'remove_entity' && id(packet.entity_id_self, true) === id(r.target.uniqueId, true)) { r.terminal = { dead: false, removed: true, by: 'server_remove_unique_id' }; cancelDraw(r); r.controller.abort(); return }
    if ((name === 'mob_equipment' && id(packet.runtime_entity_id) === id(getState().runtimeEntityId) || name === 'player_hotbar') && inventoryWindow(packet.window_id) && packet.selected_slot === r.cancelSlot) r.cleanupUnconfirmed = false
    const released = r.lastReleasedShot
    if (bound && released?.released && released.scope === r.scope && id(released.target?.runtimeId) === id(r.target.runtimeId) && id(released.target?.uniqueId, true) === id(r.target.uniqueId, true) && name === 'entity_event' && id(packet.runtime_entity_id) === id(r.target.runtimeId) && ['hurt_animation', 2].includes(packet.event_id) && clock() - released.releasedAt >= 0 && clock() - released.releasedAt <= 3000) {
      // A hurt event identifies the target, not the projectile or attacker.
      // It is evidence of damage after a shot, never an attributed bow hit.
      try { log(`射撃後の標的ダメージ: target=${String(r.target.entityType).replace('minecraft:', '')} +${Math.round(clock() - released.releasedAt)}ms after shot ${released.number} context=${JSON.stringify({ ...released.logContext, damageSource: 'unknown', hitConfirmed: false })}`) } catch {}
    }
    if (r.shot && !r.shot.released && r.shot.startSent != null && name === 'set_entity_data' && id(packet.runtime_entity_id) === id(getState().runtimeEntityId)) {
      const flags = (packet.metadata ?? []).find(e => e?.key === 'flags' || e?.key === 0)?.value
      if (flags && typeof flags === 'object' && typeof flags.action === 'boolean') { if (flags.action) r.shot.serverDrawing = true; else if (r.shot.serverDrawing) { r.shot.serverDrawEnded = true; selectionDirty = true } }
    }
    // Released arrows are confirmed in parallel with the next draw.
    for (const shot of new Set([...r.pending, ...(r.shot?.released ? [r.shot] : [])])) {
      observeArrow(r, shot, name, packet)
      observeAmmo(name, packet, shot)
    }
  }
  return { preview, survey, engage, applyPacket, cancel, drain: () => task ?? Promise.resolve(), snapshot: () => (settleCleanup(), { busy: run !== null, engaging: run !== null, cleanupUnconfirmed: cleanup !== null, phase: run?.shot?.phase ?? (run?.equipping ? 'equipping' : run ? 'waiting' : 'idle'), targetRuntimeId: run?.target.runtimeId ?? null, shotsRequested: run?.shotsRequested ?? 0, shotsConfirmed: run?.shotsConfirmed ?? 0, lastResult: copy(lastResult) }) }
}

module.exports = { createRangedCombat, bowBodyAim }
