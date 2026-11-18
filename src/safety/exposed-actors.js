'use strict'

// The safety view of the received actors. A hostile whose attack cannot reach
// the Bot now is left out of it: no walk route from it to the Bot, a shooter's
// sight blocked, or no current recognition, each known. Unknown access stays
// in; this never proves a future path safe. A forbidden combat profile
// (boss / avoid only) is still dangerous and stays in.
//
// The actors left out keep their identity in `unexposed`. The route search
// behind the answer has a shared time budget, so the same actor can be in the
// view on one pass and out of it on the next; a record held for it (work
// clearance) must then be released, not read as an actor whose identity
// changed (real Realm 2026-11-18 17:43-18:17 JST: 「Idle escape retained actor
// identity, policy or scope changed」 13 ms after every start, about ten
// starts a second for 34 minutes, for a zombie standing 11.5 m away).
const KNOWN_NEGATIVE = new Set(['ENEMY_ATTACK_ROUTE_BLOCKED', 'PROJECTILE_SIGHT_BLOCKED', 'NO_CURRENT_RECOGNITION'])

function exposed (actor, state, exposureOf) {
  if (actor.hostile !== true || actor.alive === false || actor.primed === true) return true
  const exposure = exposureOf(actor, state)
  if (exposure.reason === 'PROFILE_DISALLOWS_ENGAGEMENT') return true
  if (!exposure.unknown && exposure.evidence.sight === false) return false
  return exposure.unknown || !KNOWN_NEGATIVE.has(exposure.reason)
}

function splitExposed (actors, state, exposureOf) {
  const kept = []; const unexposed = []
  for (const actor of actors ?? []) (exposed(actor, state, exposureOf) ? kept : unexposed).push(actor)
  return { exposed: kept, unexposed }
}

// The state as one more pass of the view sees it: `actors` are the ones that
// pass kept, the rest of state.entities join the actors already left out.
function exposedView (state, actors) {
  const all = state.entities ?? []
  if (actors.length === all.length) return state
  const kept = new Set(actors)
  return { ...state, entities: actors, unexposedEntities: [...(state.unexposedEntities ?? []), ...all.filter(actor => !kept.has(actor))] }
}

module.exports = { splitExposed, exposedView }
