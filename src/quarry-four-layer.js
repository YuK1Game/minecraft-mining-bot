'use strict'

// Collection boundaries are measured from the job's actual yTop, not from
// world Y=0. For Y75 the first completed group ends at Y72.
function completedFourLayerFloor (yTop, nextY) {
  if (!Number.isSafeInteger(yTop) || !Number.isSafeInteger(nextY) || nextY > yTop) return null
  const groups = Math.floor((yTop - nextY) / 4)
  return groups > 0 ? yTop - groups * 4 + 1 : null
}
function needsFourLayerCollection (yTop, nextY, collectedThroughY = null) {
  const floor = completedFourLayerFloor(yTop, nextY)
  return floor != null && (collectedThroughY == null || collectedThroughY > floor) ? floor : null
}
module.exports = { completedFourLayerFloor, needsFourLayerCollection }
