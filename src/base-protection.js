'use strict'

const key = point => `${point.x},${point.y},${point.z}`
const integer = point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000) && point.y >= -64 && point.y <= 319
const positionOf = value => value?.position ?? value

// This is a planning view, never a world update. Memos are immutable snapshots:
// their reference (or the active scope) changes when the host accepts progress.
function createBaseProtection ({ world, getState, getHutMemo = () => null, getShelterMemo = () => null, ownerProfile = null, maxBlocks = 256 } = {}) {
  if (typeof world?.getBlock !== 'function' || [getState, getHutMemo, getShelterMemo].some(callback => typeof callback !== 'function')) throw new Error('Base protection requires a raw world, state and memo callbacks')
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 26 || maxBlocks > 1024) throw new Error('Invalid base protection bound')
  let previous = null
  let protectedCells = new Set()
  let rebuilds = 0

  function scoped (memo, state) {
    const scope = memo?.scope
    const profile = scope?.profile ?? memo?.profile ?? ownerProfile
    return scope && typeof profile === 'string' && profile.length > 0 && profile === state?.profile && scope.realmId != null && state?.realm?.id != null && String(scope.realmId) === String(state.realm.id) && ['overworld', 'nether', 'end'].includes(scope.dimension) && scope.dimension === state?.dimension
  }
  function receipts (memo) {
    if (!Array.isArray(memo?.placements) || memo.placements.length > 64) return new Set()
    return new Set(memo.placements.filter(item => item?.serverConfirmed === true && item.item === 'minecraft:dirt' && item.count === 1 && integer(item.position) && key(memo.pendingPlacement?.position ?? {}) !== key(item.position)).map(item => key(item.position)))
  }
  function hutCells (memo, state) {
    if (!scoped(memo, state)) return []
    const c = memo?.site?.center
    const forward = memo?.site?.forward
    if (memo?.site?.type !== 'soil_hut' || !integer(c) || c.y < -63 || c.y > 317 || !forward || !Number.isInteger(forward.x) || !Number.isInteger(forward.z) || Math.abs(forward.x) + Math.abs(forward.z) !== 1) return []
    const cells = []
    const permanent = new Set()
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      cells.push({ x: c.x + dx, y: c.y - 1, z: c.z + dz })
      if (dx || dz) for (const dy of [0, 1]) {
        const point = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
        cells.push(point)
        permanent.add(key(point))
      }
    }
    const roof = { ...c, y: c.y + 2 }
    cells.push(roof)
    permanent.add(key(roof))
    if (![...receipts(memo)].some(id => permanent.has(id)) || cells.some(point => !integer(point))) return []
    return cells
  }
  function shelterCells (memo, state) {
    if (memo?.established !== true || !scoped(memo, state) || memo?.site?.type !== 'soil_hill_shelter') return []
    const owned = receipts(memo)
    const doors = memo.site.doorCells
    if (!Array.isArray(doors) || doors.length !== 2 || doors.some(value => !integer(positionOf(value))) || !doors.every(value => owned.has(key(positionOf(value))))) return []
    const preserved = memo.site.preserved
    if (!preserved || ['floor', 'roof', 'walls'].some(name => !Array.isArray(preserved[name]) || preserved[name].length > 128)) return []
    const cells = [...preserved.floor, ...preserved.roof, ...preserved.walls, ...doors].map(positionOf)
    if (cells.length > maxBlocks || cells.some(point => !integer(point))) return []
    return cells
  }
  function refresh () {
    const state = getState()
    const hut = getHutMemo()
    const shelter = getShelterMemo()
    const scope = JSON.stringify([state?.profile ?? null, state?.realm?.id == null ? null : String(state.realm.id), state?.dimension ?? null])
    if (previous?.scope === scope && previous.hut === hut && previous.shelter === shelter) return
    const cells = [...hutCells(hut, state), ...shelterCells(shelter, state)]
    const next = new Set(cells.map(key))
    if (next.size > maxBlocks) throw new Error('The confirmed base protection area exceeds its bounded planning view')
    protectedCells = next
    previous = { scope, hut, shelter }
    rebuilds++
  }
  function overlay (block, point) {
    if (block?.known !== true || block.protected === true || !integer(point) || !protectedCells.has(key(point))) return block
    return { ...block, protected: true, protectionSource: 'bot_base' }
  }
  function getBlock (x, y, z) {
    refresh()
    return overlay(world.getBlock(x, y, z), { x, y, z })
  }
  function getArea (center, radius = 1) {
    if (typeof world.getArea !== 'function') throw new Error('The raw world does not expose area observations')
    refresh()
    return world.getArea(center, radius).map(block => overlay(block, block?.position))
  }
  return { getBlock, getArea, getRawBlock: (x, y, z) => world.getBlock(x, y, z), stats: () => { refresh(); return { protectedBlocks: protectedCells.size, rebuilds } } }
}

module.exports = { createBaseProtection }
