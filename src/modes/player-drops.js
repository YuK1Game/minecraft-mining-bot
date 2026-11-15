'use strict'

// Player mode does not go for items it cannot pick up (user 2026-11-15 22:54
// JST: 「通れない（高さが１で通れない）先のアイテムを回収しようとして止まって
// います。拾えないアイテムは拾わないようにしてください」).
// Before a plan is made, the dropped items it may choose from are cut down to
// - those the Bot can walk to: some cell it can stand in (received solid
//   ground, two open cells for the body), reached from its feet by ordinary
//   steps it can also take back (one block up or down), lies within pickup
//   range of the item. A pit two or more deep is not entered for an item.
//   A gap one block high is not a way through. Unreceived terrain is no way.
// - and not those a pickup has already failed on: the autonomy's own list of
//   failed drops is remembered here for ten minutes (shared.playerDropSkips),
//   so the same item is not tried again after a restart and does not fill
//   that list.
const { normalizeMode } = require('./bot-mode')

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|sweet_berry/
const SKIP_MS = 600000
const RANGE = 16
const CELL_LIMIT = 3000
const idOf = drop => String(drop?.entityId ?? drop?.runtimeEntityId ?? drop?.runtimeId ?? drop?.id ?? '')
const key = (x, y, z) => `${x},${y},${z}`

// Cells the Bot can stand in and walk to from its feet, by received terrain.
function walkableCells (position, getBlock) {
  const cache = new Map()
  const read = (x, y, z) => { const id = key(x, y, z); let block = cache.get(id); if (block === undefined) { block = getBlock(x, y, z) ?? null; cache.set(id, block) } return block }
  const open = (x, y, z) => { const block = read(x, y, z); return block?.known === true && !block.extra?.length && !HAZARD.test(block.name ?? '') && (AIR.test(block.name ?? '') || block.boundingBox === 'empty') }
  const solid = (x, y, z) => { const block = read(x, y, z); return block?.known === true && block.boundingBox === 'block' && !AIR.test(block.name ?? '') && !HAZARD.test(block.name ?? '') }
  const stand = (x, y, z) => solid(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)
  const origin = { x: Math.floor(position.x), y: Math.floor(position.y - 1.62 + 0.001), z: Math.floor(position.z) }
  const reached = new Map()
  if (!stand(origin.x, origin.y, origin.z)) return reached
  reached.set(key(origin.x, origin.y, origin.z), origin)
  const queue = [origin]
  for (let index = 0; index < queue.length && queue.length < CELL_LIMIT; index++) {
    const from = queue[index]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = from.x + dx, z = from.z + dz
      if (Math.abs(x - origin.x) > RANGE || Math.abs(z - origin.z) > RANGE) continue
      for (const dy of [0, 1, -1]) {
        const y = from.y + dy, id = key(x, y, z)
        if (reached.has(id) || !stand(x, y, z)) continue
        // A step up needs room above the head here; a step down needs the body to pass over the edge.
        if (dy === 1 && !open(from.x, from.y + 2, from.z)) continue
        if (dy < 0 && ![0, 1].every(up => open(x, from.y + up, z))) continue
        const cell = { x, y, z }
        reached.set(id, cell); queue.push(cell)
        break
      }
    }
  }
  return reached
}

// Whether standing in one of those cells brings the item into pickup range
// (the body's box widened by one block to the sides and half a block up and down).
function collectable (drop, cells) {
  const at = drop?.position
  if (!at || ![at.x, at.y, at.z].every(Number.isFinite)) return false
  const cx = Math.floor(at.x), cz = Math.floor(at.z), cy = Math.floor(at.y)
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 1; dy++) {
    const cell = cells.get(key(cx + dx, cy + dy, cz + dz))
    if (!cell) continue
    if (at.y < cell.y - 0.5 || at.y > cell.y + 2.3) continue
    // The nearest point of the cell the body can be at (0.3 from its walls).
    const px = Math.min(Math.max(at.x, cell.x + 0.3), cell.x + 0.7), pz = Math.min(Math.max(at.z, cell.z + 0.3), cell.z + 0.7)
    if (Math.abs(at.x - px) <= 1.25 && Math.abs(at.z - pz) <= 1.25) return true
  }
  return false
}

// The observations the plan may use: without the drops it cannot pick up.
function withCollectableDrops ({ mode, shared, state, observations, getBlock, log = () => {}, now = Date.now }) {
  if (normalizeMode(mode) !== 'player' || !Array.isArray(observations?.drops) || !observations.drops.length || !state?.position) return observations
  const skips = shared.playerDropSkips ??= {}
  for (const id of Object.keys(skips)) if (skips[id].until <= now()) delete skips[id]
  let cells = null
  const drops = observations.drops.filter(drop => {
    const id = idOf(drop), skip = skips[id]
    if (skip) {
      // The same item where the pickup failed; one that has moved gets another look.
      if (drop.position && Math.hypot(drop.position.x - skip.x, drop.position.y - skip.y, drop.position.z - skip.z) <= 1) return false
      delete skips[id]
    }
    cells ??= walkableCells(state.position, getBlock)
    if (collectable(drop, cells)) return true
    if (id && shared.playerDropNoted !== id) { shared.playerDropNoted = id; log(`プレイヤーモード: 歩いて届かない場所のアイテムは拾いません（${String(drop.name ?? '').replace(/^minecraft:/, '').slice(0, 40)}、(${Math.floor(drop.position?.x)}, ${Math.floor(drop.position?.y)}, ${Math.floor(drop.position?.z)})）`) }
    return false
  })
  return drops.length === observations.drops.length ? observations : { ...observations, drops }
}

// The autonomy's list of drops a pickup failed on, kept here for ten minutes.
function noteFailedDrops ({ mode, shared, progress, drops = [], now = Date.now }) {
  if (normalizeMode(mode) !== 'player' || !Array.isArray(progress?.excludedDropIds) || !progress.excludedDropIds.length) return
  const skips = shared.playerDropSkips ??= {}
  for (const id of progress.excludedDropIds.map(String)) {
    if (skips[id]) continue
    const drop = drops.find(candidate => idOf(candidate) === id)
    if (drop?.position) skips[id] = { x: drop.position.x, y: drop.position.y, z: drop.position.z, until: now() + SKIP_MS }
  }
}

module.exports = { withCollectableDrops, noteFailedDrops, walkableCells, collectable }
