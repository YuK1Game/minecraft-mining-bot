'use strict'

const { walkableCells } = require('./player-drops')
const { standable } = require('./house/house-steps')
const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const cell = p => ({ x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) })
const center = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
const air = b => b?.known === true && /^minecraft:(?:air|cave_air|void_air)$/.test(b.name) && !b.extra?.length
const floor = b => b?.known === true && b.boundingBox === 'block' && !b.extra?.length && !/lava|water|sand$|gravel|magma|infested|portal|spawner/.test(b.name)
const diggable = b => floor(b) && /^minecraft:(?:grass(?:_block)?|dirt|stone|deepslate|diorite|andesite|granite|tuff|stonebrick|(?:cracked_|mossy_)?stone_bricks)$/.test(b.name)
const masonry = b => b?.known === true && /:(?:(?:cracked_|mossy_)?stone_bricks?|stonebrick|end_portal_frame)$/.test(b.name)
function miningTarget (p, b) {
  if (!masonry(b) && b?.name !== 'minecraft:mob_spawner') return p
  return { ...p, accessPreparation: 'stronghold_access', expectedName: b.name, expectedRuntimeId: b.runtimeId }
}
const FRAME = 'minecraft:end_portal_frame'
const pointKey = p => [p.x, p.y, p.z].join(',')
const read = (get, p) => get(p.x, p.y, p.z)
const frameOffsets = dir.flatMap(([x, z]) => [-1, 0, 1].map(t => [x * 2 + z * t, z * 2 + x * t]))
const frames = c => frameOffsets.map(([dx, dz]) => ({ x: c.x + dx, y: c.y, z: c.z + dz }))
const active = (get, c) => c && [-1, 0, 1].every(dx => [-1, 0, 1].every(dz => {
  const b = get(c.x + dx, c.y, c.z + dz)
  return b?.known === true && b.name === 'minecraft:end_portal'
}))

// Recognise an actual ring rather than assuming its center from one frame's
// direction (the three frames on each edge have the same block state).
function portalFromFrame (get, p) {
  for (const [dx, dz] of frameOffsets) {
    const c = { x: p.x - dx, y: p.y, z: p.z - dz }
    if (frames(c).every(f => { const b = read(get, f); return b?.known === true && b.name === FRAME })) return c
  }
  return null
}

function localSurvey (get, at) {
  let brick = null
  for (let r = 0; r <= 14; r++) for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
    if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue
    for (let dy = -5; dy <= 5; dy++) {
      const p = { x: at.x + x, y: at.y + dy, z: at.z + z }
      const b = read(get, p)
      if (b?.known === true && b.name === FRAME) {
        const portal = portalFromFrame(get, p)
        if (portal) return { portal, brick }
      }
      if (!brick && masonry(b)) brick = p
    }
  }
  return { portal: null, brick }
}

function intersection (a, b) {
  const cross = a.dx * b.dz - a.dz * b.dx
  if (Math.abs(cross) < 0.035 || flat(a, b) < 24) return null
  const dx = b.x - a.x, dz = b.z - a.z
  const t = (dx * b.dz - dz * b.dx) / cross, u = (dx * a.dz - dz * a.dx) / cross
  if (t < 0 || u < 0 || Math.max(t, u) > 10000) return null
  return { x: Math.round(a.x + t * a.dx), z: Math.round(a.z + t * a.dz) }
}

function standsAround (ctx, target, min = 2, max = 4) {
  const at = ctx.getFeet()
  if (!at) return []
  return [...walkableCells({ ...at, y: at.y + 1.62 }, ctx.getBlock).values()].filter(p => {
    const d = flat(center(p), target)
    return d >= min && d <= max && Math.abs(p.y - target.y) <= 2 && standable(ctx.getBlock, p.x, p.y, p.z)
  }).sort((a, b) => distance(center(a), at) - distance(center(b), at))
}

// A single reversible staircase step. The bottom and ceiling of the next
// stand must be known, and only ordinary natural stone/masonry may be mined.
async function digStep (ctx, state, goal, descending) {
  const at = cell(ctx.getFeet()), visits = state.dug ??= {}
  const candidates = []
  for (const [dx, dz] of dir) {
    for (const dy of descending ? [-1] : [Math.sign(goal.y - at.y), 0]) {
      const next = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
      if (next.y < -62 || !floor(ctx.getBlock(next.x, next.y - 1, next.z))) continue
      if (!floor(ctx.getBlock(at.x, at.y - 1, at.z))) continue
      const cells = []
      if (dy > 0) cells.push({ ...at, y: at.y + 2 })
      for (let h = Math.max(1, 1 - dy); h >= 0; h--) cells.push({ ...next, y: next.y + h })
      // A switchback must never remove the floor of a previous stair tread.
      // In a two-column shaft it would otherwise destroy the return path.
      if (cells.some(p => visits[pointKey({ ...p, y: p.y + 1 })])) continue
      if (!cells.every(p => { const b = read(ctx.getBlock, p); return air(b) || diggable(b) })) continue
      candidates.push({ next, cells, cost: flat(next, goal) + Math.abs(next.y - goal.y) + (visits[pointKey(next)] ?? 0) * 10 })
    }
  }
  for (const { next, cells } of candidates.sort((a, b) => a.cost - b.cost)) {
    if (ctx.cancelled()) return false
    const cut = cells.find(p => !air(read(ctx.getBlock, p)))
    if (cut) {
      const target = miningTarget(cut, read(ctx.getBlock, cut))
      if (!await ctx.hands.pick(cut) || ctx.cancelled() || !ctx.hands.canMine(target)) continue
      if (await ctx.hands.mine(target)) return true
    } else if (await ctx.hands.walk(center(next))) {
      visits[pointKey(at)] = (visits[pointKey(at)] ?? 0) + 1
      return true
    }
  }
  return false
}

async function navigate (ctx, state, goal, { explore = false } = {}) {
  const feet = ctx.getFeet()
  const visits = state.visits ??= {}
  const candidates = [...walkableCells({ ...feet, y: feet.y + 1.62 }, ctx.getBlock).values()]
  const sector = p => [Math.floor(p.x / 5), Math.floor(p.y / 3), Math.floor(p.z / 5)].join(',')
  const cost = p => explore ? (visits[sector(p)] ?? 0) * 20 - Math.min(10, flat(p, feet)) + (masonry(ctx.getBlock(p.x, p.y - 1, p.z)) ? 0 : 8) : distance(center(p), goal)
  for (const p of candidates.filter(p => distance(center(p), feet) > 1.4 && distance(center(p), feet) < 13 && (explore || cost(p) < distance(feet, goal) - 0.4)).sort((a, b) => cost(a) - cost(b)).slice(0, 5)) {
    if (ctx.cancelled()) return false
    if (await ctx.hands.walk(center(p))) {
      if (explore) visits[sector(p)] = (visits[sector(p)] ?? 0) + 1
      return true
    }
  }
  return false
}

module.exports = { active, air, cell, center, digStep, dir, distance, flat, floor, frames, intersection, localSurvey, miningTarget, navigate, portalFromFrame, read, standsAround }
