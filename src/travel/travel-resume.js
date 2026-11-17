'use strict'

// Whether long travel resumes, on its own, a trip the previous code (or the
// previous connection) was running. In player play every trip belongs to a
// play job (sand, food, wood, the house), and that job decides again after a
// reload; a resumed trip has no owner and runs beside the autonomy the play
// restarts (live 2026-11-17 13:50-13:58 JST: the sand trip resumed after a
// reload kept walking for 8 minutes while a tunnel ran, and the two refused
// each other's movement, "CHUNK_TRAVEL_BUSY").
function resumeTrip (shared) {
  return shared?.playerWanted !== true
}

module.exports = { resumeTrip }
