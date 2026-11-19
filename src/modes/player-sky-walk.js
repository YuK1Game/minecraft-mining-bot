'use strict'

// Player mode: on foot to the open sky, before and instead of digging up.
// The climb (player-climb.js) rises while solid ground lies anywhere above the
// head. Under a wide overhang that is 18 blocks of open air: it stacked its
// pillar through the air to the lip and came out on top of the overhang,
// 13 blocks above the starter house (real Realm 2026-11-18 12:06-12:39 JST:
// 87 steps up from the tunnel; from the top the trip to the base ended 123
// times with CHUNK_TRAVEL_NO_ROUTE and the walk to the house with
// 「拠点の家の前まで歩けません（あと 17m、No safe route found）」; the received
// terrain holds five such pillars from y 70 to 87 around the house). The
// ground it had dug out of was two cells from the open sky.
// - `skyWay`: the cells the Bot can stand in and walk to from its feet (one
//   block up or down a step, received terrain only), nearest first, up to the
//   first one with nothing but received open cells, a tree's crown or built
//   blocks above it. Unreceived cells right above are not the sky (player-surface.js openAbove).
// - `walkToSky`: that way walked a few cells at a time by the ordinary walk.
const { openAbove } = require('./player-surface')
const { follow } = require('./player-tunnel-exit')

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|sweet_berry/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const RANGE = 16, LIMIT = 800

const key = (x, y, z) => `${x},${y},${z}`

function skyWay ({ block, feet, range = RANGE, limit = LIMIT }) {
  if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite) || typeof block !== 'function') return { ready: false, reason: 'NO_POSITION' }
  const seen = new Map()
  const read = (x, y, z) => { const id = key(x, y, z); let found = seen.get(id); if (found === undefined) { found = block(x, y, z) ?? null; seen.set(id, found) } return found }
  const open = (x, y, z) => { const found = read(x, y, z); return found?.known === true && !found.extra?.length && !HAZARD.test(found.name ?? '') && (AIR.test(found.name ?? '') || found.boundingBox === 'empty') }
  const solid = (x, y, z) => { const found = read(x, y, z); return found?.known === true && found.boundingBox === 'block' && !AIR.test(found.name ?? '') && !HAZARD.test(found.name ?? '') }
  const stand = (x, y, z) => solid(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)
  const sky = (x, y, z) => openAbove(read, x, y, z, { roof: true })
  const origin = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.001), z: Math.floor(feet.z) }
  if (!stand(origin.x, origin.y, origin.z)) return { ready: false, reason: 'NO_STAND' }
  const parents = new Map([[key(origin.x, origin.y, origin.z), null]]), queue = [origin]
  for (let index = 0; index < queue.length && index < limit; index++) {
    const from = queue[index]
    if (sky(from.x, from.y, from.z)) {
      const path = []
      for (let cell = from; cell; cell = parents.get(key(cell.x, cell.y, cell.z))) path.push(cell)
      return { ready: true, path: path.reverse(), cells: queue.length }
    }
    for (const [dx, dz] of SIDES) {
      const x = from.x + dx, z = from.z + dz
      if (Math.abs(x - origin.x) > range || Math.abs(z - origin.z) > range) continue
      for (const dy of [0, 1, -1]) {
        const y = from.y + dy, id = key(x, y, z)
        if (parents.has(id) || !stand(x, y, z)) continue
        // A step up needs room above the head here; a step down needs the body to pass over the edge.
        if (dy === 1 && !open(from.x, from.y + 2, from.z)) continue
        if (dy < 0 && ![0, 1].every(up => open(x, from.y + up, z))) continue
        const cell = { x, y, z }
        parents.set(id, from); queue.push(cell)
        break
      }
    }
  }
  return { ready: false, reason: 'NO_SKY_ON_FOOT', cells: queue.length }
}

// ports: the scaffold's hands (player-scaffold-ports.js).
async function walkToSky ({ ports, log = () => {}, aborted = () => false }) {
  const plan = skyWay({ block: ports.block, feet: ports.feet() })
  if (!plan.ready) return { ok: false, reason: plan.reason }
  const last = plan.path.length - 1
  if (!last) return { ok: true, walked: 0 }
  const end = plan.path[last]
  log(`プレイヤーモード: 空の見える場所へ歩いて出ます（${last}マス、${end.x},${end.y},${end.z}）`)
  const walked = await follow({ ports, path: plan.path, aborted })
  if (walked.index === last) return { ok: true, walked: last }
  if (aborted()) return { ok: false, reason: 'INTERRUPTED', walked: walked.index }
  log(`プレイヤーモード: 空の見える場所へ歩く途中で止まりました（${walked.index}/${last}マス${ports.why?.() ? `、${ports.why()}` : ''}）`)
  return { ok: false, reason: 'WALK_FAILED', walked: walked.index }
}

module.exports = { skyWay, walkToSky }
