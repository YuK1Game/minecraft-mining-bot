'use strict'

// Player mode: out of the underground by a stair it digs, when the climb
// straight up cannot go on.
//
// The climb (player-climb.js) needs one block for every step it rises. With
// nothing to stack and no pickaxe that may be used (rock mined by hand drops
// nothing), it ended with NO_DIRT and its callers asked again every two
// seconds (real Realm 2026-11-19 18:45-18:50 JST: after a death, a stone sword
// and an iron pickaxe with two uses left, in a shaft eleven blocks under the
// surface with stone on every side: 「真上へ掘る途中で止まりました（0段、
// NO_DIRT）」 117 times in five minutes, the Bot never moved).
// A stair needs no block: each step is mined out of the rock and walked. The
// way is the shared one that digs and stacks (movement/build-route.js,
// carried out by player-build-walk.js), to the nearest ground under the open
// sky. It reads received terrain only; a column with an unreceived cell above
// is not the sky.
const { BUILT } = require('./player-surface')

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const TREE = /_(?:leaves|log|wood|stem)$|leaf_litter/
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|sweet_berry/
const RANGE = 12, SCAN_UP = 64

// The ground under the open sky nearest to a stair from the feet: where to stand, and what counts as out.
function skyTarget ({ block, feet, range = RANGE, scanUp = SCAN_UP }) {
  if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite) || typeof block !== 'function') return null
  const origin = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.001), z: Math.floor(feet.z) }
  const open = found => found?.known === true && !found.extra?.length && !HAZARD.test(found.name ?? '') && (AIR.test(found.name ?? '') || found.boundingBox === 'empty')
  const ground = found => found?.known === true && found.boundingBox === 'block' && !TREE.test(found.name ?? '') && !HAZARD.test(found.name ?? '')
  // Nothing but received open cells or a tree's crown above the head of who stands at (x, y, z).
  const sky = (x, y, z) => {
    for (let up = y + 2; up < y + 2 + scanUp; up++) {
      const found = block(x, up, z)
      if (found?.known !== true) return false
      if (found.boundingBox === 'block' && !TREE.test(found.name ?? '')) return false
    }
    return true
  }
  const done = cell => ground(block(cell.x, cell.y - 1, cell.z)) && open(block(cell.x, cell.y, cell.z)) && open(block(cell.x, cell.y + 1, cell.z)) && sky(cell.x, cell.y, cell.z)
  let best = null
  for (let dx = -range; dx <= range; dx++) for (let dz = -range; dz <= range; dz++) {
    if (!dx && !dz) continue
    const x = origin.x + dx, z = origin.z + dz
    // From the top of the scan down to the first ground: every cell on the way received.
    let top = null
    for (let y = origin.y + scanUp; y >= origin.y - 2; y--) {
      const found = block(x, y, z)
      if (found?.known !== true) break
      if (found.boundingBox !== 'block' || TREE.test(found.name ?? '')) continue
      if (!BUILT.test(found.name ?? '') && ground(found)) top = y
      break
    }
    if (top === null) continue
    const cell = { x, y: top + 1, z }
    if (!done(cell)) continue
    // A straight stair rises one block a cell: the nearer the run is to the rise, the less rock is mined.
    const run = Math.abs(dx) + Math.abs(dz), rise = cell.y - origin.y
    const cost = Math.abs(run - Math.abs(rise)) + run * 0.25 + Math.abs(rise)
    if (!best || cost < best.cost) best = { cell, cost }
  }
  return best ? { target: best.cell, done } : null
}

// build: the way that digs and stacks (player-build-walk.js createBuildWalk).
async function stairOut ({ ports, build, log = () => {}, aborted = () => false }) {
  if (typeof build !== 'function') return { ok: false, reason: 'NO_BUILD_WALK', steps: 0 }
  const plan = skyTarget({ block: ports.block, feet: ports.feet() })
  if (!plan) { log('プレイヤーモード: 段を掘って出る先の、空の見える地面が受信した範囲にありません'); return { ok: false, reason: 'NO_SKY_TARGET', steps: 0 } }
  const { target } = plan
  log(`プレイヤーモード: 真上へ積めないため、地上 (${target.x}, ${target.y}, ${target.z}) へ段を掘って出ます`)
  // The box of the search: a little round the stair, so the plan is found within its limit in solid rock.
  const out = await build(target, { done: plan.done, aborted, limits: { pad: 4, rise: 3 } })
  return { ok: out.ok === true, reason: out.ok ? null : out.code, steps: out.moved ?? 0, stair: true }
}

module.exports = { skyTarget, stairOut, RANGE }
