'use strict'

// The expedition's mine and the starter jobs: who has the player while the Bot stands inside the mine.
// Uses unified `spatial-context.js` so mine occupancy is evaluated consistently across dispatcher and expedition.
const { readSpatialContext } = require('./spatial-context')

const branchOf = record => record?.stage === 'early' ? record.early?.mine?.branch ?? null : null

// Whether the Bot stands in the dug part of its own mine now (received position, the mine's own reading).
function inOwnMine ({ runtime, getFeet, record }) {
  const branch = branchOf(record)
  if (!branch?.plan || !branch.shaft) return false
  const feet = typeof getFeet === 'function' ? (() => { try { return getFeet() } catch { return null } })() : null
  return readSpatialContext({ dimension: 'overworld', feet, mineBranch: branch, runtime }).inBranchMine
}

// The step that takes the ladder out; null when the Bot is not inside (the starter jobs have the player then).
async function leaveOwnMine (ctx) {
  if (!inOwnMine({ runtime: ctx.runtime, getFeet: ctx.getFeet, record: ctx.memory })) return null
  return require('./mining/mine-controller').beforeSurfaceSupply(ctx)
}

module.exports = { inOwnMine, leaveOwnMine }
