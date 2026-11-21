'use strict'

// A block the expedition's gathering could not take rests, and the next nearest ones get their turn
// (src/modes/supply-cell-rest.js, `collect` and `inView` in dragon-supply-gather.js).
// Real Realm 2026-11-20 17:23:58-17:33:25 JST (main dfdcac3): beside an underground lake, feet (9916.5, 58.0, 10162.1),
// with raw iron to smelt and no fuel (「iron_chestplate を準備しています（0/2）。」), 49 coal ores within twelve blocks.
// About once a second, for ten minutes: 「掘る・積む道もありません（NO_BUILD_ROUTE・調べたマス 626）」「…810」, a walk of
// one step, 「…574」「…674」, a walk of three steps, two walks of one step, and round again; 「掘った 0 個」 every time,
// 448 such lines in three minutes, no coal. The goal's ledger warned after five minutes.
// The blocks are the ones received there (test/fixtures/mine-cave-back-and-forth.json: GET /blocks 17:33:26 JST,
// x 9908..9924, y 50..64, z 10154..10170, every cell received; only names were read, the water is given as sources).
// On main dfdcac3 this scene gives a round of four cells from the third tick on and no coal in fourteen ticks, with
// the same two counts 574 and 674 as the live log.
// Real here: the caller (`collect`), the route to an ore's side (`approachOre`), the mine's heading (`searchMine`),
// the dig-and-stack walk and its planner, the scaffold's hands, the navigation's planner and physics.
// Stand-in: the server (helpers/dig-world.js), with the mining check's own rule for liquid beside a block.
// Outside what was read: not received.
const test = require('node:test')
const assert = require('node:assert/strict')
const { collect, inView } = require('../src/modes/dragon-supply-gather')
const { cellRest, REST_MS, TRIES } = require('../src/modes/supply-cell-rest')
const { createDigWorld } = require('./helpers/dig-world')
const received = require('./fixtures/mine-cave-back-and-forth.json')

// As at 17:33:26 JST: the iron pickaxe (188 left), a stone pickaxe that no longer digs, raw iron, no coal.
const scene = () => createDigWorld(received, { outside: () => null, items: [
  { slot: 0, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 188 },
  { slot: 1, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 2 },
  { slot: 2, name: 'minecraft:raw_iron', count: 3 }, { slot: 3, name: 'minecraft:cobblestone', count: 64 }] })
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const wet = (w, cell) => SIDES.some(([dx, dy, dz]) => w.getBlock(cell.x + dx, cell.y + dy, cell.z + dz).name === 'minecraft:water')
const LEFT = /を掘れなかったため、しばらくほかを先に試します/
const key = cell => `${cell.x},${cell.y},${cell.z}`

test('cobblestone collection uses an exposed face instead of repeatedly approaching nearer buried stone', async () => {
  const exposed = { x: 4, y: 64, z: 0 }
  const w = createDigWorld({ x0: 0, z0: 0, feet: { x: 0.5, y: 64, z: 0.5 }, rows: {}, legend: {} },
    { outside: (x, y, z) => key({ x, y, z }) === key(exposed) || y < 62 ? 'stone' : y < 64 ? 'dirt' : 'air' })
  assert.deepEqual(inView(w.ctx, 'cobblestone').map(key), [key(exposed)])
  await collect(w.ctx, 'cobblestone')
  assert.equal(w.count('cobblestone'), 1)
  assert.deepEqual(w.minedNames, ['stone'])
  assert.equal(w.getBlock(exposed.x, exposed.y, exposed.z).name, 'minecraft:air')
  assert.equal(w.lines.some(line => LEFT.test(line)), false)
})

test('a shallow soil cover exposes stone for the next ordinary collection without a long trip', async () => {
  const w = createDigWorld({ x0: 0, z0: 0, feet: { x: 0.5, y: 64, z: 0.5 }, rows: {}, legend: {} }, {
    outside: (x, y, z) => x === 2 && y === 62 && z === 0 ? 'stone' : y === 63 ? 'grass_block' : y < 63 ? 'dirt' : 'air'
  })
  w.ctx.hands.canDig = () => { throw new Error('the rock-only hand-dig action cannot clear soil') }
  assert.deepEqual(inView(w.ctx, 'cobblestone'), [])
  await collect(w.ctx, 'cobblestone')
  assert.equal(w.getBlock(2, 63, 0).name, 'minecraft:air')
  assert.equal(w.getBlock(0, 63, 0).name, 'minecraft:grass_block')
  assert.equal(w.count('cobblestone'), 0)
  await collect(w.ctx, 'cobblestone')
  assert.equal(w.count('cobblestone'), 1)
  assert.deepEqual(w.minedNames, ['grass_block', 'stone'])
  assert.deepEqual(w.trips, [])
})

