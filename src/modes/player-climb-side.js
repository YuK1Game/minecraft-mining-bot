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
//   those is liquid or unreceived. At least eight blocks up must be received.
// - The drift goes along one axis, then the other. Every block is mined by the
//   ordinary mining after its own check; the floor must be received solid
//   ground. A refused block ends that drift and the next column is tried.
// - Leaves are never cut, so a column with leaves in its way up is not chosen
//   either, and the drift does not go through leaves (real Realm 2026-11-16
//   16:16 JST: 22 steps up, then LEAVES_ABOVE two blocks under the surface
//   below a tree; it stayed in that hole and was killed there).
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LIQUID = /water|lava|bubble_column|kelp|seagrass/
const FALLING = /^minecraft:(?:gravel|sand|red_sand|suspicious_(?:sand|gravel)|.*concrete_powder)$/
const LEAVES = /_leaves$/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const RADIUS = 12, SCAN_UP = 64, MIN_KNOWN = 8, TRIES = 3

const wet = found => found?.known !== true || !!found.extra?.length || LIQUID.test(found.name ?? '')

// The way up from feet level `at` in column (x, z): true when dry as far as received.
function dryColumn (block, x, at, z) {
  let seen = 0
  for (let y = at + 2; y < at + 2 + SCAN_UP; y++) {
    const found = block(x, y, z)
    if (found?.known !== true) break
    if (wet(found) || FALLING.test(found.name ?? '') || LEAVES.test(found.name ?? '')) return false
    if (SIDES.some(([dx, dz]) => wet(block(x + dx, y, z + dz)))) return false
    seen++
  }
  return seen >= MIN_KNOWN
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
  const start = feet()
  if (!start || ![start.x, start.y, start.z].every(Number.isFinite)) return { ok: false, reason: 'NO_POSITION' }
  const at = Math.floor(start.y + 0.001)
  const here = () => { const now = feet(); return now ? { x: Math.floor(now.x), z: Math.floor(now.z) } : null }
  const isAir = found => found?.known === true && AIR.test(found.name ?? '')
  const clear = async cell => {
    const found = block(cell.x, cell.y, cell.z)
    if (isAir(found)) return true
    if (found?.known !== true || wet(found) || LEAVES.test(found.name ?? '')) return false
    const tool = canMine(cell) || (await ports.pick?.() && canMine(cell))
    if (!tool && !ports.canDig?.(cell)) return false
    return await (tool ? mine(cell) : ports.dig(cell)) === true
  }
  const origin = here()
  const columns = dryColumns(block, origin.x, at, origin.z).slice(0, tries)
  if (!columns.length) { log('プレイヤーモード: 近く（12マス以内）に、上が水・砂利・葉でない場所が見つかりません'); return { ok: false, reason: 'NO_DRY_COLUMN' } }
  for (const column of columns) {
    log(`プレイヤーモード: 真上へ掘れないため、横へ${column.steps}マス掘ってから上がります（${column.x},${at},${column.z}）`)
    let refused = null
    while (!aborted()) {
      const now = here()
      if (!now) { refused = 'NO_POSITION'; break }
      if (now.x === column.x && now.z === column.z) return { ok: true, column }
      const next = now.x !== column.x ? { x: now.x + Math.sign(column.x - now.x), z: now.z } : { x: now.x, z: now.z + Math.sign(column.z - now.z) }
      const floor = block(next.x, at - 1, next.z)
      if (floor?.known !== true || floor.boundingBox !== 'block' || wet(floor)) { refused = `床がありません ${next.x},${at - 1},${next.z}`; break }
      if (!await clear({ x: next.x, y: at + 1, z: next.z }) || !await clear({ x: next.x, y: at, z: next.z })) { refused = `掘れません ${next.x},${at},${next.z}${ports.reason ? `: ${ports.reason({ x: next.x, y: at, z: next.z }) ?? ports.reason({ x: next.x, y: at + 1, z: next.z }) ?? ''}` : ''}`; break }
      if (aborted()) break
      await walk({ x: next.x + 0.5, y: at, z: next.z + 0.5 })
      const after = here()
      if (!after || after.x !== next.x || after.z !== next.z) { refused = `歩けません ${next.x},${at},${next.z}`; break }
    }
    if (aborted()) return { ok: false, reason: 'INTERRUPTED' }
    log(`プレイヤーモード: 横へ掘る途中で止まりました（${refused}）`)
  }
  return { ok: false, reason: 'DRIFT_REFUSED' }
}

module.exports = { sidestep, dryColumn, dryColumns }
