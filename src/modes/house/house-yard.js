'use strict'

// The ground round the starter house, and how a dug-away part of it is filled again.
// The walk out of the door and round the walls stands on the ground one cell wide round the 7x7 footprint and in
// front of the porch, at the floor's support height (origin y - 1). The gathering dug it away (real Realm 2026-11-23,
// house 9877,64,10138: cobblestone for the mine out of the ground north, east and south of the walls, down to y 57;
// the yard is protected from gathering since, house-protection.js `inYard`, but the pits stayed). 2026-11-24
// 19:26-19:33 JST: the return to the base chest walked into the pit south of the door (9870, 60, 10150), four under
// the floor, found no way up to the door, and a skeleton above shot the Bot from 19 to 1 health and then dead.
// User 2026-11-24 20:05 JST (card): the Bot fills it in itself.
// - A ring cell is a step only while it is received as air. Natural ground there counts as standing; a cell not
//   received, or a column with no received floor within DEPTH, is not a step (unknown is not claimed as damage).
// - The whole air column under a ring cell down to its received floor is filled: each of its cells is one step of
//   cobblestone (so the house's material count holds the real number).
// - It is filled from the column's floor up by the pillar step (the ordinary jump and placement, counted by the
//   received block, one block less and the landing). From the house or the porch no face of a pit cell is in view,
//   and the side face of the block under the feet is never in view from above it: the pillar is the placement that
//   needs no face but the floor.
// - The Bot reaches a column's floor by the walk that digs and stacks (player-build-walk.js), on a view where the house
//   and the ring's columns read as built: the walk never digs what was just filled (it did, in the first try).
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const DEPTH = 8
const MISSES = 2 // columns the Bot could not stand in before a run gives up (the next run, 3 s later, tries again)

const isAir = block => block?.known === true && AIR.test(block.name ?? '') && !block.extra?.length
const isFloor = block => block?.known === true && block.boundingBox === 'block' && !/water|lava/.test(block.name ?? '')

// The ring columns, nearest the porch's front first (the way out of the door is opened first).
function ringColumns (origin) {
  const columns = []
  for (let dz = -1; dz <= 8; dz++) for (let dx = -1; dx <= 7; dx++) {
    if (dx >= 0 && dx <= 6 && dz >= 0 && dz <= 6) continue
    if (dx >= 2 && dx <= 4 && dz === 7) continue // under the porch: the porch is the stand there
    columns.push({ dx, dz, x: origin.x + dx, z: origin.z + dz })
  }
  const front = { x: origin.x + 3, z: origin.z + 8 }
  const far = column => Math.hypot(column.x - front.x, column.z - front.z)
  return columns.sort((a, b) => far(a) - far(b) || a.x - b.x || a.z - b.z)
}

// The air cells of one ring column, top down, and its received floor; null while the column cannot be told.
function columnGap (getBlock, origin, column) {
  const top = origin.y - 1
  if (!isAir(getBlock(column.x, top, column.z))) return null
  const cells = []
  for (let y = top; y > top - DEPTH; y--) {
    const found = getBlock(column.x, y, column.z)
    if (isAir(found)) { cells.push({ x: column.x, y, z: column.z }); continue }
    return isFloor(found) ? { column, cells, floorY: y } : null
  }
  return null
}

// The steps the ground round the house still needs, in the blueprint's step shape (house-blueprint.js `remaining`).
function yardSteps (getBlock, origin) {
  if (!origin || typeof getBlock !== 'function') return []
  const steps = []
  for (const column of ringColumns(origin)) {
    const gap = columnGap(getBlock, origin, column)
    if (!gap) continue
    for (const position of [...gap.cells].reverse()) steps.push({ id: `yard_${column.dx}_${column.dz}_${position.y - origin.y}`, phase: 'yard', item: 'cobblestone', wood: null, position, cells: [position], look: null, half: null, support: null, ground: true })
  }
  return steps
}

