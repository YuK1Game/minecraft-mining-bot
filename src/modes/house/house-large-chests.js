'use strict'

const { placements, matches } = require('./house-blueprint')
const { stands } = require('./house-steps')

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
async function verifyHouseChests ({ origin, getBlock, getFeet, hands, ports, aborted, confirmed = [], complete = async () => true }) {
  const out = [...confirmed]
  for (const pair of chestPairs(origin)) {
    if (aborted()) break
    const first = pair[0].position
    if (out.some(at => same(at, first)) || !pair.every(step => standing(step, getBlock))) continue
    let verified = false
    for (const step of pair) {
      const position = step.position
      let receipt = await ports.inspectChest?.(position, { aborted })
      if (aborted()) break
      if (receipt?.status === 'completed') { verified = receipt.evidence?.slotCount === 54; break }
      // The first click can be behind a wall or out of reach. Try known
      // standing cells, using the same movement as ordinary house placement.
      if (!['CONTAINER_NOT_IN_REACH', 'CONTAINER_NOT_VISIBLE'].includes(receipt?.code)) continue
      for (const stand of stands(getBlock, { position, item: 'chest' }, { clicked: position, face: 1, clickY: null }, getFeet() ?? position, { reach: 3.8, radius: 3 }).slice(0, 4)) {
        if (aborted()) break
        if (!await hands.walk(stand) || aborted()) continue
        receipt = await ports.inspectChest?.(position, { aborted })
        if (receipt?.status === 'completed') { verified = receipt.evidence?.slotCount === 54; break }
        if (!['CONTAINER_NOT_IN_REACH', 'CONTAINER_NOT_VISIBLE'].includes(receipt?.code)) break
      }
      if (verified || aborted()) break
    }
    if (verified && !aborted() && await complete(first) && !aborted()) out.push({ ...first })
  }
  return out
}

module.exports = { chestPairs, neededChests, verifyHouseChests }
