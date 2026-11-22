'use strict'

// A held workstation is put down beside the Bot; in a one-wide tunnel a niche
// is mined for it. Live 2026-11-18 18:31-20:00 JST: at y=40 in its own tunnel
// the expedition tried the same five rock cells every two seconds, with no
// log line, and 「iron_pickaxe を準備しています（0/1）」 stood for 90 minutes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { placementTopVisible } = require('../src/actions/action-access')
const { placeStation, openSpots, wallSpots } = require('../src/modes/station-room')

const key = (x, y, z) => `${x},${y},${z}`
// Rock everywhere, with the listed cells open (or holding another block).
function world (open, other = {}) {
  const cells = new Map(open.map(([x, y, z]) => [key(x, y, z), 'minecraft:air']))
  for (const [where, name] of Object.entries(other)) cells.set(where, name)
  const getBlock = (x, y, z) => { const name = cells.get(key(x, y, z)) ?? 'minecraft:stone'; return { known: true, name, boundingBox: /air$/.test(name) ? 'empty' : 'block', extra: [] } }
  return { cells, getBlock }
}
const FEET = { x: -4889.5, y: 40, z: -4976.4 }
// The tunnel of the live case: the Bot's two cells, and the step it came down (one east, one up).
const tunnel = () => world([[-4890, 40, -4977], [-4890, 41, -4977], [-4889, 41, -4977], [-4889, 42, -4977]])
function hands (w, { refuse = () => false, lines = [] } = {}) {
  const mined = []
  return { mined, lines, canMine: cell => !refuse(cell), mine: async cell => { mined.push(cell); w.cells.set(key(cell.x, cell.y, cell.z), 'minecraft:air'); return true } }
}
const placer = (w, { fail = () => false } = {}) => { const placed = []; return { placed, place: async cell => { placed.push(cell); if (fail(cell)) return false; w.cells.set(key(cell.x, cell.y, cell.z), 'minecraft:crafting_table'); return true } } }

test('in the one-wide tunnel of the live case there is no open cell; one wall block is mined and the table stands in the niche', async () => {
  const w = tunnel(), h = hands(w), p = placer(w), lines = []
  assert.deepEqual(openSpots(w.getBlock, FEET), [])
  assert.equal(wallSpots(w.getBlock, FEET).length, 4)
  const at = await placeStation({ getBlock: w.getBlock, feet: FEET, place: p.place, hands: h, log: line => lines.push(line), label: '作業台' })
  assert.deepEqual(at, { x: -4889, y: 40, z: -4977 })
  assert.deepEqual(h.mined, [at])
  assert.deepEqual(p.placed, [at])
  assert.equal(w.getBlock(at.x, at.y, at.z).name, 'minecraft:crafting_table')
  assert.match(lines[0], /作業台を置く場所がないため、横の壁を1マス掘ります/)
})

test('on open ground the first fixed cell is used and nothing is mined', async () => {
  const open = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) open.push([x, 64, z], [x, 65, z])
  const w = world(open), h = hands(w), p = placer(w)
  const at = await placeStation({ getBlock: w.getBlock, feet: { x: 0.5, y: 64, z: 0.5 }, place: p.place, hands: h })
  assert.deepEqual(at, { x: 2, y: 64, z: 0 })
  assert.deepEqual(h.mined, [])
})

test('ore, an unknown wall, a wall over air and a wall the mining check refuses are not opened', async () => {
  const w = tunnel()
  w.cells.set(key(-4889, 40, -4977), 'minecraft:iron_ore') // east
  w.cells.set(key(-4891, 39, -4977), 'minecraft:air') // west wall has no floor
  const unknown = (x, y, z) => x === -4890 && y === 40 && z === -4978 ? { known: false } : w.getBlock(x, y, z) // north not received
  const south = { x: -4890, y: 40, z: -4976 }
  assert.deepEqual(wallSpots(unknown, FEET), [south])
  const lines = []
  const h = hands(w, { refuse: cell => cell.z === south.z }), p = placer(w)
  assert.equal(await placeStation({ getBlock: unknown, feet: FEET, place: p.place, hands: h, log: line => lines.push(line), label: 'かまど' }), null)
  assert.deepEqual(h.mined, [])
  assert.deepEqual(p.placed, [])
  // The failure is said, once a minute at most.
  assert.match(lines.at(-1), /かまどを置ける場所がありません（空いたマス 0・掘れる壁 1）/)
  await placeStation({ getBlock: unknown, feet: FEET, place: p.place, hands: h, log: line => lines.push(line), label: 'かまど' })
  assert.equal(lines.length, 1)
})

test('a placement that was sent and not answered ends the search: no second cell, no niche', async () => {
  const open = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) open.push([x, 64, z], [x, 65, z])
  const w = world(open), h = hands(w), p = placer(w, { fail: () => true })
  assert.equal(await placeStation({ getBlock: w.getBlock, feet: { x: 0.5, y: 64, z: 0.5 }, place: p.place, retrySafe: () => false, hands: h }), null)
  assert.equal(p.placed.length, 1)
  assert.deepEqual(h.mined, [])
})

test('a refused cell that is safe to retry moves on to the next open cell, then to a niche', async () => {
  const w = world([[0, 64, 0], [0, 65, 0], [1, 64, 0], [1, 65, 0]]), h = hands(w), p = placer(w, { fail: cell => cell.x === 1 })
  const at = await placeStation({ getBlock: w.getBlock, feet: { x: 0.5, y: 64, z: 0.5 }, place: p.place, hands: h })
  assert.deepEqual(p.placed[0], { x: 1, y: 64, z: 0 })
  assert.deepEqual(at, { x: -1, y: 64, z: 0 })
  assert.deepEqual(h.mined, [at])
})

test('a safe placement refusal can move to a nearby confirmed view before mining a niche', async () => {
  const open = []
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) open.push([x, 64, z], [x, 65, z])
  const w = world(open), h = hands(w)
  let feet = { x: 0.5, y: 64, z: 0.5 }, walked = false
  const place = async cell => {
    if (!walked) return false
    assert.ok(placementTopVisible({ state: { position: { ...feet, y: feet.y + 1.62 } },
      target: cell, getBlock: p => w.getBlock(p.x, p.y, p.z) }))
    return true
  }
  const at = await placeStation({ getBlock: w.getBlock, feet, getFeet: () => feet, place,
    hands: { ...h, walk: async target => { feet = target; walked = true; return true } } })
  assert.ok(at)
  assert.equal(walked, true)
  assert.deepEqual(h.mined, [])
})

test('a stop in the middle places nothing more', async () => {
  const w = tunnel(), h = hands(w), p = placer(w)
  let stop = false
  const mine = async cell => { stop = true; return h.mine(cell) }
  assert.equal(await placeStation({ getBlock: w.getBlock, feet: FEET, place: p.place, hands: { ...h, mine }, cancelled: () => stop }), null)
  assert.deepEqual(p.placed, [])
})
