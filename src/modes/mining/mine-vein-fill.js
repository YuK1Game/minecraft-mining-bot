'use strict'

const { solid } = require('./mine-observed')
const { wet } = require('./mine-common')

// A vein cell that is already occupied by a received full non-fluid block (including gravel/sand that was never
// mined or fell into the pocket) cannot be filled with cobblestone and does not leave an open pocket.
// Live 2026-11-28 16:15-16:19 JST: (9969,17,9997) was minecraft:gravel rejected by inspectDig; solid() excluded
// gravel so restoreVein called fillCell and looped on MINE_FILL_OCCUPIED for 240s.
const veinCellClosed = b => b?.known === true && b.boundingBox === 'block' && !wet(b) && !b.extra?.length

// How a vein pocket is closed. The pocket was dug from a corridor stand, one cell deeper at a time, so its far
// cells are out of view from that corridor. It is closed from its far end inward, and every fill is clicked
// from a stand inside the pocket's own received opening (or the corridor cells it was entered from), where the
// cell is in view. Live 2026-11-24 14:32-14:47 JST, plan 943e0d9a3c2d6da00803: the fill of (9878,49,10233), two
// cells into a pocket, was sent from the corridor (9879.6,47.5,10235.5) and refused
// 「操作対象への視線が遮られているか、未取得です」 for 15 minutes, until goal early.home_reserve#4 was reconsidered.

const column = p => `${Math.floor(p.x)},${Math.floor(p.z)}`
const SIDE = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Far end first: steps from the corridor stand through the pocket's columns, then the higher cell of a column.
function veinFillOrder (vein) {
  const columns = new Set([...(vein.opened ?? []), ...(vein.frontier ?? [])].map(column))
  const start = vein.returnTo ? column(vein.returnTo) : null, steps = new Map()
  if (start) {
    steps.set(start, 0)
    const queue = [start]
    for (let i = 0; i < queue.length; i++) {
      const [x, z] = queue[i].split(',').map(Number)
      for (const [dx, dz] of SIDE) {
        const next = `${x + dx},${z + dz}`
        if (columns.has(next) && !steps.has(next)) { steps.set(next, steps.get(queue[i]) + 1); queue.push(next) }
      }
    }
  }
  const far = p => steps.get(column(p)) ?? Infinity
  const anchor = vein.anchor ?? vein.returnTo
  const distance = p => anchor ? Math.hypot(p.x - anchor.x, p.z - anchor.z) : 0
  return [...(vein.opened ?? [])].sort((a, b) => far(b) - far(a) || distance(b) - distance(a) || b.y - a.y)
}

function createVeinFillStand (ctx, lighting, actions) {
  return async function approachVeinFill (request) {
    const vein = ctx.memory.early.mine.branch.vein
    const cells = new Set([...(vein?.opened ?? []), ...(vein?.frontier ?? []), vein?.returnTo].filter(Boolean).map(column))
    const y = vein?.anchor?.y
    return lighting.placementStand(request, feet => {
      if (!feet || !Number.isFinite(y) || Math.abs(feet.y - y) > 0.6) return false
      const x = Math.floor(feet.x), z = Math.floor(feet.z)
      return cells.has(`${x},${z}`) && solid(actions.block({ x, y: Math.floor(feet.y - 0.01), z }))
    })
  }
}

module.exports = { veinFillOrder, createVeinFillStand, veinCellClosed }
