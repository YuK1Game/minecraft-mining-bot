'use strict'

const { equipmentReady } = require('./equipment-readiness')
const { traceBlockFace } = require('./aim')
const { evaluateThreats } = require('./threats')

// Pinned Bedrock 1.26.60: bed item uses metadata for colour; block halves use
// direction/head_piece_bit/occupied_bit, and their collision height is 9/16.
// Own sleep uses player_flags byte bit 1 plus player_bed_position. Reference:
// pmmp/BedrockProtocol PlayerMetadataFlags::SLEEP and Player::syncNetworkData.
const BED = 'minecraft:bed'
const BED_HEIGHT = 0.5625
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const OFFSETS = [{ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }]
const copy = value => structuredClone(value)
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const same = (a, b) => integer(a) && integer(b) && ['x', 'y', 'z'].every(axis => a[axis] === b[axis])
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const properties = block => Object.fromEntries(Object.entries(block?.properties ?? {}).map(([key, value]) => [key, value?.value ?? value]).sort(([a], [b]) => a.localeCompare(b)))
const bit = value => value === true || value === 1 ? 1 : value === false || value === 0 ? 0 : null
const bedItem = item => item?.name === BED && Number.isInteger(item.metadata) && item.metadata >= 0 && item.metadata <= 15 && Number.isSafeInteger(item.count) && item.count > 0
const countBed = (state, colour) => (state.inventory?.items ?? []).reduce((sum, item) => sum + (bedItem(item) && item.metadata === colour ? item.count : 0), 0)
const ownerKey = state => typeof state?.profile === 'string' && state.profile && state.realm?.id != null && state.dimension === 'overworld' && typeof state.playerName === 'string' && state.playerName ? JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.playerName]) : null

function bedFingerprint (block) {
  const props = properties(block)
  if (block?.known !== true || block.name !== BED || !integer(block.position) || !Number.isSafeInteger(block.runtimeId) || block.extra?.length || !Number.isInteger(props.direction) || props.direction < 0 || props.direction > 3 || bit(props.head_piece_bit) == null || bit(props.occupied_bit) == null) return null
  return { position: { ...block.position }, name: BED, runtimeId: block.runtimeId, properties: props }
}

function pairMatches (record, getBlock) {
  if (!record?.verified || record.source !== 'server_bed_placement' || !record.foot || !record.head || Math.abs(record.foot.position.x - record.head.position.x) + Math.abs(record.foot.position.z - record.head.position.z) !== 1 || record.foot.position.y !== record.head.position.y) return { valid: false, reason: 'ownership_unconfirmed' }
  const foot = bedFingerprint(getBlock(record.foot.position.x, record.foot.position.y, record.foot.position.z))
  const head = bedFingerprint(getBlock(record.head.position.x, record.head.position.y, record.head.position.z))
  if (!foot || !head) return { valid: false, reason: 'bed_geometry_unknown_or_changed' }
  for (const [actual, expected, headBit] of [[foot, record.foot, 0], [head, record.head, 1]]) {
    if (!same(actual.position, expected.position) || bit(actual.properties.head_piece_bit) !== headBit || actual.properties.direction !== expected.properties.direction) return { valid: false, reason: 'bed_fingerprint_changed' }
    const actualStable = { ...actual.properties }; const expectedStable = { ...expected.properties }
    delete actualStable.occupied_bit; delete expectedStable.occupied_bit
    if (JSON.stringify(actualStable) !== JSON.stringify(expectedStable) || bit(actual.properties.occupied_bit) === 0 && actual.runtimeId !== expected.runtimeId) return { valid: false, reason: 'bed_fingerprint_changed' }
  }
  return { valid: true, occupied: bit(foot.properties.occupied_bit) === 1 || bit(head.properties.occupied_bit) === 1 }
}

