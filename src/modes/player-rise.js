'use strict'

// Player mode: from under ground to the open sky, the cheapest way first
// (shared by the recovery, the trip to the base and the search for food).
// 1. the tunnel it dug itself, on foot (player-tunnel-exit.js);
// 2. a walk to the open sky where one exists: under an overhang, at a cave's
//    mouth (player-sky-walk.js);
// 3. straight up by mining and the pillar step (player-climb.js), moving
//    sideways under water, gravel or leaves (player-climb-side.js). That climb
//    ends where it has come out of the ground and a walk leads to the sky;
//    the walk is taken then. Only when that walk fails does the climb go on
//    to the ground overhead, as it did before.
// 4. a stair mined to the nearest ground under the open sky, when the climb
//    ended for a reason of its own (nothing to stack, no pillar step, rock it
//    may not mine): player-stair-out.js, the shared way that digs and stacks.
const { walkOut } = require('./player-tunnel-exit')
const { skyWay, walkToSky } = require('./player-sky-walk')
const { climbOut } = require('./player-climb')
const { sidestep } = require('./player-climb-side')
const { stairOut } = require('./player-stair-out')

// ports: the scaffold's hands. `sky()`: whether the Bot stands under the open sky now.
// `build`: the way that digs and stacks (player-build-walk.js), for the stair.
async function riseToSky ({ ports, floors = [], log = () => {}, aborted = () => false, sky = () => false, sleep, build = null }) {
  const walked = await walkOut({ ports, floors, log, aborted, open: sky })
  if (walked.ok && sky()) return { ok: true, steps: 0, walked: walked.walked }
  const onFoot = () => walkToSky({ ports, log, aborted }), wayOut = () => skyWay({ block: ports.block, feet: ports.feet() }).ready
  if (!aborted()) { const foot = await onFoot(); if (foot.ok && sky()) return { ok: true, steps: 0, walked: foot.walked } }
  if (aborted()) return { ok: false, reason: 'INTERRUPTED' }
  const climb = extra => climbOut({ ports, log, aborted, ...(sleep ? { sleep } : {}), ...extra })
  let out = await climb({ wayOut })
  for (let i = 0; i < 3 && !out.ok && (out.reason === 'CANNOT_MINE' || out.reason === 'LEAVES_ABOVE') && !aborted(); i++) {
    if (!(await sidestep({ ports, log, aborted })).ok) break
    out = await climb({ wayOut })
  }
  if (out.ok && out.walkable && !(await onFoot()).ok && !aborted()) out = await climb({})
  if (!out.ok && build && !aborted() && !sky() && !/INTERRUPTED|NOT_UNDER_COVER/.test(out.reason ?? '')) {
    const stair = await stairOut({ ports, build, log, aborted })
    if (stair.ok) return { ...stair, steps: out.steps ?? 0, walked: stair.steps }
  }
  return out
}

module.exports = { riseToSky }
