'use strict'

const { isDeepStrictEqual } = require('node:util')
const MATERIALS = '(?:wooden|golden|stone|iron|diamond|netherite)'
const family = { sword: new RegExp('^minecraft:' + MATERIALS + '_sword$'), pickaxe: new RegExp('^minecraft:' + MATERIALS + '_pickaxe$') }
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000001)
const fullName = value => String(value ?? '').includes(':') ? String(value) : 'minecraft:' + value
const runtimeOf = drop => drop?.entityId ?? drop?.runtimeEntityId ?? drop?.runtimeId ?? drop?.id
function wireId (value, signed = false) {
  if (value == null || typeof value === 'number' && !Number.isSafeInteger(value) || !new RegExp(signed ? '^-?\\d+$' : '^\\d+$').test(String(value))) return null
  try { const n = BigInt(value); return n >= (signed ? -(1n << 63n) : 0n) && n < 1n << (signed ? 63n : 64n) ? String(n) : null } catch { return null }
}
function starterGearScope (state) {
  const life = state?.lifecycle?.deathId
  if (state?.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(Number.isFinite(state.health) && state.health > 0) || state.lifecycle?.phase !== 'alive' || !Number.isSafeInteger(life) || life < 0 || typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !['overworld', 'nether', 'end'].includes(state.dimension) || wireId(state.runtimeEntityId) === null || state.uniqueEntityId != null && wireId(state.uniqueEntityId, true) === null) return null
  return { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: wireId(state.runtimeEntityId), uniqueEntityId: state.uniqueEntityId == null ? null : wireId(state.uniqueEntityId, true), deathId: life }
}
const sameStarterGearScope = (scope, state) => scope != null && isDeepStrictEqual(scope, starterGearScope(state))
const inventoryKnown = state => state?.inventory?.known === true && !state.inventory.uncertain && state.inventory.serverConfirmed !== false && state.inventory.source !== 'client_prediction'
function unprotected (drop) {
  return drop?.protected !== true && drop.owned !== true && drop.playerOwned !== true && drop.ownedByPlayer !== true && drop.natural !== false && drop.tamed !== true && drop.isTamed !== true && drop.owner == null && drop.ownerId == null && drop.ownerUniqueId == null && drop.ownerRuntimeId == null && drop.ownerEntityId == null && typeof drop.username !== 'string'
}
function observedGear (drop, state, kind) {
  return family[kind]?.test(fullName(drop?.name)) && (drop.known === true || drop.positionKnown === true) && drop.alive !== false && (drop.kind == null || drop.kind === 'item') && (drop.dimension == null || drop.dimension === state.dimension) && (drop.connectionId == null || drop.connectionId === state.connectionId) && (drop.startedAt == null || drop.startedAt === state.startedAt) && drop.positionSource !== 'client_prediction' && drop.source !== 'client_prediction' && finite(drop.position) && Number.isSafeInteger(drop.count) && drop.count > 0 && wireId(runtimeOf(drop)) !== null && wireId(drop.uniqueId, true) !== null && !(drop.durabilityKnown === true && drop.durabilityRemaining <= 0) && unprotected(drop) && Math.hypot(drop.position.x - state.position.x, drop.position.y - state.position.y, drop.position.z - state.position.z) <= 12
}
function selectStarterGearDrop (state, observations = {}, { kind } = {}) {
  if (!family[kind] || !starterGearScope(state) || !inventoryKnown(state) || !Array.isArray(state.inventory.items) || !finite(state.position)) return null
  if ((state.inventory.items ?? []).some(item => family[kind].test(fullName(item.name)) && Number.isSafeInteger(item.count) && item.count > 0 && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))) return null
  const excluded = new Set((Array.isArray(observations.progress?.excludedDropIds) ? observations.progress.excludedDropIds : []).map(String))
  const source = Array.isArray(observations.drops) ? observations.drops : Array.isArray(state.droppedItems) ? state.droppedItems : []
  const drops = source.filter(drop => observedGear(drop, state, kind) && !excluded.has(wireId(runtimeOf(drop))) && !excluded.has(wireId(drop.uniqueId, true))).sort((a, b) => Math.hypot(a.position.x - state.position.x, a.position.y - state.position.y, a.position.z - state.position.z) - Math.hypot(b.position.x - state.position.x, b.position.y - state.position.y, b.position.z - state.position.z) || wireId(runtimeOf(a)).localeCompare(wireId(runtimeOf(b))))
  const drop = drops[0]
  return drop ? { entityId: wireId(runtimeOf(drop)), uniqueId: wireId(drop.uniqueId, true), name: fullName(drop.name), count: 1, position: { ...drop.position }, starterGear: kind, collectionScope: starterGearScope(state) } : null
}
function validateStarterGearTarget (state, target) {
  if (!family[target?.starterGear] || wireId(target.entityId) === null || wireId(target.uniqueId, true) === null || !family[target.starterGear].test(target.name)) return { ready: false, code: 'INVALID_GEAR_TARGET', reason: 'Starter gear requires an identified observed drop' }
  if (!sameStarterGearScope(target.collectionScope, state)) return { ready: false, code: 'STALE_SESSION', reason: 'Starter gear collection changed actual life or player session' }
  if (!inventoryKnown(state)) return { ready: false, code: 'INVENTORY_UNKNOWN', reason: 'Starter gear pickup requires actual known inventory' }
  const drop = (state.droppedItems ?? []).find(item => wireId(runtimeOf(item)) === target.entityId)
  if (!drop || wireId(drop.uniqueId, true) !== target.uniqueId || fullName(drop.name) !== target.name || !observedGear(drop, state, target.starterGear)) return { ready: false, code: 'DROP_TARGET_CHANGED', reason: 'The bound starter gear drop is missing, changed, protected or no longer local' }
  return { ready: true, drop }
}

module.exports = { selectStarterGearDrop, starterGearScope, sameStarterGearScope, validateStarterGearTarget }
