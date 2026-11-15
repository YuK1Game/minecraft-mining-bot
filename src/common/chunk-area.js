'use strict'

const keys = new Set(['x1', 'z1', 'x2', 'z2'])
const invalid = () => Object.assign(new Error('最大4チャンクの範囲を整数で選択してください。'), { code: 'INVALID_CHUNK_AREA', status: 400 })
function normalizeChunkArea (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.has(key))) throw invalid()
  const x2 = input.x2 ?? input.x1, z2 = input.z2 ?? input.z1
  if (![input.x1, input.z1, x2, z2].every(n => Number.isSafeInteger(n) && n >= -1875000 && n <= 1874999)) throw invalid()
  const area = { x1: Math.min(input.x1, x2), z1: Math.min(input.z1, z2), x2: Math.max(input.x1, x2), z2: Math.max(input.z1, z2) }
  if ((area.x2 - area.x1 + 1) * (area.z2 - area.z1 + 1) > 4) throw invalid()
  return area
}
function areaContainsFeet (input, feet, radius = 0) {
  let area
  try { area = normalizeChunkArea(input) } catch { return false }
  if (!feet || !['x', 'y', 'z'].every(key => Number.isFinite(feet[key])) || !Number.isFinite(radius) || radius < 0 || radius > 1.5) return false
  return feet.x - radius >= area.x1 * 16 && feet.x + radius < (area.x2 + 1) * 16 &&
    feet.z - radius >= area.z1 * 16 && feet.z + radius < (area.z2 + 1) * 16
}
const chunkAreaKey = input => { const a = normalizeChunkArea(input); return JSON.stringify([a.x1, a.z1, a.x2, a.z2]) }
module.exports = { normalizeChunkArea, areaContainsFeet, chunkAreaKey }
