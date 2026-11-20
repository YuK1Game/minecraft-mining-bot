'use strict'

// A route over received terrain that may dig and stack, for a place no walk
// leads to (user 2026-11-18: 「移動場所ルートが見つからないときは、『ブロックを
// 積み上げて移動できるか』『掘って移動できるか』も計算してください」).
// It only plans; modes/player-build-walk.js carries the plan out one step at
// a time and confirms each step by received data.
// Moves, from a cell the Bot stands in (its feet cell):
// - walk: to the cell beside it, level, one up or one down. Blocks in the
//   way of the body are mined first (a step carved into a slope, a notch
//   through a wall), each only when it is received, plain to mine, and has no
//   liquid, falling block or unreceived cell touching it.
// - shaft: the block under the feet is mined and the Bot stands one lower.
//   Only blocks the Bot stacks itself (dirt, grass block, cobblestone, cobbled
//   deepslate) with a received solid block right under them: the way down a
//   pillar it stacked (user 2026-11-18: 「積み上げて登ってきたブロックの箇所を
//   掘っていけばいいのでは？」).
// - stack: one pillar step up on the spot, from the blocks it carries.
// - bridge: level over a gap, one carried block placed as the floor of the cell
//   beside the feet first (against the block under the feet, or a block beside
//   the gap; the walk carries it out and confirms the received block). Only
//   over received air with nothing unreceived and no lava touching it (real
//   Realm 2026-11-18 20:42 JST: on the same layer, four cells of air lay between
//   the Bot and the pillar it had stacked; every cell round was received).
//   Off unless asked for (`allowBridge`): the walk asks only after a plan
//   without it found no way, so the wider search never costs a way that exists.
// - drop: off an edge onto a received floor two or three lower in the cell beside
//   the feet (no fall damage up to three), every cell the body falls through
//   received and open; nothing is mined. The walk carries it out with the
//   navigation's predicted controlled drop. Off unless asked for (`allowDrop`),
//   like the bridge (real Realm 2026-11-19 12:05-12:07 JST: respawned with empty
//   hands on the two-block entrance step of the house, the ground three lower;
//   no block to bridge with, the search ended after 21 cells, six times).
//   With `maxFall` over three (up to MAX_FALL) the drop may be deeper and costs
//   health (one point a block beyond three), as a player jumps down a ledge
//   when nothing else leads off it; the walk gives the limit from the health
//   it holds, and such a drop is dear (HURT a point), so any way without it is
//   taken first (real Realm 2026-11-19 17:19-17:37 JST: respawned with empty
//   hands in the house; the door step, three cobblestones in the air, stood
//   four and five blocks over the ground; NO_BUILD_ROUTE sixty times in
//   fourteen minutes, and nothing else leads out of the house).
// Never: an unreceived cell, liquid, leaves, logs, a container, a bed, a
// door, a block a base protects (`natural: false`), a drop of more than one.
// The search is bounded (a box round the start and the target, a node limit
// and a time limit) and says why it ended: it does not go on looking.
// `greed` (1 by default) multiplies the guide toward the target. The guide counts steps; through rock a step costs
// about eleven, so a short route through rock is found only after the whole box round it. A caller that digs
// toward a near cell gives a greed near that cost: the route is found in a fraction of the cells, every step of it
// checked as before; it may cost more than the cheapest one.
// Real Realm 2026-11-18 12:40 and 15:30 JST: on a thin layer of grass 18
// blocks over the ground west of the house, 12-17 m from the base chest and
// 14 blocks over it, every walk and every trip ended with no route, while
// the cobblestone pillar the Bot had stacked up to that layer (-4905, 66..88,
// -4996) stood four cells away.
const { classify } = require('../travel/coarse-route')
const { low } = require('../modes/low-block')

const FIXED = /bedrock|obsidian|barrier|command|structure|reinforced|portal|spawner|chest|shulker|barrel|furnace|crafting_table|bed$|_bed$|door|log$|_log|_stem|leaves|wood$|planks|torch|glass|wool|slab|stairs|fence|sign|ladder/
const SOFT = /dirt|grass_block|gravel|sand|clay|snow|mud|podzol|mycelium|farmland/
const FALLING = /gravel|(?:^|:|_)sand$|concrete_powder|anvil/
const OWN = /^minecraft:(?:dirt|grass_block|cobblestone|cobbled_deepslate)$/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const AROUND = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const COST = { walk: 1, step: 1.5, soft: 2, hard: 5, shaft: 3, stack: 5, bridge: 6, drop: 4 }
const SAFE_FALL = 3, MAX_FALL = 6, HURT = 8
const AIR = /^minecraft:(?:air|cave_air|void_air)$/

const keyOf = (x, y, z) => `${x},${y},${z}`

