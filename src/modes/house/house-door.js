'use strict'

// The starter house's door is opened by an ordinary click so the Bot can go
// in to the chest and the bed (real Realm 2026-11-17 15:16 JST: right after
// the house was finished the door stood closed and the base trip ended
// outside, 「拠点のチェストのそばまで行けません（残り 6m）」). It counts as open
// only when the received door block says open_bit. The door is left open;
// closing it behind the Bot is not done yet.
const { placements } = require('./house-blueprint')
const DOOR = /^minecraft:[a-z_]*door$/
const AIR = /^minecraft:(?:air|cave_air|void_air)$/

const isDoor = block => block?.known === true && DOOR.test(block.name ?? '') && !/iron|trapdoor/.test(block.name)
const isOpen = block => [true, 1].includes(block?.properties?.open_bit)
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

async function openDoor ({ origin, getBlock, useDoor, walk, getFeet, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const at = origin && doorOf(origin)
  if (!at) return true
  const block = getBlock(at.x, at.y, at.z)
  if (!isDoor(block)) return true
  if (isOpen(block)) return true
  const feet = getFeet()
  if (!feet) return false
  const far = stand => Math.hypot(stand.x - feet.x, stand.z - feet.z)
  const stands = doorStands(getBlock, at).sort((a, b) => far(a) - far(b))
  if (Math.hypot(at.x + 0.5 - feet.x, at.y - feet.y, at.z + 0.5 - feet.z) > 3 && stands.length) { try { await walk(stands[0]) } catch {} }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await useDoor(at) } catch (error) { log(`プレイヤーモード: 拠点の家のドアを開けられません ${String(error?.message ?? error).slice(0, 80)}`); return false }
    const until = now() + 3000
    while (now() < until && !isOpen(getBlock(at.x, at.y, at.z))) await sleep(200)
    if (isOpen(getBlock(at.x, at.y, at.z))) { log(`プレイヤーモード: 拠点の家のドア (${at.x}, ${at.y}, ${at.z}) を開けました`); return true }
  }
  log('プレイヤーモード: 拠点の家のドアに触れましたが、開いたことを確認できません')
  return false
}

module.exports = { openDoor, doorOf, doorStands, isOpen }
