'use strict'

// The fields every runtime state hands to evaluateThreats: the avoidance
// policy and whether player play is on (which caps non-creeper danger radii
// at 8 m). State builders that set only threatPolicy left playerPlay out, so
// idle protection and guarded routes still held work for a witch and a
// zombie 9-10 m away (real Realm 2026-11-17 17:44-17:52 JST).
function threatFields (shared) {
  return { threatPolicy: shared?.autoWanted ? 'online_learning' : 'balanced_mining', playerPlay: shared?.playerWanted === true }
}

module.exports = { threatFields }