function * search ({ getBlock, start, done, target, blocks = 0, allowShaft = true, allowBridge = false, allowDrop = false, maxFall = SAFE_FALL, refused = null, barred = null, pad = 12, rise = 8, maxNodes = 12000, maxMs = 1500, greed = 1, now = Date.now }) {
  const lo = { x: Math.min(start.x, target.x) - pad, y: Math.min(start.y, target.y) - rise, z: Math.min(start.z, target.z) - pad }
  const hi = { x: Math.max(start.x, target.x) + pad, y: Math.max(start.y, target.y) + rise, z: Math.max(start.z, target.z) + pad }
  const inside = (x, y, z) => x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y && z >= lo.z && z <= hi.z
  const deepest = Math.min(MAX_FALL, Math.max(SAFE_FALL, Math.floor(Number(maxFall) || SAFE_FALL)))
  const seen = new Map()
  const at = (x, y, z) => {
    const k = keyOf(x, y, z)
    let cell = seen.get(k)
    if (!cell) {
      const found = getBlock(x, y, z), kind = classify(found), name = found?.name ?? ''
      cell = { kind, name, open: kind === 'pass', floor: kind === 'solid' && !low(found), leaf: kind === 'leaves' && found.boundingBox === 'block', rock: kind === 'solid' && !low(found) && found.natural !== false && !FIXED.test(name) && !found.extra?.length }
      seen.set(k, cell)
    }
    return cell
  }
  // A floor to step onto from (x, y, z). Leaves are a floor only for a body that stands on leaves already: the way
  // off a canopy is over its leaves and off their edge, and no route climbs onto one (leaves are never dug or passed).
  const floorFrom = (x, y, z, fx, fy, fz) => { const cell = at(fx, fy, fz); return cell.floor || cell.leaf && at(x, y - 1, z).leaf }
  // A block the ordinary mining takes: nothing flows or falls into the hole.
  const minable = (x, y, z) => {
    if (!at(x, y, z).rock || refused?.has(keyOf(x, y, z))) return false
    if (FALLING.test(at(x, y + 1, z).name)) return false
    return AROUND.every(([dx, dy, dz]) => { const near = at(x + dx, y + dy, z + dz); return near.kind !== 'unknown' && near.kind !== 'water' && near.kind !== 'hazard' }) && at(x, y - 1, z).kind !== 'unknown'
  }
  // A cell a floor block may be placed into: received air, nothing unreceived and no lava beside or under it.
  const gap = (x, y, z) => AIR.test(at(x, y, z).name) && [...SIDES.map(([dx, dz]) => [dx, 0, dz]), [0, -1, 0]].every(([dx, dy, dz]) => { const near = at(x + dx, y + dy, z + dz); return near.kind !== 'unknown' && near.kind !== 'hazard' })
  // The cells the body passes: each open or minable. Returns the ones to mine, or null.
  const through = cells => {
    const dig = []
    for (const [x, y, z] of cells) {
      const cell = at(x, y, z)
      if (cell.open) continue
      if (!minable(x, y, z)) return null
      dig.push({ x, y, z, name: cell.name })
    }
    return dig
  }
  const digCost = dig => dig.reduce((sum, cell) => sum + (SOFT.test(cell.name) ? COST.soft : COST.hard), 0)
  const lean = Math.max(1, Number(greed) || 1)
  const h = (x, y, z) => lean * Math.max(Math.abs(target.x - x) + Math.abs(target.z - z), Math.abs(target.y - y))

  const open = [], best = new Map(), from = new Map()
  let order = 0
  const push = node => { node.order = order++; open.push(node); let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p].f < open[i].f || open[p].f === open[i].f && open[p].order < open[i].order) break; [open[p], open[i]] = [open[i], open[p]]; i = p } }
  const pop = () => {
    const top = open[0], last = open.pop()
    if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; const less = (a, b) => open[a].f < open[b].f || open[a].f === open[b].f && open[a].order < open[b].order; if (l < open.length && less(l, m)) m = l; if (r < open.length && less(r, m)) m = r; if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m } }
    return top
  }
  const offer = (node, x, y, z, cost, step, used = node.used) => {
    if (!inside(x, y, z) || barred?.has(`${keyOf(node.x, node.y, node.z)}>${keyOf(x, y, z)}`)) return
    const k = keyOf(x, y, z), g = node.g + cost
    if (g >= (best.get(k) ?? Infinity)) return
    best.set(k, g)
    from.set(k, { prev: keyOf(node.x, node.y, node.z), step: { ...step, to: { x, y, z } } })
    push({ x, y, z, g, f: g + h(x, y, z), used })
  }

  const deadline = now() + maxMs
  let expanded = 0, end = null, code = 'NO_BUILD_ROUTE'
  push({ x: start.x, y: start.y, z: start.z, g: 0, f: h(start.x, start.y, start.z), used: 0 })
  best.set(keyOf(start.x, start.y, start.z), 0)
  while (open.length) {
    if (expanded >= maxNodes) { code = 'BUILD_ROUTE_SEARCH_LIMIT'; break }
    if ((expanded & 127) === 0) { if (now() > deadline) { code = 'BUILD_ROUTE_SEARCH_LIMIT'; break } yield expanded }
    const node = pop(); expanded++
    if (node.g > (best.get(keyOf(node.x, node.y, node.z)) ?? Infinity)) continue
    if (done(node)) { end = node; break }
    const { x, y, z } = node
    for (const [dx, dz] of SIDES) {
      const nx = x + dx, nz = z + dz
      // Level: a floor there, the two body cells open or mined.
      if (floorFrom(x, y, z, nx, y - 1, nz)) {
        const dig = through([[nx, y + 1, nz], [nx, y, nz]])
        if (dig) offer(node, nx, y, nz, COST.walk + digCost(dig), { kind: 'walk', dig })
      } else if (allowBridge && node.used < blocks && gap(nx, y - 1, nz)) {
        // Level over a gap: a carried block becomes the floor there first.
        const dig = through([[nx, y + 1, nz], [nx, y, nz]])
        if (dig) offer(node, nx, y, nz, COST.bridge + digCost(dig), { kind: 'bridge', dig, place: { x: nx, y: y - 1, z: nz } }, node.used + 1)
      }
      // One up: the block beside the feet is the floor; the room over the own head and over that floor.
      if (floorFrom(x, y, z, nx, y, nz)) {
        const dig = through([[x, y + 2, z], [nx, y + 2, nz], [nx, y + 1, nz]])
        if (dig) offer(node, nx, y + 1, nz, COST.step + digCost(dig), { kind: 'walk', dig })
      }
      // One down: a floor one lower; the three cells the body passes.
      if (floorFrom(x, y, z, nx, y - 2, nz)) {
        const dig = through([[nx, y + 1, nz], [nx, y, nz], [nx, y - 1, nz]])
        if (dig) offer(node, nx, y - 1, nz, COST.step + digCost(dig), { kind: 'walk', dig })
      }
      // Off the edge: two or three down (deeper at the cost of health) onto a received floor, through open cells only.
      if (allowDrop && at(nx, y + 1, nz).open && at(nx, y, nz).open && at(nx, y - 1, nz).open) {
        for (let d = 2; d <= deepest; d++) {
          if (!at(nx, y - d, nz).open) break
          if (floorFrom(x, y, z, nx, y - d - 1, nz)) { offer(node, nx, y - d, nz, COST.drop + HURT * Math.max(0, d - SAFE_FALL), { kind: 'drop', dig: [], fall: d }); break }
        }
      }
    }
    // Down the own pillar: the block under the feet, a received solid block under it.
    if (allowShaft && OWN.test(at(x, y - 1, z).name) && minable(x, y - 1, z) && at(x, y - 2, z).floor && SIDES.every(([dx, dz]) => !['water', 'hazard', 'unknown'].includes(at(x + dx, y, z + dz).kind))) offer(node, x, y - 1, z, COST.shaft, { kind: 'shaft', dig: [] })
    // One pillar step up, from the blocks carried.
    if (node.used < blocks) {
      const dig = through([[x, y + 2, z]])
      if (dig) offer(node, x, y + 1, z, COST.stack + digCost(dig), { kind: 'stack', dig }, node.used + 1)
    }
  }
  if (!end) return { ok: false, code, expanded, steps: [] }
  const steps = []
  for (let k = keyOf(end.x, end.y, end.z); from.has(k); k = from.get(k).prev) steps.push(from.get(k).step)
  steps.reverse()
  const count = kind => steps.filter(step => step.kind === kind).length
  return { ok: true, code: 'BUILD_ROUTE', expanded, steps, cost: end.g, dig: steps.reduce((sum, step) => sum + step.dig.length, 0), shaft: count('shaft'), stack: count('stack'), bridge: count('bridge'), drop: count('drop'), hurt: steps.reduce((sum, step) => sum + (step.kind === 'drop' ? Math.max(0, step.fall - SAFE_FALL) : 0), 0) }
}

function planBuildRoute (options) {
  const it = search(options)
  for (;;) { const r = it.next(); if (r.done) return r.value }
}
// The same search, giving the event loop its turn every sliceMs.
async function planBuildRouteAsync (options = {}) {
  const sliceMs = options.sliceMs ?? 25, now = options.now ?? Date.now
  const it = search(options)
  let slice = now()
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    if (now() - slice >= sliceMs) { await new Promise(resolve => setImmediate(resolve)); slice = now() }
  }
}

module.exports = { planBuildRoute, planBuildRouteAsync, keyOf, SAFE_FALL, MAX_FALL }
