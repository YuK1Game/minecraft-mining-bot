'use strict'

// Read-only values from the start_game packet received on this connection,
// shown in /status. worldSeed is the signed 64-bit seed as a string.
module.exports = function startInfo (startGame) {
  let worldSeed = null
  try { if (startGame?.seed != null) worldSeed = String(BigInt.asIntN(64, BigInt(startGame.seed))) } catch {}
  return { dayCycleStopTime: startGame?.day_cycle_stop_time ?? null, worldSeed }
}