// Reuse the existing known-voxel ray, but calculate reach/face against the real
// 9/16 bed shape instead of granting full-cube reach to an empty upper half.
function bedVisibleFace ({ eye, target, world, maxReach = 4.5, previousAim = null }) {
  if (!finite(eye) || !integer(target) || !bedFingerprint(world.getBlock(target.x, target.y, target.z))) return null
  const center = { x: target.x + 0.5, y: target.y + BED_HEIGHT / 2, z: target.z + 0.5 }
  const points = previousAim ? [previousAim.point] : [
    { ...center, y: target.y + BED_HEIGHT - 0.001 }, { ...center, x: target.x + 0.001 }, { ...center, x: target.x + 0.999 }, { ...center, z: target.z + 0.001 }, { ...center, z: target.z + 0.999 }
  ]
  for (const point of points) {
    if (!finite(point)) continue
    let entry = 0; let exit = 1; let face = null
    for (const [axis, height, lowFace, highFace] of [['x', 1, 4, 5], ['y', BED_HEIGHT, 0, 1], ['z', 1, 2, 3]]) {
      const delta = point[axis] - eye[axis]
      if (Math.abs(delta) < 1e-12) { if (eye[axis] <= target[axis] || eye[axis] >= target[axis] + height) { exit = -1; break }; continue }
      let near = (target[axis] - eye[axis]) / delta; let far = (target[axis] + height - eye[axis]) / delta
      const side = delta > 0 ? lowFace : highFace
      if (near > far) [near, far] = [far, near]
      if (near > entry) { entry = near; face = side }
      exit = Math.min(exit, far)
    }
    if (entry < 0 || entry > exit || entry > 1 || face == null || previousAim && face !== previousAim.face) continue
    const hit = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, eye[axis] + (point[axis] - eye[axis]) * entry]))
    if (distance(eye, hit) > maxReach) continue
    try {
      if (traceBlockFace({ eye, target, point, world, maxReach: 6 })) return { point: { ...point }, hit, face, distance: distance(eye, hit) }
    } catch { /* Unknown or invalid received geometry rejects this face. */ }
  }
  return null
}

