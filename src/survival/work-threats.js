'use strict'

const { evaluateThreats } = require('../combat/threats')

// Player play (state.playerPlay): a hostile more than 8 m away is left to
// combat mode, so ordinary work keeps going and only steers around it as an
// outside-danger actor. Creepers always count. Real Realm 2026-11-17
// 16:37-16:58 JST: a skeleton 11-17 m away (policy radius 18 m) interrupted
// every tunnel step with NEARBY_THREAT and the run stopped as blocked.
const PLAY_NEAR = 8
const creeper = actor => /creeper/.test(actor?.name ?? actor?.entityType ?? '')
const nearThreat = actor => creeper(actor) || !(actor?.distance > PLAY_NEAR)

function workThreats (state, evaluation) {
  if (state?.playerPlay !== true || !evaluation?.threats?.some(actor => !nearThreat(actor))) return evaluation
  const threats = evaluation.threats.filter(nearThreat)
  const far = evaluation.threats.filter(actor => !nearThreat(actor))
  return {
    ...evaluation,
    threats,
    outsideDanger: [...far, ...(evaluation.outsideDanger ?? [])].sort((a, b) => a.distance - b.distance),
    recommendation: threats.length ? 'avoid' : evaluation.requiresObservation ? 'observe' : 'continue_observing',
    reason: threats[0]?.reason ?? '8mより遠い敵は戦闘モードに任せ、作業を続けます。'
  }
}

function threatEntitiesOf (state) {
  return [state.entities, state.hostiles, state.nearbyHostiles, state.hostileEntities, state.threats].find(Array.isArray)
}

function threatEvaluationOf (state) {
  const evaluation = workThreats(state, evaluateThreats(state, threatEntitiesOf(state), { observationRadius: 32 }))
  const reported = state.entityStats?.unknownPositions
  if (Number.isSafeInteger(reported) && reported > evaluation.unknownPositions.length) {
    evaluation.hostUnknownPositionCount = reported
    evaluation.requiresObservation = true
    if (!evaluation.threats.length) {
      evaluation.recommendation = 'observe'
      evaluation.reason = 'ホストに位置不明のactorがあるため、近接関係や安全を確認できません。'
    }
  }
  return evaluation
}

module.exports = { PLAY_NEAR, nearThreat, workThreats, threatEntitiesOf, threatEvaluationOf }
