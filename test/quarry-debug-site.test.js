'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { findDebugChestSite, debugSiteReachable } = require('../src/quarry-debug-site')
const key = p => [p.x, p.y, p.z].join(',')
const isAir = b => b.known === true && b.name === 'minecraft:air' && !b.extra?.length
const isFloor = b => b.known === true && b.boundingBox === 'block' && !/water|lava|magma|fire|powder_snow|scaffolding|cactus/.test(b.name) && !b.extra?.length
function fixture (feet = { x: 8, y: 67, z: 8 }, position = { x: feet.x + 0.5, y: feet.y + 1.62, z: feet.z + 0.5 }) {
  const blocks = new Map(), reads = []
  const getBlock = (x, y, z) => {
    const p = { x, y, z }; reads.push(p)
    return blocks.get(key(p)) ?? { known: true, name: y < feet.y ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < feet.y ? 'block' : 'empty', extra: [] }
  }
  const put = (x, y, z, name, extra = {}) => blocks.set(key({ x, y, z }), { known: true, name, boundingBox: 'block', extra: [], ...extra })
  return { feet, position, blocks, reads, getBlock, put, find: (options = {}) => findDebugChestSite({ feet, position, getBlock, isAir, isFloor, ...options }) }
}

test('the original east-first layout stays read-only and fixes the stand to the current cell', () => {
  const f = fixture(), before = structuredClone({ feet: f.feet, position: f.position, blocks: f.blocks })
  const home = f.find()
  assert.deepEqual(home, { position: { x: 9, y: 67, z: 8 }, other: { x: 10, y: 67, z: 8 }, stage: { x: 7, y: 67, z: 8 }, stand: f.feet, chunk: { x: 0, z: 0 }, existing: false })
  assert.equal(debugSiteReachable(home, f.position), true)
  assert.deepEqual({ feet: f.feet, position: f.position, blocks: f.blocks }, before)
  home.stand.x = 100
  assert.equal(f.feet.x, 8, 'the returned home cannot mutate the actual stand')
  assert.ok(f.reads.length < 2000, 'terrain scanning is bounded')
})

test('an east boundary keeps both chest halves and the new stage inside the current chunk', () => {
  const f = fixture({ x: 15, y: 67, z: 8 }), home = f.find()
  assert.equal(home.position.x, 14); assert.equal(home.other.x, 13)
  for (const p of [home.position, home.other, home.stage]) assert.ok(p.x >= 0 && p.x <= 15 && p.z >= 0 && p.z <= 15)
})

test('a tree on the only original pair and an occupied old stage select another east-west row without touching the filled chest', () => {
  const f = fixture({ x: 1998, y: 67, z: 2008 }, { x: 1998.6959, y: 68.62, z: 2008.8618 })
  f.put(1997, 67, 2008, 'minecraft:oak_log'); f.put(1997, 68, 2008, 'minecraft:oak_log')
  f.put(1999, 67, 2008, 'minecraft:chest'); f.put(1999, 67, 2009, 'minecraft:chest')
  const before = structuredClone(f.blocks), home = f.find()
  assert.ok(home)
  assert.equal(home.position.z, 2009); assert.equal(home.other.z, 2009)
  assert.equal(Math.abs(home.position.x - home.other.x), 1)
  assert.notDeepEqual(home.stage, { x: 1999, y: 67, z: 2008 })
  assert.equal(debugSiteReachable(home, f.position), true)
  assert.deepEqual(home.stand, f.feet); assert.deepEqual(f.blocks, before)
})

test('the temporary stage is selected independently when the preferred opposite cell is occupied', () => {
  const f = fixture(); f.put(7, 67, 8, 'minecraft:oak_log')
  const home = f.find()
  assert.equal(home.position.x, 9); assert.equal(home.other.x, 10)
  assert.notDeepEqual(home.stage, { x: 7, y: 67, z: 8 })
  assert.equal(debugSiteReachable(home, f.position), true)
  const dx = Math.abs(home.stage.x - home.stand.x), dz = Math.abs(home.stage.z - home.stand.z)
  assert.ok((dx === 0 || dz === 0) && dx + dz >= 1 && dx + dz <= 2, 'normal portable supply must be able to rediscover the stage')
})

