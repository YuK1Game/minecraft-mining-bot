'use strict'

// A route that digs and stacks where no walk leads (movement/build-route.js)
// and the job that carries it out (modes/player-build-walk.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { planBuildRoute } = require('../src/movement/build-route')
const { buildWalk } = require('../src/modes/player-build-walk')
const { stopsWhenBlocked } = require('../src/travel/travel-blocked')
const { createOverhangWorld, PILLAR, HOUSE } = require('./helpers/overhang-world')

const CHEST = { x: -4897, y: 75, z: -4983 } // the base chest
const beside = at => cell => Math.hypot(cell.x - at.x, cell.z - at.z) <= 2.5 && Math.abs(cell.y - at.y) <= 1
const inHouse = cell => cell.x >= HOUSE.x && cell.x <= HOUSE.x + 6 && cell.z >= HOUSE.z && cell.z <= HOUSE.z + 6 && cell.y >= HOUSE.y

// A small flat world: stone below y 64, air above; `set` changes cells.
function flatWorld () {
  const cells = new Map(), key = (x, y, z) => `${x},${y},${z}`
  const solid = (name, extra = {}) => ({ known: true, name: `minecraft:${name}`, boundingBox: 'block', ...extra })
  const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const getBlock = (x, y, z) => cells.get(key(x, y, z)) ?? (y < 64 ? solid('stone') : air)
  const set = (x, y, z, name, extra) => cells.set(key(x, y, z), name === 'air' ? air : name === null ? { known: false } : name === 'water' ? { known: true, name: 'minecraft:water', boundingBox: 'empty' } : solid(name, extra))
  return { getBlock, set }
}

// The hands over a block world: every step changes the world the way the server would.
function hands (world, feet, { fill = 0, refuse = () => false } = {}) {
  const body = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, did = []
  const open = (x, y, z) => world.getBlock(x, y, z).boundingBox !== 'block'
  const firm = (x, y, z) => world.getBlock(x, y, z).boundingBox === 'block'
  const stand = (x, y, z) => firm(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)
  const ports = {
    feet: () => ({ ...body }), block: world.getBlock, fill: () => fill, why: () => null, reason: () => 'refused by the mining check',
    async walk (to) {
      const x = Math.floor(to.x), z = Math.floor(to.z), cx = Math.floor(body.x), cz = Math.floor(body.z)
      // A short walk: a few cells, each a step of at most one up or down.
      if (!stand(x, to.y, z) || Math.abs(x - cx) + Math.abs(z - cz) > 4 || Math.abs(to.y - body.y) > Math.abs(x - cx) + Math.abs(z - cz)) return false
      Object.assign(body, { x: to.x, y: to.y, z: to.z }); did.push({ kind: 'walk', x, y: to.y, z })
      return true
    },
    canMine: cell => !refuse(cell) && firm(cell.x, cell.y, cell.z),
    async mine (cell) { world.setBlock(cell.x, cell.y, cell.z, 'air'); did.push({ kind: 'mine', ...cell }); return true },
    async descend (cell) {
      if (refuse(cell) || cell.x !== Math.floor(body.x) || cell.z !== Math.floor(body.z) || cell.y !== body.y - 1 || !firm(cell.x, cell.y - 1, cell.z)) return false
      world.setBlock(cell.x, cell.y, cell.z, 'air'); body.y -= 1; did.push({ kind: 'descend', ...cell })
      return true
    },
    // A floor block into a gap beside the feet, from the blocks carried.
    async bridge (cell) {
      if (fill < 1 || refuse(cell) || !open(cell.x, cell.y, cell.z)) return false
      fill--; world.setBlock(cell.x, cell.y, cell.z, 'cobblestone'); did.push({ kind: 'bridge', ...cell })
      return true
    },
    async pillar (column, feetY) {
      if (fill < 1 || !open(column.x, feetY + 2, column.z)) return { ok: false, reason: 'BLOCKED' }
      fill--; world.setBlock(column.x, feetY, column.z, 'cobblestone'); body.y = feetY + 1; did.push({ kind: 'pillar', x: column.x, y: feetY, z: column.z })
      return { ok: true }
    }
  }
  return { ports, body, did, cell: () => ({ x: Math.floor(body.x), y: body.y, z: Math.floor(body.z) }) }
}