// Fill the gaps: to each column's floor, then the pillar up to the ground's height. One try a column a run.
// hands: the scaffold's hands (feet, block, walk, pillar, fill); build: the walk that digs and stacks.
function ringKeys (origin) {
  const keys = new Set()
  for (const column of ringColumns(origin)) for (let y = origin.y - 1; y > origin.y - 1 - DEPTH; y--) keys.add(`${column.x},${y},${column.z}`)
  return keys
}
// player-build-walk.js reads the house's blueprint, which reads this file: required when a fill runs.
async function fillYard ({ origin, getBlock, hands, aborted = () => false, log = () => {}, centre = null, memo = null, sleep = undefined }) {
  const { createBuildWalk, createMemo } = require('../player-build-walk')
  const say = text => log(`プレイヤーモード: ${text}`)
  const ring = ringKeys(origin)
  const kept = (x, y, z) => { const found = hands.block(x, y, z); return found?.known === true && found.boundingBox === 'block' && ring.has(`${x},${y},${z}`) ? { ...found, natural: false, yardBlock: true } : found }
  const build = createBuildWalk({ hands: { ...hands, block: kept }, getHouse: () => ({ origin }), log, memo: memo ?? createMemo(), sleep })
  const cellOf = () => { const at = hands.feet(); return at ? { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } : null }
  // Standing on the floor: the feet at the cell's bottom within 0.01, once landed by the ordinary settle.
  const standing = async cell => {
    for (let round = 0; round < 2; round++) {
      const feet = hands.feet()
      if (feet && Math.floor(feet.x) === cell.x && Math.floor(feet.z) === cell.z && Math.abs(feet.y - cell.y) < 0.01) return true
      if (round === 0 && !(await hands.land?.())) return false
    }
    return false
  }
  let placed = 0, tried = 0, why = null, missed = 0
  for (const column of ringColumns(origin)) {
    if (aborted()) break
    const gap = columnGap(getBlock, origin, column)
    if (!gap) continue
    if ((hands.fill?.() ?? 0) <= 0) { why = 'NO_BLOCK'; break }
    tried++
    const bottom = { x: column.x, y: gap.floorY + 1, z: column.z }
    const at = (cell, to) => !!cell && cell.x === to.x && cell.y === to.y && cell.z === to.z
    if (!at(cellOf(), bottom)) {
      const walked = await hands.walk({ x: bottom.x + 0.5, y: bottom.y, z: bottom.z + 0.5 }) && at(cellOf(), bottom)
      if (!walked && !aborted()) await build(bottom, { done: cell => at(cell, bottom), aborted })
      if (aborted()) break
      if (!at(cellOf(), bottom)) { why = `COLUMN_UNREACHED:${hands.why?.() ?? ''}`; if (++missed >= MISSES) break; continue }
    }
    if (!await standing(bottom)) { why = 'COLUMN_FLOOR_UNCONFIRMED'; if (++missed >= MISSES) break; continue }
    while (!aborted()) {
      const now = cellOf()
      if (!now || now.x !== column.x || now.z !== column.z || now.y >= origin.y) break
      if (!await standing(now)) { why = 'PILLAR:FLOOR_UNCONFIRMED'; break }
      if (centre) await centre({ x: column.x, z: column.z }, now.y)
      if (aborted()) break
      const up = await hands.pillar({ x: column.x, z: column.z }, now.y, { any: true })
      const after = cellOf()
      // A step refused mid-jump leaves the body in the air: it is landed by the ordinary settle before anything else.
      if (!up?.ok || !after || after.y !== now.y + 1) { why = `PILLAR:${up?.reason ?? hands.why?.() ?? 'BLOCKED'}`; await hands.land?.(); break }
      placed++
    }
  }
  if (tried) say(`拠点の家: まわりの掘られた地面を ${placed} 個埋め戻しました${why && !placed ? `（${String(why).slice(0, 60)}）` : ''}`)
  return { placed, tried, why }
}

module.exports = { ringColumns, columnGap, yardSteps, fillYard, DEPTH }
