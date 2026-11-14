'use strict'

// Coarse wide-area route over received terrain (2026-11-14, long travel
// stage 1+: local 16-48 m searches kept failing in the hilly spawn area).
// Columns are searched with A* on standing heights: walkable surface (solid
// received floor, two received passable cells), a water surface (swim, higher
// cost), one-block steps up and drops of up to three. Unreceived terrain is
// never passable; when the goal cannot be reached the best partial path toward
// it (closest reached column) is returned with the unknown frontier, so the
// caller can request terrain there. It only plans; it never moves.

const PASS = /^minecraft:(?:air|cave_air|void_air|short_grass|tall_grass|grass|fern|large_fern|dead_bush|deadbush|dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|snow_layer|wildflowers|leaf_litter|short_dry_grass|tall_dry_grass|bush|firefly_bush)$/
const WATER = /^minecraft:(?:flowing_)?water$/
const HAZARD = /lava|fire|magma|cactus|campfire|powder_snow|cobweb|wither_rose|dripstone|sweet_berry/

function classify (b) {
  if (!b || b.known !== true) return 'unknown'
  const name = b.name ?? ''
  if (WATER.test(name)) return 'water'
  if (HAZARD.test(name)) return 'hazard'
  // Live 2026-11-14 13:47: the route crossed a tree canopy on its leaves and the
  // bot was stranded up there. Leaves are neither a floor nor passable.
  if (/leaves/.test(name)) return 'leaves'
  if (PASS.test(name) || b.boundingBox === 'empty') return 'pass'
  return b.boundingBox === 'block' ? 'solid' : 'other'
}

function createSurface (getBlock, { minY = -60, maxY = 300, leafFloor = false } = {}) {
  const cache = new Map()
  // Standing heights of a column inside [lo, hi]: feet y with a solid (or water
  // surface) below and two passable received cells. 'unknown' when any scanned
  // cell is unreceived.
  function stands (x, z, lo, hi) {
    const key = `${x},${z},${lo},${hi}`
    if (cache.has(key)) return cache.get(key)
    const out = []
    let unknown = false
    let above2 = classify(getBlock(x, hi + 2, z)), above1 = classify(getBlock(x, hi + 1, z))
    for (let y = hi; y >= lo; y--) {
      const here = classify(getBlock(x, y, z)), below = classify(getBlock(x, y - 1, z))
      if ([above1, here, below].includes('unknown')) unknown = true
      if (here === 'pass' && above1 === 'pass' && (below === 'solid' || below === 'water' || leafFloor && below === 'leaves')) out.push({ y, water: below === 'water', leaves: below === 'leaves' })
      above2 = above1; above1 = here
    }
    const value = { stands: out, unknown }
    cache.set(key, value)
    return value
  }
  return { stands, clear: () => cache.clear() }
}