function createPortableBed ({ getState, getBlock, getClock, getMemory, setMemory, equip, place, use, wake, mine, collect = null, move = null, canAct = () => true, cancelActions = () => {}, onProgress = () => {}, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), version = '1.26.60', timeoutMs = 5000 } = {}) {
  if (version !== '1.26.60' || [getState, getBlock, getClock, getMemory, setMemory, equip, place, use, wake, mine, canAct, cancelActions, onProgress, now, delay].some(fn => typeof fn !== 'function') || collect != null && typeof collect !== 'function' || move != null && typeof move !== 'function') throw new Error('Portable beds require the pinned version, received observations, owned memory and normal action callbacks')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15000) throw new Error('Invalid portable-bed timeout')
  let memory = copy(getMemory() ?? { version: 1, sequence: 0, lifeSerial: 0, record: null, sleep: null, lastSleep: null })
  memory.sequence = Number.isSafeInteger(memory.sequence) ? memory.sequence : 0
  memory.lifeSerial = Number.isSafeInteger(memory.lifeSerial) ? memory.lifeSerial : 0
  let active = null; let generation = 0; let cleanupTask = Promise.resolve()
  let status = { phase: 'idle', busy: false, sleeping: false, serverConfirmed: false, collected: false, lastError: null, lastResult: null }
  const world = { getBlock }
  const lifeKey = state => JSON.stringify([state.connectionId ?? null, state.startedAt ?? null, String(state.runtimeEntityId ?? ''), state.lifecycle?.deathId ?? null, memory.lifeSerial ?? 0])
  const save = () => setMemory(copy(memory))
  const report = phase => { status.phase = phase; try { onProgress(snapshot()) } catch { /* Observers do not own actions. */ } }
  const currentSleep = state => !state.dead && !state.isDead && !state.lifecycle?.dead && state.health > 0 && memory.sleep?.scope === lifeKey(state) ? memory.sleep.sleeping : null
  function snapshot () { let state; try { state = getState() } catch { state = {} }; return copy({ ...status, busy: active !== null, sleeping: currentSleep(state) === true, ownedBed: memory.record, sleepReceipt: memory.sleep, lastSleepReceipt: memory.lastSleep }) }
  function window () {
    const value = getClock()
    if (!value || !Number.isSafeInteger(value.time) || !/^server_/.test(value.source ?? '')) return null
    const tick = ((value.time % 24000) + 24000) % 24000
    return tick >= 12000 ? 'night' : tick >= 200 ? 'day' : 'dawn'
  }
  function safeState () {
    const state = getState()
    if (!ownerKey(state) || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !finite(state.position) || !['survival', 0].includes(state.gameMode) || !state.connectionId || state.inventory?.known !== true || state.inventory.uncertain || state.inventory.serverConfirmed === false || state.inventory.source === 'client_prediction') return { ready: false, code: 'LIVING_CONFIRMED_STATE_REQUIRED', state }
    const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 })
    if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length) return { ready: false, code: 'ACTOR_OBSERVATION_REQUIRED', state }
    if (evaluation.threats.length || canAct(state) !== true) return { ready: false, code: 'NEARBY_THREAT_OR_OWNED_ACTION', state }
    return { ready: true, state }
  }
  const air = block => block?.known === true && AIR.has(block.name) && !block.extra?.length && !block.protected
  const support = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && /^(?:minecraft:)(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_planks)$/.test(block.name)
  function standing (state) {
    const physical = state.predicted?.physicsState ?? state.physicsState
    const feet = { ...state.position, y: state.position.y - 1.62 }; const y = Math.round(feet.y)
    if (physical?.onGround === false || physical?.isInWater || physical?.isInLava || Math.abs(feet.y - y) > 1e-4) return false
    for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) if (!support(getBlock(x, y - 1, z)) || !air(getBlock(x, y, z)) || !air(getBlock(x, y + 1, z))) return false
    return true
  }
  function accessStandpoint (state, record) {
    if (!move) return null
    const target = record.foot.position, candidates = []
    for (let x = target.x - 3; x <= target.x + 3; x++) for (let z = target.z - 3; z <= target.z + 3; z++) {
      const position = { x: x + 0.5, y: target.y + 1.62, z: z + 0.5 }
      const trial = { ...state, position, predicted: null, physicsState: null }
      if (distance(position, state.position) < 0.4 || Math.hypot(position.x - state.position.x, position.z - state.position.z) > 8 || !standing(trial) || !bedVisibleFace({ eye: position, target, world, maxReach: 4.2 })) continue
      candidates.push({ x: position.x, y: target.y, z: position.z })
    }
    return candidates.sort((a, b) => Math.hypot(a.x - state.position.x, a.z - state.position.z) - Math.hypot(b.x - state.position.x, b.z - state.position.z))[0] ?? null
  }
  function placement (state) {
    if (!standing(state)) return null
    const y = Math.round(state.position.y - 1.62), candidates = []
    for (let x = Math.floor(state.position.x) - 3; x <= Math.floor(state.position.x) + 3; x++) for (let z = Math.floor(state.position.z) - 3; z <= Math.floor(state.position.z) + 3; z++) {
      const foot = { x, y, z }, heads = OFFSETS.map(offset => ({ x: x + offset.x, y, z: z + offset.z }))
      if (Math.hypot(x + 0.5 - state.position.x, z + 0.5 - state.position.z) < 1.3 || distance(state.position, { x: x + 0.5, y, z: z + 0.5 }) > 4) continue
      const cells = [foot, ...heads]
      if (!cells.every(p => air(getBlock(p.x, p.y, p.z)) && air(getBlock(p.x, p.y + 1, p.z)) && support(getBlock(p.x, p.y - 1, p.z)) && !(p.x < state.position.x + 0.3 && p.x + 1 > state.position.x - 0.3 && p.z < state.position.z + 0.3 && p.z + 1 > state.position.z - 0.3))) continue
      try {
        const aimed = traceBlockFace({ eye: state.position, target: { x, y: y - 1, z }, point: { x: x + 0.5, y: y - 0.001, z: z + 0.5 }, world, maxReach: 4.5 })
        if (aimed?.face === 1) candidates.push({ foot, heads, cost: distance(state.position, { x: x + 0.5, y, z: z + 0.5 }) })
      } catch { /* No unknown geometry or blocked placement face. */ }
    }
    return candidates.sort((a, b) => a.cost - b.cost || a.foot.x - b.foot.x || a.foot.z - b.foot.z)[0] ?? null
  }
  function owned (state) {
    const record = memory.record
    if (!record || record.invalidated || record.owner !== ownerKey(state) || record.connectionId !== state.connectionId) return false
    return record.version === 1 && record.source === 'server_bed_placement' && record.verified === true
  }
  function previewUnchecked () {
    const checked = safeState(); if (!checked.ready) return { ready: false, code: checked.code }
    const state = checked.state, period = window(), record = memory.record
    if (!period) return { ready: false, code: 'SERVER_CLOCK_REQUIRED' }
    if (record && record.owner !== ownerKey(state)) return { ready: false, code: 'FOREIGN_BED_MEMORY' }
    if (currentSleep(state) === true) return { ready: period === 'day' && owned(state), action: period === 'day' && owned(state) ? 'wake' : 'sleeping', code: !owned(state) ? 'SLEEP_HAS_NO_OWNED_BED_RECORD' : period === 'day' ? null : 'SERVER_NIGHT_CONTINUES' }
    if (owned(state) && record.phase === 'retrieving') return { ready: true, action: 'collect', position: record.foot.position }
    const pair = owned(state) ? pairMatches(record, getBlock) : { valid: false }
    if (period === 'day') {
      if (!owned(state)) return { ready: false, code: 'NO_CONFIRMED_OWN_BED' }
      if (!pair.valid) return { ready: false, code: 'OWNED_BED_CHANGED_OR_UNKNOWN' }
      if (pair.occupied || currentSleep(state) !== false) return { ready: false, code: 'AWAKE_UNOCCUPIED_RECEIPT_REQUIRED' }
      if (now() < (record.retrieveRetryAt ?? 0)) return { ready: false, code: 'BED_RETRY_COOLDOWN' }
      if (!standing(state) || !bedVisibleFace({ eye: state.position, target: record.foot.position, world })) { const standpoint = accessStandpoint(state, record); return standpoint ? { ready: true, action: 'approach', target: standpoint } : { ready: false, code: 'KNOWN_BED_ACCESS_REQUIRED' } }
      return { ready: true, action: 'retrieve', position: record.foot.position }
    }
    if (period !== 'night') return { ready: false, code: 'WAIT_FOR_SERVER_DAY_OR_NIGHT' }
    if (now() < (memory.retryAt ?? 0)) return { ready: false, code: 'BED_RETRY_COOLDOWN' }
    if (owned(state) && pair.valid) {
      if (pair.occupied) return { ready: false, code: 'BED_OCCUPIED' }
      if (!bedVisibleFace({ eye: state.position, target: record.foot.position, world })) { const standpoint = accessStandpoint(state, record); return standpoint ? { ready: true, action: 'approach', target: standpoint } : { ready: false, code: 'KNOWN_BED_ACCESS_REQUIRED' } }
      return { ready: true, action: 'sleep', position: record.foot.position }
    }
    const item = state.inventory.items.find(bedItem)
    if (!item) return { ready: false, code: 'BED_ITEM_REQUIRED' }
    const plan = placement(state)
    return plan ? { ready: true, action: 'place', item: copy(item), plan } : { ready: false, code: 'NO_KNOWN_BED_SPACE' }
  }
  function preview () { try { return previewUnchecked() } catch { return { ready: false, code: 'BED_OBSERVATION_UNAVAILABLE' } } }
  function check (run) {
    if (active !== run || run.generation !== generation || run.controller.signal.aborted) throw new Error('Portable-bed action cancelled')
    const checked = safeState()
    if (!checked.ready || lifeKey(checked.state) !== run.life || ownerKey(checked.state) !== run.owner || checked.state.health < run.health) throw new Error('Portable-bed life, health, actor or ownership changed')
    return checked.state
  }
  function cleanup (run, reason) {
    if (!run || run.cleaned) return cleanupTask
    run.cleaned = true
    try { cleanupTask = Promise.resolve(cancelActions(reason)).catch(error => { status.lastError = String(error.message ?? error).slice(0, 300) }) } catch (error) { status.lastError = String(error.message ?? error).slice(0, 300) }
    return cleanupTask
  }
  async function wait (run, predicate) {
    while (now() <= run.deadline) { const state = check(run); if (predicate(state)) return state; await delay(50, run.controller.signal) }
    throw new Error('Portable-bed server confirmation timed out')
  }
  function rememberPair (run, footPosition, heads, item, beforeCount, placementReceipt, state) {
    const foot = bedFingerprint(getBlock(footPosition.x, footPosition.y, footPosition.z))
    if (!foot || bit(foot.properties.head_piece_bit) !== 0 || bit(foot.properties.occupied_bit) !== 0 || countBed(state, item.metadata) !== beforeCount - 1 || !(placementReceipt?.serverConfirmed === true || placementReceipt?.phase === 'completed' && placementReceipt.confirmedBy === 'server_block_and_inventory')) return false
    const matched = heads.map(p => bedFingerprint(getBlock(p.x, p.y, p.z))).filter(head => head && bit(head.properties.head_piece_bit) === 1 && bit(head.properties.occupied_bit) === 0 && head.properties.direction === foot.properties.direction)
    if (matched.length !== 1) return false
    memory.record = { version: 1, id: `${state.connectionId}:${now()}:${++memory.sequence}`, owner: run.owner, connectionId: state.connectionId, verified: true, source: 'server_bed_placement', item: { name: BED, metadata: item.metadata, networkId: item.networkId }, foot, head: matched[0], phase: 'placed', placedAt: now() }
    save(); return true
  }
  async function work (run, decision) {
    check(run)
    if (decision.action === 'approach') {
      report('approaching_bed')
      await move({ target: decision.target, allowWater: false }, { signal: run.controller.signal }); check(run)
      return { phase: 'approached', serverConfirmed: false, collected: false }
    }
    if (decision.action === 'place') {
      report('equipping_bed')
      const before = check(run), beforeCount = countBed(before, decision.item.metadata)
      const equipped = await equip(decision.item.slot, { signal: run.controller.signal }); const state = check(run)
      const slot = equipped?.slot ?? state.rawServerSelectedSlot ?? state.rawSelectedSlot
      const held = state.inventory.items.find(item => item.slot === slot)
      const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
      if (!equipmentReady(equipped, state, { sourceSlot: decision.item.slot, expectedItem: decision.item }) || selected !== slot || !bedItem(held) || held.metadata !== decision.item.metadata || state.equipmentServerConfirmed === false || state.heldItem?.name !== BED || state.heldItem.metadata !== decision.item.metadata) throw new Error('Bed equipment was not server-confirmed')
      if (![decision.plan.foot, ...decision.plan.heads].every(p => air(getBlock(p.x, p.y, p.z)) && air(getBlock(p.x, p.y + 1, p.z)) && support(getBlock(p.x, p.y - 1, p.z)))) throw new Error('Bed placement space changed before the normal item use')
      report('placing_bed')
      const receipt = await place({ position: decision.plan.foot, slot }, { signal: run.controller.signal })
      await wait(run, state => rememberPair(run, decision.plan.foot, decision.plan.heads, decision.item, beforeCount, receipt, state))
      return { phase: 'placed', serverConfirmed: true, confirmedBy: 'two_server_bed_halves_and_inventory', collected: false }
    }
    if (decision.action === 'sleep') {
      const sequence = memory.sequence ?? 0
      report('requesting_sleep')
      await use(memory.record.foot.position, { signal: run.controller.signal }); check(run)
      memory.sleepAttempts = (memory.sleepAttempts ?? 0) + 1; memory.retryAt = now() + Math.min(30000, 5000 * memory.sleepAttempts); save()
      await wait(run, () => memory.lastSleep?.scope === run.life && memory.lastSleep.sequence > sequence && (same(memory.lastSleep.bedPosition, memory.record.foot.position) || same(memory.lastSleep.bedPosition, memory.record.head.position)))
      return { phase: currentSleep(getState()) === true ? 'sleeping' : 'awake', serverConfirmed: true, confirmedBy: 'own_server_sleep_metadata', dayAdvanced: false, collected: false }
    }
    if (decision.action === 'wake') {
      report('requesting_wake')
      await wake(memory.record.foot.position, { signal: run.controller.signal })
      await wait(run, state => currentSleep(state) === false)
      return { phase: 'awake', serverConfirmed: true, confirmedBy: 'own_server_wake_receipt', dayAdvanced: false, collected: false }
    }
    if (decision.action === 'retrieve') {
      const state = check(run)
      memory.record.phase = 'retrieving'; memory.record.retrievalLife = run.life; memory.record.inventoryBefore = countBed(state, memory.record.item.metadata); memory.record.miningConfirmed = false; save()
      report('retrieving_bed')
      try {
        const result = await mine({ ...memory.record.foot.position, accessPreparation: 'owned_bed', expectedName: BED, ownershipKey: memory.record.id }, { signal: run.controller.signal })
        check(run)
        if (!(result?.serverConfirmed === true || result?.phase === 'completed')) throw new Error('Bed break was not confirmed by the normal miner')
        memory.record.miningConfirmed = true; save()
      } catch (error) {
        if (memory.record && pairMatches(memory.record, getBlock).valid) { memory.record.phase = 'placed'; memory.record.retrieveRetryAt = now() + 5000; save() }
        throw error
      }
    }
    if (decision.action === 'retrieve' || decision.action === 'collect') {
      report('collecting_bed')
      if (collect) await collect({ position: memory.record.foot.position, name: BED, metadata: memory.record.item.metadata }, { signal: run.controller.signal })
      await wait(run, state => memory.record.retrievalLife === run.life && memory.record.miningConfirmed && [memory.record.foot, memory.record.head].every(part => air(getBlock(part.position.x, part.position.y, part.position.z))) && countBed(state, memory.record.item.metadata) >= memory.record.inventoryBefore + 1)
      memory.record = null; memory.sleepAttempts = 0; memory.retryAt = 0; save()
      return { phase: 'collected', serverConfirmed: true, confirmedBy: 'owned_bed_air_and_server_inventory', collected: true }
    }
    return { phase: 'waiting', serverConfirmed: false, collected: false }
  }
  function execute ({ signal } = {}) {
    if (active) return active.task
    const decision = preview()
    if (!decision.ready) { status.lastResult = { phase: 'waiting', code: decision.code, serverConfirmed: false, collected: false }; report(decision.action === 'sleeping' ? 'sleeping' : 'waiting'); return Promise.resolve(snapshot()) }
    const state = getState(), controller = new AbortController()
    const abort = () => controller.abort(signal.reason ?? new Error('Portable-bed action cancelled'))
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    const run = { generation: ++generation, owner: ownerKey(state), life: lifeKey(state), health: state.health, controller, deadline: now() + timeoutMs, task: null }
    active = run; status.busy = true; status.serverConfirmed = false; status.collected = false; status.lastError = null
    let timer; let cancelled
    const cancellation = new Promise((resolve, reject) => { cancelled = () => reject(controller.signal.reason ?? new Error('Portable-bed action cancelled')); if (controller.signal.aborted) cancelled(); else controller.signal.addEventListener('abort', cancelled, { once: true }) })
    run.task = Promise.race([Promise.resolve().then(() => work(run, decision)), cancellation, new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(new Error('Portable-bed action deadline')); reject(new Error('Portable-bed action deadline')) }, timeoutMs + 100) })]).then(result => { check(run); status.lastResult = result; status.serverConfirmed = result.serverConfirmed === true; status.collected = result.collected === true; report(result.phase) }).catch(error => { controller.abort(error); cleanup(run, String(error.message ?? error)); status.lastError = String(error.message ?? error).slice(0, 300); status.lastResult = { phase: 'waiting', serverConfirmed: false, collected: false }; report('waiting') }).finally(async () => { clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled); signal?.removeEventListener('abort', abort); await cleanupTask; if (active === run) active = null; status.busy = false })
    return run.task.then(snapshot)
  }
  function applyPacket (name, packet = {}) {
    const state = getState(), own = id => id != null && state.runtimeEntityId != null && String(id) === String(state.runtimeEntityId)
    const health = name === 'set_health' ? packet.health : name === 'update_attributes' && own(packet.runtime_entity_id) ? packet.attributes?.find(attribute => attribute.name === 'minecraft:health')?.current : null
    const death = Number.isFinite(health) && health <= 0 || name === 'entity_event' && own(packet.runtime_entity_id) && ['death_animation', 3].includes(packet.event_id)
    const boundary = ['start_game', 'change_dimension', 'close', 'disconnect'].includes(name) || name === 'entity_event' && own(packet.runtime_entity_id) && ['respawn', 18].includes(packet.event_id)
    if (death || boundary) {
      if (!death || !memory.deadObserved) memory.lifeSerial = (memory.lifeSerial ?? 0) + 1
      memory.deadObserved = death; memory.sleep = null; memory.lastSleep = null; save(); cancel('Bed life changed'); return
    }
    if (Number.isFinite(health) && health > 0 && memory.deadObserved && state.dead === false && !state.lifecycle?.dead) { memory.deadObserved = false; save() }
    if (name === 'set_entity_data' && own(packet.runtime_entity_id)) {
      let sleeping = null; let bedPosition = memory.sleep?.scope === lifeKey(state) ? memory.sleep.bedPosition : null
      for (const entry of packet.metadata ?? []) {
        if ([28, 'player_bed_position', 133, 'bed_enter_position'].includes(entry.key) && integer(entry.value)) bedPosition = { ...entry.value }
        if ([26, 'player_flags'].includes(entry.key) && Number.isInteger(entry.value)) sleeping = (entry.value & (1 << 1)) !== 0
      }
      const prior = memory.sleep?.scope === lifeKey(state) ? memory.sleep : null
      if (sleeping !== null || bedPosition) {
        memory.sleep = { sleeping: sleeping ?? prior?.sleeping ?? null, bedPosition, scope: lifeKey(state), sequence: ++memory.sequence, source: 'own_server_metadata', at: now() }
        if (memory.sleep.sleeping === true && owned(state) && (same(bedPosition, memory.record.foot.position) || same(bedPosition, memory.record.head.position))) memory.lastSleep = copy(memory.sleep)
        save()
      }
    } else if (name === 'animate' && own(packet.runtime_entity_id) && ['wake_up', 3].includes(packet.action_id)) {
      memory.sleep = { sleeping: false, bedPosition: memory.sleep?.bedPosition ?? null, scope: lifeKey(state), sequence: ++memory.sequence, source: 'own_server_wake_animation', at: now() }; save()
    }
    if (['update_block', 'update_subchunk_blocks'].includes(name) && owned(state) && memory.record.phase !== 'retrieving') {
      const parts = [memory.record.foot, memory.record.head].map(part => getBlock(part.position.x, part.position.y, part.position.z))
      if (parts.some(block => block?.known === true && block.name !== BED) || parts.every(block => block?.known === true) && !pairMatches(memory.record, getBlock).valid) { memory.record.invalidated = true; memory.record.invalidation = 'received_bed_replacement'; save() }
    }
  }
  function ownsTarget (state, target, block) {
    const checked = safeState()
    if (!checked.ready) return false
    const current = checked.state
    if (ownerKey(state) !== ownerKey(current) || state.connectionId !== current.connectionId || state.startedAt !== current.startedAt || String(state.runtimeEntityId) !== String(current.runtimeEntityId) || !finite(state.position) || distance(state.position, current.position) > 0.05 || state.lifecycle?.deathId != null && current.lifecycle?.deathId != null && state.lifecycle.deathId !== current.lifecycle.deathId) return false
    const record = memory.record
    const pair = owned(current) ? pairMatches(record, getBlock) : null
    return !!(active && status.phase === 'retrieving_bed' && owned(current) && record.phase === 'retrieving' && record.retrievalLife === lifeKey(current) && window() === 'day' && currentSleep(current) === false && target.accessPreparation === 'owned_bed' && target.ownershipKey === record.id && same(target, record.foot.position) && bedFingerprint(block) && pair?.valid && !pair.occupied)
  }
  function cancel (reason = 'Portable-bed operation cancelled') {
    generation++; const run = active; run?.controller.abort(new Error(reason))
    cleanup(run, reason)
    return snapshot()
  }
  return { preview, execute, tick: execute, applyPacket, ownsTarget, cancel, drain: () => Promise.allSettled([active?.task, cleanupTask]), snapshot }
}

module.exports = { createPortableBed, bedVisibleFace, bedFingerprint, pairMatches, BED_HEIGHT }
