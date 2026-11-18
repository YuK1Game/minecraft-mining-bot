'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerCover, coverCells, exposedTo } = require('../src/modes/player-cover')
const { walkableCells } = require('../src/modes/player-drops')
const { createCombatExposure } = require('../src/combat/combat-exposure')

// Flat stone floor at y=63, air above, and a wall two high along x=3 for z=-1..1.
function terrain ({ wall = true, known = () => true } = {}) {
  return (x, y, z) => {
    if (!known(x, y, z)) return { known: false }
    if (y <= 63) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    if (wall && x === 3 && z >= -1 && z <= 1 && y <= 65) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
}
const real = getBlock => ({
  sight: createCombatExposure({ world: { getBlock }, entities: {}, scopeOf: () => null }).sight,
  cells: position => walkableCells(position, getBlock).values()
})
const skeleton = (x, z = 0) => ({ entityType: 'minecraft:skeleton', hostile: true, position: { x, y: 64, z } })
const eye = { x: 0.5, y: 65.62, z: 0.5 }

function setup ({ getBlock = terrain(), hostiles = [skeleton(-10.5, 0.5)], inventory = { items: [{ name: 'minecraft:stone_sword', count: 1 }] }, hitAgo = 1000, walk, reachable } = {}) {
  let time = 100000
  const logs = [], walks = [], stops = []
  const shared = { playerWanted: true, recentDamageNoPrimary: { at: time - hitAgo } }
  const cover = createPlayerCover({
    getMode: () => 'player', shared, log: text => logs.push(text), now: () => time, reachable,
    agent: { running: () => true, stop: reason => stops.push(reason) },
    getState: () => ({ health: 12, position: eye, inventory }), hostiles: () => hostiles, ...real(getBlock),
    walk: walk ?? (async target => { walks.push({ target, flee: shared.playerFlee }); return true })
  })
  return { cover, shared, logs, walks, stops, advance: ms => { time += ms } }
}

test('the wall hides the body: cells behind it are cover, open cells are not', () => {
  const getBlock = terrain(), { sight, cells } = real(getBlock), archers = [skeleton(-10.5, 0.5)]
  assert.equal(exposedTo({ x: 0.5, y: 64, z: 0.5 }, archers, sight).length, 1)
  assert.equal(exposedTo({ x: 4.5, y: 64, z: 0.5 }, archers, sight).length, 0)
  const found = coverCells({ feet: { x: 0.5, y: 64, z: 0.5 }, cells: cells(eye), archers, sight })
  assert.ok(found.length >= 1)
  for (const cell of found) assert.equal(exposedTo({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, archers, sight).length, 0)
  assert.equal(found[0].x, 4)
})

test('unreceived blocks are not cover', () => {
  const getBlock = terrain({ known: (x, y, z) => !(x === 3 && y >= 64) }), { sight, cells } = real(getBlock)
  assert.deepEqual(coverCells({ feet: { x: 0.5, y: 64, z: 0.5 }, cells: cells(eye), archers: [skeleton(-10.5, 0.5)], sight }), [])
})

test('shot by an archer it cannot walk to: stops the work, stands combat down and walks behind the wall', async () => {
  const { cover, shared, logs, walks, stops } = setup()
  assert.equal(await cover.tick(), true)
  assert.equal(walks[0].target.x, 4.5)
  assert.ok(walks[0].flee.until > 100000)
  assert.equal(stops.length, 1)
  assert.equal(shared.playerFlee, null)
  assert.match(logs[0], /skeleton（11\.0m）に撃たれているため、射線から外れます/)
  assert.match(logs[1], /射線から外れました/)
})

test('it does not move without a recent hit, with a bow and arrows, for a reachable archer, or for a zombie', async () => {
  assert.equal(await setup({ hitAgo: 6000 }).cover.tick(), false)
  assert.equal(await setup({ inventory: { items: [{ name: 'minecraft:bow', count: 1 }, { name: 'minecraft:arrow', count: 8 }] } }).cover.tick(), false)
  assert.equal(await setup({ inventory: null }).cover.tick(), false)
  assert.equal(await setup({ reachable: () => true }).cover.tick(), false)
  assert.equal(await setup({ hostiles: [{ ...skeleton(-10.5, 0.5), entityType: 'minecraft:zombie' }] }).cover.tick(), false)
  assert.equal(await setup({ hostiles: [skeleton(-2.5, 0.5)] }).cover.tick(), false)
  const hidden = setup({ hostiles: [skeleton(10.5, 0.5)] })
  assert.equal(await hidden.cover.tick(), false)
  assert.equal(hidden.walks.length, 0)
})

test('without a weapon a reachable archer cannot be fought either: it takes cover (live 2026-11-18 11:49 JST)', async () => {
  const witch = { entityType: 'minecraft:witch', hostile: true, position: { x: -8.5, y: 64, z: 0.5 } }
  const bare = { items: [{ name: 'minecraft:wooden_pickaxe', count: 1 }, { name: 'minecraft:oak_planks', count: 4 }] }
  const { cover, walks, logs, stops } = setup({ hostiles: [witch], inventory: bare, reachable: () => true })
  assert.equal(await cover.tick(), true)
  assert.equal(walks.length, 1)
  assert.equal(stops.length, 1)
  assert.match(logs[0], /武器がなく戦えない witch（9\.0m）に撃たれているため、射線から外れます/)
  // The same witch with a sword in the inventory is combat's.
  const armed = setup({ hostiles: [witch], reachable: () => true })
  assert.equal(await armed.cover.tick(), false)
  assert.equal(armed.cover.status().skip, 'reachable')
  assert.equal(armed.walks.length, 0)
})

test('no cover near: said once, then it rests ten seconds', async () => {
  const { cover, logs, stops, advance } = setup({ getBlock: terrain({ wall: false }) })
  assert.equal(await cover.tick(), false)
  assert.equal(await cover.tick(), false)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /射線から外れられる場所が近くにありません/)
  assert.equal(stops.length, 0)
  advance(3000)
  assert.equal(await cover.tick(), false)
  assert.equal(logs.length, 1)
})

test('a walk that does not arrive tries the next place, and combat is released afterwards', async () => {
  const tried = []
  const { cover, shared, logs } = setup({ walk: async target => { tried.push(target); return false } })
  assert.equal(await cover.tick(), false)
  assert.equal(tried.length, 3)
  assert.equal(shared.playerFlee, null)
  assert.match(logs.at(-1), /歩けませんでした/)
})

test('a witch that cannot be reached is treated like an archer from 3 m', async () => {
  const witch = (x) => ({ ...skeleton(x, 0.5), entityType: 'minecraft:witch' })
  const { cover, logs } = setup({ hostiles: [witch(-10.5)] })
  assert.equal(await cover.tick(), true)
  assert.match(logs[0], /witch（11\.0m）に撃たれているため/)
  assert.equal(await setup({ hostiles: [witch(-2.5)] }).cover.tick(), false)
})
