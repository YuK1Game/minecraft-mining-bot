'use strict'

// Why a new base chest may not be made now, apart from the wood: the house is
// being built or mended (houseDuty, house-repair.js), or the record of chests set
// down is not read yet (player-storage.js pairs). null: nothing but the wood
// decides. Both are over by themselves, wherever the Bot stands, so the return
// goal holds for them and wakes when they end (return-goal.js `build_free`).
function chestBuildHeld ({ house, pairs }) {
  if (!house?.origin) return null
  if (require('./house/house-repair').houseDuty(house) !== null) return 'HOUSE_WORK'
  if (pairs && typeof pairs.ready === 'function' && !pairs.ready()) return 'CHEST_PENDING'
  return null
}

module.exports = { chestBuildHeld }
