'use strict'

const { resourceMinHealth } = require('../safety/learning-health')
const { supplyScope } = require('../survival/supply-return')

const STATIONS = new Set(['minecraft:crafting_table', 'minecraft:furnace'])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const failure = (code, message) => Object.assign(new Error(message), { code })
const samePosition = (a, b) => ['x', 'y', 'z'].every(axis => a?.[axis] === b?.[axis])

function stationTarget (position) {
  if (!position || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis]) && Math.abs(position[axis]) <= 30000000) || position.accessPreparation !== 'owned_station' || !STATIONS.has(position.expectedName) || typeof position.ownershipKey !== 'string' || !position.ownershipKey.length || position.ownershipKey.length > 200 || !Number.isSafeInteger(position.expectedRuntimeId) || position.expectedRuntimeId < 0 || position.expectedRuntimeId > 4294967295) throw failure('STATION_TARGET_INVALID', 'Owned-station mining requires an exact temporary table or furnace placement receipt')
  return { x: position.x, y: position.y, z: position.z, accessPreparation: 'owned_station', expectedName: position.expectedName, expectedRuntimeId: position.expectedRuntimeId, ownershipKey: position.ownershipKey }
}

function stationScope (state) {
  const life = state?.lifecycle?.deathId, inventory = state?.inventory
  const scope = supplyScope(state)
  if (!scope || state?.phase !== 'spawned' || !['survival', 0].includes(state.gameMode) || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state) || inventory?.known !== true || inventory.uncertain || inventory.serverConfirmed === false || inventory.source === 'client_prediction' || !Array.isArray(inventory.items) || typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !String(state.realm.id) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) || !/^[1-9]\d*$/.test(String(state.runtimeEntityId ?? '')) || state.dimension == null || !Number.isSafeInteger(life) || life < 0) throw failure('STATION_SCOPE_UNCONFIRMED', 'Owned-station recovery requires received inventory and the current living connection')
  return scope
}

function assertOwnedStation ({ state, target, block, verifyOwnedStation, scope = null, isProtected = () => false }) {
  if (scope !== null && stationScope(state) !== scope) throw failure('STATION_SCOPE_CHANGED', 'Owned-station recovery changed connection or life')
  if (scope === null) stationScope(state)
  if (block?.known !== true || block.protected === true || block.protectionSource || isProtected(target, state, block) || block.extra?.some(layer => !AIR.has(layer?.name))) throw failure('STATION_BLOCK_UNCONFIRMED', 'Owned-station block is unknown, protected or has an additional layer')
  const air = AIR.has(block.name)
  if (!air && (block.name !== target.expectedName || block.runtimeId !== target.expectedRuntimeId || !STATIONS.has(block.name) || block.boundingBox !== 'block' || block.diggable === false)) throw failure('STATION_BLOCK_CHANGED', 'Owned-station block changed from its placement receipt')
  // The owner checks world, temporary placement, permanent house cells and,
  // for a furnace, fresh received empty slots and an inactive fire. AIR is
  // accepted only against that same recorded, pending retrieval.
  if (typeof verifyOwnedStation !== 'function' || verifyOwnedStation(state, target, block) !== true) throw failure('STATION_OWNERSHIP_UNCONFIRMED', 'This station lacks current temporary placement and contents proof')
  return air
}

