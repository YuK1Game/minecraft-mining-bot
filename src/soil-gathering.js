'use strict'

const SOIL = new Set(['minecraft:dirt', 'minecraft:grass_block'])
const FLOOR = new Set(['dirt', 'grass_block', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite'].map(name => `minecraft:${name}`))
const AIR = new Set(['air', 'cave_air', 'void_air'].map(name => `minecraft:${name}`))
const PLANTS = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'deadbush', 'leaf_litter'].map(name => `minecraft:${name}`))
const key = point => `${point.x},${point.y},${point.z}`
const integer = point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
const positionOf = value => value?.position ?? value
const dry = block => block?.known === true && !block.extra?.length && block.protected !== true && block.owned !== true && block.natural !== false
const floor = block => dry(block) && FLOOR.has(block.name) && block.boundingBox === 'block'
const clear = block => dry(block) && (AIR.has(block.name) || PLANTS.has(block.name) && block.boundingBox === 'empty')

function soilCandidates (state, observations, { excludedPositions = [], sites = [] } = {}) {
  if (!state?.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis])) || !Array.isArray(observations?.blocks)) return []
  const map = new Map(observations.blocks.filter(block => integer(block.position)).map(block => [key(block.position), block]))
  const excluded = new Set(excludedPositions.map(positionOf).filter(integer).map(key))
  const add = values => { for (const value of (Array.isArray(values) ? values : values ? [values] : [])) { const point = positionOf(value); if (integer(point)) excluded.add(key(point)) } }
  for (const site of sites.filter(Boolean)) {
    for (const field of ['floor', 'walls', 'wallCells', 'roof', 'doorCells', 'footprint', 'buildCells', 'ownedBuildCells', 'temporaryPillar', 'tempCells', 'minimumInterior', 'finalInterior']) add(site[field])
    for (const values of Object.values(site.preserved ?? {})) add(values)
    for (const values of Object.values(site.expansionPlan?.preserved ?? {})) add(values)
    if (site.type === 'soil_hut' && integer(site.center)) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) excluded.add(key({ x: site.center.x + dx, y: site.center.y + dy, z: site.center.z + dz }))
  }
  const feet = state.position.y - 1.62
  const supportY = Math.floor(feet - 1e-4)
  // Preserve the entire current footprint, body, and immediate support ring.
  for (let x = Math.floor(state.position.x - 0.3 + 1e-6) - 1; x <= Math.floor(state.position.x + 0.3 - 1e-6) + 1; x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6) - 1; z <= Math.floor(state.position.z + 0.3 - 1e-6) + 1; z++) excluded.add(key({ x, y: supportY, z }))
  for (let x = Math.floor(state.position.x - 0.3 + 1e-6); x <= Math.floor(state.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6); z <= Math.floor(state.position.z + 0.3 - 1e-6); z++) for (let y = supportY; y <= Math.floor(feet + 1.8 - 1e-6); y++) excluded.add(key({ x, y, z }))
  const result = []
  for (const block of map.values()) {
    const p = block.position
    if (!dry(block) || !SOIL.has(block.name) || block.boundingBox !== 'block' || excluded.has(key(p)) || Math.hypot(p.x + 0.5 - state.position.x, p.z + 0.5 - state.position.z) > 6 || Math.abs(p.y + 1 - feet) > 1) continue
    let safe = true; let grass = 0; let soil = 0
    for (let dx = -1; safe && dx <= 1; dx++) for (let dz = -1; safe && dz <= 1; dz++) {
      const column = { x: p.x + dx, y: p.y, z: p.z + dz }
      const surface = map.get(key(column))
      if (excluded.has(key(column)) || !floor(surface) || !floor(map.get(key({ ...column, y: p.y - 1 })))) { safe = false; break }
      if (surface.name === 'minecraft:grass_block') grass++
      if (SOIL.has(surface.name)) soil++
      for (let dy = 1; dy <= 3; dy++) if (!clear(map.get(key({ ...column, y: p.y + dy })))) { safe = false; break }
    }
    if (!safe || grass < 1 || soil < 3) continue
    result.push({ position: { ...p }, name: block.name, distance: Math.hypot(p.x + 0.5 - state.position.x, p.y + 0.5 - state.position.y, p.z + 0.5 - state.position.z), naturalEvidence: { type: 'known_exposed_soil_with_grass', grassCells: grass, soilCells: soil, placementHistoryKnown: false } })
  }
  return result.sort((a, b) => a.distance - b.distance || a.position.x - b.position.x || a.position.z - b.position.z).slice(0, 16)
}

module.exports = { soilCandidates }
