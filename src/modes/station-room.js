'use strict'

// Where a held workstation (crafting table, furnace) is put down beside the
// Bot, and room made for it when there is none.
//
// The expedition's supplies tried five fixed cells at the feet's height and
// nothing else. In its own one-wide tunnel all five are rock: every two
// seconds the same placement failed, with no log line and no step (real Realm
// 2026-11-18 18:31-20:00 JST: at y=40, a crafting table in hand, 「iron_pickaxe
// を準備しています（0/1）」 for an hour and a half).
//
// Order: the open cells first (received air with a received solid floor), the
// five fixed cells before the direct neighbours; then one block of plain rock
// in a wall beside the feet is mined by the ordinary mining and the station
// goes into the niche. Ore, unknown cells and anything the mining check
// refuses are left alone. A placement that was sent and not answered ends the
// search (no second station while the first may still appear).
// A cell the placement takes is received air and nothing else (actions/interactions.js `placementPlan`), and a
// click's line passes air only (actions/interaction-sight.js). Until 2026-11-20 short grass, ferns and leaf litter
// counted as open here and none of them could be placed in; and from a cell that holds a plant the line to the
// floor of every cell beside it crosses that plant. Live 03:49-03:55 JST on a forest floor, standing in leaf litter:
// 「作業台を置ける場所がありません（空いたマス 8・掘れる壁 0）」 for six minutes; seven of the eight were litter, the
// eighth was air behind the Bot's own litter cell. So: open is air; and when nothing could be placed from a cell
// that holds a plant, the Bot first steps onto bare ground that has bare ground beside it (`bareStance`) and
// places from there. Litter is not swept: leaves and litter are never broken.
const { planPlacementAccess, placementTopVisible } = require('../actions/action-access')
const OPEN = /^minecraft:(?:air|cave_air|void_air)$/
const ROCK = /^minecraft:(?:stone|deepslate|andesite|diorite|granite|tuff|dirt|grass_block|cobblestone|cobbled_deepslate|netherrack)$/
const FIXED = [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1]]
const BESIDE = [[1, 0], [-1, 0], [0, 1], [0, -1], [-1, -1], [1, -1], [-1, 1]]
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// After those, every other cell within three (nearest first): where the cells beside the feet hold plants, a cell of
// air a step further is still in the click's reach, and the placement itself answers for reach and line.
const AROUND = (() => {
  const taken = new Set([[0, 0], ...FIXED, ...BESIDE].map(String)), out = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (!taken.has(String([dx, dz]))) out.push([dx, dz])
  return out.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))
})()
const SAY_MS = 60000, TRY_MS = 20000

const cellOf = feet => ({ x: Math.floor(feet.x), y: Math.floor(feet.y + 0.05), z: Math.floor(feet.z) })
const solid = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length

function openSpots (getBlock, feet) {
  const at = cellOf(feet), out = []
  for (const [dx, dz] of [...FIXED, ...BESIDE, ...AROUND]) {
    const cell = { x: at.x + dx, y: at.y, z: at.z + dz }, here = getBlock(cell.x, cell.y, cell.z)
    if (here?.known === true && OPEN.test(here.name ?? '') && !here.extra?.length && solid(getBlock(cell.x, cell.y - 1, cell.z))) out.push(cell)
  }
  return out
}

// A cell of air to stand on (solid floor, air for the head) with a cell of air right beside it, nearest first:
// from there the line to that neighbour's floor crosses air only.
function bareStance (getBlock, feet) {
  const at = cellOf(feet), bare = cell => { const here = getBlock(cell.x, cell.y, cell.z); return here?.known === true && OPEN.test(here.name ?? '') && !here.extra?.length }
  const ground = cell => bare(cell) && solid(getBlock(cell.x, cell.y - 1, cell.z))
  const cells = [...FIXED, ...BESIDE, ...AROUND].map(([dx, dz]) => ({ x: at.x + dx, y: at.y, z: at.z + dz }))
    .sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))
  return cells.find(cell => ground(cell) && bare({ ...cell, y: cell.y + 1 }) && SIDES.some(([dx, dz]) => ground({ x: cell.x + dx, y: cell.y, z: cell.z + dz }))) ?? null
}
function placementAccess (getBlock, feet) {
  const targetCells = openSpots(getBlock, feet)
  if (!targetCells.length) return null
  const at = cellOf(feet), blocks = []
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -5; dy <= 3; dy++) {
    const position = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
    const ground = getBlock(position.x, position.y, position.z)
    if (solid(ground)) blocks.push({ ...ground, position })
  }
  const read = position => {
    const block = getBlock(position.x, position.y, position.z)
    return !block || block.position ? block : { ...block, position }
  }
  return planPlacementAccess({ state: { position: { ...feet, y: feet.y + 1.62 } }, targets: targetCells, blocks, getBlock: read })
}

