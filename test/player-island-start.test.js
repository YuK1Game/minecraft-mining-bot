'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createIslandStart } = require('../src/modes/island-start')
const { walkableCells } = require('../src/modes/player-drops')
const { planBuildRouteAsync } = require('../src/movement/build-route')

// The door step of the real Realm, 2026-11-19 07:05 JST: two cobblestones at
// y=76 with four blocks of air to the south, ground at the same height six
// cells south, lower ground under the gap.
function world ({ roof = false } = {}) {
  const solid = new Map()
  const put = (x, y, z, name) => solid.set(`${x},${y},${z}`, name)
  for (const x of [0, 1]) put(x, 76, 0, 'minecraft:cobblestone')
  for (let x = -10; x <= 10; x++) for (let z = 6; z <= 16; z++) put(x, 76, z, 'minecraft:grass_block')
  for (let x = -10; x <= 10; x++) for (let z = -3; z <= 16; z++) put(x, 71, z, 'minecraft:stone')
  if (roof) put(1, 80, 0, 'minecraft:stone')
  return (x, y, z) => {
    const name = solid.get(`${x},${y},${z}`)
    return name ? { known: true, name, boundingBox: 'block', position: { x, y, z } } : { known: true, name: 'minecraft:air', boundingBox: 'empty', position: { x, y, z } }
  }
}
const ports = (getBlock, feet, extra = {}) => {
  const logs = [], builds = []
  const leave = createIslandStart({
    getFeet: () => feet, walkable: at => walkableCells({ x: at.x, y: at.y + 1.62, z: at.z }, getBlock),
    build: async (target, done) => { builds.push({ target, done }); return extra.build ? extra.build(target, done) : { ok: true } },
    log: text => logs.push(text), ...extra.options
  })
  return { leave, logs, builds }
}

test('a door step with a drop all round is left by the build route to the open ground, before the trip', async () => {
  const getBlock = world(), feet = { x: 1.5, y: 77, z: 0.5 }
  const { leave, logs, builds } = ports(getBlock, feet)
  const went = await leave({ x: 100, z: 0 })
  assert.equal(went.ok, true)
  assert.equal(builds.length, 1)
  const { target, done } = builds[0]
  assert.equal(target.y, 77)
  assert.ok(target.z >= 6)
  assert.equal(done({ x: 1, y: 77, z: 0 }), false)
  assert.equal(done(target), true)
  assert.match(logs[0], /歩いて出られない足場（2 マス）/)
  // The real planner reaches that ground over the gap with carried blocks.
  const route = await planBuildRouteAsync({ getBlock, start: { x: 1, y: 77, z: 0 }, target, done, blocks: 16, allowBridge: true })
  assert.equal(route.ok, true)
  assert.ok(route.bridge >= 1)
})

test('open ground, a near destination and a roof overhead start nothing', async () => {
  const getBlock = world()
  const onGround = ports(getBlock, { x: 0.5, y: 77, z: 10.5 })
  assert.equal(await onGround.leave({ x: 100, z: 0 }), null)
  const near = ports(getBlock, { x: 1.5, y: 77, z: 0.5 })
  assert.equal(await near.leave({ x: 3, z: 4 }), null)
  const covered = ports(getBlock, { x: 1.5, y: 77, z: 0.5 }, { options: { openSky: () => false } })
  assert.equal(await covered.leave({ x: 100, z: 0 }), null)
  assert.equal(onGround.builds.length + near.builds.length + covered.builds.length, 0)
})

test('a ledge that could not be left is not tried again for a minute from the same cell', async () => {
  let clock = 1000
  const getBlock = world(), feet = { x: 1.5, y: 77, z: 0.5 }
  const { leave, logs, builds } = ports(getBlock, feet, { build: () => ({ ok: false, code: 'NO_BUILD_ROUTE' }), options: { now: () => clock } })
  assert.equal((await leave({ x: 100, z: 0 })).code, 'NO_BUILD_ROUTE')
  assert.equal(await leave({ x: 100, z: 0 }), null)
  clock += 61000
  assert.equal((await leave({ x: 100, z: 0 })).code, 'NO_BUILD_ROUTE')
  assert.equal(builds.length, 2)
  assert.ok(logs.some(text => /足場から地面へ出られませんでした（NO_BUILD_ROUTE）/.test(text)))
})

test('no received ground with room within reach is said once and nothing is built', async () => {
  const bare = (x, y, z) => (y === 76 && z === 0 && (x === 0 || x === 1)) ? { known: true, name: 'minecraft:cobblestone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const { leave, logs, builds } = ports(bare, { x: 1.5, y: 77, z: 0.5 })
  assert.equal((await leave({ x: 100, z: 0 })).code, 'NO_GROUND')
  assert.equal(builds.length, 0)
  assert.equal(logs.length, 1)
})

test('a second trip from the same cell on wide ground first moves to open ground toward the destination', async () => {
  const getBlock = world(), feet = { x: 0.5, y: 77, z: 10.5 }
  let clock = 1000
  const { leave, logs, builds } = ports(getBlock, feet, { options: { now: () => clock, skyAt: cell => cell.z >= 8 } })
  assert.equal(await leave({ x: 0, z: 200 }), null)
  clock += 30000
  const went = await leave({ x: 0, z: 200 })
  assert.equal(went.ok, true)
  assert.equal(builds.length, 1)
  const { target, done } = builds[0]
  assert.ok(Math.hypot(target.x - 0, target.z - 10) >= 8)
  assert.ok(target.z > 10)
  assert.equal(done(target), true)
  assert.equal(done({ x: 0, y: 77, z: 10 }), false)
  assert.match(logs[0], /同じ場所からの長距離移動が進まなかったため/)
  // After a move the count starts again; a trip three minutes later is a new one.
  assert.equal(await leave({ x: 0, z: 200 }), null)
  clock += 200000
  assert.equal(await leave({ x: 0, z: 200 }), null)
  assert.equal(builds.length, 1)
})