test('diagonal-only staging cannot create a home that normal initial supplies cannot rediscover', () => {
  const f = fixture(), ordinary = f.getBlock
  const getBlock = (x, y, z) => {
    const dx = Math.abs(x - f.feet.x), dz = Math.abs(z - f.feet.z)
    if (y === f.feet.y && (dx === 0 || dz === 0) && dx + dz >= 1 && dx + dz <= 2) return { known: true, name: 'minecraft:oak_log', boundingBox: 'block', extra: [] }
    return ordinary(x, y, z)
  }
  assert.equal(f.find({ getBlock }), null, 'empty diagonal cells are not supported supply stations')
})

test('empty rows behind a log wall cannot be selected through their blocked normal interaction face', () => {
  const f = fixture()
  for (const x of [7, 9]) for (const y of [67, 68]) f.put(x, y, 8, 'minecraft:oak_log')
  for (let x = 5; x <= 11; x++) for (const y of [67, 68]) for (const z of [7, 9]) f.put(x, y, z, 'minecraft:oak_log')
  const before = structuredClone(f.blocks)
  assert.equal(f.getBlock(9, 67, 10).name, 'minecraft:air', 'the farther row itself has received empty placement cells')
  assert.equal(f.find(), null, 'neither a wall nor the unseen route through it may be cleared by a proposal')
  assert.deepEqual(f.blocks, before)
})

test('unknown intervening sight cells cannot be replaced by known planned container cells', () => {
  const f = fixture(); f.put(8, 68, 8, 'minecraft:air', { known: false })
  assert.equal(f.find(), null)
})

test('the stage cannot border a future chest or an existing chest even while the future pair is still air', () => {
  const f = fixture()
  f.put(9, 67, 8, 'minecraft:oak_log'); f.put(7, 67, 8, 'minecraft:oak_log'); f.put(8, 67, 7, 'minecraft:oak_log')
  const home = f.find()
  assert.equal(home.position.z, 9); assert.equal(home.other.z, 9)
  for (const p of [home.position, home.other]) assert.ok(Math.abs(home.stage.x - p.x) + Math.abs(home.stage.z - p.z) > 1)
  assert.notDeepEqual(home.stage, { x: 8, y: 67, z: 9 })
  const g = fixture(); g.put(6, 67, 8, 'minecraft:chest')
  const besideExisting = g.find()
  assert.equal(besideExisting.position.x, 9)
  assert.notDeepEqual(besideExisting.stage, { x: 7, y: 67, z: 8 })
})

for (const mode of ['unknown_floor', 'liquid_floor', 'protected_floor', 'protected_head', 'protected_air', 'unknown_head', 'occupied']) test(`${mode} cannot authorize any placement`, () => {
  const f = fixture(), ordinary = f.getBlock
  const getBlock = (x, y, z) => {
    const b = ordinary(x, y, z)
    if (mode === 'unknown_floor' && y === 66 || mode === 'unknown_head' && y === 68) return { known: false }
    if (mode === 'liquid_floor' && y === 66) return { ...b, name: 'minecraft:water' }
    if (mode === 'protected_floor' && y === 66 || mode === 'protected_head' && y === 68) return { ...b, protectionSource: 'registered_home' }
    if (mode === 'protected_air' && y === 67) return { ...b, protected: true }
    if (mode === 'occupied' && y === 67) return { ...b, name: 'minecraft:oak_log', boundingBox: 'block' }
    return b
  }
  assert.equal(f.find({ getBlock }), null)
})

