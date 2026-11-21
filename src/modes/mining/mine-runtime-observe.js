'use strict'

// Small, bounded terrain requests for the existing connection. Announced
// columns, request suppression and receipt handling stay owned by World.
async function observeMineRuntime (rt, { cells = null } = {}, { signal } = {}) {
  if (signal?.aborted) return
  if (!Array.isArray(cells) || !cells.length) return rt.prospecting.scan({ minY: -60, maxY: Math.min(319, Math.floor(rt.quarryState().position.y)), chunkRadius: 1, maxResults: 1 }, { signal })
  const sections = new Map()
  for (const p of cells) {
    if (!p || !['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))) continue
    const x = Math.floor(p.x / 16), z = Math.floor(p.z / 16), y = Math.floor(p.y / 16), id = `${x},${y},${z}`
    if (!sections.has(id)) sections.set(id, { x, y, z })
  }
  for (const section of [...sections.values()].slice(0, 8)) {
    if (signal?.aborted) return
    await rt.requestQuarryTerrain({ config: { dimension: 'overworld', target: { chunks: [{ x: section.x, z: section.z }] } }, yBottom: Math.max(-64, section.y * 16), yTop: Math.min(319, section.y * 16 + 15) }, { signal })
  }
}

module.exports = { observeMineRuntime }
