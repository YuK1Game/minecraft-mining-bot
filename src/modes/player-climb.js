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
// It also ends where it has come out of the ground and a walk from there
// leads to the open sky, although more ground lies far overhead (`wayOut`;
// real Realm 2026-11-18 12:06-12:10 JST: 87 steps, the last 18 through the
// open air under an overhang, up onto ground with no way down to the house).
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LEAVES = /_leaves$/
const TREE = /_(?:leaves|log|wood|stem)$|leaf_litter/
const SCAN_UP = 64
const MAX_STEPS = 96
const { gatherFill, arrives } = require('./fill-source')

// ports: the scaffold's hands (player-scaffold-ports.js).
async function climbOut ({ ports, log = () => {}, aborted = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxSteps = MAX_STEPS, wayOut = null }) {
  const { feet, block, dirt, walk, canMine, mine, pillar } = ports
  // Dirt, or the cobblestone mined on the way up (real Realm 2026-11-16 08:39
  // JST: 64 blocks under the surface with 34 dirt).
  const fill = () => ports.fill?.() ?? dirt()
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
  let steps = 0, top = null, reason = null, detail = null, walkable = false
  if (above(Math.floor(start.y + 0.001)) !== 'cover') return { ok: false, reason: 'NOT_UNDER_COVER', steps }
  const base = Math.floor(start.y + 0.001), centre = { x: column.x + 0.5, y: base, z: column.z + 0.5 }
  await walk(centre)
  // The pillar step is confirmed by the server within 0.12 of the column's
  // centre, and a walk of a few centimetres does not move the Bot: off centre,
  // one step to a free block beside and back (real Realm 2026-11-16 15:33-15:38
  // JST: 0.1 off after a tunnel, five climbs ended at 0 steps with
  // ASCENT_POSITION_UNCONFIRMED under three blocks of air).
  const off = () => { const at = feet(); return at ? Math.hypot(at.x - centre.x, at.z - centre.z) : 0 }
  if (off() > 0.06 && !aborted()) {
    const solid = (x, y, z) => { const found = block(x, y, z); return found?.known === true && found.boundingBox === 'block' }
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: column.x + dx, z: column.z + dz }))
    const there = async side => { await walk({ x: side.x + 0.5, y: side.y, z: side.z + 0.5 }); await walk(centre) }
    let side = null
    await require('./pillar-centre').centreOnColumn({ column, base, feet, block, walk, aborted, tries: 1 })
    // Walled in (a stair it dug itself): the blocks of one side are mined (real
    // Realm 15:46-15:57 JST: 0.149 off, stone on every side at the feet or the head).
    if (off() > 0.06 && !aborted()) for (const cell of sides) {
      if (!solid(cell.x, base - 1, cell.z)) continue
      let open = true
      for (const y of [base + 1, base]) {
        const target = { x: cell.x, y, z: cell.z }
        if (isAir(block(target.x, y, target.z))) continue
        const tool = canMine(target) || (await ports.pick?.(target) && canMine(target))
        if (!(tool ? await mine(target) : ports.canDig?.(target) && await ports.dig(target))) { open = false; break }
      }
      if (open) { side = { ...cell, y: base }; break }
    }
    if (side) await there(side)
  }
  while (!reason && !aborted()) {
    const at = level()
    if (at === null) { reason = 'LEFT_COLUMN'; break }
    const sky = above(at)
    if (sky !== 'cover' && top !== null && at > top) break // feet level with the ground dug through
    // Out of the ground with more ground far overhead (an overhang, a cave with
    // a mouth): where a walk leads to the open sky, the climb ends here and
    // does not stack its pillar through the open air (player-sky-walk.js).
    if (sky === 'cover' && top !== null && at > top && wayOut?.()) { walkable = true; break }
    if (sky === 'unknown' && top === null) { reason = 'UNKNOWN_ABOVE'; break }
    if (steps >= maxSteps) { reason = 'TOO_HIGH'; break }
    let took = false // a block mined with a tool in this step: its drop is on the way
    for (const y of [at + 2, at + 3]) {
      // climbShaft: the floor of a tunnel it walked may be passed through here
      // (the pillar fills the hole again; real Realm 2026-11-16 16:01-16:11 JST:
      // four steps up, then PROTECTED_BLOCK under its own corridor, six times).
      const cell = { x: column.x, y, z: column.z, climbShaft: true }, found = block(cell.x, cell.y, cell.z)
      if (isAir(found)) continue
      if (found?.known !== true) { reason = 'UNKNOWN_ABOVE'; break }
      if (LEAVES.test(found.name ?? '')) { reason = 'LEAVES_ABOVE'; break }
      // No pickaxe left that may be used: plain rock by hand (real Realm
      // 2026-11-16 09:28 JST: every pickaxe at 2 uses, 20 blocks under the surface).
      const tool = canMine(cell) || (await ports.pick?.(cell) && canMine(cell))
      if (!tool && !ports.canDig?.(cell)) { reason = 'CANNOT_MINE'; detail = ports.reason?.(cell) ?? null; break }
      if (!await (tool ? mine(cell) : ports.dig(cell))) { reason = 'MINE_FAILED'; break }
      if (tool) took = true
      if (found.boundingBox === 'block') top = Math.max(top ?? y, y)
    }
    if (reason || aborted()) break
    // Nothing to stack: what was just mined is in the pack a moment later; else blocks from beside the feet,
    // one for every open cell up to the rock overhead (fill-source.js; live 2026-11-19 18:45 JST: NO_DIRT at once).
    if (fill() < 1 && took) await arrives({ fill, had: 0, sleep, aborted })
    if (fill() < 1 && !aborted()) {
      let gap = 1
      while (gap < 12 && isAir(block(column.x, at + 3 + gap, column.z))) gap++
      await gatherFill({ ports, want: gap, aborted, log, sleep })
    }
    if (fill() < 1) { reason = 'NO_DIRT'; break }
    let step = await pillar(column, at, { any: true })
    // The step before may still be ending (ASCENT_BUSY, a mining that just finished).
    if (!step?.ok && !aborted()) { await sleep(1500); if (level() === at) step = await pillar(column, at, { any: true }); else step = { ok: level() === at + 1 } }
    if (!step?.ok) { reason = `PILLAR_${String(step?.reason ?? 'BLOCKED').slice(0, 60)}`; break }
    steps++
  }
  if (aborted() && !reason) reason = 'INTERRUPTED'
  if (reason) detail ??= ports.why?.() ?? null
  log(reason ? `プレイヤーモード: 真上へ掘る途中で止まりました（${steps}段、${reason}${detail ? `、${detail}` : ''}）` : walkable ? `プレイヤーモード: 真上へ${steps}段のぼりました。ここから空の見える場所へ歩いて出られるので、頭上の地面へは登りません（土の柱は残します）` : `プレイヤーモード: 真上へ${steps}段のぼって地上へ出ました（土の柱は残します）`)
  return { ok: !reason, reason, steps, detail, walkable }
}

module.exports = { climbOut }
