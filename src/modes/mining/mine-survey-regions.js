'use strict'

const { surveyMine, validBounds } = require('./mine-survey')

// A site's height is independent of the work allowed in one survey. Keep the
// 128 x 128 design and its received horizon; split tall columns into bounded
// slices instead of rejecting a valid entrance at Y65. The complete ephemeral
// snapshot is still bounded (105 x 105 x the world's height fits this ceiling).
const MAX_TOTAL_CELLS = 4500000
const MAX_REGIONS = 64

async function surveyMineRegions (options = {}, control = {}) {
  const { bounds, maxCells = 1500000, maxRequests = 18 } = options
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > 3000000 || !validBounds(bounds, MAX_TOTAL_CELLS)) return { status: 'blocked', code: 'MINE_SURVEY_BUDGET_INVALID' }
  const plane = (bounds.max.x - bounds.min.x + 1) * (bounds.max.z - bounds.min.z + 1)
  const height = Math.floor(maxCells / plane), count = Math.ceil((bounds.max.y - bounds.min.y + 1) / height)
  if (height < 1 || count > MAX_REGIONS) return { status: 'blocked', code: 'MINE_SURVEY_BUDGET_INVALID' }
  const regions = [], receipts = [], missing = new Map()
  let requests = 0, known = 0, unknown = 0, total = 0
  const ores = []
  for (let y = bounds.min.y; y <= bounds.max.y; y += height) {
    if (receipts.some(receipt => !receipt.current())) return { status: 'observing', code: 'MINE_TERRAIN_CHANGED', requests }
    const regionBounds = { min: { ...bounds.min, y }, max: { ...bounds.max, y: Math.min(bounds.max.y, y + height - 1) } }
    const part = await surveyMine({ ...options, bounds: regionBounds, maxRequests: Math.max(0, maxRequests - requests) }, control)
    if (!['ready', 'partial'].includes(part.status)) return { ...part, requests: requests + (part.requests ?? 0) }
    regions.push(part); receipts.push(part.terrainReceipt)
    requests += part.requests; known += part.known; unknown += part.unknown; total += part.total
    for (const ore of part.ores) ores.push(ore)
    for (const section of part.needsObservation) {
      const key = `${section.x},${section.y},${section.z}`, previous = missing.get(key)
      missing.set(key, { ...section, unknown: section.unknown + (previous?.unknown ?? 0) })
    }
  }
  if (regions.some(region => !region.current())) return { status: 'observing', code: 'MINE_TERRAIN_CHANGED', requests }
  const first = regions[0]
  return {
    status: unknown ? 'partial' : 'ready', scope: first.scope, liveScope: first.liveScope, bounds: structuredClone(bounds), revision: first.revision,
    requests, known, unknown, total, ores, needsObservation: [...missing.values()], regions: regions.length,
    // Retain only the section witnesses in a waiting site's cache, not the
    // typed cell arrays or the ore list of this temporary snapshot.
    terrainReceipt: { current: () => receipts.every(receipt => receipt.current()) },
    current: () => regions.every(region => region.current()),
    at: point => regions[Math.floor((point?.y - bounds.min.y) / height)]?.at(point) ?? { known: false, position: point, reason: 'outside_mine_survey' }
  }
}

module.exports = { surveyMineRegions, MAX_TOTAL_CELLS, MAX_REGIONS }
