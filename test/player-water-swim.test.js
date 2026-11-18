'use strict'
// Live 2026-11-19 05:02-05:31 JST: afloat in the middle of a pond west of the
// house, no ledge within five blocks; 「5マス以内に上がれる岸が見つかりません」
// 573 times in 20 minutes and the Bot did not move one cell.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ledges } = require('../src/movement/water-ledges')
const { way, RANGE } = require('../src/movement/water-swim')
const { createPhysics } = require('../src/movement/physics')
const { planWaterExit, createWaterExitStepper } = require('../src/movement/water-exit')
const { createPlayerWater } = require('../src/modes/player-water')
const lake = require('./helpers/sunken-lake')

const FAR = { x: -4905.5, y: 62.3, z: -4873.5 }

test('from open water the way leads to the nearest shore of the received water, in a straight first leg', () => {
  assert.deepEqual(ledges(lake.getBlock, FAR), [], 'no ledge within the exit\'s reach')
  const found = way(lake.getBlock, FAR)
  assert.equal(found.shore.y, 63)
  assert.equal(found.shore.z, -4861.5)
  assert.equal(found.leg.y, 62, 'the leg is a surface water cell')
  assert.equal(lake.getBlock(Math.floor(found.leg.x), 62, Math.floor(found.leg.z)).name, 'minecraft:water')
  const length = Math.hypot(found.leg.x - FAR.x, found.leg.z - FAR.z)
  assert.ok(length > 3 && length <= 8, `leg ${length}`)
  assert.ok(RANGE >= 24)
})

