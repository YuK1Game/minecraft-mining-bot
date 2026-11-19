'use strict'

// Player mode: something to stack, taken from the ground beside.
//
// A pillar step needs one block (dirt, cobblestone, cobbled deepslate). The
// climb out of the underground had only what was already in the pack and what
// fell from the rock overhead; with neither it ended at once with NO_DIRT, and
// its callers asked again every two seconds (real Realm 2026-11-19 18:45-18:50
// JST: after a death, with a sword and a pickaxe and nothing else, at the
// bottom of its own four-high shaft eleven blocks under the surface:
// 「真上へ掘る途中で止まりました（0段、NO_DIRT）」 117 times in five minutes).
// - A block just mined is in the pack a moment later: `arrives` waits for the
//   received inventory before the count is read.
// - With nothing to stack, blocks beside the feet are mined by ordinary mining:
//   the wall at head and at foot height on each side, then the floor of a side
//   that stands open (over received solid ground). Only blocks whose drop can
//   be stacked (dirt, grass, stone, cobblestone, deepslate); never the block
//   under the feet, a block a base protects (`natural: false`), or one the
//   mining preview refuses (liquid, falling blocks, unreceived terrain beside).
// - It counts by the received inventory only. A drop that did not come by
//   itself is fetched with one step to where it lies and back.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const DROPS = /^minecraft:(?:dirt|grass_block|grass|podzol|mycelium|dirt_with_roots|stone|cobblestone|deepslate|cobbled_deepslate)$/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const ARRIVE_MS = 2500, MAX_WANT = 12

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Waits until the pack holds more than `had` blocks to stack.
async function arrives ({ fill, had, sleep = pause, aborted = () => false, ms = ARRIVE_MS }) {
  for (let waited = 0; waited < ms && !aborted(); waited += 200) {
    if (fill() > had) return true
    await sleep(200)
  }
  return fill() > had
}

// ports: the scaffold's hands (player-scaffold-ports.js).
async function gatherFill ({ ports, want = 1, aborted = () => false, log = () => {}, sleep = pause }) {
  const { feet, block, walk, canMine, mine } = ports
  const fill = () => ports.fill?.() ?? ports.dirt()
  const start = feet()
  if (!start || ![start.x, start.y, start.z].every(Number.isFinite)) return { ok: false, got: 0, code: 'NO_POSITION' }
  const base = Math.floor(start.y + 0.001), home = { x: Math.floor(start.x), z: Math.floor(start.z) }
  const centre = { x: home.x + 0.5, y: base, z: home.z + 0.5 }
  const before = fill(), goal = before + Math.max(1, Math.min(MAX_WANT, Math.round(want)))
  const at = (x, y, z) => block(x, y, z)
  const isAir = found => found?.known === true && AIR.test(found.name ?? '')
  const solid = found => found?.known === true && found.boundingBox === 'block'
  const usable = cell => { const found = at(cell.x, cell.y, cell.z); return found?.known === true && found.natural !== false && DROPS.test(found.name ?? '') }
  let mined = 0
  // One block: mined, then counted when it is in the pack. `fetch`: where to step when it does not come by itself.
  async function take (cell, fetch = null) {
    if (aborted() || fill() >= goal || !usable(cell)) return false
    if (!(canMine(cell) || (await ports.pick?.() && canMine(cell)))) return false
    const had = fill()
    if (!await mine(cell)) return false
    mined++
    if (await arrives({ fill, had, sleep, aborted })) return true
    const stand = fetch?.()
    if (!stand || aborted()) return false
    await walk(stand)
    await walk(centre)
    return arrives({ fill, had, sleep, aborted, ms: 600 })
  }
  const sides = SIDES.map(([dx, dz]) => ({ x: home.x + dx, z: home.z + dz }))
  const open = side => isAir(at(side.x, base, side.z)) && isAir(at(side.x, base + 1, side.z))
  // Where a drop lies inside a side that stands open over a floor.
  const inside = side => () => open(side) && solid(at(side.x, base - 1, side.z)) ? { x: side.x + 0.5, y: base, z: side.z + 0.5 } : null
  for (const side of sides) for (const y of [base + 1, base]) await take({ x: side.x, y, z: side.z }, inside(side))
  // The floor of an open side: the drop lies one lower, a step down and back up.
  for (const side of sides) {
    if (!open(side) || !solid(at(side.x, base - 2, side.z))) continue
    await take({ x: side.x, y: base - 1, z: side.z }, () => isAir(at(side.x, base - 1, side.z)) ? { x: side.x + 0.5, y: base - 1, z: side.z + 0.5 } : null)
  }
  const now = feet()
  if (now && (Math.floor(now.x) !== home.x || Math.floor(now.z) !== home.z || Math.floor(now.y + 0.001) !== base) && !aborted()) await walk(centre)
  const got = fill() - before
  if (mined) log(`プレイヤーモード: 積むブロックがないため、足の横のブロックを ${mined} 個掘って ${got} 個拾いました`)
  return { ok: got > 0, got, mined, code: got > 0 ? 'GATHERED' : mined ? 'NOT_PICKED_UP' : 'NOTHING_TO_MINE' }
}

module.exports = { gatherFill, arrives, DROPS, ARRIVE_MS, MAX_WANT }
