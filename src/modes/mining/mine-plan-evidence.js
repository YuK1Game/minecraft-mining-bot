'use strict'

// Waiting plans retain only bounded, in-memory terrain witnesses. A checkpoint
// stores the opaque id; after a reload there is no matching witness, so the
// received world is surveyed once again. No old cells become trusted on disk.
const worlds = new WeakMap()
const generation = require('node:crypto').randomUUID()
let next = 0

function rememberPlanEvidence (world, receipt) {
  if (!world || typeof world !== 'object' || typeof receipt?.current !== 'function') return null
  let entries = worlds.get(world)
  if (!entries) { entries = new Map(); worlds.set(world, entries) }
  const id = `${generation}:${++next}`
  entries.set(id, receipt)
  while (entries.size > 64) entries.delete(entries.keys().next().value)
  return id
}

function planEvidenceCurrent (world, id) {
  return id != null && worlds.get(world)?.get(id)?.current() === true
}

// A computation limit or invalid/cancelled scope says nothing about the site.
// Only these completed comparisons may advance past an entrance.
const SITE_REJECTIONS = new Set(['MINE_SURFACE_TOO_LOW', 'MINE_SURFACE_OBSERVATION_NEEDED', 'MINE_SHAFT_DEPTH_EXCEEDED', 'MINE_NO_OBSERVED_LOWER_ORE', 'MINE_NO_SAFE_RESOURCE_PLAN'])
const rejectsSite = result => result?.status === 'blocked' && SITE_REJECTIONS.has(result.code)

module.exports = { rememberPlanEvidence, planEvidenceCurrent, rejectsSite }
