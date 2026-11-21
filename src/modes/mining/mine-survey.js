'use strict'

const { setImmediate: immediate } = require('node:timers/promises')
const { mineWorldScope, mineLiveScope } = require('./mine-state')
const ORES = Object.freeze({ coal_ore: 'coal', iron_ore: 'raw_iron', copper_ore: 'raw_copper', gold_ore: 'raw_gold', diamond_ore: 'diamond', redstone_ore: 'redstone', lit_redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', emerald_ore: 'emerald' })
const oreResource = name => ORES[String(name ?? '').replace(/^minecraft:/, '').replace(/^lit_/, '').replace(/^deepslate_/, '')] ?? null
const key = p => `${p.x},${p.y},${p.z}`
const fail = code => { throw Object.assign(new Error(code), { code }) }

function validBounds (bounds, maxCells) {
  if (!bounds?.min || !bounds.max || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(bounds.min[axis]) && Number.isSafeInteger(bounds.max[axis]) && bounds.min[axis] <= bounds.max[axis]) || bounds.min.y < -64 || bounds.max.y > 319 || ['x', 'z'].some(axis => Math.max(Math.abs(bounds.min[axis]), Math.abs(bounds.max[axis])) > 30000000)) return false
  return ['x', 'y', 'z'].reduce((n, axis) => n * (bounds.max[axis] - bounds.min[axis] + 1), 1) <= maxCells
}

// Scan the received World itself, with a finite volume. No display-list result
// cap and no saved ore cache can hide a candidate. The typed palette is only an
// ephemeral observation; it is deliberately absent from the persisted plan.
async function surveyMine ({ world, getState, bounds, requestSections = null, maxRequests = 18, maxCells = 450000, batchSize = 512, yieldNow = immediate, isProtected = () => false } = {}, { signal } = {}) {
  if (typeof world?.getBlock !== 'function' || typeof getState !== 'function' || !Number.isInteger(maxCells) || maxCells < 1 || maxCells > 1500000 || !validBounds(bounds, maxCells) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2048 || !Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 64) return { status: 'blocked', code: 'MINE_SURVEY_BUDGET_INVALID' }
  const state = getState(), scope = mineWorldScope(state), liveScope = mineLiveScope(state)
  if (!scope || !liveScope) return { status: 'blocked', code: 'MINE_SCOPE_UNKNOWN' }
  let witness = null, capturedRevision = null, requests = 0
  const check = () => {
    if (signal?.aborted) fail('MINE_CANCELLED')
    if (mineLiveScope(getState()) !== liveScope) fail('MINE_SCOPE_CHANGED')
    if (witness ? !witness.current() : capturedRevision != null && world.revision?.() !== capturedRevision) fail('MINE_TERRAIN_CHANGED')
  }
  try {
    // Reuse the Host's announced-column and in-flight suppression. Sending a
    // request never marks any cell known, and no new chunk subscription is made.
    if (requestSections && typeof world.buildSubchunkRequest === 'function') {
      for (let x = Math.floor(bounds.min.x / 16); x <= Math.floor(bounds.max.x / 16) && requests < maxRequests; x++) for (let z = Math.floor(bounds.min.z / 16); z <= Math.floor(bounds.max.z / 16) && requests < maxRequests; z++) for (let y = Math.floor(bounds.min.y / 16); y <= Math.floor(bounds.max.y / 16) && requests < maxRequests; y++) {
        check()
        const packet = world.buildSubchunkRequest({ x: x * 16 + 8, y: y * 16 + 8, z: z * 16 + 8 }, { horizontalRadius: 0, verticalRadius: 0 })
        if (packet) { await requestSections(packet); requests += packet.requests.length; if (requests % 4 === 0) await yieldNow() }
      }
    }
    check(); witness = world.observeTerrain?.() ?? null; capturedRevision = world.revision?.() ?? null
    const size = { x: bounds.max.x - bounds.min.x + 1, y: bounds.max.y - bounds.min.y + 1, z: bounds.max.z - bounds.min.z + 1 }, total = size.x * size.y * size.z
    const ids = new Uint16Array(total), palette = [null], lookup = new Map(), ores = [], unknownSections = new Map()
    let known = 0, unknown = 0, index = 0
    const read = p => {
      const block = world.getBlock(p.x, p.y, p.z)
      if (block?.known !== true) {
        unknown++
        const section = { x: Math.floor(p.x / 16), y: Math.floor(p.y / 16), z: Math.floor(p.z / 16) }, id = key(section)
        const previous = unknownSections.get(id); unknownSections.set(id, { ...section, unknown: (previous?.unknown ?? 0) + 1 })
        return
      }
      known++
      const protectedBlock = block.protected === true || !!block.protectionSource || isProtected(p, block) === true
      const paletteKey = `${block.runtimeId}|${block.name}|${protectedBlock}|${block.natural === false}|${(block.extra ?? []).map(layer => layer.name).join(',')}`
      let id = lookup.get(paletteKey)
      if (id == null) {
        if (palette.length >= 65535) fail('MINE_PALETTE_BUDGET')
        id = palette.length; lookup.set(paletteKey, id)
        palette.push({ known: true, name: block.name, runtimeId: block.runtimeId, boundingBox: block.boundingBox, hardness: block.hardness, diggable: block.diggable, properties: structuredClone(block.properties ?? {}), extra: structuredClone(block.extra ?? []), protected: protectedBlock, ...(block.natural === false ? { natural: false } : {}) })
      }
      ids[index] = id
      const resource = oreResource(block.name)
      if (resource) ores.push({ position: p, resource, name: block.name, runtimeId: block.runtimeId })
    }
    for (; index < total;) {
      check()
      const end = Math.min(total, index + batchSize)
      const batch = () => { for (; index < end; index++) {
        const x = index % size.x, z = Math.floor(index / size.x) % size.z, y = Math.floor(index / (size.x * size.z))
        read({ x: bounds.min.x + x, y: bounds.min.y + y, z: bounds.min.z + z })
      } }
      if (witness) witness.run(batch); else batch()
      if (index < total) await yieldNow()
    }
    check()
    const at = p => {
      if (!p || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]) && p[axis] >= bounds.min[axis] && p[axis] <= bounds.max[axis])) return { known: false, position: p, reason: 'outside_mine_survey' }
      const i = ((p.y - bounds.min.y) * size.z + p.z - bounds.min.z) * size.x + p.x - bounds.min.x, block = palette[ids[i]]
      return block ? { ...block, position: p } : { known: false, position: p, reason: 'unreceived_mine_terrain' }
    }
    return { status: unknown ? 'partial' : 'ready', scope, liveScope, bounds: structuredClone(bounds), revision: capturedRevision, known, unknown, total, requests, ores,
      needsObservation: [...unknownSections.values()], at, current: () => { try { check(); return true } catch { return false } } }
  } catch (error) {
    return { status: error.code === 'MINE_CANCELLED' ? 'cancelled' : 'observing', code: error.code ?? 'MINE_SURVEY_FAILED', requests, reason: error.message }
  }
}

module.exports = { surveyMine, oreResource, validBounds }