test('no way from water that is not received around the body, on land, or in a closed pool', () => {
  assert.equal(way(lake.getBlock, { x: -4902.5, y: 63, z: -4861.5 }), null, 'on the shore')
  const pool = (x, y, z) => ({ known: true, name: y <= 60 || Math.abs(x) > 3 || Math.abs(z) > 3 ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air', boundingBox: y <= 60 || Math.abs(x) > 3 || Math.abs(z) > 3 ? 'block' : 'empty' })
  assert.equal(way(pool, { x: 0.5, y: 62.3, z: 0.5 }), null, 'walls all round, three blocks above the water')
  const dark = (x, y, z) => (Math.abs(x) > 2 || Math.abs(z) > 2 ? { known: false, name: 'minecraft:air', boundingBox: 'empty' } : { known: true, name: y <= 62 ? 'minecraft:water' : 'minecraft:air', boundingBox: 'empty' })
  assert.equal(way(dark, { x: 0.5, y: 62.3, z: 0.5 }), null, 'cells that were not received are neither water nor shore')
})

test('the real physics swims the legs across the lake and then onto the shore', () => {
  const physics = createPhysics({ world: { getBlock: lake.getBlock }, allowWater: true })
  for (const y of [61, 62.3]) {
    let state = physics.fromServer({ position: { x: FAR.x, y: y + 1.62, z: FAR.z }, gameMode: 'survival' })
    Object.assign(state, { isInWater: true, onGround: y === 61, velocity: { x: 0, y: 0, z: 0 } })
    let legs = 0
    while (!ledges(lake.getBlock, state.position).length) {
      assert.ok(++legs <= 4, 'a few legs')
      const found = way(lake.getBlock, state.position)
      const route = planWaterExit({ physics, initial: state, target: found.leg })
      assert.equal(route.ready, true, route.reason)
      assert.equal(route.waterExit.swim, true)
      const stepper = createWaterExitStepper({ route, initial: state, physics })
      let frame = stepper.next()
      for (let i = 0; i < 300 && frame.phase === 'moving'; i++) frame = stepper.next()
      assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason)
      assert.ok(Math.hypot(frame.predictedState.position.x - found.leg.x, frame.predictedState.position.z - found.leg.z) <= 0.7)
      state = frame.predictedState
    }
    const out = planWaterExit({ physics, initial: state, target: ledges(lake.getBlock, state.position)[0] })
    assert.equal(out.ready, true, out.reason)
    assert.equal(out.waterExit.swim, undefined)
    assert.equal(out.exitFrames.at(-1).state.position.y, 63)
  }
})

test('a swim target farther than ten blocks is refused', () => {
  const physics = createPhysics({ world: { getBlock: lake.getBlock }, allowWater: true })
  const state = physics.fromServer({ position: { x: FAR.x, y: FAR.y + 1.62, z: FAR.z }, gameMode: 'survival' })
  Object.assign(state, { isInWater: true, onGround: false, velocity: { x: 0, y: 0, z: 0 } })
  const out = planWaterExit({ physics, initial: state, target: { x: -4905.5, y: 62, z: -4862.5 } })
  assert.equal(out.ready, false)
  assert.match(out.reason, /within ten blocks/)
})

function player (move, extra = {}) {
  const logs = [], calls = []
  let feet = { ...FAR }, clock = 0
  const water = createPlayerWater({
    getMode: () => 'player', shared: { playerWanted: true }, getBlock: lake.getBlock, getPosition: () => feet,
    agent: { objective: {}, start: async () => calls.push('start'), stop: () => calls.push('stop'), settled: () => true },
    start: (target, options) => { calls.push({ target, swim: lake.getBlock(Math.floor(target.x), target.y, Math.floor(target.z)).name === 'minecraft:water', options }); feet = move(feet, target) },
    moving: () => false, why: () => 'Movement frame guard rejected the proposed input [threat]', log: line => logs.push(line), now: () => clock, sleep: async ms => { clock += ms }, ...extra
  })
  return { water, logs, calls, feet: () => feet, at: value => { clock = value }, put: value => { feet = value } }
}

test('the exit from open water swims toward the shore in legs, then climbs out', async () => {
  const run = player((feet, target) => ({ x: target.x, y: target.y === 62 ? 62.3 : target.y, z: target.z }))
  const out = await run.water.exit()
  assert.deepEqual(out, { ok: true })
  const swims = run.calls.filter(call => call.swim), exits = run.calls.filter(call => call.swim === false)
  assert.ok(swims.length >= 1 && swims.length <= 4)
  assert.equal(exits.length, 1)
  assert.ok(run.calls.every(call => call.options.waterExit === true && call.options.allowWater === true))
  assert.equal(run.feet().y, 63)
  assert.equal(run.logs.filter(line => /泳ぎます/.test(line)).length, 1)
  assert.match(run.logs.at(-1), /水から上がりました/)
})

test('two legs without progress end the try with the reason, and nothing more is sent', async () => {
  const run = player(feet => feet)
  const out = await run.water.exit()
  assert.equal(out.ok, false)
  assert.match(out.reason, /frame guard/)
  assert.equal(run.calls.length, 2)
  assert.match(run.logs.at(-1), /岸へ泳げません/)
})

test('a refused start counts as no progress; an abort stops before the next leg', async () => {
  const refused = player(() => { throw new Error('前の操作の終了処理を待ってください。') })
  assert.deepEqual(await refused.water.exit(), { ok: false, reason: '前の操作の終了処理を待ってください。' })
  const stopped = player(feet => feet)
  assert.deepEqual(await stopped.water.exit(() => true), { ok: false, reason: 'INTERRUPTED' })
  assert.equal(stopped.calls.length, 0)
})

test('no shore in the received water is said once a minute and nothing is sent', async () => {
  const dark = (x, y, z) => (Math.abs(x) > 2 || Math.abs(z) > 2 ? { known: false, name: 'minecraft:air', boundingBox: 'empty' } : { known: true, name: y <= 62 ? 'minecraft:water' : 'minecraft:air', boundingBox: 'empty' })
  const run = player(feet => feet, { getBlock: dark })
  run.put({ x: 0.5, y: 62.3, z: 0.5 })
  for (let i = 0; i < 5; i++) assert.deepEqual(await run.water.exit(), { ok: false, reason: 'NO_LEDGE' })
  assert.equal(run.logs.length, 1)
  run.at(61000)
  await run.water.exit()
  assert.equal(run.logs.length, 2)
  assert.equal(run.calls.length, 0)
})

test('stuck afloat for 15 s in open water: the tick stops the autonomy, swims out and plays on', async () => {
  const run = player((feet, target) => ({ x: target.x, y: target.y === 62 ? 62.3 : target.y, z: target.z }))
  assert.equal(await run.water.tick(), null)
  run.at(16000)
  assert.equal(await run.water.tick(), true)
  assert.equal(run.calls[0], 'stop')
  assert.equal(run.calls.at(-1), 'start')
  assert.equal(run.feet().y, 63)
})
