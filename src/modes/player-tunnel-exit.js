'use strict'

// Player mode: out through the tunnel the Bot dug itself. Every floor of a
// tunnel is recorded as a "way back" floor (shared.tunnelFloors) and kept from
// being mined, so a stair it walked down is a stair it can walk up. Neither
// walk plans it: the short walk sees 12-16 blocks, the long trip only ground
// under the open sky (user, 2026-11-16 20:01 JST: 「自分の掘った穴があるのに
// そこ経由ででられなかった理由が知りたい」). Before digging straight up, the
// recorded floors are followed.
// - A floor counts when it is received solid ground with two received clear
//   cells over it. Floors connect to the four neighbours one step up, level
//   or one step down.
// - From the floor under the feet (or one beside it) the way goes to the
//   highest connected floor; it is taken when that is at least four blocks up.
// - It is walked a few floors at a time by the ordinary walk. A stretch that
//   fails is tried one floor at a time; where even that fails, the walk ends
//   and says where and why.
const AIR = /^minecraft:(?:air|cave_air|void_air|torch|short_grass|fern|leaf_litter)$/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const MIN_RISE = 4, STRIDE = 5, LIMIT = 1024

const key = (x, y, z) => `${x},${y},${z}`
const clear = found => found?.known === true && !found.extra?.length && AIR.test(found.name ?? '') && found.boundingBox !== 'block'
const ground = found => found?.known === true && found.boundingBox === 'block' && !found.extra?.length && !/water|lava/.test(found.name ?? '')

// The recorded floors of this world: [{x, y, z}] (the floor block itself).
function recordedFloors (shared, state) {
  const scope = JSON.stringify([state?.profile ?? null, state?.realm?.id == null ? null : String(state.realm.id), state?.dimension ?? null])
  const floors = shared?.tunnelFloors?.scopes?.[scope]?.floors
  return Array.isArray(floors) ? floors.filter(point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))).slice(0, LIMIT) : []
}

// The stands (feet positions) from the Bot up to the highest connected floor.
function wayUp ({ floors, block, feet }) {
  if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) return { ready: false, reason: 'NO_POSITION' }
  if (!floors.length) return { ready: false, reason: 'NO_FLOORS' }
  const nodes = new Map()
  for (const point of floors) if (ground(block(point.x, point.y, point.z)) && clear(block(point.x, point.y + 1, point.z)) && clear(block(point.x, point.y + 2, point.z))) nodes.set(key(point.x, point.y, point.z), point)
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001) - 1, fz = Math.floor(feet.z)
  let origin = nodes.get(key(fx, fy, fz)) ?? null
  for (const [dx, dz] of SIDES) for (const dy of [0, 1, -1]) origin ??= nodes.get(key(fx + dx, fy + dy, fz + dz)) ?? null
  if (!origin) return { ready: false, reason: 'NOT_ON_A_RECORDED_FLOOR', usable: nodes.size }
  const start = key(origin.x, origin.y, origin.z), parents = new Map([[start, null]]), queue = [start]
  let top = start
  for (let index = 0; index < queue.length; index++) {
    const point = nodes.get(queue[index])
    if (point.y > nodes.get(top).y) top = queue[index]
    for (const [dx, dz] of SIDES) for (const dy of [1, 0, -1]) {
      const next = key(point.x + dx, point.y + dy, point.z + dz)
      if (nodes.has(next) && !parents.has(next)) { parents.set(next, queue[index]); queue.push(next) }
    }
  }
  const rise = nodes.get(top).y - origin.y
  if (rise < MIN_RISE) return { ready: false, reason: 'NO_WAY_UP_RECORDED', rise, connected: queue.length, usable: nodes.size }
  const path = []
  for (let id = top; id !== null; id = parents.get(id)) { const point = nodes.get(id); path.push({ x: point.x, y: point.y + 1, z: point.z }) }
  path.reverse()
  return { ready: true, path, rise, connected: queue.length }
}

// A way of stands (feet cells, each one step from the one before) walked a few
// at a time by the ordinary walk. A stretch that fails is tried one cell at a
// time. Returns how far it came and, where even one cell failed, that cell.
async function follow ({ ports, path, aborted = () => false, done = () => false, stride = STRIDE }) {
  const { feet, walk } = ports
  const at = () => { const now = feet(); return now ? { x: Math.floor(now.x), y: Math.floor(now.y + 0.001), z: Math.floor(now.z) } : null }
  const on = point => { const now = at(); return !!now && now.x === point.x && now.z === point.z && now.y === point.y }
  const go = async point => { await walk({ x: point.x + 0.5, y: point.y, z: point.z + 0.5 }); return on(point) }
  let index = 0
  while (index < path.length - 1 && !aborted()) {
    if (done()) break
    const far = Math.min(index + stride, path.length - 1)
    if (await go(path[far])) { index = far; continue }
    if (aborted()) break
    // The stretch failed: the cell it is standing on now, then one cell further.
    const now = at(), here = now ? path.findIndex((point, i) => i >= index && i <= far && point.x === now.x && point.y === now.y && point.z === now.z) : -1
    if (here > index) { index = here; continue }
    if (await go(path[index + 1])) { index++; continue }
    return { index, stuck: path[index + 1] }
  }
  return { index, stuck: null }
}

async function walkOut ({ ports, floors, log = () => {}, aborted = () => false, open = () => false }) {
  const { feet, block } = ports
  const plan = wayUp({ floors, block, feet: feet() })
  if (!plan.ready) { log(`プレイヤーモード: 掘った坑道を歩いて戻る道がありません（${plan.reason}${plan.rise != null ? `、上へ${plan.rise}段` : ''}、記録した床 ${floors.length}・使える床 ${plan.usable ?? '-'}・つながる床 ${plan.connected ?? '-'}）`); return { ok: false, reason: plan.reason } }
  log(`プレイヤーモード: 掘った坑道を歩いて戻ります（${plan.path.length - 1}マス、上へ${plan.rise}段）`)
  const at = () => { const now = feet(); return now ? { x: Math.floor(now.x), y: Math.floor(now.y + 0.001), z: Math.floor(now.z) } : null }
  const startY = at()?.y ?? plan.path[0].y
  // Under the open sky the tunnel has done its work.
  const { index, stuck } = await follow({ ports, path: plan.path, aborted, done: open })
  if (stuck) {
    log(`プレイヤーモード: 坑道を戻る途中で歩けなくなりました（${index}/${plan.path.length - 1}マス、次の床 ${stuck.x},${stuck.y - 1},${stuck.z}${ports.why?.() ? `、${ports.why()}` : ''}）`)
    return { ok: false, reason: 'WALK_FAILED', walked: index, rose: (at()?.y ?? startY) - startY }
  }
  if (aborted()) return { ok: false, reason: 'INTERRUPTED', walked: index }
  const rose = (at()?.y ?? startY) - startY
  log(`プレイヤーモード: 坑道を${index}マス戻りました（上へ${rose}段）`)
  return { ok: true, walked: index, rose }
}

module.exports = { walkOut, wayUp, recordedFloors, follow }