test('the received place: on coal ore beside the lake, 49 coal ores in view, the six nearest against the water', () => {
  const w = scene()
  assert.deepEqual(w.cell(), { x: 9916, y: 58, z: 10162 })
  assert.equal(w.getBlock(9916, 57, 10162).name, 'minecraft:coal_ore')
  assert.equal(w.getBlock(9915, 57, 10162).name, 'minecraft:water')
  const seen = inView(w.ctx, 'coal')
  assert.equal(seen.length, 49)
  for (const cell of seen.slice(0, 6)) {
    assert.equal(wet(w, cell), true, key(cell))
    assert.match(w.ctx.hands.reason(cell), /液体/)
  }
  // Coal the ordinary mining takes stands a few blocks further.
  assert.ok(seen.some(cell => !wet(w, cell)))
})

test('the gathering leaves the coal against the water after one try each and mines coal further off', async () => {
  const w = scene()
  const cells = []
  let ticks = 0
  while (ticks < 8 && w.count('coal') === 0) { await collect(w.ctx, 'coal'); cells.push(key(w.cell())); ticks++ }
  const log = w.lines.join('\n')
  // Before: no coal in fourteen ticks.
  assert.ok(w.count('coal') >= 1, `${cells.join(' / ')}\n${log}`)
  assert.ok(ticks <= 4, `${ticks} ticks\n${log}`)
  assert.ok(w.minedNames.includes('coal_ore'))
  // Each block that was not taken is said once, and is not tried a second time.
  const said = w.lines.filter(line => LEFT.test(line)).map(line => /\((-?\d+), (-?\d+), (-?\d+)\)/.exec(line).slice(1).join(','))
  assert.ok(said.length >= 6, log)
  assert.equal(new Set(said).size, said.length, log)
  // What rests is not in view for the search for another place, or for the choice of fuel.
  assert.equal(inView(w.ctx, 'coal').length, 49 - said.length - w.minedNames.filter(name => name === 'coal_ore').length)
  // The way to the coal was short: not the mine's heading, and few blocks.
  assert.ok(w.minedNames.length <= 24, w.minedNames.join(' '))
})

test('no round: every tick ends with coal mined or with fewer blocks left to try', async () => {
  const w = scene()
  let left = inView(w.ctx, 'coal').length
  for (let tick = 0; tick < 10 && left > 0; tick++) {
    const coal = w.count('coal')
    await collect(w.ctx, 'coal')
    const now = inView(w.ctx, 'coal').length
    assert.ok(w.count('coal') > coal || now < left, `tick ${tick}: ${left} -> ${now}\n${w.lines.join('\n')}`)
    left = now
  }
  assert.ok(w.count('coal') >= 4)
})

test('the rest itself: beside the block or no nearer rests at once, coming nearer rests after its tries, and it ends', () => {
  let time = 0
  const shared = {}
  const rest = () => cellRest(shared, 'overworld', { now: () => time })
  const a = { x: 1, y: 2, z: 3 }, b = { x: 4, y: 5, z: 6 }, c = { x: 7, y: 8, z: 9 }
  assert.equal(rest().resting(a), false)
  // Stood beside it and could not take it.
  assert.equal(rest().miss(a, 6, 2.5), true)
  assert.equal(rest().resting(a), true)
  // No nearer than the try began.
  assert.equal(rest().miss(b, 6, 5.5), true)
  // Nearer each time, never there: its tries, then it rests too.
  for (let i = 1; i < TRIES; i++) { assert.equal(rest().miss(c, 12 - i * 2 + 2, 12 - i * 2), false); assert.equal(rest().resting(c), false) }
  assert.equal(rest().miss(c, 8, 6), true)
  // Another dimension has its own blocks.
  assert.equal(cellRest(shared, 'nether', { now: () => time }).resting(a), false)
  time += REST_MS - 1
  assert.equal(rest().resting(a), true)
  time += 1
  assert.equal(rest().resting(a), false)
  assert.equal(rest().resting(b), false)
})

test('a resting block is tried again when its rest is over', async () => {
  const w = scene()
  let time = 1000
  w.ctx.now = () => time
  const nearest = inView(w.ctx, 'coal')[0]
  await collect(w.ctx, 'coal')
  assert.equal(inView(w.ctx, 'coal').some(cell => key(cell) === key(nearest)), false)
  time += REST_MS
  assert.equal(inView(w.ctx, 'coal').some(cell => key(cell) === key(nearest)), true)
})
