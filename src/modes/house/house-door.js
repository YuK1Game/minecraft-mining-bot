'use strict'

// The starter house's door is opened by an ordinary click so the Bot can go
// in to the chest and the bed (real Realm 2026-11-17 15:16 JST: right after
// the house was finished the door stood closed and the base trip ended
// outside, 「拠点のチェストのそばまで行けません（残り 6m）」). It counts as open
// only when the received door block says open_bit. The door is left open;
// closing it behind the Bot is not done yet.
const { placements } = require('./house-blueprint')
const { isDoor, isOpen } = require('../../movement/door-cell')
const AIR = /^minecraft:(?:air|cave_air|void_air)$/

const doorOf = origin => placements(origin).find(step => step.item === 'oak_door')?.position ?? null

// Cells to stand in front of and behind the door: across the wall it sits in.
function doorStands (getBlock, at) {
  const solid = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox === 'block' }
  const air = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && (AIR.test(found.name ?? '') || found.boundingBox === 'empty') }
  // The wall runs along x when the cells east and west of the door are wall.
  const alongX = solid(at.x - 1, at.y, at.z) || solid(at.x + 1, at.y, at.z)
  const sides = alongX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]
  return sides.map(([dx, dz]) => ({ x: at.x + dx, y: at.y, z: at.z + dz })).filter(cell => solid(cell.x, cell.y - 1, cell.z) && air(cell.x, cell.y, cell.z) && air(cell.x, cell.y + 1, cell.z)).map(cell => ({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }))
}

// A click is sent only from where it can reach the door: farther, the server refuses it (real Realm 2026-11-24
// 15:49:50-15:51:10 JST, the return to the base chest: 「拠点の家のドアを開けられません 操作対象が手の届く範囲外です。」
// nine times, the walk to the stand having found no way over the dug ground; the return was held CHEST_UNREACHED).
// Where the walk did not bring the Bot within reach, `reach` (house-entry.js toEntrance: the walk, then the way that
// digs and stacks) takes it to the stand outside the door first.
const REACH = 4.5

async function openDoor ({ origin, getBlock, useDoor, walk, getFeet, reach = null, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const at = origin && doorOf(origin)
  if (!at) return true
  const block = getBlock(at.x, at.y, at.z)
  if (!isDoor(block)) return true
  if (isOpen(block)) return true
  const feet = getFeet()
  if (!feet) return false
  const far = stand => Math.hypot(stand.x - feet.x, stand.z - feet.z)
  const stands = doorStands(getBlock, at).sort((a, b) => far(a) - far(b))
  const gap = () => { const here = getFeet(); return here ? Math.hypot(at.x + 0.5 - here.x, at.y - here.y, at.z + 0.5 - here.z) : Infinity }
  const onStand = () => {
    const here = getFeet()
    return Boolean(here && stands.some(stand => Math.hypot(stand.x - here.x, stand.z - here.z) <= 0.85 && Math.abs(stand.y - here.y) <= 0.6))
  }
  if (gap() > 3 && stands.length) { try { await walk(stands[0]) } catch {} }
  if (gap() > REACH && !isOpen(getBlock(at.x, at.y, at.z)) && typeof reach === 'function') { try { await reach() } catch {} }
  if (gap() > REACH && !isOpen(getBlock(at.x, at.y, at.z))) {
    const here = getFeet()
    log(`プレイヤーモード: 拠点の家のドアに手の届く場所へ行けません（ドアまで ${gap().toFixed(1)}m${here ? `、足元 ${Math.floor(here.x)}, ${Math.floor(here.y)}, ${Math.floor(here.z)}` : ''}）`)
    return false
  }
  let repositioned = false
  for (let attempt = 0; attempt < 2; attempt++) {
    // The walk to the stand may have opened it already (the hands click a closed door on their way: door-on-way.js);
    // a second click would close it again.
    if (isOpen(getBlock(at.x, at.y, at.z))) return true
    try {
      await useDoor(at)
    } catch (error) {
      const msg = String(error?.message ?? error)
      if (!repositioned && /視線|範囲外/.test(msg) && (stands.length || typeof reach === 'function')) {
        repositioned = true
        if (!onStand() && stands.length) { try { await walk(stands[0]) } catch {} }
        if (!onStand() && !isOpen(getBlock(at.x, at.y, at.z)) && typeof reach === 'function') { try { await reach() } catch {} }
        if (isOpen(getBlock(at.x, at.y, at.z))) return true
        attempt--
        continue
      }
      log(`プレイヤーモード: 拠点の家のドアを開けられません ${msg.slice(0, 80)}`)
      return false
    }
    const until = now() + 3000
    while (now() < until && !isOpen(getBlock(at.x, at.y, at.z))) await sleep(200)
    if (isOpen(getBlock(at.x, at.y, at.z))) { log(`プレイヤーモード: 拠点の家のドア (${at.x}, ${at.y}, ${at.z}) を開けました`); return true }
  }
  log('プレイヤーモード: 拠点の家のドアに触れましたが、開いたことを確認できません')
  return false
}

module.exports = { openDoor, doorOf, doorStands, isOpen }
