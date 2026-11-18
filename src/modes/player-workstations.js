'use strict'

// A placed portable station remains a responsibility until its item is received
// again. Observed stations can be reused, but observation alone grants no right
// to break them. House fixtures never enter this ledger.
const { deserialize } = require('node:v8')
const { supplyScope, stationWorldScope } = require('../survival/supply-return')
const { placements } = require('./house/house-blueprint')

const ITEMS = new Set(['minecraft:crafting_table', 'minecraft:furnace'])
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)
const same = (a, b) => point(a) && point(b) && ['x', 'y', 'z'].every(k => a[k] === b[k])
const properties = b => Object.fromEntries(Object.entries(b?.properties ?? {}).map(([k, v]) => [k, v?.value ?? v]).sort(([a], [b]) => a.localeCompare(b)))
const count = (state, item) => (state.inventory?.items ?? []).filter(i => i.name === item && Number.isSafeInteger(i.count) && i.count > 0).reduce((n, i) => n + i.count, 0)
const inventoryReady = state => state?.inventory?.known === true && !state.inventory.uncertain && state.inventory.serverConfirmed !== false && state.inventory.source !== 'client_prediction'
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x - 0.5, a.y - b.y - 0.5, a.z - b.z - 0.5) : Infinity

function fixedStation (shared, position) {
  const origin = shared.playerHouse?.origin
  return point(origin) && placements(origin).some(step => ['crafting_table', 'furnace'].includes(step.item) && same(step.position, position))
}

function fingerprint (block) {
  return block?.known === true && point(block.position) && ITEMS.has(block.name) && Number.isSafeInteger(block.runtimeId) && !block.extra?.length
    ? { name: block.name, runtimeId: block.runtimeId, properties: properties(block) } : null
}

function matches (record, block) {
  const actual = fingerprint(block)
  return !!actual && same(record.position, block.position) && actual.name === record.item && actual.runtimeId === record.fingerprint?.runtimeId && JSON.stringify(actual.properties) === JSON.stringify(record.fingerprint?.properties)
}

function validRecord (record) {
  return record?.temporary === true && record.source === 'server_station_placement' && record.serverConfirmed === true &&
    typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 200 && typeof record.worldScope === 'string' &&
    point(record.position) && ITEMS.has(record.item) && record.fingerprint?.name === record.item && Number.isSafeInteger(record.fingerprint.runtimeId)
}

// The interaction controller supplies both receipts from the same placement.
// A resolved request or a block appearing without item consumption is insufficient.
function placementRecord ({ shared, state, item, receipt, block, now = Date.now() }) {
  const scope = supplyScope(state), worldScope = stationWorldScope(state), witness = receipt?.placementObservation
  if (shared.botMode !== 'player' || !scope || !worldScope || !ITEMS.has(item) || !inventoryReady(state) ||
      receipt?.phase !== 'completed' || receipt.operation !== 'place' || receipt.confirmedBy !== 'server_block_and_inventory' || receipt.expectedBlock !== item || receipt.blockName !== item ||
      witness?.version !== 1 || witness.wireSent !== true || witness.transactionQueued !== true || witness.rawEncoding !== 'v8-base64' || witness.targetBlock?.name !== item ||
      !Number.isSafeInteger(receipt.requestId) || receipt.requestId !== witness.requestId || !Number.isInteger(witness.slot) || witness.slot < 0 || witness.slot > 8 ||
      !Number.isFinite(witness.observedAt) || witness.observedAt > now || now - witness.observedAt > 30000 ||
      ![witness.sourceObservedAt, witness.blockObservedAt].every(at => Number.isFinite(at) && at > 0 && at <= witness.observedAt) ||
      !same(receipt.position, witness.targetBlock?.position) || !same(receipt.position, block?.position) || fixedStation(shared, receipt.position)) return null
  const frame = witness.scope
  if (!frame || frame.profile !== state.profile || String(frame.realmId) !== String(state.realm?.id) || frame.dimension !== state.dimension ||
      frame.connectionId !== state.connectionId || frame.startedAt !== state.startedAt || String(frame.runtimeEntityId) !== String(state.runtimeEntityId) || frame.life !== state.lifecycle?.deathId || witness.life !== frame.life) return null
  const fp = fingerprint(block)
  if (!fp || fp.name !== item || fp.runtimeId !== witness.targetBlock.runtimeId) return null
  try {
    if (typeof witness.sourceBefore !== 'string' || typeof witness.sourceAfter !== 'string' || witness.sourceBefore.length > 65536 || witness.sourceAfter.length > 65536) return null
    const before = deserialize(Buffer.from(witness.sourceBefore, 'base64')), after = deserialize(Buffer.from(witness.sourceAfter, 'base64'))
    if (!(before.network_id > 0) || !Number.isSafeInteger(before.count) || before.count < 1 || after.count !== before.count - 1 ||
        (after.count === 0 ? after.network_id !== 0 : after.network_id !== before.network_id)) return null
  } catch { return null }
  shared.playerWorkstationSequence = (Number.isSafeInteger(shared.playerWorkstationSequence) ? shared.playerWorkstationSequence : 0) + 1
  return { id: `station:${shared.playerWorkstationSequence}:${now}`, receiptKey: `${scope}:${receipt.requestId}`, item, position: { ...receipt.position }, worldScope,
    source: 'server_station_placement', temporary: true, serverConfirmed: true, fingerprint: fp, placedAt: now, phase: 'placed', pending: null, attempts: 0 }
}

