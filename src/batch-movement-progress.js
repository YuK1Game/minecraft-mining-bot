'use strict'

const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000000)
const copy = point => ({ x: point.x, y: point.y, z: point.z })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN

// A completed movement batch is distinct from arrival or construction. Only
// independently received progress towards its validated target can yield one.
function confirmedBatchMovementProgress (before, current, target, maxDistance = 12) {
  if (![before?.rawServerPosition, current?.rawServerPosition, current?.position, target].every(finite) || before.health !== current.health || !Number.isFinite(current.health) || current.health <= 0 || current.dead || current.isDead || current.lifecycle?.dead) return null
  if (before.realm?.id == null || current.realm?.id == null || String(before.realm.id) !== String(current.realm.id) || ['dimension', 'startedAt', 'connectionId', 'runtimeEntityId'].some(key => before[key] == null || before[key] !== current[key]) || before.profile !== current.profile) return null
  const previousStamp = stamp(before.rawServerPositionUpdatedAt)
  const currentStamp = stamp(current.rawServerPositionUpdatedAt)
  const physical = current.predicted?.physicsState ?? current.physicsState
  if (!Number.isFinite(previousStamp) || !Number.isFinite(currentStamp) || currentStamp <= previousStamp || physical?.isInWater || physical?.isInLava || distance(current.position, current.rawServerPosition) > 0.75) return null
  const receivedProgress = distance(before.rawServerPosition, current.rawServerPosition)
  const fromFeet = { ...before.rawServerPosition, y: before.rawServerPosition.y - 1.62 }
  const toFeet = { ...current.rawServerPosition, y: current.rawServerPosition.y - 1.62 }
  const closerBy = distance(fromFeet, target) - distance(toFeet, target)
  if (receivedProgress < 0.15 || receivedProgress > maxDistance || closerBy < 0.15) return null
  return { confirmedBy: 'fresh_server_position_toward_batch_target', from: copy(before.rawServerPosition), position: copy(current.rawServerPosition), target: copy(target), rawServerPositionUpdatedAt: current.rawServerPositionUpdatedAt, receivedProgress, closerBy }
}

module.exports = { confirmedBatchMovementProgress }
