'use strict'

// The things in the starter house a job needs, read from the received blocks now.
//
// "The house is finished" (the record's `done`) says nothing about one thing in it today: a blast takes the
// bed or one chest and leaves the rest, and a wall with a hole does not stop a furnace from cooking. A job
// asks for the one thing it needs:
// - bed: the blueprint's bed;
// - chest: one of the two large chests (A, then B: either pair is a place to store);
// - furnace: one of the two furnaces;
// - table: the crafting table;
// - entrance: the floor through the doorway (the three floor blocks in the door's column) and a doorway that
//   holds a door or nothing. A missing door is still a way in.
//
// The answer is one of:
// - standing: every block of one alternative is received and is what the blueprint draws (`at`: its block);
// - broken: no alternative stands and none is unreceived (`missing`: the steps of the nearest-to-whole one);
// - unknown: no alternative stands and one has unreceived cells. Unreceived is never broken and never standing;
// - spent: an alternative stands, and the caller's own use of every standing one has failed (`spent(at)`).
// Standing blocks are not yet "usable": the walk to it, the open click, the received 54 slots and the cook are
// the existing steps' own checks, and their failures are told to the goal's ledger (goal/goal-ledger.js).
const { placements, matches } = require('./house-blueprint')
const { chestPairs } = require('./house-large-chests')

const NAMES = Object.freeze(['bed', 'chest', 'furnace', 'table', 'entrance'])
const LABEL = Object.freeze({ bed: 'ベッド', chest: 'ラージチェスト', furnace: 'かまど', table: '作業台', entrance: '入口' })
const TABLE = 'p_178', DOOR = 'p_172'
// Things made at the crafting table: without the table they cannot be made again.
const CRAFTED = new Set(['white_bed', 'chest', 'furnace', 'oak_door', 'oak_slab'])

const read = (getBlock, cell) => getBlock(cell.x, cell.y, cell.z)
// One blueprint step in the received world.
function stepState (getBlock, step) {
  let unknown = false
  for (const cell of step.cells) {
    const block = read(getBlock, cell)
    if (block?.known !== true) { unknown = true; continue }
    if (!matches(step.item, block)) return 'missing'
  }
  return unknown ? 'unknown' : 'standing'
}

const passable = block => block?.known === true && (block.boundingBox ? block.boundingBox !== 'block' : /^minecraft:(?:air|cave_air)$/.test(block.name ?? ''))
// The doorway: a door, or nothing in the way.
function doorway (getBlock, door) {
  let unknown = false
  for (const cell of door.cells) {
    const block = read(getBlock, cell)
    if (block?.known !== true) { unknown = true; continue }
    if (!matches('oak_door', block) && !passable(block)) return 'missing'
  }
  return unknown ? 'unknown' : 'standing'
}

// The alternatives of one thing: each a list of blueprint steps that must all stand.
function groups (origin, name) {
  const steps = placements(origin), by = id => steps.find(step => step.id === id)
  switch (name) {
    case 'bed': return [steps.filter(step => step.item === 'white_bed')]
    case 'chest': return chestPairs(origin)
    case 'furnace': return steps.filter(step => step.item === 'furnace').map(step => [step])
    case 'table': return [[by(TABLE)]]
    case 'entrance': { const door = by(DOOR); return [steps.filter(step => step.phase === 'foundation' && step.position.x === door.position.x && Math.abs(step.position.z - door.position.z) <= 1)] }
    default: throw new Error(`Unknown house facility: ${name}`)
  }
}

function facility (getBlock, origin, name, { spent = () => false, prefer = null } = {}) {
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z
  const door = name === 'entrance' ? placements(origin).find(step => step.id === DOOR) : null
  const seen = groups(origin, name).map((steps, index) => {
    const states = steps.map(step => stepState(getBlock, step))
    if (door) states.push(doorway(getBlock, door))
    const at = name === 'entrance' ? door.position : steps[0].position
    return { index, at, steps, missing: steps.filter((step, i) => states[i] === 'missing'), state: states.includes('missing') ? 'missing' : states.includes('unknown') ? 'unknown' : 'standing' }
  })
  // The one used before comes first while it stands, so a kit is not split over two chests.
  const order = [...seen].sort((a, b) => Number(same(b.at, prefer)) - Number(same(a.at, prefer)))
  const standing = order.filter(group => group.state === 'standing')
  const free = standing.find(group => !spent(group.at))
  const answer = (state, group, missing = []) => ({ name, state, at: { ...(group ?? seen[0]).at }, alternative: (group ?? seen[0]).index > 0, missing })
  if (free) return answer('standing', free)
  if (standing.length) return answer('spent', standing[0])
  const unknown = order.find(group => group.state === 'unknown')
  if (unknown) return answer('unknown', unknown)
  const nearest = [...order].sort((a, b) => a.missing.length - b.missing.length)[0]
  // (A doorway with a foreign block in it is broken with no blueprint step missing.)
  return answer('broken', nearest, nearest.missing)
}

// The steps that put one broken thing back: its own missing steps, the floor under them when that is gone too,
// and the crafting table when the thing is made at it. Ids, in no order (house-build.js orders them).
function repairSteps (getBlock, origin, name) {
  const steps = placements(origin), found = facility(getBlock, origin, name)
  if (found.state !== 'broken') return []
  const ids = new Set(found.missing.map(step => step.id))
  const add = step => { if (step && !ids.has(step.id) && stepState(getBlock, step) === 'missing') ids.add(step.id) }
  if (found.missing.some(step => CRAFTED.has(step.item))) add(steps.find(step => step.id === TABLE))
  for (const id of [...ids]) {
    const support = steps.find(step => step.id === id)?.support?.position
    if (support) add(steps.find(step => step.cells.some(cell => cell.x === support.x && cell.y === support.y && cell.z === support.z)))
  }
  return [...ids]
}

module.exports = { NAMES, LABEL, stepState, facility, repairSteps }
