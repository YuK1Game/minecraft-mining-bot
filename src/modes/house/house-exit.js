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

async function leaveHouse ({ house, getFeet, getBlock, walk, door = async () => true, log = () => {} }) {
  const origin = house?.origin
  if (!inside(origin, getFeet())) return false
  const at = doorOf(origin)
  if (!at) return false
  try { await door() } catch {}
  const centre = { x: origin.x + SIZE / 2, z: origin.z + SIZE / 2 }
  const away = stand => Math.hypot(stand.x - centre.x, stand.z - centre.z)
  const stands = doorStands(getBlock, at).sort((a, b) => away(a) - away(b))
  if (stands.length < 2) { log('プレイヤーモード: 家のドアの前後に立てる場所がないため、そのまま移動します'); return false }
  for (const stand of stands) { try { await walk(stand) } catch {} }
  const out = !inside(origin, getFeet())
  log(out ? 'プレイヤーモード: 家のドアから外へ出ました' : 'プレイヤーモード: 家のドアから外へ出られませんでした')
  return out
}

module.exports = { leaveHouse, inside }