test('the real overhang: from where the Bot stood, down the pillar it stacked and on to the base chest (live 2026-11-18 12:40 and 15:30 JST)', () => {
  const world = createOverhangWorld()
  for (const start of [{ x: -4906, y: 89, z: -4992 }, { x: -4911, y: 89, z: -4992 }]) {
    const route = planBuildRoute({ getBlock: world.getBlock, start, target: CHEST, done: beside(CHEST), blocks: 0 })
    assert.equal(route.ok, true, route.code)
    const shafts = route.steps.filter(step => step.kind === 'shaft')
    assert.equal(shafts.length, 20, 'the pillar from its top at y 88 down to the ground under the layer')
    assert.ok(shafts.every(step => step.to.x === PILLAR.x && step.to.z === PILLAR.z), 'only the column the Bot stacked')
    assert.equal(route.stack, 0)
    assert.ok(route.steps.every(step => !inHouse(step.to) && step.dig.every(cell => !inHouse(cell))), 'the house is not part of the way')
    assert.ok(beside(CHEST)(route.steps.at(-1).to))
    assert.ok(route.expanded < 12000)
  }
})

test('the real overhang, carried out: every step by the ordinary walk and the pillar descent; the pillar is gone and the house untouched', async () => {
  const world = createOverhangWorld()
  const bot = hands(world, { x: -4906, y: 89, z: -4992 })
  const log = []
  const out = await buildWalk({ ports: bot.ports, target: CHEST, done: beside(CHEST), log: line => log.push(line) })
  assert.equal(out.ok, true, log.join('\n'))
  assert.ok(beside(CHEST)(bot.cell()), JSON.stringify(bot.cell()))
  assert.equal(bot.did.filter(step => step.kind === 'descend').length, 20)
  assert.equal(bot.did.filter(step => step.kind === 'pillar').length, 0)
  for (let y = 69; y <= PILLAR.top; y++) assert.equal(world.getBlock(PILLAR.x, y, PILLAR.z).name, 'minecraft:air', `the pillar block at y ${y}`)
  assert.ok([...world.changed.keys()].every(k => { const [x, y, z] = k.split(',').map(Number); return !inHouse({ x, y, z }) }), 'no house block was changed')
  assert.equal(log.filter(line => /掘る・積む道で進みます/.test(line)).length, 1, log.join('\n'))
  assert.match(log.at(-1), /掘る・積む道で着きました/)
})

test('a pillar block the mining refuses: the way is planned again from there, and with no other way the answer is the reason, not another search', async () => {
  const world = createOverhangWorld()
  const bot = hands(world, { x: -4906, y: 89, z: -4992 }, { refuse: cell => cell.x === PILLAR.x && cell.z === PILLAR.z && cell.y === 80 })
  const log = []
  let plans = 0
  const { planBuildRouteAsync } = require('../src/movement/build-route')
  const out = await buildWalk({ ports: bot.ports, target: CHEST, done: beside(CHEST), log: line => log.push(line), plan: options => { plans++; return planBuildRouteAsync(options) } })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NO_BUILD_ROUTE', log.join('\n'))
  assert.equal(plans, 2, 'one plan, one more without the refused step, then the answer')
  assert.deepEqual(bot.cell(), { x: PILLAR.x, y: 81, z: PILLAR.z }, 'the Bot stands on the block it could not mine')
  assert.equal(log.filter(line => /掘る・積む道もありません/.test(line)).length, 1)
})

test('stacking: up a face that cannot be mined, from the blocks carried; with none carried there is no way', async () => {
  const world = flatWorld()
  // A ledge four blocks high (obsidian), three cells east of the start.
  for (let x = 3; x <= 12; x++) for (let z = -12; z <= 12; z++) for (let y = 64; y < 68; y++) world.set(x, y, z, 'obsidian')
  const start = { x: 0, y: 64, z: 0 }, target = { x: 6, y: 68, z: 0 }, done = cell => cell.x >= 3 && cell.y === 68
  const none = planBuildRoute({ getBlock: world.getBlock, start, target, done, blocks: 0, pad: 4 })
  assert.deepEqual([none.ok, none.code], [false, 'NO_BUILD_ROUTE'])
  const route = planBuildRoute({ getBlock: world.getBlock, start, target, done, blocks: 8, pad: 4 })
  assert.equal(route.ok, true)
  assert.deepEqual([route.stack, route.dig], [3, 0], 'three pillar steps, then the step onto the ledge')
  const flat = { getBlock: world.getBlock, setBlock: world.set }
  const bot = hands(flat, start, { fill: 8 })
  const out = await buildWalk({ ports: bot.ports, target, done, limits: { pad: 4 } })
  assert.equal(out.ok, true)
  assert.deepEqual([out.stacked, bot.cell().y], [3, 68])
})

