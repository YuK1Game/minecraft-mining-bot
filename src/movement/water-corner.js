'use strict'

// Water exit around a corner: first beside the ledge, then onto it.
// Live 2026-11-19 09:22-09:25 JST: the Bot floated at the west edge of a pond
// two blocks deep, pressed against a bank two blocks above the surface. The
// ledges it could stand on (2.4 m and 3.1 m away) lay along the same bank, to
// the side. The exit tape holds one fixed heading from the start to the ledge:
// the body slid along the bank, bobbed past the opening and never stood on the
// chosen cell, so 「水から上がれません（Water exit tape did not stand on the ledge
// within its tick bound）」 came 37 times in 72 s (every ledge, every 2 s) and
// the long travel did not start.
// - sides(): the water cells straight beside the ledge (the four neighbours at
//   the surface level, received water with a received empty cell above),
//   nearest to the swimmer first.
// - aim(): a rule without memory, so the stepper follows it again after a
//   server correction: while the body is off the line that runs through the
//   side cell into the ledge by more than ALIGNED, it heads for the centre of
//   the side cell; on the line it heads for the ledge.
const ALIGNED = 0.2
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const { water } = require('./wet-cell')

function sides (physics, cell, top, feet) {
  const out = []
  for (const [dx, dz] of SIDES) {
    try {
      const at = { x: cell.x + dx, y: top, z: cell.z + dz }
      const body = physics.blockAt(at), above = physics.blockAt({ ...at, y: top + 1 })
      if (!body || body.known === false || !water(body)) continue
      if (!above || above.known === false || (Array.isArray(above.shapes) && above.shapes.length) || water(above) || /lava/.test(above.name ?? '')) continue
      out.push({ x: at.x + 0.5, z: at.z + 0.5, dx: -dx || 0, dz: -dz || 0 })
    } catch { /* A cell that cannot be read is not a side. */ }
  }
  return out.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))
}

// Yaw for the next tick: via is { x, z, dx, dz } (the side cell's centre and the unit step from it into the ledge).
function aim (position, via, ledge) {
  const off = via.dx ? position.z - via.z : position.x - via.x
  const to = Math.abs(off) <= ALIGNED ? ledge : via
  return Math.atan2(-(to.x - position.x), to.z - position.z) * 180 / Math.PI
}

module.exports = { sides, aim, ALIGNED }
