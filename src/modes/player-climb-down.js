'use strict'

// Player mode: the climb (player-climb.js) stands on a pillar it stacked
// through a cave, the block over the head cannot be mined, and there is no
// floor beside the pillar for the drift (player-climb-side.js). The pillar is
// taken down again from under the feet, one block at a time by the ordinary
// mining (`pillar_descent`: the received pillar block right under the feet,
// received solid ground below it, the feet one lower afterwards), until a
// cell beside it can be walked onto (real Realm 2026-11-16 18:54-19:04 JST:
// 59 steps up into a cave under a lake, every pickaxe at two uses; the drift
// ended three times with 「床がありません」 and the Bot stood on the pillar).
// - Only blocks the climb stacks are mined: dirt, cobblestone, cobbled deepslate.
// - A cell beside the pillar counts when it is level or one step down, with
//   received solid dry ground under it and received air for the body.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const OWN = /^minecraft:(?:dirt|grass_block|cobblestone|cobbled_deepslate)$/
const LIQUID = /water|lava/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const MAX = 96

const isAir = found => found?.known === true && AIR.test(found.name ?? '') && !found.extra?.length
const ground = found => found?.known === true && found.boundingBox === 'block' && !found.extra?.length && !LIQUID.test(found.name ?? '')

// A cell beside (x, z) the Bot can walk onto from feet level `at`, or null.
function wayOff (block, x, at, z) {
  for (const [dx, dz] of SIDES) {
    const sx = x + dx, sz = z + dz
    if (!isAir(block(sx, at, sz)) || !isAir(block(sx, at + 1, sz))) continue
    if (ground(block(sx, at - 1, sz))) return { x: sx, y: at, z: sz }
    if (isAir(block(sx, at - 1, sz)) && ground(block(sx, at - 2, sz))) return { x: sx, y: at - 1, z: sz }
  }
  return null
}

async function climbDown ({ ports, log = () => {}, aborted = () => false, max = MAX }) {
  const { feet, block, descend } = ports
  const cell = () => { const at = feet(); return at && [at.x, at.y, at.z].every(Number.isFinite) ? { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } : null }
  let steps = 0, reason = null
  while (!aborted()) {
    const at = cell()
    if (!at) { reason = 'NO_POSITION'; break }
    const off = wayOff(block, at.x, at.y, at.z)
    if (off) { if (steps) log(`プレイヤーモード: 柱を${steps}段下りました。横へ歩けます（${off.x},${off.y},${off.z}）`); return { ok: true, steps, off } }
    if (steps >= max) { reason = 'TOO_DEEP'; break }
    const under = block(at.x, at.y - 1, at.z)
    if (!OWN.test(under?.name ?? '')) { reason = 'NOT_OWN_PILLAR'; break }
    if (!steps) log('プレイヤーモード: 柱の横に床がないため、積んだ柱を下りてから横へ進みます')
    if (!await descend({ x: at.x, y: at.y - 1, z: at.z })) { reason = 'DESCEND_FAILED'; break }
    steps++
  }
  if (aborted() && !reason) reason = 'INTERRUPTED'
  if (steps || reason !== 'NOT_OWN_PILLAR') log(`プレイヤーモード: 柱を下りる途中で止まりました（${steps}段、${reason}${ports.why?.() ? `、${ports.why()}` : ''}）`)
  return { ok: false, steps, reason }
}

module.exports = { climbDown, wayOff }
