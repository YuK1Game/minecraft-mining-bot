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
  if (PASS.test(name) || b.boundingBox === 'empty') return 'pass'
  return b.boundingBox === 'block' ? 'solid' : 'other'
}

function createSurface (getBlock, { minY = -60, maxY = 300 } = {}) {
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
      if (here === 'pass' && above1 === 'pass' && (below === 'solid' || below === 'water')) out.push({ y, water: below === 'water' })
      above2 = above1; above1 = here
    }
    const value = { stands: out, unknown }
    cache.set(key, value)
    return value
  }
  return { stands, clear: () => cache.clear() }
}

function planCoarseRoute ({ getBlock, start, goal, maxNodes = 60000, maxRadius = 320, arriveM = 6, window = 12 }) {
  const surface = createSurface(getBlock)
  const sx = Math.floor(start.x), sz = Math.floor(start.z), sy = Math.round(start.y)
  const gx = Math.floor(goal.x), gz = Math.floor(goal.z)
  const h = (x, z) => Math.hypot(gx - x, gz - z)
  const key = (x, y, z) => `${x},${y},${z}`
  const open = [{ x: sx, y: sy, z: sz, g: 0, f: h(sx, sz) }]
  const best = new Map([[key(sx, sy, sz), 0]])
  const parent = new Map()
  const frontier = new Set()
  let closest = { x: sx, y: sy, z: sz, d: h(sx, sz) }, expanded = 0
  const pop = () => { let i = 0; for (let j = 1; j < open.length; j++) if (open[j].f < open[i].f) i = j; return open.splice(i, 1)[0] }
  while (open.length && expanded < maxNodes) {
    const n = pop(); expanded++
    const d = h(n.x, n.z)
    if (d < closest.d) closest = { x: n.x, y: n.y, z: n.z, d }
    if (d <= arriveM) { closest = { x: n.x, y: n.y, z: n.z, d }; break }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = n.x + dx, z = n.z + dz
      if (Math.hypot(x - sx, z - sz) > maxRadius) continue
      const col = surface.stands(x, z, n.y - 3, n.y + 1)
      if (col.unknown && !col.stands.length) { frontier.add(`${x},${z}`); continue }
      for (const s of col.stands) {
        const dy = s.y - n.y
        if (dy > 1 || dy < -3) continue
        if (dx && dz) {
          // Diagonal: both side columns must be walkable at the same height.
          const a = surface.stands(n.x + dx, n.z, Math.min(n.y, s.y) - 1, Math.max(n.y, s.y) + 1).stands, b = surface.stands(n.x, n.z + dz, Math.min(n.y, s.y) - 1, Math.max(n.y, s.y) + 1).stands
          if (!a.length || !b.length) continue
        }
        const g = n.g + (dx && dz ? 1.414 : 1) * (s.water ? 3 : 1) + (dy > 0 ? 0.5 : 0)
        const k = key(x, s.y, z)
        if (g >= (best.get(k) ?? Infinity)) continue
        best.set(k, g); parent.set(k, key(n.x, n.y, n.z))
        open.push({ x, y: s.y, z, g, f: g + h(x, z) })
      }
    }
  }
  const path = []
  let k = key(closest.x, closest.y, closest.z)
  while (k) { const [x, y, z] = k.split(',').map(Number); path.push({ x: x + 0.5, y, z: z + 0.5 }); k = parent.get(k) }
  path.reverse()
  return { ready: path.length > 1, reached: closest.d <= arriveM, path, remaining: Math.round(closest.d), expanded, frontier: [...frontier].slice(0, 64).map(s => { const [x, z] = s.split(',').map(Number); return { x, z } }) }
}

module.exports = { planCoarseRoute, createSurface, classify }
