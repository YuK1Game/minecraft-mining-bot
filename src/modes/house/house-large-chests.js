'use strict'

const { placements, matches } = require('./house-blueprint')
const { createOpenStand } = require('../open-stand')

const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const standing = (step, getBlock) => step.cells.every(at => matches('chest', getBlock(at.x, at.y, at.z)))

// These are blueprint pairs only. Actual joining is proved by opening them.
function chestPairs (origin) {
  const chests = placements(origin).filter(step => step.item === 'chest')
  const used = new Set(), pairs = []
  for (const step of chests) {
    if (used.has(step.id)) continue
    const mate = chests.find(other => !used.has(other.id) && other.id !== step.id && other.look === step.look && other.position.y === step.position.y && Math.abs(other.position.x - step.position.x) + Math.abs(other.position.z - step.position.z) === 1)
    if (!mate) continue
    used.add(step.id); used.add(mate.id); pairs.push([step, mate])
  }
  return pairs
}

function neededChests (step, origin, getBlock) {
  const pair = chestPairs(origin).find(pair => pair.some(other => other.id === step.id))
  return pair ? pair.filter(other => !standing(other, getBlock)).length : 2
}

// Receive each complete container before closing the doorway or calling the
// house finished. A received 27-slot window is a failed pair, not success.
async function verifyHouseChests ({ origin, getBlock, getFeet, hands, ports, aborted, build = null, confirmed = [], complete = async () => true }) {
  const out = [...confirmed]
  const access = createOpenStand({ getBlock, getFeet, walk: at => hands.walk(at) })
  const outOfReach = receipt => ['CONTAINER_NOT_IN_REACH', 'CONTAINER_NOT_VISIBLE'].includes(receipt?.code)
  for (const pair of chestPairs(origin)) {
    if (aborted()) break
    const first = pair[0].position
    if (out.some(at => same(at, first)) || !pair.every(step => standing(step, getBlock))) continue
    let verified = false
    for (const step of pair) {
      const position = step.position
      let receipt = await ports.inspectChest?.(position, { aborted })
      if (aborted()) break
      if (outOfReach(receipt) && await access.go(position, aborted) && !aborted()) {
        receipt = await ports.inspectChest?.(position, { aborted })
      }
      if (build && !aborted() && outOfReach(receipt)) {
        const route = await build(position, { done: cell => access.opens(cell, position), aborted })
        if (route?.ok && !aborted()) receipt = await ports.inspectChest?.(position, { aborted })
      }
      if (aborted()) break
      if (receipt?.status === 'completed') { verified = receipt.evidence?.slotCount === 54; break }
    }
    if (verified && !aborted() && await complete(first) && !aborted()) out.push({ ...first })
  }
  return out
}

module.exports = { chestPairs, neededChests, verifyHouseChests }
