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
// A cell the placement takes is received air and nothing else (actions/interactions.js `placementPlan`). Until
// 2026-11-20 short grass, ferns and leaf litter counted as open here and none of them could be placed in (live
// 03:49-03:55 JST on a forest floor: 「作業台を置ける場所がありません（空いたマス 8・掘れる壁 0）」 for six minutes; seven
// of the eight were litter, the eighth was air whose click line crossed the Bot's own litter cell, see
// actions/interaction-sight.js). Litter is not swept: leaves and litter are never broken.
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
async function placeStation ({ getBlock, feet, place, retrySafe = () => true, hands = null, cancelled = () => false, log = () => {}, label = '設備', why = () => null, now = Date.now }) {
  if (!feet) return null
  const end = now() + TRY_MS
  for (const cell of openSpots(getBlock, feet)) {
    if (cancelled()) return null
    // A placement that waits on another operation takes seconds a cell: the rest is for the next look.
    if (now() > end) break
    if (await place(cell)) return cell
    if (!retrySafe()) return null
  }
  const walls = hands ? wallSpots(getBlock, feet) : []
  for (const cell of walls) {
    if (cancelled()) return null
    if (!hands.canMine(cell) && !(await hands.pick?.() && hands.canMine(cell))) continue
    log(`プレイヤーモード: ${label}を置く場所がないため、横の壁を1マス掘ります（${cell.x}, ${cell.y}, ${cell.z}）`)
    if (!await hands.mine(cell) || cancelled()) continue
    if (await place(cell)) return cell
    if (!retrySafe()) return null
  }
  const refusal = why()
  sayOnce(log, `${label}を置ける場所がありません（空いたマス ${openSpots(getBlock, feet).length}・掘れる壁 ${walls.length}${refusal ? `・${String(refusal).slice(0, 60)}` : ''}）`)
  return null
}

module.exports = { placeStation, openSpots, wallSpots }
