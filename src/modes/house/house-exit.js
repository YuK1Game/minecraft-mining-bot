'use strict'

// Inside the starter house a long trip cannot leave: the surface route sees the
// roof and the walls and finds no walkable relay (real Realm 2026-11-17
// 21:52-21:54 JST: after banking, standing on the house furnace, every leg to
// the western dig site ended with CHUNK_TRAVEL_NO_ROUTE and 「歩ける中継点が見つかりません」
// every 15 s; the same at 12:13-12:20 and 14:50-15:05). Before a long trip
// starts inside the house the Bot opens the door and walks out through it: to
// the stand inside the door, then the stand outside it.
const { doorOf, doorStands } = require('./house-door')

const SIZE = 7, HEIGHT = 5

function inside (origin, feet) {
  if (!origin || !feet) return false
  return feet.x >= origin.x && feet.x < origin.x + SIZE && feet.z >= origin.z && feet.z < origin.z + SIZE && feet.y >= origin.y && feet.y < origin.y + HEIGHT
}

// The door walk can fail on a damaged house (real Realm 2026-11-19 02:36-02:44
// JST: a creeper blast had taken the door and the floor under it; the walk
// across the gap was refused, 「家のドアから外へ出られませんでした」 twice, and
// the trip from under the roof found no relay for eight minutes). Then the
// route that digs, stacks and bridges (`build`, modes/player-build-walk.js)
// takes the Bot to the first cell outside, in front of the door.
async function leaveHouse ({ house, getFeet, getBlock, walk, door = async () => true, why = () => null, build = null, log = () => {} }) {
  const origin = house?.origin
  if (!inside(origin, getFeet())) return false
  const at = doorOf(origin)
  if (!at) return false
  try { await door() } catch {}
  const centre = { x: origin.x + SIZE / 2, z: origin.z + SIZE / 2 }
  const away = stand => Math.hypot(stand.x - centre.x, stand.z - centre.z)
  const stands = doorStands(getBlock, at).sort((a, b) => away(a) - away(b))
  // The refusal of the walk is kept for the log: without it the stall cannot be told apart.
  let refused = stands.length < 2 ? 'ドアの前後に立てる場所がありません' : null
  if (stands.length >= 2) for (const stand of stands) { try { if (!await walk(stand)) refused = why() ?? refused } catch (error) { refused = error?.message ?? refused } }
  if (inside(origin, getFeet()) && typeof build === 'function') {
    const outside = cell => !inside(origin, cell) && cell.y >= origin.y && cell.y <= origin.y + 2 && Math.abs(cell.x - at.x) <= 3 && Math.abs(cell.z - at.z) <= 4
    try { const went = await build({ x: at.x, y: at.y, z: origin.z + SIZE + 1 }, outside); if (!went?.ok) refused = `${refused ?? '歩けません'}、掘る・積む道 ${went?.code ?? '不明'}` } catch (error) { refused = error?.message ?? refused }
  }
  const out = !inside(origin, getFeet())
  log(out ? 'プレイヤーモード: 家のドアから外へ出ました' : `プレイヤーモード: 家のドアから外へ出られませんでした${refused ? `（${String(refused).slice(0, 120)}）` : ''}`)
  return out
}

module.exports = { leaveHouse, inside }
