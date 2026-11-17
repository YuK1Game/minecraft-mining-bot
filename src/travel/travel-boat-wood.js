'use strict'

// Whether long travel may stop between legs to cut logs for a new boat.
// In player play the trip only makes a boat from logs already held: the play
// gathers its own wood (player-supply, the house), and on a trip to sand the
// boat step tried 40 trees it could not walk beside for two minutes and the
// trip was given up 54 m short (live 2026-11-17 13:42-13:45 JST).
function gatherBoatLogs (shared) {
  return shared?.playerWanted !== true
}

module.exports = { gatherBoatLogs }