function inventoryCount (state, name) {
  return state.inventory.items.reduce((sum, item) => sum + (item.name === name && Number.isSafeInteger(item.slot) && item.slot >= 0 && item.slot < 36 && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)
}

function createStationRecovery ({ getState, getBlock, mining, collect, getPending, setPending, verifyOwnedStation, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 15000, pollMs = 50 }) {
  for (const reader of [getState, getBlock, collect, getPending, setPending, verifyOwnedStation, now, sleep]) if (typeof reader !== 'function') throw new Error('Station recovery needs explicit ownership, persistence, mining and pickup callbacks')
  for (const method of ['preview', 'start', 'snapshot', 'stop']) if (typeof mining?.[method] !== 'function') throw new Error('Station recovery needs actual mining operations')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Station recovery time limits must be positive')
  let active = null

  async function recover (position, { signal } = {}) {
    if (active) throw failure('STATION_RECOVERY_BUSY', 'Another station retrieval is still active')
    const target = stationTarget(position), controller = new AbortController(), run = { scope: stationScope(getState()), miningId: null, deadline: now() + timeoutMs, collecting: false }
    const abortPickup = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abortPickup, { once: true })
    active = run
    let pending = null
    function check () {
      if (signal?.aborted || active !== run) throw failure('ABORTED', 'Station retrieval was interrupted')
      const state = getState(), block = getBlock(target.x, target.y, target.z)
      const air = assertOwnedStation({ state, target, block, verifyOwnedStation, scope: run.scope })
      return { state, block, air }
    }
    function ownMining () {
      const status = mining.snapshot()
      return status.operation === 'owned_station' && run.miningId !== null && status.stationRunId === run.miningId ? status : null
    }
    function stopOwnMining (reason) {
      if (ownMining()?.phase === 'mining') mining.stop(reason)
    }
    function completeEvidence (observation) {
      return pending?.miningStarted === true && observation.air && inventoryCount(observation.state, target.expectedName) >= pending.inventoryBefore + 1
    }
    async function waitFor (predicate) {
      while (true) {
        const observation = check()
        if (predicate(observation)) return observation
        if (now() >= run.deadline) throw failure('STATION_RECOVERY_TIMEOUT', 'Station destruction and received inventory recovery were not both confirmed')
        await sleep(Math.min(pollMs, Math.max(1, run.deadline - now())))
      }
    }
    async function collectWithChecks () {
      let settled = false, rejected = null
      run.collecting = true
      // Observe life/ownership/abort while the movement callback is awaiting
      // server position. Do not wait forever for a callback that never settles.
      Promise.resolve().then(() => { check(); return collect(target, { signal: controller.signal }) }).then(() => { settled = true }, error => { settled = true; rejected = error })
      await waitFor(() => settled)
      run.collecting = false
      if (rejected) throw rejected
    }
    try {
      let observation = check()
      const previous = await getPending(target)
      observation = check()
      if (previous != null) {
        if (previous.version !== 1 || previous.ownershipKey !== target.ownershipKey || !samePosition(previous.position, target) || previous.item !== target.expectedName || previous.runtimeId !== target.expectedRuntimeId || previous.scope !== run.scope || !Number.isSafeInteger(previous.inventoryBefore) || previous.inventoryBefore < 0 || typeof previous.miningStarted !== 'boolean') throw failure('STATION_PENDING_CHANGED', 'Pending station retrieval no longer matches this placement and life')
        pending = structuredClone(previous)
      }
      if (observation.air && pending?.miningStarted !== true) throw failure('STATION_MINING_UNCONFIRMED', 'AIR alone does not prove an owned station was retrieved')
      if (!observation.air) {
        if (mining.snapshot().phase === 'mining') throw failure('STATION_MINING_BUSY', 'Another mining operation is active')
        const plan = mining.preview([target])
        if (plan.ready !== true) throw failure('STATION_MINING_DENIED', plan.errors?.join('\n') || 'Station mining is not ready')
        // Refresh the baseline if an interrupted dig left the block intact.
        // Inventory changes between attempts never count as its eventual drop.
        pending = { version: 1, ownershipKey: target.ownershipKey, position: { x: target.x, y: target.y, z: target.z }, item: target.expectedName, runtimeId: target.expectedRuntimeId, scope: run.scope, inventoryBefore: inventoryCount(observation.state, target.expectedName), startedAt: now(), miningStarted: false, blockCleared: false }
        await setPending(target, structuredClone(pending))
        observation = check()
        const latestCount = inventoryCount(observation.state, target.expectedName)
        if (latestCount !== pending.inventoryBefore) {
          pending.inventoryBefore = latestCount
          await setPending(target, structuredClone(pending))
          observation = check()
          if (inventoryCount(observation.state, target.expectedName) !== latestCount) throw failure('STATION_INVENTORY_CHANGED', 'Station inventory changed while saving the pre-dig baseline')
        }
        const started = mining.start([target])
        run.miningId = started.stationRunId
        if (started.operation !== 'owned_station' || !Number.isSafeInteger(run.miningId)) throw failure('STATION_MINING_UNCONFIRMED', 'Mining did not acknowledge this owned-station operation')
        pending.miningStarted = true
        await setPending(target, structuredClone(pending))
        await waitFor(observed => {
          const status = ownMining()
          if (!status || !['mining', 'completed'].includes(status.phase)) throw failure('STATION_MINING_INTERRUPTED', status?.reason || 'Station mining was replaced or stopped')
          return status.phase === 'completed' && status.serverConfirmed === true && status.blockCleared === true && observed.air
        })
      }
      observation = check()
      pending.blockCleared = true
      await setPending(target, structuredClone(pending))
      observation = check()
      if (!completeEvidence(observation)) {
        // The callback owns its movement and must stop only that movement on
        // interruption. Its return value or a vanished drop cannot prove pickup.
        await collectWithChecks()
        observation = await waitFor(completeEvidence)
      }
      if (!completeEvidence(check())) throw failure('STATION_PICKUP_UNCONFIRMED', 'The received station item has not returned to this inventory')
      await setPending(target, null)
      // Successful clear may remove the ownership record, so only the life and
      // received inventory are checked again after the persistence boundary.
      if (signal?.aborted || stationScope(getState()) !== run.scope || inventoryCount(getState(), target.expectedName) < pending.inventoryBefore + 1) throw failure('STATION_SCOPE_CHANGED', 'Station recovery changed while saving the received pickup')
      return { ok: true, collected: true, serverConfirmed: true, confirmedBy: 'owned_station_air_and_server_inventory', position: pending.position, item: pending.item }
    } catch (error) {
      if (run.collecting) controller.abort(error)
      stopOwnMining(error.message)
      if (!error.code) error.code = 'STATION_RECOVERY_FAILED'
      throw error
    } finally {
      signal?.removeEventListener('abort', abortPickup)
      if (active === run) active = null
    }
  }
  return { recover }
}

module.exports = { createStationRecovery, stationTarget, stationScope, assertOwnedStation }
