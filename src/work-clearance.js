'use strict'

const { terrainOcclusionApplies } = require('./terrain-threats')
const { knownUnreachable } = require('./threat-reachability')

// This is a pause/work margin, never a replacement for the world's hostile
// policy. Callers keep evaluateThreats() as the canonical danger evaluation.
const WORK_MARGIN = 8
const SPAWN_RANGED = new Set(['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'])
// Canonical learning archer avoidance already contains its observation reserve.
// Restore the former absolute18 work band, retaining a larger canonical radius.
// This is a work-policy decision, never proof of safety or movement clearance.
function learningArcherMargin (state, actor) {
  return state?.threatPolicy === 'online_learning' && Number.isFinite(state.health) && state.health > 0 && !state.dead && !state.isDead && !state.lifecycle?.dead && SPAWN_RANGED.has(actor?.name) && Number.isFinite(actor.dangerRadius) ? Math.max(0,18-actor.dangerRadius) : null
}
const archerWorkFloor = (state, actor) => Number.isFinite(actor?.dangerRadius) ? actor.dangerRadius + (learningArcherMargin(state,actor) ?? WORK_MARGIN) : null
const workMargin = (state, actor = null) => learningArcherMargin(state,actor) ?? (state?.survivalWorkClearance === true ? WORK_MARGIN : state?.threatPolicy === 'online_learning' ? state.spawnRangedClearance === true && (!actor || SPAWN_RANGED.has(actor.name)) ? WORK_MARGIN : 0 : WORK_MARGIN)
const actorId = actor => String(actor.runtimeId ?? actor.runtimeEntityId ?? actor.entityId ?? actor.id)
const workScope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.runtimeEntityId == null ? null : String(state.runtimeEntityId), state.startedAt ?? null])
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN

function captureWorkActors (state, evaluation, actors = evaluation.threats, now = Date.now()) {
  if (evaluation.requiresObservation) return []
  return actors.flatMap(actor => {
    const entity = (state.entities ?? state.hostiles ?? []).find(value => actorId(value) === actor.runtimeId)
    if (!entity || entity.uniqueId == null || terrainOcclusionApplies(state, entity) || knownUnreachable(state, entity) || !Number.isFinite(actor.dangerRadius) || actor.distance >= actor.dangerRadius + workMargin(state, actor)) return []
    return [{ runtimeId: actor.runtimeId, uniqueId: String(entity.uniqueId), name: actor.name, dangerRadius: actor.dangerRadius, scope: workScope(state), observedAt: now }]
  })
}

function resolveWorkActors (state, evaluation, records) {
  const actors = []; const retained = []; const invalid = []; const released = []
  const entities = state.entities ?? state.hostiles ?? []
  for (const record of records ?? []) {
    if (!record || record.scope !== workScope(state) || typeof record.runtimeId !== 'string' || typeof record.uniqueId !== 'string' || !Number.isFinite(record.dangerRadius)) { invalid.push(record?.runtimeId ?? null); continue }
    const entity = entities.find(value => actorId(value) === record.runtimeId)
    const same = entity && String(entity.uniqueId) === record.uniqueId && entity.entityType === record.name
    if (same && (entity.alive === false || entity.dead === true || entity.health === 0)) { released.push({ runtimeId: record.runtimeId, reason: 'dead' }); continue }
    if (!entity && !entities.some(value => value.uniqueId != null && String(value.uniqueId) === record.uniqueId) && (state.removedEntities ?? []).some(receipt => String(receipt.runtimeId) === record.runtimeId && String(receipt.uniqueId) === record.uniqueId && receipt.entityType === record.name && timestamp(receipt.removedAt) >= record.observedAt)) { released.push({ runtimeId: record.runtimeId, reason: 'removed' }); continue }
    if (same && terrainOcclusionApplies(state, entity)) { released.push({ runtimeId: record.runtimeId, reason: 'terrain' }); continue }
    if (same && knownUnreachable(state, entity)) { released.push({ runtimeId: record.runtimeId, reason: 'unreachable' }); continue }
    const actor = [...evaluation.threats, ...evaluation.outsideDanger].find(value => value.runtimeId === record.runtimeId)
    if (!same || !actor || actor.name !== record.name || actor.dangerRadius > record.dangerRadius) { invalid.push(record.runtimeId); continue }
    if (actor.distance >= actor.dangerRadius + workMargin(state, actor)) { released.push({ runtimeId: record.runtimeId, reason: 'clearance' }); continue }
    const current = { ...record, dangerRadius: actor.dangerRadius }
    retained.push(current); actors.push(actor)
  }
  return { actors, records: retained, invalid, released }
}

function workEscapeEvaluation (evaluation, retained) {
  const ids = new Set(retained.map(actor => actor.runtimeId))
  return { ...evaluation, threats: [...evaluation.threats, ...evaluation.outsideDanger.filter(actor => ids.has(actor.runtimeId))], outsideDanger: evaluation.outsideDanger.filter(actor => !ids.has(actor.runtimeId)) }
}

module.exports = { WORK_MARGIN, workMargin, archerWorkFloor, workScope, captureWorkActors, resolveWorkActors, workEscapeEvaluation }
