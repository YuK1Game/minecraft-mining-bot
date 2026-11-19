'use strict'

// Player mode: out of a hole that cannot be walked out of.
// Walking climbs one block at a time, so the floor of a pit two deep has no
// route anywhere (real Realm 2026-11-16 14:33-14:38 JST: at the bottom of an
// open pit two blocks deep with dirt walls, every plan stopped with 「No known
// safe standing position has a valid route」; user: 「穴に落ちてでられないみたい
// だね。土掘ったり掘った土で足場作るとでられるよ」).
// From the cell the Bot stands in, this cuts one step into the wall by
// ordinary mining (the wall block at head height and the one above it, and the
// block over its own head when there is one) and walks up onto it, again and
// again, until the ground it can walk on is no longer a small closed area.
// The side whose rim is lowest is cut first. The mining preview refuses
// liquid, falling blocks and unreceived terrain; the climb then stops with the
// reason. Leaves are never cut.
// Nor is a block of the starter house (read as natural: false through
// safety/house-protection.js): the house with a blown-away door step is a
// small closed area too, and its roof and walls were the "wall" (real Realm
// 2026-11-19 17:33 JST: 「穴から出る途中で止まりました（…birch_slab）」 from the door step).
const { walkableCells } = require('./player-drops')

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LEAVES = /_leaves$/
const BOXED_CELLS = 60
const MAX_STEPS = 8
const RIM_SCAN = 8
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Whether the ground reachable on foot from here is a small closed area.
// `position` is the eye position; an unknown place under the feet is not a pit.
function boxedIn (getBlock, position) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return false
  const cells = walkableCells(position, getBlock)
  return cells.size > 0 && cells.size <= BOXED_CELLS
}

// ports: the scaffold's hands (player-scaffold-ports.js).
async function stepOut ({ ports, getBlock = ports.block, log = () => {}, aborted = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxSteps = MAX_STEPS }) {
  const { feet, block, walk, canMine, mine } = ports
  const open = found => found?.known === true && !found.extra?.length && (AIR.test(found.name ?? '') || found.boundingBox === 'empty')
  const solid = found => found?.known === true && found.boundingBox === 'block'
  const cellOf = () => { const at = feet(); return at && [at.x, at.y, at.z].every(Number.isFinite) ? { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } : null }
  const eye = () => { const at = feet(); return at ? { x: at.x, y: at.y + 1.62, z: at.z } : null }
  let steps = 0, reason = null, detail = null
  while (!reason && !aborted()) {
    const at = cellOf()
    if (!at) { reason = 'NO_POSITION'; break }
    if (!boxedIn(getBlock, eye())) break
    if (steps >= maxSteps) { reason = 'TOO_DEEP'; break }
    // The step to cut: a wall column with a solid block at foot height.
    const sides = SIDES.map(([dx, dz]) => {
      const x = at.x + dx, z = at.z + dz
      if (!solid(block(x, at.y, z))) return null
      const cut = [{ x, y: at.y + 2, z }, { x, y: at.y + 1, z }, { x: at.x, y: at.y + 2, z: at.z }].filter(cell => !open(block(cell.x, cell.y, cell.z)))
      if (cut.some(cell => { const found = block(cell.x, cell.y, cell.z); return found?.known !== true || found.natural === false || LEAVES.test(found.name ?? '') })) return null
      let rim = RIM_SCAN
      for (let up = 1; up <= RIM_SCAN; up++) if (open(block(x, at.y + up, z)) && open(block(x, at.y + up + 1, z))) { rim = up; break }
      return { x, z, cut, rim }
    }).filter(Boolean).sort((a, b) => a.rim - b.rim || a.cut.length - b.cut.length)
    if (!sides.length) { reason = 'NO_WALL'; break }
    let done = false
    for (const side of sides) {
      let failed = false
      for (const cell of side.cut) {
        const tool = canMine(cell) || (await ports.pick?.() && canMine(cell))
        if (!tool && !ports.canDig?.(cell)) { failed = true; detail = ports.reason?.(cell) ?? ports.why?.() ?? null; break }
        if (!await (tool ? mine(cell) : ports.dig(cell))) { failed = true; detail = ports.why?.() ?? null; break }
        if (aborted()) break
      }
      if (aborted()) break
      if (failed) continue
      await walk({ x: side.x + 0.5, y: at.y + 1, z: side.z + 0.5 })
      let now = cellOf()
      if (!(now && now.y > at.y) && !aborted()) { await sleep(1500); now = cellOf() }
      if (now && now.y > at.y) { done = true; break }
      detail = ports.why?.() ?? detail
    }
    if (aborted()) break
    if (!done) { reason = 'STEP_FAILED'; break }
    steps++
  }
  if (aborted() && !reason) reason = 'INTERRUPTED'
  log(reason ? `プレイヤーモード: 穴から出る途中で止まりました（${steps}段、${reason}${detail ? `、${detail}` : ''}）` : `プレイヤーモード: 壁に${steps}段の足場を掘って穴から出ました`)
  return { ok: !reason, reason, steps, detail }
}

module.exports = { boxedIn, stepOut, BOXED_CELLS }