// The feet's own cell holds a plant (litter, grass, a flower): something received that is not air and has no body.
const inPlant = (getBlock, feet) => { const at = cellOf(feet), here = getBlock(at.x, at.y, at.z); return here?.known === true && !OPEN.test(here.name ?? '') && here.boundingBox === 'empty' && !here.extra?.length }

// Wall blocks beside the feet that may be opened: plain rock on a solid floor.
function wallSpots (getBlock, feet) {
  const at = cellOf(feet), out = []
  for (const [dx, dz] of SIDES) {
    const cell = { x: at.x + dx, y: at.y, z: at.z + dz }, here = getBlock(cell.x, cell.y, cell.z)
    if (solid(here) && ROCK.test(here.name ?? '') && !here.protected && !here.protectionSource && solid(getBlock(cell.x, cell.y - 1, cell.z))) out.push(cell)
  }
  return out
}

const said = new Map()
function sayOnce (log, text, now = Date.now()) {
  if (now - (said.get(text) ?? -Infinity) < SAY_MS) return
  if (said.size > 32) said.clear()
  said.set(text, now); log(`プレイヤーモード: ${text}`)
}

// `why`: the placement's last refusal, for the line that says nothing could be placed.
// `getFeet`: where the Bot stands after a step (received), for the step onto bare ground.
async function placeStation ({ getBlock, feet, getFeet = null, place, retrySafe = () => true, hands = null, cancelled = () => false, log = () => {}, label = '設備', why = () => null, now = Date.now }) {
  if (!feet) return null
  const end = now() + TRY_MS
  // The open cells from where the Bot stands; false when a placement was sent and not answered.
  async function open () {
    for (const cell of openSpots(getBlock, feet)) {
      if (cancelled()) return false
      // A placement that waits on another operation takes seconds a cell: the rest is for the next look.
      if (now() > end) break
      if (await place(cell)) return cell
      if (!retrySafe()) return false
    }
    return null
  }
  let put = await open()
  if (put !== null) return put || null
  // Standing in a plant, every line to a floor beside the feet crosses it: onto bare ground first, once.
  const stance = hands?.walk && getFeet && inPlant(getBlock, feet) ? bareStance(getBlock, feet) : null
  if (stance && !cancelled()) {
    log(`プレイヤーモード: 草・落ち葉のマスからは${label}を置く床が見えないため、何もないマス (${stance.x}, ${stance.y}, ${stance.z}) へ移ってから置きます`)
    await hands.walk({ x: stance.x + 0.5, y: stance.y, z: stance.z + 0.5 })
    const after = getFeet()
    if (cancelled() || !after) return null
    feet = after
    if (!inPlant(getBlock, feet)) { put = await open(); if (put !== null) return put || null }
  }
  if (hands?.walk && getFeet && !cancelled() && now() < end) {
    const access = placementAccess(getBlock, feet)
    if (access) {
      const arrived = await hands.walk(access.standpoint)
      const after = getFeet()
      if (cancelled() || !after) return null
      feet = after
      const state = { position: { ...after, y: after.y + 1.62 } }
      if (arrived && placementTopVisible({ state, target: access.target, getBlock: p => getBlock(p.x, p.y, p.z) })) {
        if (await place(access.target)) return access.target
        if (!retrySafe()) return null
      }
    }
  }
  const walls = hands ? wallSpots(getBlock, feet) : []
  for (const cell of walls) {
    if (cancelled()) return null
    if (!hands.canMine(cell) && !(await hands.pick?.(cell) && hands.canMine(cell))) continue
    log(`プレイヤーモード: ${label}を置く場所がないため、横の壁を1マス掘ります（${cell.x}, ${cell.y}, ${cell.z}）`)
    if (!await hands.mine(cell) || cancelled()) continue
    if (await place(cell)) return cell
    if (!retrySafe()) return null
  }
  const refusal = why()
  sayOnce(log, `${label}を置ける場所がありません（空いたマス ${openSpots(getBlock, feet).length}・掘れる壁 ${walls.length}${refusal ? `・${String(refusal).slice(0, 60)}` : ''}）`)
  return null
}

module.exports = { placeStation, openSpots, wallSpots, bareStance }
