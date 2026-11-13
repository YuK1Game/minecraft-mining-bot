'use strict'

// Read-only geometry and observed terrain for the explicit debug chest reset.
const { chunkOf, chunkBounds } = require('./quarry-region')
const { interactionSightError } = require('./interaction-sight')
const EYE_HEIGHT = 1.62, HALF_WIDTH = 0.31, HEIGHT = 1.8, REACH = 4.5, CORNER_ZONE = 4
const FACE = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
const key = p => `${p.x},${p.y},${p.z}`
const point = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]) && Math.abs(p[axis]) < 30000000)
const positionKnown = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) < 30000000)
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const validCell = p => point(p) && p.y >= -63 && p.y <= 317
const protectedBlock = b => b?.protected || b?.protectionSource
const chest = b => /^minecraft:(?:trapped_)?chest$/.test(b?.name ?? '')
const stageHazard = /water|lava|fire|magma|cactus|campfire|sand$|gravel$|powder|anvil$|scaffolding|dripstone/
const adjacent = (a, b) => a.y === b.y && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1
const inside = (p, bounds) => p.x >= bounds.xMin && p.x <= bounds.xMax && p.z >= bounds.zMin && p.z <= bounds.zMax
function clearOfPlayer (p, position) {
  const bottom = position.y - EYE_HEIGHT
  return !(p.x < position.x + HALF_WIDTH && p.x + 1 > position.x - HALF_WIDTH &&
    p.y < bottom + HEIGHT && p.y + 1 > bottom && p.z < position.z + HALF_WIDTH && p.z + 1 > position.z - HALF_WIDTH)
}
const reachable = (p, position) => clearOfPlayer(p, position) && Math.hypot(p.x + 0.5 - position.x, p.y + 0.5 - position.y, p.z + 0.5 - position.z) <= REACH

function visibleSite (home, position, getBlock) {
  const planned = new Map([home.position, home.other, home.stage].map((p, index) => [key(p), {
    known: true, name: index === 2 ? 'minecraft:purple_shulker_box' : 'minecraft:chest', boundingBox: 'block', extra: []
  }]))
  const read = p => planned.get(key(p)) ?? getBlock(p.x, p.y, p.z)
  // mainSlots always opens the first half; the second half is addressed by
  // fixed commands. Match interactions.openPlan's exact clicked-face choice.
  return [home.position, home.stage].every(target => {
    const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }
    const dx = position.x - center.x, dy = position.y - center.y, dz = position.z - center.z
    const face = Math.abs(dy) >= Math.max(Math.abs(dx), Math.abs(dz)) ? (dy > 0 ? 1 : 0) : Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
    const offset = FACE[face]
    const point = { x: center.x + offset.x * 0.5, y: center.y + offset.y * 0.5, z: center.z + offset.z * 0.5 }
    return interactionSightError(read, position, point, target) === null
  })
}

function debugSiteReachable (home, position) {
  if (!positionKnown(position) || !home || ![home.position, home.other, home.stage, home.stand].every(validCell)) return false
  const stand = { x: Math.floor(position.x), y: Math.floor(position.y - EYE_HEIGHT + 0.001), z: Math.floor(position.z) }
  if (!same(home.stand, stand) || ![home.position, home.other, home.stage].every(p => p.y === home.stand.y)) return false
  if (home.position.z !== home.other.z || Math.abs(home.position.x - home.other.x) !== 1 ||
    same(home.stage, home.position) || same(home.stage, home.other) || adjacent(home.stage, home.position) || adjacent(home.stage, home.other)) return false
  const chunk = chunkOf(home.stand.x, home.stand.z), bounds = chunkBounds(chunk)
  if (home.chunk && (home.chunk.x !== chunk.x || home.chunk.z !== chunk.z)) return false
  // Older registered stations could have a staging cell outside their chunk.
  return [home.position, home.other].every(p => inside(p, bounds)) &&
    [home.position, home.other, home.stage].every(p => reachable(p, position))
}

function findDebugChestSite ({ feet, position, getBlock, isAir, isFloor } = {}) {
  if (!validCell(feet) || !positionKnown(position) || [getBlock, isAir, isFloor].some(fn => typeof fn !== 'function')) return null
  const chunk = chunkOf(feet.x, feet.z), bounds = chunkBounds(chunk)
  const available = p => {
    if (!validCell(p) || !inside(p, bounds) || !reachable(p, position)) return false
    const body = getBlock(p.x, p.y, p.z), head = getBlock(p.x, p.y + 1, p.z), floor = getBlock(p.x, p.y - 1, p.z)
    return [body, head, floor].every(b => b?.known === true && !protectedBlock(b)) && isAir(body) && isAir(head) && isFloor(floor)
  }
  const unjoined = (p, partner = null, staging = false) => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => {
    const neighbor = { x: p.x + dx, y: p.y, z: p.z + dz }
    if (partner && same(neighbor, partner)) return true
    const block = getBlock(neighbor.x, neighbor.y, neighbor.z)
    return block?.known === true && !protectedBlock(block) && !chest(block) && (!staging || !block.extra?.length && !stageHazard.test(block.name ?? ''))
  })
  const nearby = []
  // Initial supply recovery can rediscover only the normal portable planner's
  // cardinal cells one or two blocks from this fixed stand.
  for (const distance of [1, 2]) for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) nearby.push({ dx: dx * distance, dz: dz * distance })
  // Near a chunk corner, prefer the pair closest to that corner (user request
  // 2026-11-13). Away from the corners every pair ranks the same and the
  // stable sort keeps the earlier east-first order.
  const corners = [[bounds.xMin, bounds.zMin], [bounds.xMin, bounds.zMax], [bounds.xMax, bounds.zMin], [bounds.xMax, bounds.zMax]]
  const cornerDistance = (first, other) => Math.min(...corners.map(([x, z]) => Math.min(Math.hypot(first.x - x, first.z - z), Math.hypot(other.x - x, other.z - z))))
  const pairs = []
  for (const row of [0, 1, -1, 2, -2]) for (const dx of [1, -1]) {
    const first = { x: feet.x + dx, y: feet.y, z: feet.z + row }, other = { x: feet.x + 2 * dx, y: feet.y, z: feet.z + row }
    pairs.push({ dx, first, other, corner: Math.min(cornerDistance(first, other), CORNER_ZONE) })
  }
  pairs.sort((a, b) => a.corner - b.corner)
  for (const { dx, first, other } of pairs) {
    if (!available(first) || !available(other) || !unjoined(first, other) || !unjoined(other, first)) continue
    const stages = [{ x: feet.x - dx, y: feet.y, z: feet.z }, ...nearby.map(offset => ({ x: feet.x + offset.dx, y: feet.y, z: feet.z + offset.dz }))]
    for (const stage of stages) {
      if (same(stage, first) || same(stage, other) || adjacent(stage, first) || adjacent(stage, other) || !available(stage) || !unjoined(stage, null, true)) continue
      const home = { position: first, other, stage, stand: { ...feet }, chunk, existing: false }
      if (debugSiteReachable(home, position) && visibleSite(home, position, getBlock)) return home
    }
  }
  return null
}

module.exports = { findDebugChestSite, debugSiteReachable }