for (const neighbor of ['minecraft:chest', 'minecraft:trapped_chest', 'unknown', 'protected']) test(`an unrelated ${neighbor} neighbor excludes a potentially merged pair`, () => {
  const f = fixture()
  f.put(11, 67, 8, neighbor, neighbor === 'unknown' ? { known: false } : neighbor === 'protected' ? { protectionSource: 'old_home' } : {})
  const before = structuredClone(f.blocks), home = f.find()
  assert.equal(home.position.x, 7); assert.equal(home.other.x, 6)
  assert.deepEqual(f.blocks, before)
})

test('fractional actual player overlap cannot be hidden by a clear integer stand cell', () => {
  const f = fixture(), original = f.find()
  const position = { ...f.position, x: 8.8 }
  assert.equal(debugSiteReachable(original, position), false)
  const home = f.find({ position })
  assert.ok(home); assert.equal(home.position.x, 7)
  assert.equal(debugSiteReachable(home, position), true)
  assert.notDeepEqual(home.stage, { x: 9, y: 67, z: 8 })
})

test('geometry guards reject changed stands, invalid pairs, overlaps, heights and unreachable cells without terrain reads', () => {
  const f = fixture(), original = f.find(), reads = f.reads.length
  const variants = [
    h => { h.other.z++ }, h => { h.other.x++ }, h => { h.stage = { ...h.position } },
    h => { h.stage = { x: 9, y: 67, z: 9 } },
    h => { h.stage.y++ }, h => { h.position.x = 16; h.other.x = 17 },
    h => { h.stage = { x: 12, y: 67, z: 12 } }, h => { h.position.x = 30000000 },
    h => { h.chunk.x++ }, h => { h.stand.x++ }
  ]
  for (const change of variants) {
    const home = structuredClone(original); change(home)
    assert.equal(debugSiteReachable(home, f.position), false)
  }
  assert.equal(debugSiteReachable(original, { ...f.position, x: 9.5 }), false)
  assert.equal(debugSiteReachable(original, { ...f.position, y: NaN }), false)
  assert.equal(f.reads.length, reads, 'the geometry guard never observes or mutates terrain')
})

test('registered geometry remains compatible with an older outside-chunk stage', () => {
  const f = fixture({ x: 15, y: 67, z: 8 }), home = f.find()
  home.stage = { x: 16, y: 67, z: 8 }
  assert.equal(debugSiteReachable(home, f.position), true)
})

test('invalid inputs fail closed before observing terrain', () => {
  const f = fixture()
  for (const options of [{ feet: { ...f.feet, x: 1.5 } }, { feet: { ...f.feet, y: 318 } }, { position: { ...f.position, z: Infinity } }, { isAir: null }]) assert.equal(f.find(options), null)
  assert.equal(f.reads.length, 0)
  assert.equal(findDebugChestSite(), null)
  assert.equal(debugSiteReachable(null, f.position), false)
})

test('a stand beside a chunk corner puts the chest pair into that corner, and the middle of the chunk keeps the east-first row', () => {
  for (const [feet, position, other] of [
    [{ x: 2, y: 67, z: 2 }, { x: 1, z: 0 }, { x: 0, z: 0 }],
    [{ x: 13, y: 67, z: 2 }, { x: 14, z: 0 }, { x: 15, z: 0 }],
    [{ x: 2, y: 67, z: 13 }, { x: 1, z: 15 }, { x: 0, z: 15 }],
    [{ x: 13, y: 67, z: 13 }, { x: 14, z: 15 }, { x: 15, z: 15 }]
  ]) {
    const f = fixture(feet), home = f.find()
    assert.deepEqual([home.position.x, home.position.z, home.other.x, home.other.z], [position.x, position.z, other.x, other.z])
    assert.equal(debugSiteReachable(home, f.position), true)
  }
  const blocked = fixture({ x: 2, y: 67, z: 2 }); blocked.put(0, 67, 0, 'minecraft:oak_log')
  const next = blocked.find()
  assert.ok(next && !(next.other.x === 0 && next.other.z === 0), 'an occupied corner falls back to the next nearest pair')
  const middle = fixture().find()
  assert.deepEqual([middle.position, middle.other], [{ x: 9, y: 67, z: 8 }, { x: 10, y: 67, z: 8 }])
})
