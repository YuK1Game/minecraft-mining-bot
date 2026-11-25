'use strict'

// The palette describes received block states; each cell has its own index,
// including known air and unknown cells. Positions are implicit in y/x/z order.
// Do not infer air from a missing entry in an old (lossy) incident.
const MAX_RADIUS = 16
const DY = [-2, 3]
const FIELDS = ['known', 'name', 'runtimeId', 'properties', 'boundingBox', 'hardness', 'diggable', 'extra', 'shapes', 'reason']

function stable (value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

function blockState (block) {
  if (!block || typeof block !== 'object') return { known: false }
  const result = { known: block.known === true }
  for (const key of FIELDS) if (key !== 'known' && block[key] !== undefined) result[key] = stable(block[key])
  return result
}

function sampleTerrain (getBlock, feet, radius = 5) {
  if (typeof getBlock !== 'function' || !feet || !['x', 'y', 'z'].every(k => Number.isFinite(feet[k]))) return null
  radius = Number.isSafeInteger(radius) ? Math.max(0, Math.min(MAX_RADIUS, radius)) : 5
  const center = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.05), z: Math.floor(feet.z) }
  const width = 2 * radius + 1, total = width * width * (DY[1] - DY[0] + 1)
  const cells = Buffer.alloc(total * 2), palette = [], lookup = new Map()
  let index = 0, unknownCount = 0
  for (let dy = DY[0]; dy <= DY[1]; dy++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    let received
    try { received = getBlock(center.x + dx, center.y + dy, center.z + dz) } catch { received = null }
    const state = blockState(received), key = JSON.stringify(state)
    let id = lookup.get(key)
    if (id === undefined) { id = palette.length; lookup.set(key, id); palette.push(state) }
    cells.writeUInt16LE(id, index++ * 2)
    if (!state.known) unknownCount++
  }
  return { version: 2, center, radius, dy: [...DY], order: 'y,x,z', encoding: 'u16le-base64', palette, cells: cells.toString('base64'), unknownCount }
}

function replayTerrain (terrain) {
  const unknown = (x, y, z, reason = 'outside_incident') => ({ known: false, position: { x, y, z }, reason })
  if (!terrain || terrain.version !== 2) {
    const received = new Map((terrain?.nonAirKnown ?? []).map(([x, y, z, name]) => [`${x},${y},${z}`, { known: true, name }]))
    return { getBlock: (x, y, z) => {
      const block = received.get(`${x},${y},${z}`)
      return block ? { ...block, position: { x, y, z } } : unknown(x, y, z, 'legacy_incident_unobserved')
    } }
  }
  const { center, radius, dy, palette, cells, order, encoding } = terrain
  if (!center || !['x', 'y', 'z'].every(k => Number.isSafeInteger(center[k])) || !Number.isSafeInteger(radius) || radius < 0 || radius > MAX_RADIUS || !Array.isArray(dy) || dy[0] !== DY[0] || dy[1] !== DY[1] || order !== 'y,x,z' || encoding !== 'u16le-base64' || typeof cells !== 'string' || !Array.isArray(palette) || !palette.length) throw new Error('Invalid incident terrain')
  const width = 2 * radius + 1, total = width * width * (DY[1] - DY[0] + 1)
  if (palette.length > total || cells.length !== 4 * Math.ceil(total * 2 / 3)) throw new Error('Invalid incident terrain size')
  const bytes = Buffer.from(cells, 'base64')
  if (bytes.length !== total * 2 || bytes.toString('base64') !== cells || palette.some(block => !block || typeof block !== 'object' || typeof block.known !== 'boolean')) throw new Error('Invalid incident terrain palette')
  for (let i = 0; i < total; i++) if (bytes.readUInt16LE(i * 2) >= palette.length) throw new Error('Invalid incident terrain cell')
  const states = structuredClone(palette)
  return { getBlock (x, y, z) {
    if (![x, y, z].every(Number.isSafeInteger)) return unknown(x, y, z, 'invalid_position')
    const dx = x - center.x + radius, dz = z - center.z + radius, height = y - center.y - DY[0]
    if (dx < 0 || dx >= width || dz < 0 || dz >= width || height < 0 || height > DY[1] - DY[0]) return unknown(x, y, z)
    const index = (height * width + dx) * width + dz
    return { ...structuredClone(states[bytes.readUInt16LE(index * 2)]), position: { x, y, z } }
  } }
}

module.exports = { sampleTerrain, replayTerrain }