test('bridging: level over a gap on blocks carried; with none carried, over lava or beside an unreceived cell there is no way', async () => {
  // A chasm three cells wide and deep, across the whole way.
  const chasm = () => { const world = flatWorld(); for (let z = -30; z <= 30; z++) for (let y = 40; y < 64; y++) for (const x of [3, 4, 5]) world.set(x, y, z, 'air'); return world }
  const start = { x: 0, y: 64, z: 0 }, target = { x: 8, y: 64, z: 0 }, done = cell => cell.x === 8 && cell.z === 0 && cell.y === 64
  const none = planBuildRoute({ getBlock: chasm().getBlock, start, target, done, blocks: 0, pad: 4 })
  assert.deepEqual([none.ok, none.code], [false, 'NO_BUILD_ROUTE'])
  const world = chasm()
  assert.equal(planBuildRoute({ getBlock: world.getBlock, start, target, done, blocks: 8, pad: 4 }).ok, false, 'not unless asked for')
  const route = planBuildRoute({ getBlock: world.getBlock, start, target, done, blocks: 8, pad: 4, allowBridge: true })
  assert.equal(route.ok, true, route.code)
  assert.deepEqual([route.bridge, route.stack, route.dig], [3, 0, 0])
  assert.deepEqual(route.steps.filter(step => step.kind === 'bridge').map(step => step.place), [3, 4, 5].map(x => ({ x, y: 63, z: 0 })))
  // Two blocks carried do not cross three cells.
  assert.equal(planBuildRoute({ getBlock: chasm().getBlock, start, target, done, blocks: 2, pad: 4, allowBridge: true }).ok, false)
  // Lava under the gap, or a cell not received beside it: no floor is placed there.
  const lava = chasm(); for (let z = -30; z <= 30; z++) for (let y = 40; y <= 62; y++) for (const x of [3, 4, 5]) lava.set(x, y, z, 'lava', { boundingBox: 'empty' })
  assert.equal(planBuildRoute({ getBlock: lava.getBlock, start, target, done, blocks: 3, pad: 4, allowBridge: true }).ok, false, 'no floor right over the lava')
  const over = planBuildRoute({ getBlock: lava.getBlock, start, target, done, blocks: 8, pad: 4, allowBridge: true })
  assert.equal(over.ok && over.steps.filter(step => step.kind === 'bridge').every(step => step.place.y === 64), true, 'one pillar step up, then the floor a block clear of the lava')
  const unseen = chasm(); for (let z = -30; z <= 30; z++) for (let y = 40; y <= 80; y++) unseen.set(4, y, z, null)
  assert.equal(planBuildRoute({ getBlock: unseen.getBlock, start, target, done, blocks: 8, pad: 4, allowBridge: true }).ok, false)
  // Carried out: each floor block is received before the step onto it.
  const bot = hands({ getBlock: world.getBlock, setBlock: world.set }, start, { fill: 8 })
  const log = []
  const out = await buildWalk({ ports: bot.ports, target, done, limits: { pad: 4 }, log: line => log.push(line) })
  assert.equal(out.ok, true, log.join('\n'))
  assert.deepEqual(bot.did.filter(step => step.kind === 'bridge').map(step => step.x), [3, 4, 5])
  assert.equal(bot.cell().x, 8)
  assert.match(log[0], /足場を置く 3 個/)
  assert.match(log.at(-1), /置いた足場 3 個/)
  // A placement the server refuses: that step is left out, and with no other way the answer is the reason.
  const stuck = chasm(), refused = hands({ getBlock: stuck.getBlock, setBlock: stuck.set }, start, { fill: 8, refuse: cell => cell.x === 4 })
  const failed = await buildWalk({ ports: refused.ports, target, done, limits: { pad: 4, maxNodes: 3000 } })
  assert.equal(failed.ok, false)
  assert.equal(refused.cell().x <= 3, true)
})

