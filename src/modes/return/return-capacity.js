'use strict'

const { createHash } = require('node:crypto')
const { pairedChest } = require('../chest-pair')

const key = at => `${at.x},${at.y},${at.z}`
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const cargoKey = cargo => JSON.stringify(cargo.map(({ slot, name, count }) => ({ slot, name, count })))
const observation = (getBlock, contents, at) => {
  const block = getBlock(at.x, at.y, at.z)
  return createHash('sha256').update(JSON.stringify([block?.known, block?.name, block?.runtimeId, block?.properties, contents?.(at) ?? null])).digest('hex')
}

// "Full" is a conclusion about these received slots and this cargo, not a
// permanent property of a cell. New receipts, changed cargo or a changed
// block invalidate it. Wake/reload also discard it before a new evaluation.
function refreshCapacity (goal, { getBlock, contents, cargo }) {
  const plan = cargoKey(cargo)
  goal.full = goal.full.filter(at => {
    const seen = goal.fullObservations?.[key(at)]
    return seen && seen.cargo === plan && seen.sourceObservation === observation(getBlock, contents, seen.source) && seen.cellObservation === observation(getBlock, contents, at)
  })
  const kept = new Set(goal.full.map(key))
  for (const entry of Object.keys(goal.fullObservations ?? {})) if (!kept.has(entry)) delete goal.fullObservations[entry]
}

function rememberFull (goal, at, { getBlock, contents, cargo }) {
  const pair = pairedChest(getBlock, at, contents), source = { x: at.x, y: at.y, z: at.z }
  goal.fullObservations ??= {}
  for (const cell of [at, pair].filter(Boolean)) {
    if (!goal.full.some(other => same(other, cell))) goal.full.push({ x: cell.x, y: cell.y, z: cell.z })
    goal.fullObservations[key(cell)] = { source, cargo: cargoKey(cargo), sourceObservation: observation(getBlock, contents, source), cellObservation: observation(getBlock, contents, cell) }
  }
}

module.exports = { refreshCapacity, rememberFull }
