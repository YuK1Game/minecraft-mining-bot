'use strict'

// Night stop during long travel (2026-11-14, coordinator relay: the user keeps
// the Realm at day only for debugging and expects the day/night cycle to run).
// Before sunset (judged only from the received world clock) the trip pauses,
// the bot digs a covered pit at its feet and waits there until morning.
// - The clock must be received from the server (sync_world_clocks / set_time);
//   an unknown clock never counts as day: the trip holds instead.
// - The pit is three cells straight down from the feet, every cell received,
//   solid and diggable; its walls and floor received solid (no cave openings,
//   no liquid); the cover is placed in the top cell against a wall face.
// It only judges and plans; mining and placing are the ordinary ones and their
// results are confirmed by received terrain.

const SHELTER_AT = 11500 // dusk; hostile mobs spawn from about 13000
const RESUME_BEFORE = 11000 // after the clock wraps to sunrise (0)

function dayPhase (clock) {
  const time = clock?.time
  if (!Number.isSafeInteger(time) || !/^server_/.test(String(clock?.source ?? ''))) return { known: false, dayTime: null, shelter: false, resume: false }
  const dayTime = ((time % 24000) + 24000) % 24000
  return { known: true, dayTime, shelter: dayTime >= SHELTER_AT, resume: dayTime < RESUME_BEFORE }
}

const AIRY = /^minecraft:(?:air|cave_air|void_air)$/
const BAD = /water|lava|fire|magma|bedrock|obsidian|chest|shulker|barrel|furnace|spawner|bed$|_bed$|door|log|leaves|wood|planks|gravel|sand$|red_sand|concrete_powder|powder_snow|cobweb|portal/
const solid = b => b?.known === true && b.boundingBox === 'block' && !BAD.test(b.name ?? '')

function planPit (getBlock, feet) {
  if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) return { ready: false, reason: 'POSITION_UNKNOWN' }
  const x = Math.floor(feet.x), z = Math.floor(feet.z), g = Math.round(feet.y)
  const at = (xx, y, zz) => getBlock(xx, y, zz)
  const dig = [g - 1, g - 2, g - 3].map(y => ({ x, y, z }))
  for (const c of dig) { const b = at(c.x, c.y, c.z); if (b?.known !== true) return { ready: false, reason: 'UNRECEIVED', cell: c }; if (!solid(b)) return { ready: false, reason: 'NOT_DIGGABLE', cell: c, name: b.name ?? null } }
  const floor = at(x, g - 4, z)
  if (!solid(floor) && !(floor?.known === true && floor.boundingBox === 'block' && /bedrock|obsidian/.test(floor.name ?? ''))) return { ready: false, reason: 'NO_FLOOR', name: floor?.name ?? null }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [g - 1, g - 2, g - 3]) {
    const w = at(x + dx, y, z + dz)
    if (w?.known !== true) return { ready: false, reason: 'UNRECEIVED', cell: { x: x + dx, y, z: z + dz } }
    if (w.boundingBox !== 'block' || /water|lava|fire|magma/.test(w.name ?? '') || AIRY.test(w.name ?? '')) return { ready: false, reason: 'OPEN_WALL', cell: { x: x + dx, y, z: z + dz }, name: w.name ?? null }
  }
  return { ready: true, dig, stand: { x: x + 0.5, y: g - 3, z: z + 0.5 }, cover: { x, y: g - 1, z } }
}

module.exports = { dayPhase, planPit, SHELTER_AT, RESUME_BEFORE }
