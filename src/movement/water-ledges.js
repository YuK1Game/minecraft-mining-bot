'use strict'

// Ledges a swimmer can climb onto, measured from the water surface and not
// from the feet. A body that is not swimming sinks: live 2026-11-18 16:44-17:03
// JST, in a lake two blocks deep the feet stood on the bottom at y=61, the top
// water block was y=62 and the sand shore 1.7 m away was a standing cell at
// y=63. The search looked only at the feet cell's level and the one above
// (61, 62), so it said 「5マス以内に上がれる岸が見つかりません」 160 times in 19
// minutes while the long travel and the return to the base could not start.
// - The surface is the highest water cell of the swimmer's own column, at most
//   DEPTH cells above the feet (deeper water has no ledge here).
// - A ledge is a received solid floor that is not water, with two received
//   empty dry cells above it, standing at the surface level or one above (and,
//   for a body bobbing above the top water block, one above its feet cell).
const REACH = 5.5
const DEPTH = 8

const water = found => /water/.test(found?.name ?? '')

// The column whose water the body is in: its own (water at the feet or one
// below), or one its 0.6-wide body reaches into with water at the feet's
// level. A body on a dry cell at the water's edge is pulled about by the
// water beside it: the server's feet bob, no walk, landing or pillar step is
// accepted, and the own column says "dry" (live 2026-11-19 14:53-15:03 JST:
// feet (-4928.77, 61, -4967.30) on dirt, water in the columns west and north,
// isInWater true; the dig-and-stack route was planned about 60 times in ten
// minutes and no water exit ran).
const HALF = 0.3
function wetColumn (getBlock, feet) {
  if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) return null
  const x = Math.floor(feet.x), y = Math.floor(feet.y + 0.2), z = Math.floor(feet.z)
  if (water(getBlock(x, y, z))) return { x, y, z, own: true }
  if (water(getBlock(x, y - 1, z))) return { x, y: y - 1, z, own: true }
  for (const [dx, dz] of [[-HALF, 0], [HALF, 0], [0, -HALF], [0, HALF], [-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) {
    const cx = Math.floor(feet.x + dx), cz = Math.floor(feet.z + dz)
    if ((cx !== x || cz !== z) && water(getBlock(cx, y, cz))) return { x: cx, y, z: cz, own: false }
  }
  return null
}

// y of the highest water cell in the column of the water the body is in; null
// when the body is not in water or the water goes on above DEPTH cells.
function surface (getBlock, feet, depth = DEPTH) {
  const column = wetColumn(getBlock, feet)
  if (!column) return null
  let y = column.y
  for (let i = 0; i < depth; i++) { if (!water(getBlock(column.x, y + 1, column.z))) return y; y += 1 }
  return null
}

// Standing cells beside the water, nearest first.
function ledges (getBlock, feet, { reach = REACH } = {}) {
  const top = surface(getBlock, feet)
  if (top === null) return []
  const own = wetColumn(getBlock, feet).own
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.2), fz = Math.floor(feet.z)
  const span = Math.ceil(reach - 0.5), out = []
  for (let dx = -span; dx <= span; dx++) {
    for (let dz = -span; dz <= span; dz++) {
      // The own cell is a ledge only for a body that reaches into water from a dry cell.
      if ((!dx && !dz && own) || Math.hypot(dx, dz) > reach) continue
      for (let y = top; y <= Math.max(top, fy) + 1; y++) {
        const x = fx + dx, z = fz + dz
        const floor = getBlock(x, y - 1, z), body = getBlock(x, y, z), head = getBlock(x, y + 1, z)
        if (floor?.known !== true || floor.boundingBox !== 'block' || water(floor)) continue
        if ([body, head].some(cell => cell?.known !== true || cell.boundingBox !== 'empty' || water(cell) || /lava/.test(cell.name ?? ''))) continue
        out.push({ x: x + 0.5, y, z: z + 0.5 })
      }
    }
  }
  return out.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))
}

module.exports = { wetColumn, surface, ledges, REACH, DEPTH }