test('digging: through a wall that spans the way, never through water, unreceived cells, a base\'s blocks or a container', () => {
  const wall = () => { const world = flatWorld(); for (let z = -30; z <= 30; z++) for (let y = 64; y <= 90; y++) for (const x of [3, 4]) world.set(x, y, z, 'stone'); return world }
  const start = { x: 0, y: 64, z: 0 }, target = { x: 8, y: 64, z: 0 }, done = cell => cell.x === 8 && cell.z === 0 && cell.y === 64
  const plain = planBuildRoute({ getBlock: wall().getBlock, start, target, done, blocks: 0, pad: 6 })
  assert.equal(plain.ok, true)
  assert.equal(plain.dig, 4, 'a passage two blocks high through two blocks of wall')
  assert.ok(plain.steps.every(step => step.to.z === 0), 'straight through')
  // Water over the wall where the straight passage would go: the passage is cut beside it.
  const wet = wall(); for (const z of [-1, 0, 1]) wet.set(3, 66, z, 'water')
  const round = planBuildRoute({ getBlock: wet.getBlock, start, target, done, blocks: 0, pad: 6 })
  assert.equal(round.ok, true)
  const touchesWater = cell => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => /water/.test(wet.getBlock(cell.x + dx, cell.y + dy, cell.z + dz).name))
  assert.ok(round.dig >= 4 && round.steps.every(step => step.dig.every(cell => !touchesWater(cell))), 'no block touching the water is mined')
  assert.ok(round.steps.some(step => Math.abs(step.to.z) >= 2), 'the passage goes beside the water')
  // The whole wall unreceived, a base's wall, or chests: no way, said at once.
  for (const [name, extra] of [[null], ['cobblestone', { natural: false }], ['chest']]) {
    const world = flatWorld(); for (let z = -30; z <= 30; z++) for (let y = 40; y <= 90; y++) world.set(3, y, z, name, extra) // from under the search box to over it
    const out = planBuildRoute({ getBlock: world.getBlock, start, target, done, blocks: 0, pad: 6 })
    assert.deepEqual([out.ok, out.code], [false, 'NO_BUILD_ROUTE'], String(name))
    assert.ok(out.expanded < 2000)
  }
})

test('the search is bounded: a node limit and a time limit end it with a code', () => {
  const world = flatWorld()
  const start = { x: 0, y: 64, z: 0 }, target = { x: 40, y: 64, z: 0 }
  const few = planBuildRoute({ getBlock: world.getBlock, start, target, done: () => false, blocks: 0, maxNodes: 50 })
  assert.deepEqual([few.ok, few.code, few.expanded], [false, 'BUILD_ROUTE_SEARCH_LIMIT', 50])
  let clock = 0
  const slow = planBuildRoute({ getBlock: world.getBlock, start, target, done: () => false, blocks: 0, maxMs: 100, now: () => (clock += 30) })
  assert.deepEqual([slow.ok, slow.code], [false, 'BUILD_ROUTE_SEARCH_LIMIT'])
  assert.ok(slow.expanded <= 512)
})

test('a long trip with no way on ends with its reason in player play; a trip started by hand keeps trying', () => {
  assert.equal(stopsWhenBlocked({ playerWanted: true }), true)
  assert.equal(stopsWhenBlocked({ playerWanted: false }), false)
  assert.equal(stopsWhenBlocked({}), false)
  assert.equal(stopsWhenBlocked(null), false)
})

test('with empty hands on a step three over the ground, the route drops off the edge (live 2026-11-19 12:05 JST)', async () => {
  const world = flatWorld()
  for (const y of [64, 65, 66]) world.set(0, y, 0, 'oak_planks')
  const start = { x: 0, y: 67, z: 0 }, target = { x: 6, y: 64, z: 0 }, done = cell => cell.y === 64 && cell.x >= 3
  const plain = planBuildRoute({ getBlock: world.getBlock, start, target, done })
  assert.equal(plain.ok, false)
  const wider = planBuildRoute({ getBlock: world.getBlock, start, target, done, allowDrop: true })
  assert.equal(wider.ok, true)
  assert.equal(wider.drop, 1)
  assert.deepEqual(wider.steps[0], { kind: 'drop', dig: [], fall: 3, to: { x: 1, y: 64, z: 0 } })
  // Four down is not offered, nor a drop into water or onto an unreceived floor.
  world.set(0, 67, 0, 'oak_planks')
  assert.equal(planBuildRoute({ getBlock: world.getBlock, start: { x: 0, y: 68, z: 0 }, target, done, allowDrop: true }).ok, false)
  world.set(0, 67, 0, 'air')
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(x, 64, z, 'water')
  assert.equal(planBuildRoute({ getBlock: world.getBlock, start, target, done, allowDrop: true }).ok, false)

  // The walk carries it out with the drop port and counts the received feet.
  const land = flatWorld()
  for (const y of [64, 65, 66]) land.set(0, y, 0, 'oak_planks')
  const h = hands(land, start)
  let drops = 0
  h.ports.drop = async to => { drops++; Object.assign(h.body, { x: to.x, y: to.y, z: to.z }); return true }
  const result = await buildWalk({ ports: h.ports, target, done, sleep: async () => {} })
  assert.equal(result.ok, true, result.code)
  assert.equal(drops, 1)
  assert.ok(done(h.cell()))
})
