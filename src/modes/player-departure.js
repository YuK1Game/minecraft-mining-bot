'use strict'

// Packing and leaving are asynchronous preparations for the same trip. A
// stop while either is saving/settling must still cancel the eventual start.
async function departPlayer ({ input, aborted, canPack, pack, leave, dry, waterNeeded, travel }) {
  const check = () => {
    if (aborted()) throw Object.assign(new Error('長距離移動を中断しました。'), { code: 'LONG_TRAVEL_CANCELLED' })
  }
  check()
  if (canPack()) { await pack(); check() }
  try { await leave() } catch { /* A normal failed house exit keeps the existing fallback. */ }
  check()
  await dry()
  check()
  if (waterNeeded()) throw Object.assign(new Error('水から上がれないため、長距離移動を始めません。'), { code: 'WATER_EXIT_FAILED' })
  const result = await travel(input, { aborted })
  check()
  return result
}

module.exports = { departPlayer }