function records (shared, state) {
  const worldScope = stationWorldScope(state)
  if (!worldScope || shared.playerWorkstations?.version !== 1) return []
  return (shared.playerWorkstations.records ?? []).filter(record => validRecord(record) && !record.invalidated && record.worldScope === worldScope && !fixedStation(shared, record.position))
}

function stationTarget (record) {
  return { ...record.position, accessPreparation: 'owned_station', expectedName: record.item, expectedRuntimeId: record.fingerprint.runtimeId, ownershipKey: record.id }
}

function ownsStation ({ shared, state, target, block, now = Date.now() }) {
  const record = records(shared, state).find(r => r.id === target?.ownershipKey)
  if (shared.botMode !== 'player' || !record || !same(record.position, target) || target.accessPreparation !== 'owned_station' || target.expectedName !== record.item ||
      target.expectedRuntimeId !== record.fingerprint.runtimeId || !supplyScope(state) || record.authorization?.scope !== supplyScope(state) ||
      !(record.authorization.expiresAt >= now) || block?.protected || block?.protectionSource || block?.extra?.length) return false
  if (record.item === 'minecraft:furnace' && record.authorization.furnaceEmpty !== true) return false
  if (block?.known === true && AIR.has(block.name)) return record.phase === 'retrieving' && record.pending?.miningStarted === true && record.pending.ownershipKey === record.id && record.pending.scope === supplyScope(state)
  return matches(record, block)
}

function hasRoom (state, item) {
  if (!inventoryReady(state)) return false
  const items = (state.inventory.items ?? []).filter(i => i.count > 0)
  return items.some(i => i.name === item && i.count < 64) || new Set(items.map(i => i.slot)).size < 36
}

function emptyFurnace (view, position, block) {
  const at = view?.window?.coordinates ?? view?.window?.position
  return block?.known === true && block.name === 'minecraft:furnace' && same(at, position) && view.contentsKnown === true && view.needsOpen !== true &&
    !view.inventoryUncertain && !view.busy && !(view.progress?.burnTicksRemaining > 0) &&
    [0, 1, 2].every(slot => view.slots?.some(item => item.slot === slot && item.known === true && item.count === 0 && !item.name))
}

function nearbyRecords ({ shared, state, getBlock, now = Date.now() }) {
  if (shared.botMode !== 'player' || !supplyScope(state) || !inventoryReady(state)) return []
  return records(shared, state).filter(record => record.phase !== 'collected' && (record.retryAt ?? 0) <= now && distance(state.position, record.position) <= 12 &&
    hasRoom(state, record.item) && (matches(record, getBlock(record.position.x, record.position.y, record.position.z)) || record.pending && AIR.has(getBlock(record.position.x, record.position.y, record.position.z)?.name)))
    .sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || distance(state.position, a.position) - distance(state.position, b.position))
}

function recoveryDecision (record) {
  return record ? { type: 'recover_workstation', stage: 'portable_worksite', workstationId: record.id, item: record.item, target: { ...record.position },
    reason: record.item === 'minecraft:crafting_table' ? '使い終えた仮設の作業台を回収し、次の場所でも使います。' : '中身のない仮設かまどを回収し、次の場所でも使います。' } : null
}

// Only ordinary departure/work choices yield to packing. Defense, eating,
// stopping and crafting retain their own priority. A batch of nearby crafts
// therefore uses one placement rather than repeatedly unpacking the same table.
function withWorkstationCleanup ({ mode, decision, observation }) {
  if (mode !== 'player' || !observation?.enabled || !decision || decision.type === 'recover_workstation') return decision
  const departures = new Set(['explore', 'prospect', 'tunnel', 'gather_logs', 'mine_stone', 'mine_ore', 'move_to', 'collect_drops', 'complete'])
  if (!departures.has(decision.type) || ['safety', 'retreat', 'food', 'nutrition', 'shelter', 'portable_worksite'].includes(decision.stage) || decision.stationTarget || decision.interactionTarget || decision.placementPurpose || decision.accessPreparation) return decision
  const candidates = [observation.recoverTable, observation.recoverFurnace ?? observation.inspectFurnace].filter(Boolean)
  for (const candidate of candidates) {
    const target = decision.resourceTarget ?? decision.target
    const away = !target || Math.hypot(target.x - candidate.target.x, target.y - candidate.target.y, target.z - candidate.target.z) > 5
    if (away || ['explore', 'prospect', 'tunnel', 'complete'].includes(decision.type)) return candidate
  }
  return decision
}

module.exports = { ITEMS, AIR, same, count, inventoryReady, fixedStation, fingerprint, matches, validRecord, placementRecord, records, stationTarget, ownsStation, hasRoom, emptyFurnace, nearbyRecords, recoveryDecision, withWorkstationCleanup }
