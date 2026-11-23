'use strict'

// To the stand outside the house's door, for a house that has stood (house-build.js: a repair, the chest check).
// The plain walk first; where it has no way, the way that digs and stacks (modes/player-build-walk.js), as the
// return and the expedition's way home already do.
//
// Real Realm 2026-11-23 20:05-20:16 JST, the starter house (origin 9877,64,10138), its repair reviewed at 20:05:32
// (6 hands left): the ground round the house had been dug away, the Bot stood in the pit south-east of the door
// (9886.4, 59.0, 10148.5), five under the floor. Four runs in ten minutes ended in
//   拠点の家の前まで歩けません（あと 8〜9m、No safe route found）
// and nothing was placed. On the blocks received at 16:20 (test/fixtures/house-moat.json) with the door down, the
// approach from that cell ends in the same line. With the door standing it walks to the pit bottom under the porch
// (9880, 61, 10146) and counts it as "at the house" (within 8 m), three under the door step; from there no walk
// reaches a stand of the house (the 19:05 JST line 「(9878, 65, 10141) へ歩けません: No safe route found」 may be
// this; where the Bot stood then was not read).
//
// → { ok, how: 'inside' | 'walk' | 'build' } or { ok: false, code, why }. Nothing is concluded about the house.
const { doorOf, doorStands } = require('./house-door')
const { inside } = require('./house-exit')

const LIMITS = { pad: 7, rise: 7, greed: 3 }

// The stands across the door: the one outside the walls and the one inside (either may be missing).
function entranceStands (getBlock, origin) {
  const at = origin && doorOf(origin)
  if (!at) return { outside: null, entry: null }
  const stands = doorStands(getBlock, at)
  return { outside: stands.find(pos => !inside(origin, pos)) ?? null, entry: stands.find(pos => inside(origin, pos)) ?? null }
}

// Standing lower than the ground a house is built on (its floor lies on the highest ground, sites differ by two).
const below = (origin, feet) => !!feet && Number.isFinite(feet.y) && feet.y < origin.y

async function toEntrance ({ origin, getBlock, getFeet, hands, build = null, aborted = () => false }) {
  const feet = getFeet()
  if (!feet) return { ok: false, code: 'NO_POSITION' }
  if (inside(origin, feet)) return { ok: true, how: 'inside' }
  const { outside, entry } = entranceStands(getBlock, origin)
  if (!outside) return { ok: false, code: 'NO_ENTRANCE_STAND', entry }
  if (await hands.walk(outside)) return { ok: true, how: 'walk', outside, entry }
  const why = hands.why?.() ?? null
  if (typeof build !== 'function' || aborted()) return { ok: false, code: 'ENTRANCE_WALK_REFUSED', why, outside, entry }
  const cell = { x: Math.floor(outside.x), y: outside.y, z: Math.floor(outside.z) }
  const out = await build(cell, { done: pos => pos.x === cell.x && pos.y === cell.y && pos.z === cell.z, aborted, limits: LIMITS })
  return out?.ok ? { ok: true, how: 'build', outside, entry } : { ok: false, code: out?.code ?? 'ENTRANCE_BUILD_FAILED', why, outside, entry }
}

module.exports = { toEntrance, entranceStands, below }
