'use strict'

// Player mode: straight up to the surface when no walk leads out.
// The long travel plans a walking route to open sky; from a tunnel whose
// stairs are blocked there is none (real Realm 2026-11-16 06:15-06:31 JST:
// three trips of four minutes each, 「歩ける中継点が見つかりません」 13
// times, the Bot never left y 62-65 with trees standing at y 71-79).
// From where the Bot stands this mines the two blocks above the head by
// ordinary mining and rises one dirt pillar step (the quarry's step: jump and
// ordinary placement, confirmed by the received block, one dirt less and the
// landing), until its feet are level with the top of the ground it dug
// through. The mining preview refuses liquid, falling blocks and unreceived
// terrain above; the climb then stops with the reason. Leaves are never cut.
// The dirt column stays behind as the filled shaft.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LEAVES = /_leaves$/
const TREE = /_(?:leaves|log|wood|stem)$|leaf_litter/
const SCAN_UP = 64
const MAX_STEPS = 48

// ports: the scaffold's hands (player-scaffold-ports.js).
async function climbOut ({ ports, log = () => {}, aborted = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxSteps = MAX_STEPS }) {
  const { feet, block, dirt, walk, canMine, mine, pillar } = ports
  const start = feet()
  if (!start || ![start.x, start.y, start.z].every(Number.isFinite)) return { ok: false, reason: 'NO_POSITION', steps: 0 }
  const column = { x: Math.floor(start.x), z: Math.floor(start.z) }
  const level = () => { const at = feet(); return at && Math.floor(at.x) === column.x && Math.floor(at.z) === column.z ? Math.floor(at.y + 0.001) : null }
  const isAir = found => found?.known === true && AIR.test(found.name ?? '')
  // Received solid ground (not a tree) above the head: 'cover', 'open', or 'unknown' before either.
  const above = at => {
    for (let y = at + 2; y < at + 2 + SCAN_UP; y++) {
      const found = block(column.x, y, column.z)
      if (found?.known !== true) return 'unknown'
      if (found.boundingBox === 'block' && !TREE.test(found.name ?? '')) return 'cover'
    }
    return 'open'
  }
  let steps = 0, top = null, reason = null, detail = null
  if (above(Math.floor(start.y + 0.001)) !== 'cover') return { ok: false, reason: 'NOT_UNDER_COVER', steps }
  await walk({ x: column.x + 0.5, y: Math.floor(start.y + 0.001), z: column.z + 0.5 })
  while (!reason && !aborted()) {
    const at = level()
    if (at === null) { reason = 'LEFT_COLUMN'; break }
    const sky = above(at)
    if (sky !== 'cover' && top !== null && at > top) break // feet level with the ground dug through
    if (sky === 'unknown' && top === null) { reason = 'UNKNOWN_ABOVE'; break }
    if (steps >= maxSteps) { reason = 'TOO_HIGH'; break }
    for (const y of [at + 2, at + 3]) {
      const cell = { x: column.x, y, z: column.z }, found = block(cell.x, cell.y, cell.z)
      if (isAir(found)) continue
      if (found?.known !== true) { reason = 'UNKNOWN_ABOVE'; break }
      if (LEAVES.test(found.name ?? '')) { reason = 'LEAVES_ABOVE'; break }
      if (!canMine(cell) && !(await ports.pick?.() && canMine(cell))) { reason = 'CANNOT_MINE'; detail = ports.reason?.(cell) ?? null; break }
      if (!await mine(cell)) { reason = 'MINE_FAILED'; break }
      if (found.boundingBox === 'block') top = Math.max(top ?? y, y)
    }
    if (reason || aborted()) break
    if (dirt() < 1) { reason = 'NO_DIRT'; break }
    let step = await pillar(column, at)
    // The step before may still be ending (ASCENT_BUSY, a mining that just finished).
    if (!step?.ok && !aborted()) { await sleep(1500); if (level() === at) step = await pillar(column, at); else step = { ok: level() === at + 1 } }
    if (!step?.ok) { reason = `PILLAR_${String(step?.reason ?? 'BLOCKED').slice(0, 60)}`; break }
    steps++
  }
  if (aborted() && !reason) reason = 'INTERRUPTED'
  if (reason) detail ??= ports.why?.() ?? null
  log(reason ? `プレイヤーモード: 真上へ掘る途中で止まりました（${steps}段、${reason}${detail ? `、${detail}` : ''}）` : `プレイヤーモード: 真上へ${steps}段のぼって地上へ出ました（土の柱は残します）`)
  return { ok: !reason, reason, steps, detail }
}

module.exports = { climbOut }
