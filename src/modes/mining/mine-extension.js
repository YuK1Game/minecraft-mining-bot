'use strict'

const { setImmediate: immediate } = require('node:timers/promises')
const { surveyMineRegions } = require('./mine-survey-regions')
const { evaluateMineGeometry, lowerLevels, resourceName, withClosed } = require('./mine-plan')
const { extendMineGeometry, defaultDropEstimate, point, MAX_SHAFT_DEPTH } = require('./mine-geometry')
const { mineWorldScope, mineLiveScope, sameWorld } = require('./mine-state')
const fail = code => { throw Object.assign(new Error(code), { code }) }

function extensionBounds (plan) {
  const corners = []
  for (const u of [0, plan.site.length - 1]) for (const v of [0, plan.site.width - 1]) corners.push(point(plan, u, 0, v))
  return { min: { x: Math.min(...corners.map(p => p.x)) - 4, y: -60, z: Math.min(...corners.map(p => p.z)) - 4 },
    max: { x: Math.max(...corners.map(p => p.x)) + 4, y: plan.layers.find(layer => layer.id === 'upper').y + 1, z: Math.max(...corners.map(p => p.z)) + 4 } }
}

// The fixed footprint and upper construction never enter a new site search.
// Only lower excavation and the still-unbuilt shaft are evaluated. This result
// does not confirm the existing upper route; the movement owner checks it from
// current receipts before either descent or return.
async function planMineExtension ({ world, getState, plan, origin = plan?.shaft?.approach, resource = 'diamond', targetCount = 1,
  ownedFills = [], isProtected = () => false, maxLowerLevels = 4, maxWork = 6000000, maxCells = 2500000, yieldNow = immediate } = {}, { signal } = {}) {
  const current = getState?.(), liveScope = mineLiveScope(current), scope = mineWorldScope(current)
  if (!liveScope || !sameWorld(plan?.scope, scope)) return { status: 'blocked', code: 'MINE_SCOPE_UNKNOWN' }
  resource = resourceName(resource)
  if (plan.layers?.length !== 1 || plan.layers[0].id !== 'upper' || !['diamond', 'raw_gold', 'redstone'].includes(resource) || !Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 4096 || !Number.isInteger(maxLowerLevels) || maxLowerLevels < 1 || maxLowerLevels > 8 || !Number.isInteger(maxWork) || maxWork < 1 || maxWork > 20000000 || !origin || !['x', 'y', 'z'].every(axis => Number.isFinite(origin[axis]))) return { status: 'blocked', code: 'MINE_EXTENSION_INVALID' }
  const survey = await surveyMineRegions({ world, getState, bounds: extensionBounds(plan), maxCells, yieldNow, isProtected }, { signal })
  if (!['ready', 'partial'].includes(survey.status)) return survey
  const observed = result => ({ ...result, terrainReceipt: survey.terrainReceipt })
  let work = 0, nextYield = 512, evaluated = 0, rejectedUnknown = 0, rejectedHazard = 0
  const guard = () => {
    if (signal?.aborted) fail('MINE_CANCELLED')
    if (mineLiveScope(getState()) !== liveScope || survey.liveScope !== liveScope) fail('MINE_SCOPE_CHANGED')
    if (!survey.current()) fail('MINE_TERRAIN_CHANGED')
    if (work > maxWork) fail('MINE_PLAN_BUDGET')
  }
  const account = () => { if (++work > maxWork) fail('MINE_PLAN_BUDGET') }
  const read = p => { account(); return survey.at(p) }
  const checkpoint = async () => { if (work >= nextYield) { nextYield = work + 512; await yieldNow(); guard() } }
  try {
    guard()
    const upperY = plan.layers[0].y
    const observedLowers = lowerLevels(survey, upperY, maxLowerLevels, -Infinity, resource)
    if (!observedLowers.length) return observed({ status: survey.unknown ? 'observing' : 'blocked', code: survey.unknown ? 'MINE_LOWER_ORE_OBSERVATION_NEEDED' : 'MINE_NO_OBSERVED_LOWER_ORE', needsObservation: survey.needsObservation, diagnostics: { known: survey.known, unknown: survey.unknown, observedOres: survey.ores.length } })
    const lowers = lowerLevels(survey, upperY, maxLowerLevels, plan.site.surfaceY - MAX_SHAFT_DEPTH, resource)
    if (!lowers.length) return observed({ status: 'blocked', code: 'MINE_SHAFT_DEPTH_EXCEEDED', diagnostics: { maximumShaftDepth: MAX_SHAFT_DEPTH, observedLowerYs: observedLowers, known: survey.known, unknown: survey.unknown } })
    let best = null
    for (const lowerY of lowers) {
      let candidate = extendMineGeometry(plan, { lowerY })
      let evaluation = await evaluateMineGeometry(candidate, survey, { origin, resource, targetCount, checkpoint, read, account, existingPlan: plan, ownedFills })
      let expected = defaultDropEstimate(plan.site.width, plan.site.length)
      for (let adjustment = 0; evaluation.eligible && adjustment < 8; adjustment++) {
        expected = Math.max(expected, evaluation.estimatedDrops.lower)
        let resized
        try { resized = extendMineGeometry(plan, { lowerY, expectedDrops: { lower: expected } }) } catch (error) {
          if (!['MINE_STORAGE_CAPACITY_EXCEEDED', 'MINE_STORAGE_ROOM_TOO_LARGE'].includes(error.message)) throw error
          evaluation = { eligible: false, unknown: 0, hazards: 0, code: error.message }; break
        }
        const unchanged = JSON.stringify(resized.segments) === JSON.stringify(candidate.segments) && JSON.stringify(resized.storage) === JSON.stringify(candidate.storage)
        candidate = resized
        if (unchanged) break
        evaluation = await evaluateMineGeometry(candidate, survey, { origin, resource, targetCount, checkpoint, read, account, existingPlan: plan, ownedFills })
        if (adjustment === 7) evaluation = { eligible: false, unknown: 0, hazards: 0, code: 'MINE_STORAGE_BUDGET' }
      }
      evaluated++
      if (evaluation.unknown) rejectedUnknown++
      if (evaluation.hazards) rejectedHazard++
      if (evaluation.eligible && (!best || Number(evaluation.meetsTarget) > Number(best.evaluation.meetsTarget) || evaluation.meetsTarget === best.evaluation.meetsTarget && (evaluation.meetsTarget ? evaluation.targetCost < best.evaluation.targetCost : evaluation.shortfall < best.evaluation.shortfall || evaluation.shortfall === best.evaluation.shortfall && evaluation.targetCost < best.evaluation.targetCost))) best = { plan: candidate, evaluation }
      await yieldNow(); guard()
    }
    const diagnostics = { candidates: lowers.length, evaluated, work, known: survey.known, unknown: survey.unknown, observedOres: survey.ores.length, rejectedUnknown, rejectedHazard, upperYs: [upperY], lowerYs: lowers, extension: true }
    if (!best) return observed({ status: rejectedUnknown ? 'observing' : 'blocked', code: rejectedUnknown ? 'MINE_TERRAIN_UNKNOWN' : 'MINE_NO_SAFE_RESOURCE_PLAN', needsObservation: survey.needsObservation, diagnostics })
    withClosed(best.plan, best.evaluation)
    best.plan.evaluation = { ...best.evaluation, observationOnly: true, source: 'current_received_world', terrainRevision: survey.revision, scope: 'lower_extension_only', existingUpperRequiresLiveValidation: true, optimality: 'best_complete_candidate_in_bounded_search', ...diagnostics }
    return observed({ status: 'planned', code: best.evaluation.meetsTarget ? 'MINE_TARGET_REACHABLE' : 'MINE_RESOURCE_SHORTFALL', plan: best.plan, diagnostics })
  } catch (error) { return observed({ status: error.code === 'MINE_CANCELLED' ? 'cancelled' : error.code === 'MINE_PLAN_BUDGET' ? 'blocked' : 'observing', code: error.code ?? 'MINE_PLAN_FAILED', reason: error.message, diagnostics: { evaluated, work } }) }
}

module.exports = { planMineExtension, extensionBounds }
