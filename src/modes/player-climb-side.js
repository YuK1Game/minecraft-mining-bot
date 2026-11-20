'use strict'

// Player mode: the climb straight up (player-climb.js) stopped under water,
// lava, gravel or sand. The mining check is right to refuse the block under
// them, so the shaft moves sideways instead: a drift two high at the feet's
// level to the nearest column whose way up is dry, and the climb goes on from
// there (real Realm 2026-11-16 15:12-15:24 JST: 66 steps up from the diamonds,
// then stone with three blocks of water on it; the climb ended at 0 steps
// every two minutes, with twelve diamonds held).
// - A column is dry when every received block above the head in it is neither
//   liquid nor a falling block, and none of the four blocks beside each of
//   those is liquid, a falling block or unreceived. At least eight blocks up must be received.
// - The drift goes along one axis, then the other. Every block is mined by the
//   ordinary mining after its own check; the floor must be received solid
//   ground. A refused block ends that drift and the next column is tried.
// - Leaves are never cut, so a column with leaves in its way up is not chosen
//   either, and the drift does not go through leaves (real Realm 2026-11-16
//   16:16 JST: 22 steps up, then LEAVES_ABOVE two blocks under the surface
//   below a tree; it stayed in that hole and was killed there).
// - Each drift is a path (x then z, or z then x) whose cells have no liquid or
//   falling block beside them, which the mining check would refuse; a cell
//   refused once is not tried again by a later drift (real Realm 2026-11-17
//   02:35 JST: the three drifts all began at the same cell beside water and
//   all ended there, under gravel 60 steps up).
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LIQUID = /water|lava|bubble_column|kelp|seagrass/
const FALLING = /^minecraft:(?:gravel|sand|red_sand|suspicious_(?:sand|gravel)|.*concrete_powder)$/
const LEAVES = /_leaves$/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const { climbDown } = require('./player-climb-down')
const RADIUS = 12, SCAN_UP = 64, MIN_KNOWN = 8, TRIES = 3

const wet = found => found?.known !== true || !!found.extra?.length || LIQUID.test(found.name ?? '')

// The way up from feet level `at` in column (x, z): true when dry as far as received.
function dryColumn (block, x, at, z) {
  let seen = 0
  for (let y = at + 2; y < at + 2 + SCAN_UP; y++) {
    const found = block(x, y, z)
    if (found?.known !== true) break
    if (wet(found) || FALLING.test(found.name ?? '') || LEAVES.test(found.name ?? '')) return false
    // Sand or gravel beside the way up is refused by the mining check too (live 2026-11-17 11:33 JST: three columns near the surface, each refused at y=87 beside a falling block).
    if (SIDES.some(([dx, dz]) => { const side = block(x + dx, y, z + dz); return wet(side) || FALLING.test(side?.name ?? '') })) return false
    seen++
  }
  return seen >= MIN_KNOWN
}

// Whether the pillar stands in a cave: a side at feet level is open with no
// ground under it, so no drift can start from here.
function hanging (block, feet) {
  const x = Math.floor(feet.x), at = Math.floor(feet.y + 0.001), z = Math.floor(feet.z)
  const open = found => found?.known === true && AIR.test(found.name ?? '')
  return SIDES.some(([dx, dz]) => open(block(x + dx, at, z + dz)) && !(block(x + dx, at - 1, z + dz)?.known === true && block(x + dx, at - 1, z + dz).boundingBox === 'block'))
}

const HOLD = /water|lava|bubble_column/
const NEAR = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const keyOf = (x, y, z) => `${x},${y},${z}`

// The cells of a drift from (x, z) to the column, along x then z (or z then x).
function driftPath (from, to, zFirst) {
  const cells = []
  let { x, z } = from
  const stepX = () => { while (x !== to.x) { x += Math.sign(to.x - x); cells.push({ x, z }) } }
  const stepZ = () => { while (z !== to.z) { z += Math.sign(to.z - z); cells.push({ x, z }) } }
  if (zFirst) { stepZ(); stepX() } else { stepX(); stepZ() }
  return cells
}

// A path whose cells (feet and head) the mining check would let through:
// nothing liquid or falling beside them, and no cell refused before.
function openPath (block, path, at, refused = new Set()) {
  return path.every(({ x, z }) => [at, at + 1].every(y => {
    if (refused.has(keyOf(x, y, z))) return false
    if (HOLD.test(block(x, y, z)?.name ?? '')) return false
    return NEAR.every(([dx, dy, dz]) => { const name = block(x + dx, y + dy, z + dz)?.name ?? ''; return !HOLD.test(name) && !FALLING.test(name) })
  }))
}

// Dry columns around (x, z), nearest first (walking distance of the drift).
function dryColumns (block, x, at, z, radius = RADIUS) {
  const found = []
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const steps = Math.abs(dx) + Math.abs(dz)
    if (steps < 2 || steps > radius) continue
    if (dryColumn(block, x + dx, at, z + dz)) found.push({ x: x + dx, z: z + dz, steps })
  }
  return found.sort((a, b) => a.steps - b.steps)
}

