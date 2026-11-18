'use strict'

// Player mode: a long trip does not start from a ledge no walk leads off.
// The long travel plans walks only (one block up or down). From a few cells
// with a drop all round it finds no relay, fails the same leg from the same
// feet and is started again (real Realm 2026-11-19 06:47-07:05 JST: a creeper
// blast at 01:34 had taken the ground in front of the house door; the Bot stood
// on the two cobblestones of the door step (-4898, 77, -4986) with four blocks
// of air to the south, 「歩ける中継点が見つかりません」 142 times and
// CHUNK_TRAVEL_NO_ROUTE over 400 times in 18 minutes, every food search trip and
// every trip beside a food source ended where it began; open ground at the
// same height lay six cells south).
// Before the trip starts: when the cells the Bot can walk to from its feet are
// few (LEDGE or fewer) and it stands under the open sky, it goes by the route
// that digs, stacks and bridges (modes/player-build-walk.js) to the nearest
// received ground with room to walk (ROOM cells or more), toward the
// destination first (not for a destination within 20 m). Only received terrain counts. A ledge it could not leave
// is not tried again for REST_MS while the Bot stands on the same cell.
// The same when the cells are many but the trip before this one started from
// this very cell within three minutes (it did not move the Bot; real Realm
// 07:30-07:32 JST, the same door step after a walk joined it to the ground:
// 「歩ける中継点が見つかりません」 and a cancelled leg every 26 s, walked 0.0 m).
// Then the ground is one under the open sky (not the house), AWAY cells or
// more from the Bot, toward the destination, and the trip starts from there.
const { cellKey } = require('../movement/plan-cache')

const LEDGE = 32, ROOM = 60, RANGE = 14, DOWN = 8, UP = 3, FILLS = 12, REST_MS = 60000, NEAR_M = 20, AWAY = 8, AGAIN_MS = 180000

function ground ({ start, island, walkable, toward = null, min = 2, open = () => true }) {
  const heading = toward && Number.isFinite(toward.x) && Number.isFinite(toward.z) ? Math.atan2(toward.z - start.z, toward.x - start.x) : null
  // Ground at the Bot's own height first: a bridge reaches it, a drop of several blocks is no step.
  const spots = []
  for (let dx = -RANGE; dx <= RANGE; dx++) for (let dz = -RANGE; dz <= RANGE; dz++) {
    const far = Math.hypot(dx, dz)
    if (far < min || far > RANGE) continue
    const along = heading === null ? 0 : dx * Math.cos(heading) + dz * Math.sin(heading)
    for (let dy = UP; dy >= -DOWN; dy--) spots.push({ dx, dy, dz, score: far + 1.5 * Math.abs(dy) - 0.5 * along })
  }
  spots.sort((a, b) => a.score - b.score)
  const small = new Set()
  let fills = 0
  for (const { dx, dy, dz } of spots) {
    const x = start.x + dx, y = start.y + dy, z = start.z + dz, id = cellKey(x, y, z)
    if (island.has(id) || small.has(id)) continue
    const cells = walkable({ x: x + 0.5, y, z: z + 0.5 })
    if (!cells?.size || !open({ x, y, z })) continue
    if (cells.size >= ROOM && ![...island.keys()].some(k => cells.has(k))) return { target: { x, y, z }, cells }
    for (const k of cells.keys()) small.add(k)
    if (++fills >= FILLS) return null
  }
  return null
}

function createIslandStart ({ getFeet, walkable, openSky = () => true, skyAt = () => true, build, log = () => {}, now = Date.now }) {
  let rested = null, last = null
  return async function leaveIsland (toward = null) {
    const feet = getFeet()
    if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) return null
    const start = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.001), z: Math.floor(feet.z) }
    const here = cellKey(start.x, start.y, start.z)
    // A destination this near is reached where the Bot stands.
    if (toward && Number.isFinite(toward.x) && Number.isFinite(toward.z) && Math.hypot(toward.x - feet.x, toward.z - feet.z) <= NEAR_M) return null
    // The trip before this one started from this very cell: it did not move the Bot.
    const again = last?.at === here && now() - last.time < AGAIN_MS
    last = { at: here, time: now() }
    const island = walkable({ x: feet.x, y: start.y, z: feet.z })
    if (!island?.size) return null
    const ledge = island.size <= LEDGE
    if (!ledge && !again) return null
    if (rested?.at === here && now() < rested.until) return null
    if (!openSky()) return null
    const found = ledge ? ground({ start, island, walkable, toward }) : ground({ start, island: new Map(), walkable, toward, min: AWAY, open: skyAt })
    if (!found) { rested = { at: here, until: now() + REST_MS }; log(`プレイヤーモード: ${ledge ? `歩いて出られない足場（${island.size} マス）にいますが` : '同じ場所からの長距離移動が進みませんでしたが'}、まわり ${RANGE} マスに歩ける広い地面が見つかりません`); return { ok: false, code: 'NO_GROUND' } }
    log(ledge
      ? `プレイヤーモード: 歩いて出られない足場（${island.size} マス）にいるため、長距離移動の前に、掘る・積む道で地面 (${found.target.x}, ${found.target.y}, ${found.target.z}) へ下ります`
      : `プレイヤーモード: 同じ場所からの長距離移動が進まなかったため、掘る・積む道で空の見える地面 (${found.target.x}, ${found.target.y}, ${found.target.z}) へ移ってから出発します`)
    const done = ledge
      ? cell => found.cells.has(cellKey(cell.x, cell.y, cell.z))
      : cell => cell.y === found.target.y && Math.abs(cell.x - found.target.x) <= 1 && Math.abs(cell.z - found.target.z) <= 1
    let went = null
    try { went = await build(found.target, done) } catch (error) { went = { ok: false, code: String(error?.code ?? error?.message ?? 'BUILD_FAILED').slice(0, 60) } }
    if (!went?.ok) { rested = { at: here, until: now() + REST_MS }; log(`プレイヤーモード: 足場から地面へ出られませんでした（${went?.code ?? '不明'}）`) }
    else last = null
    return went
  }
}

module.exports = { createIslandStart, ground, LEDGE, ROOM }
