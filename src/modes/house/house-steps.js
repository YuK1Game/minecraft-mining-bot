'use strict'

// How one blueprint step is placed: which received block to click, on which
// face, and where to stand.
// - A step with a support in the blueprint (door, bed, chests, table,
//   furnaces, torches) clicks that support's face.
// - Otherwise the block below, top face. A roof slab with nothing below
//   clicks the side of a slab or block beside it low on the face (a bottom
//   slab); any other block clicks a solid block beside it.
// - Stands: received solid ground (or a placed block) with two open cells
//   above, within reach of the click point. A step with a look direction
//   (chests, furnaces, the door, the bed) is placed from a stand behind it
//   along that direction, so it faces as drawn.
const FACES = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 }
const NORMAL = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
const LOOK = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 } }
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LIQUID = /water|lava/
const { low } = require('../low-block')

const solid = block => block?.known === true && !AIR.test(block.name ?? '') && !LIQUID.test(block.name ?? '') && block.boundingBox !== 'empty' && !block.extra?.length
const slabby = block => solid(block) && /_slab$/.test(block.name ?? '')
const open = block => block?.known === true && !block.extra?.length && block.boundingBox === 'empty' && !LIQUID.test(block.name ?? '')

// [{ clicked, face, clickY }] in order of preference.
function clicks (getBlock, step) {
  const at = step.position
  if (step.support) {
    const face = FACES[step.support.face]
    return Number.isInteger(face) && solid(getBlock(step.support.position.x, step.support.position.y, step.support.position.z)) ? [{ clicked: step.support.position, face, clickY: face > 1 ? 0.5 : null }] : []
  }
  const out = []
  if (solid(getBlock(at.x, at.y - 1, at.z))) out.push({ clicked: { x: at.x, y: at.y - 1, z: at.z }, face: 1, clickY: null })
  for (let face = 2; face <= 5; face++) {
    const n = NORMAL[face], from = { x: at.x - n.x, y: at.y, z: at.z - n.z }
    const block = getBlock(from.x, from.y, from.z)
    if (step.item === 'oak_slab' ? slabby(block) || solid(block) && /_(?:planks|log|stem)$|cobblestone|glass/.test(block.name ?? '') : solid(block)) out.push({ clicked: from, face, clickY: step.item === 'oak_slab' ? 0.25 : 0.5 })
  }
  return out
}

// Whether the Bot can stand with its feet in cell (x, y, z).
function standable (getBlock, x, y, z) {
  return solid(getBlock(x, y - 1, z)) && !low(getBlock(x, y - 1, z)) && open(getBlock(x, y, z)) && open(getBlock(x, y + 1, z))
}

// Whether the straight line from `eye` to `point` passes only received open
// cells (the clicked block itself aside).
function clearLine (getBlock, eye, point, click) {
  const d = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z), n = Math.max(1, Math.ceil(d / 0.1))
  for (let i = 0; i < n; i++) {
    const t = i / n, x = Math.floor(eye.x + (point.x - eye.x) * t), y = Math.floor(eye.y + (point.y - eye.y) * t), z = Math.floor(eye.z + (point.z - eye.z) * t)
    if (x === click.x && y === click.y && z === click.z) continue
    if (!open(getBlock(x, y, z))) return false
  }
  return true
}

// Stands for a step, nearest to `from` first: feet cells whose eye is within
// reach of the click point. Stands with a received clear line to the point come
// first: a floor cell left under a wall is seen only from outside the house
// (live 2026-11-17 14:33-14:35 JST: the cobblestone at the floor's west edge,
// under the west wall, was tried three runs from the nearest stands inside,
// all 「操作対象への視線が遮られているか、未取得です」).
function stands (getBlock, step, click, from, { reach = 4.2, radius = 4 } = {}) {
  const n = NORMAL[click.face]
  const front = eye => (eye.x - point.x) * n.x + (eye.y - point.y) * n.y + (eye.z - point.z) * n.z > 0
  const seen = list => { const clear = new Set(list.filter(stand => { const eye = { x: stand.x, y: stand.y + 1.62, z: stand.z }; return front(eye) && clearLine(getBlock, eye, point, click.clicked) })); return [...list.filter(stand => clear.has(stand)), ...list.filter(stand => !clear.has(stand))] }
  const point = { x: click.clicked.x + 0.5 + n.x * 0.5, y: click.clicked.y + (click.clickY ?? 0.5 + n.y * 0.5), z: click.clicked.z + 0.5 + n.z * 0.5 }
  const out = []
  const look = step.look ? LOOK[step.look] : null
  if (look) {
    for (let k = 1; k <= 3; k++) for (const dy of [0, -1, 1]) {
      const x = step.position.x - look.x * k, z = step.position.z - look.z * k, y = step.position.y + dy
      if (standable(getBlock, x, y, z)) out.push({ x: x + 0.5, y, z: z + 0.5 })
    }
    return seen(out.filter(stand => Math.hypot(point.x - stand.x, point.y - (stand.y + 1.62), point.z - stand.z) <= reach))
  }
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -3; dy <= 1; dy++) {
    const x = step.position.x + dx, y = step.position.y + dy, z = step.position.z + dz
    if (x === step.position.x && z === step.position.z && y >= step.position.y - 1 && y <= step.position.y) continue
    if (!standable(getBlock, x, y, z)) continue
    const stand = { x: x + 0.5, y, z: z + 0.5 }
    if (Math.hypot(point.x - stand.x, point.y - (stand.y + 1.62), point.z - stand.z) <= reach) out.push(stand)
  }
  const cost = stand => Math.hypot(stand.x - from.x, stand.z - from.z) + Math.abs(stand.y - from.y) * 2
  return seen(out.sort((a, b) => cost(a) - cost(b)))
}

module.exports = { clicks, stands, standable, clearLine, FACES, LOOK }
