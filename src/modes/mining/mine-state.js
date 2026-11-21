'use strict'

const { mineSteps } = require('./mine-geometry')
const copy = value => structuredClone(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }

function mineWorldScope (state) {
  if (typeof state?.profile !== 'string' || !state.profile || state.realm?.id == null || !String(state.realm.id) || state.dimension !== 'overworld') return null
  const seed = state.worldSeed ?? state.seed
  return { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension, ...(seed == null ? {} : { worldSeed: String(seed) }) }
}
function mineLiveScope (state) {
  const world = mineWorldScope(state), life = state?.lifecycle?.deathId ?? state?.deathId
  if (!world || state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || state.lifecycle?.dead || !(state.health > 0) || !state.connectionId || !state.startedAt || !/^[1-9]\d*$/.test(String(state.runtimeEntityId ?? '')) || !Number.isSafeInteger(life) || life < 0) return null
  return JSON.stringify([world.profile, world.realmId, world.dimension, world.worldSeed ?? null, state.connectionId, state.startedAt, String(state.runtimeEntityId), life])
}
function sameWorld (a, b) { return !!a && !!b && a.profile === b.profile && a.realmId === b.realmId && a.dimension === b.dimension && (a.worldSeed ?? null) === (b.worldSeed ?? null) }

function createMineState (plan, { layer = null } = {}) {
  if (!plan?.id || !plan.scope) fail('MINE_PLAN_INVALID')
  return { version: 1, planId: plan.id, scope: copy(plan.scope), layer, cursor: 0, confirmedSteps: 0, stepCount: mineSteps(plan, { layer }).length, status: 'planned', needsRevalidation: true, receipts: [], blocked: [] }
}

// A saved cursor describes work history. It never certifies current air,
// footing, light, chest contents, or the safety of a resumed route.
function resumeMineState (saved, { plan, scope } = {}) {
  if (!saved || saved.version !== 1 || saved.planId !== plan?.id || !sameWorld(saved.scope, scope) || !sameWorld(plan.scope, scope)) fail('MINE_STATE_SCOPE_MISMATCH')
  const steps = mineSteps(plan, { layer: saved.layer ?? null })
  if (!Number.isInteger(saved.cursor) || saved.cursor < 0 || saved.cursor > steps.length || saved.stepCount !== steps.length) fail('MINE_STATE_INVALID')
  return { ...copy(saved), needsRevalidation: true, liveScope: null, receipts: [] }
}

function extendMineProgress (progress, { previous, plan } = {}) {
  if (!previous?.id || previous.id !== plan?.id || !sameWorld(previous.scope, plan.scope) || previous.layers?.length !== 1 || previous.layers[0].id !== 'upper' || plan.layers?.length !== 2 || !plan.layers.some(layer => layer.id === 'lower') || progress?.lower) fail('MINE_EXTENSION_STATE_INVALID')
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const upper = value => value.filter(entry => entry.layer === 'upper')
  if (!same(previous.site, plan.site) || !same(previous.layers[0], plan.layers.find(layer => layer.id === 'upper')) || !same(previous.segments, upper(plan.segments)) || !same(previous.storage, upper(plan.storage)) || !same(previous.shaft.columns, plan.shaft.columns) || !same(previous.shaft.ladder, plan.shaft.ladder) || !same(previous.shaft.landings, upper(plan.shaft.landings))) fail('MINE_EXTENSION_MOVED_EXISTING_WORK')
  // Validate the saved upper cursor without minting new upper receipts or
  // changing its confirmed work count. Only the newly added layer starts at 0.
  resumeMineState(progress.upper, { plan: previous, scope: previous.scope })
  return { ...copy(progress), lower: createMineState(plan, { layer: 'lower' }) }
}

function advanceMineState (state, receipt, { step, liveScope, plan = null } = {}) {
  if (state?.version !== 1 || !liveScope || typeof liveScope !== 'string' || receipt?.liveScope !== liveScope || receipt?.planId !== state.planId || receipt?.stepId !== step?.id || receipt?.serverConfirmed !== true || receipt.receivedAir !== true || receipt.walkConfirmed !== true || receipt.finishConfirmed !== true) fail('MINE_RECEIPT_UNCONFIRMED')
  if (!Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor >= state.stepCount || state.layer != null && state.layer !== step.layer) fail('MINE_PROGRESS_INVALID')
  if (!plan || plan.id !== state.planId || mineSteps(plan, { layer: state.layer })[state.cursor]?.id !== step.id) fail('MINE_STEP_OUT_OF_ORDER')
  // The executor must name its observed cursor even when it already holds the
  // compact next step, so retries cannot spend the same receipt twice.
  if (receipt.cursor !== state.cursor) fail('MINE_STEP_OUT_OF_ORDER')
  const cursor = state.cursor + 1
  return { ...state, cursor, confirmedSteps: (state.confirmedSteps ?? 0) + 1, status: cursor === state.stepCount ? (state.blocked?.length ? 'partial' : 'completed') : 'building', needsRevalidation: false, liveScope,
    receipts: [...(state.receipts ?? []).slice(-7), { stepId: step.id, cursor: state.cursor, liveScope, serverConfirmed: true, receivedAir: true, walkConfirmed: true, finishConfirmed: true }] }
}

function skipMineSegment (state, { segmentId, code, plan, liveScope, attempts } = {}) {
  const steps = mineSteps(plan, { layer: state.layer }), current = steps[state.cursor]
  if (plan.id !== state.planId || !liveScope || !Number.isInteger(attempts) || attempts < 3 || current?.segmentId !== segmentId || current.kind !== 'branch' || typeof code !== 'string' || !code) fail('MINE_SEGMENT_SKIP_DENIED')
  let cursor = state.cursor
  while (steps[cursor]?.segmentId === segmentId) cursor++
  return { ...state, cursor, status: cursor === state.stepCount ? 'partial' : 'building', needsRevalidation: true, liveScope,
    blocked: [...(state.blocked ?? []), { segmentId, code, attempts, fromCursor: state.cursor, toCursor: cursor, liveScope }] }
}

module.exports = { mineWorldScope, mineLiveScope, sameWorld, createMineState, resumeMineState, advanceMineState, skipMineSegment, extendMineProgress }