// Blocks that ordinary bare-hand or tool mining may carve for a step.
const NOT_DIGGABLE = /bedrock|obsidian|barrier|command|structure|reinforced|end_portal|spawner|chest|shulker|barrel|furnace|bed$|_bed$|door|log|leaves|wood|planks/
const SOFT = /dirt|grass_block|gravel|sand|clay|snow|mud|podzol|mycelium|farmland/
function createHeap () {
  const a = []; let seq = 0
  const less = (i, j) => a[i].f < a[j].f || a[i].f === a[j].f && a[i].seq < a[j].seq
  const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t }
  return {
    get length () { return a.length },
    push (v) { v.seq = seq++; a.push(v); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(i, p)) break; swap(i, p); i = p } },
    pop () {
      const top = a[0], last = a.pop()
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && less(l, m)) m = l; if (r < a.length && less(r, m)) m = r; if (m === i) break; swap(i, m); i = m } }
      return top
    }
  }
}
function planCoarseRoute ({ getBlock, start, goal, maxNodes = 60000, maxRadius = 320, arriveM = 6, window = 12, allowDig = false, maxDrop = 3, blocked = null, surfaceOnly = false, maxMs = Infinity, now = Date.now }) {
  // Live 2026-11-14 12:13: the route led down into a cave to y-33. With
  // surfaceOnly a stand must see the sky (nothing solid above but leaves/logs
  // within 40 blocks); covered stands cost five times and may only be entered
  // upward or level, so an underground start climbs back out; the goal counts
  // only on a sky-open stand.
  const skyCache = new Map()
  const sky = (x, y, z) => { const k = `${x},${y},${z}`; if (skyCache.has(k)) return skyCache.get(k); let open = true; for (let yy = y + 2; yy < 320; yy++) { const b = getBlock(x, yy, z); if (!b || b.known !== true) { if (yy >= 128) break; open = false; break } if (b.boundingBox === 'block' && !/leaves|log|wood/.test(b.name ?? '')) { open = false; break } } skyCache.set(k, open); return open }
  const surface = createSurface(getBlock)
  // A bot already on a canopy may keep walking on leaves until it can get down;
  // a route on the ground never climbs onto leaves.
  const leafSurface = createSurface(getBlock, { leafFloor: true })
  const onLeaves = n => classify(getBlock(n.x, n.y - 1, n.z)) === 'leaves'
  // A carved step may also be cut into the face of a wall (2026-11-14, a ravine):
  // the cell beside its head, perpendicular to the move, is open with the sky
  // above it. A notch through a wall (both sides closed) never qualifies.
  // The side the step comes from also counts (a notch one block deep into a face).
  const openFace = (x, headY, z, dx, dz) => [[dz, dx], [-dz, -dx], [-dx, -dz]].some(([ox, oz]) => classify(getBlock(x + ox, headY, z + oz)) === 'pass' && sky(x + ox, headY - 2, z + oz))
  const sx = Math.floor(start.x), sz = Math.floor(start.z), sy = Math.round(start.y)
  const gx = Math.floor(goal.x), gz = Math.floor(goal.z)
  const h = (x, z) => Math.hypot(gx - x, gz - z)
  const key = (x, y, z) => `${x},${y},${z}`
  // Binary heap on f, ties by insertion order (live 14:42: the linear scan made
  // large searches quadratic).
  const open = createHeap()
  open.push({ x: sx, y: sy, z: sz, g: 0, f: h(sx, sz) })
  const best = new Map([[key(sx, sy, sz), 0]])
  const parent = new Map(), digOf = new Map()
  const frontier = new Set()
  let closest = { x: sx, y: sy, z: sz, d: h(sx, sz) }, expanded = 0, reached = false, surfaced = false
  // Underground start (live 12:13, cave at y-33): the nearest open-sky stand is
  // the first goal; the trip continues from there.
  const startCovered = surfaceOnly && !sky(sx, sy, sz)
  const pop = () => open.pop()
  // Live 2026-11-14 14:42: an 18.6 s search stalled the event loop and the
  // server closed the connection. The search stops at its time budget and the
  // best partial route is used.
  const deadline = now() + maxMs
  let timedOut = false
  while (open.length && expanded < maxNodes) {
    if ((expanded & 255) === 0 && now() > deadline) { timedOut = true; break }
    const n = pop(); expanded++
    const d = h(n.x, n.z)
    if (d < closest.d && (!surfaceOnly || !startCovered && sky(n.x, n.y, n.z) || startCovered)) closest = { x: n.x, y: n.y, z: n.z, d }
    if (startCovered && expanded > 1 && sky(n.x, n.y, n.z)) { closest = { x: n.x, y: n.y, z: n.z, d }; surfaced = true; break }
    if (d <= arriveM && (!surfaceOnly || sky(n.x, n.y, n.z))) { closest = { x: n.x, y: n.y, z: n.z, d }; reached = true; break }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = n.x + dx, z = n.z + dz
      if (Math.hypot(x - sx, z - sz) > maxRadius) continue
      // Columns the local walk already failed to reach (2026-11-14) are avoided.
      if (blocked?.has?.(`${x},${z}`)) continue
      const col = (onLeaves(n) ? leafSurface : surface).stands(x, z, n.y - (onLeaves(n) ? Math.max(maxDrop, 4) : 3), n.y + 1)
      if (col.unknown && !col.stands.length) { frontier.add(`${x},${z}`); continue }
      // A step carved up a wall (2026-11-14): straight moves only, one block up,
      // the two cells of the new step solid and diggable, its floor received
      // solid, the cell above it open (never a tunnel), and the own head cell
      // open or diggable. Mining cost grows with hardness.
      if (allowDig && !col.stands.length && !(dx && dz)) {
        const b = (yy, xx = x, zz = z) => getBlock(xx, yy, zz)
        const floor = b(n.y), c1 = b(n.y + 1), c2 = b(n.y + 2), sky = b(n.y + 3), head = b(n.y + 2, n.x, n.z)
        const solid = v => v?.known === true && v.boundingBox === 'block' && !NOT_DIGGABLE.test(v.name ?? '') && !HAZARD.test(v.name ?? '') && !WATER.test(v.name ?? '')
        const isOpen = v => classify(v) === 'pass'
        if (solid(floor) && solid(c1) && (solid(c2) || isOpen(c2)) && (isOpen(sky) || openFace(x, n.y + 2, z, dx, dz)) && (isOpen(head) || solid(head))) {
          const cells = [{ x, y: n.y + 1, z, v: c1 }, { x, y: n.y + 2, z, v: c2 }, { x: n.x, y: n.y + 2, z: n.z, v: head }].filter(c => solid(c.v)).map(c => ({ x: c.x, y: c.y, z: c.z, name: c.v.name }))
          const g = n.g + 1 + cells.reduce((t, c) => t + (SOFT.test(c.name) ? 2 : 6), 0)
          const k = key(x, n.y + 1, z)
          if (g < (best.get(k) ?? Infinity)) { best.set(k, g); parent.set(k, key(n.x, n.y, n.z)); digOf.set(k, cells); open.push({ x, y: n.y + 1, z, g, f: g + h(x, z) }) }
        }
      }
      // A step carved down (2026-11-14, a ravine on the way): straight moves
      // only, one block down; the three cells of the step (new feet, new head,
      // the head while stepping) received and diggable or open, at least one to
      // dig, a received solid floor below, no liquid beside any carved cell, and
      // everything above the step open to the sky: a trench, never a tunnel.
      if (allowDig && !(dx && dz) && !onLeaves(n)) {
        const b = yy => getBlock(x, yy, z)
        const floor = b(n.y - 2), cells = [n.y + 1, n.y, n.y - 1].map(yy => ({ y: yy, v: b(yy) }))
        const diggable = v => v?.known === true && v.boundingBox === 'block' && !NOT_DIGGABLE.test(v.name ?? '') && !HAZARD.test(v.name ?? '') && !WATER.test(v.name ?? '')
        const dry = (xx, yy, zz) => { const v = getBlock(xx, yy, zz); return v?.known === true && !WATER.test(v.name ?? '') && !/lava/.test(v.name ?? '') }
        const floorOk = floor?.known === true && floor.boundingBox === 'block' && !HAZARD.test(floor.name ?? '') && !WATER.test(floor.name ?? '') && !/leaves/.test(floor.name ?? '')
        const cellsOk = cells.every(c => diggable(c.v) || classify(c.v) === 'pass') && cells.some(c => diggable(c.v))
        const dryOk = cellsOk && cells.filter(c => diggable(c.v)).every(c => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([ox, oz]) => dry(x + ox, c.y, z + oz)))
        if (floorOk && cellsOk && dryOk && (sky(x, n.y, z) || openFace(x, n.y, z, dx, dz))) {
          const dig = cells.filter(c => diggable(c.v)).map(c => ({ x, y: c.y, z, name: c.v.name }))
          const g = n.g + 1 + dig.reduce((t, c) => t + (SOFT.test(c.name) ? 2 : 6), 0)
          const k = key(x, n.y - 1, z)
          if (g < (best.get(k) ?? Infinity)) { best.set(k, g); parent.set(k, key(n.x, n.y, n.z)); digOf.set(k, dig); open.push({ x, y: n.y - 1, z, g, f: g + h(x, z) }) }
        }
      }
      for (const s of col.stands) {
        const dy = s.y - n.y
        if (dy > 1 || dy < -(onLeaves(n) ? Math.max(maxDrop, 4) : maxDrop)) continue
        if (dx && dz) {
          // Diagonal: both side columns must be walkable at the same height.
          const a = surface.stands(n.x + dx, n.z, Math.min(n.y, s.y) - 1, Math.max(n.y, s.y) + 1).stands, b = surface.stands(n.x, n.z + dz, Math.min(n.y, s.y) - 1, Math.max(n.y, s.y) + 1).stands
          if (!a.length || !b.length) continue
        }
        const covered = surfaceOnly && !sky(x, s.y, z)
        if (covered && dy < 0) continue
        const g = n.g + (dx && dz ? 1.414 : 1) * (s.water ? 3 : 1) * (covered ? 5 : 1) + (dy > 0 ? 0.5 : 0)
        const k = key(x, s.y, z)
        if (g >= (best.get(k) ?? Infinity)) continue
        best.set(k, g); parent.set(k, key(n.x, n.y, n.z))
        open.push({ x, y: s.y, z, g, f: g + h(x, z) })
      }
    }
  }
  const path = []
  let k = key(closest.x, closest.y, closest.z)
  while (k) { const [x, y, z] = k.split(',').map(Number); const dig = digOf.get(k); path.push({ x: x + 0.5, y, z: z + 0.5, ...(dig ? { dig } : {}) }); k = parent.get(k) }
  path.reverse()
  return { ready: path.length > 1, reached, surfaced, timedOut, path, remaining: Math.round(closest.d), expanded, frontier: [...frontier].slice(0, 64).map(s => { const [x, z] = s.split(',').map(Number); return { x, z } }) }
}

module.exports = { planCoarseRoute, createSurface, classify }