async function sidestep ({ ports, log = () => {}, aborted = () => false, tries = TRIES }) {
  const { feet, block, walk, canMine, mine } = ports
  // On a pillar with no floor beside it: down the pillar first (player-climb-down.js).
  // Only in a cave: inside a shaft cut through rock the drift digs sideways
  // from where it stands (live 2026-11-17 02:06-02:09 JST: 42 steps up under a
  // lake, then 42 steps back down the pillar, a drift of two and the same water).
  if (ports.descend && feet() && hanging(ports.block, feet())) await climbDown({ ports, log, aborted })
  const start = feet()
  if (!start || ![start.x, start.y, start.z].every(Number.isFinite)) return { ok: false, reason: 'NO_POSITION' }
  const at = Math.floor(start.y + 0.001)
  const here = () => { const now = feet(); return now ? { x: Math.floor(now.x), z: Math.floor(now.z) } : null }
  const isAir = found => found?.known === true && AIR.test(found.name ?? '')
  const clear = async cell => {
    const found = block(cell.x, cell.y, cell.z)
    if (isAir(found)) return true
    if (found?.known !== true || wet(found) || LEAVES.test(found.name ?? '')) return false
    const tool = canMine(cell) || (await ports.pick?.(cell) && canMine(cell))
    if (!tool && !ports.canDig?.(cell)) return false
    return await (tool ? mine(cell) : ports.dig(cell)) === true
  }
  const origin = here()
  const standY = (x, z) => { for (let y = at + 3; y >= at - 6; y--) { const below = block(x, y - 1, z); if (below?.known === true && below.boundingBox === 'block' && !wet(below) && isAir(block(x, y, z)) && isAir(block(x, y + 1, z))) return y } return null }
  const columns = dryColumns(block, origin.x, at, origin.z)
  if (!columns.length) { log('プレイヤーモード: 近く（12マス以内）に、上が水・砂利・葉でない場所が見つかりません'); return { ok: false, reason: 'NO_DRY_COLUMN' } }
  const refusedCells = new Set()
  let tried = 0
  for (const column of columns) {
    if (tried >= tries || aborted()) break
    const from = here() ?? origin
    // Through a cave the column may simply be walked to.
    const spot = standY(column.x, column.z)
    const walkable = spot !== null && dryColumn(block, column.x, spot, column.z)
    const path = [false, true].map(zFirst => driftPath(from, column, zFirst)).find(cells => openPath(block, cells, at, refusedCells))
    if (!walkable && !path) continue
    tried++
    log(`プレイヤーモード: 真上へ掘れないため、横へ${column.steps}マス掘ってから上がります（${column.x},${at},${column.z}）`)
    let refused = null
    if (walkable) { await walk({ x: column.x + 0.5, y: spot, z: column.z + 0.5 }); const now = here(); if (now && now.x === column.x && now.z === column.z) return { ok: true, column, walked: true } }
    if (!path) { log('プレイヤーモード: 横へ掘る途中で止まりました（歩いて行けません）'); continue }
    for (const next of path) {
      if (aborted()) break
      const now = here()
      if (!now) { refused = 'NO_POSITION'; break }
      if (now.x === column.x && now.z === column.z) return { ok: true, column }
      if (now.x === next.x && now.z === next.z) continue
      const floor = block(next.x, at - 1, next.z)
      // A gap one deep in the floor is filled with a held block (ordinary placement).
      const gap = isAir(floor) && !floor.extra?.length && ports.place && await clear({ x: next.x, y: at + 1, z: next.z }) && await clear({ x: next.x, y: at, z: next.z }) && await ports.place({ x: next.x, y: at - 1, z: next.z }, { any: true })
      if (!gap && (floor?.known !== true || floor.boundingBox !== 'block' || wet(floor))) { refused = `床がありません ${next.x},${at - 1},${next.z}`; break }
      if (!await clear({ x: next.x, y: at + 1, z: next.z })) { refusedCells.add(keyOf(next.x, at + 1, next.z)); refused = `掘れません ${next.x},${at + 1},${next.z}${ports.reason ? `: ${ports.reason({ x: next.x, y: at + 1, z: next.z }) ?? ''}` : ''}`; break }
      if (!await clear({ x: next.x, y: at, z: next.z })) { refusedCells.add(keyOf(next.x, at, next.z)); refused = `掘れません ${next.x},${at},${next.z}${ports.reason ? `: ${ports.reason({ x: next.x, y: at, z: next.z }) ?? ''}` : ''}`; break }
      if (aborted()) break
      await walk({ x: next.x + 0.5, y: at, z: next.z + 0.5 })
      const after = here()
      if (!after || after.x !== next.x || after.z !== next.z) { refused = `歩けません ${next.x},${at},${next.z}`; break }
    }
    if (aborted()) return { ok: false, reason: 'INTERRUPTED' }
    const end = here()
    if (!refused && end && end.x === column.x && end.z === column.z) return { ok: true, column }
    log(`プレイヤーモード: 横へ掘る途中で止まりました（${refused ?? '不明'}）`)
  }
  if (aborted()) return { ok: false, reason: 'INTERRUPTED' }
  if (!tried) { log('プレイヤーモード: 近くの上が乾いた場所へは、水・砂利の横を通らずに掘って行けません'); return { ok: false, reason: 'NO_DRY_PATH' } }
  return { ok: false, reason: 'DRIFT_REFUSED' }
}

module.exports = { sidestep, dryColumn, dryColumns, hanging, driftPath, openPath }
