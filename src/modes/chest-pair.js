'use strict'

const CHEST = 'minecraft:chest'
const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const facing = block => {
  const props = block?.properties ?? {}, value = entry => entry?.value ?? entry
  return value(props['minecraft:cardinal_direction'] ?? props.cardinal_direction) ?? ({ 2: 'north', 3: 'south', 4: 'west', 5: 'east' }[value(props.facing_direction)]) ?? null
}

// Adjacency alone does not identify a double chest. Share capacity/content
// only for an unambiguous pair with a received 54-slot window, and never
// across a known facing mismatch or a received single-chest window.
function pairedChest (getBlock, at, contents) {
  const block = cell => getBlock(cell.x, cell.y, cell.z)
  const isChest = cell => { const seen = block(cell); return seen?.known === true && seen.name === CHEST }
  if (!at || !isChest(at)) return null
  const beside = cell => OFFSETS.map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y, z: cell.z + dz })).filter(isChest)
  const near = beside(at)
  if (near.length !== 1 || beside(near[0]).length !== 1) return null
  const other = near[0], front = facing(block(at)), otherFront = facing(block(other))
  if (front != null && otherFront != null && front !== otherFront) return null
  const direction = front ?? otherFront
  if (['north', 'south'].includes(direction) && at.z !== other.z || ['east', 'west'].includes(direction) && at.x !== other.x) return null
  const own = contents?.(at), theirs = contents?.(other)
  if (own?.length === 27 || theirs?.length === 27) return null
  return own?.length === 54 || theirs?.length === 54 ? other : null
}

module.exports = { pairedChest }
