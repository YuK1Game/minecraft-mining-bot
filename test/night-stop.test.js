'use strict'
// Night stop during long travel (2026-11-14, coordinator relay): the day/night
// cycle is expected to run, so the trip stops before sunset and waits for
// morning in a covered pit. Judged only from the received clock.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { dayPhase, planPit } = require('../src/night-stop')
const { createLongTravel } = require('../src/long-travel')

test('day phase comes only from a received server clock; unknown is not day', () => {
  assert.deepEqual(dayPhase({ time: null, source: 'unknown' }), { known: false, dayTime: null, shelter: false, resume: false })
  assert.equal(dayPhase({ time: 6000, source: 'guess' }).known, false, 'a clock not received from the server does not count')
  assert.equal(dayPhase({ time: 6000, source: 'server_sync_world_clocks' }).shelter, false)
  assert.equal(dayPhase({ time: 11499, source: 'server_set_time' }).shelter, false)
  assert.equal(dayPhase({ time: 11500, source: 'server_set_time' }).shelter, true, 'dusk stops the trip before mobs spawn')
  assert.equal(dayPhase({ time: 18000, source: 'server_set_time' }).shelter, true)
  assert.equal(dayPhase({ time: 24000 * 3 + 100, source: 'server_set_time' }).resume, true, 'the clock wraps to sunrise')
  assert.equal(dayPhase({ time: 24000 * 3 + 100, source: 'server_set_time' }).shelter, false)
  assert.equal(dayPhase({ time: 11200, source: 'server_set_time' }).resume, false, 'between resume and shelter neither fires')
})

// Flat stone world: grass top at y=63, stone below, unreceived above y=80.
function world (patch = {}) {
  return (x, y, z) => {
    const k = `${x},${y},${z}`
    if (k in patch) return patch[k]
    if (y > 80) return { known: false }
    if (y >= 64) return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
    if (y === 63) return { known: true, name: 'minecraft:grass_block', boundingBox: 'block' }
    return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  }
}
const feet = { x: 5.4, y: 64, z: 7.6 }

test('a pit is three received solid cells under the feet with solid walls and floor; the cover goes in the top cell', () => {
  const p = planPit(world(), feet)
  assert.equal(p.ready, true, p.reason)
  assert.deepEqual(p.dig.map(c => c.y), [63, 62, 61])
  assert.deepEqual(p.cover, { x: 5, y: 63, z: 7 })
  assert.equal(p.stand.y, 61)
})

test('unreceived, cave-opened, liquid or falling cells refuse the pit', () => {
  assert.equal(planPit(world({ '5,62,7': { known: false } }), feet).reason, 'UNRECEIVED')
  assert.equal(planPit(world({ '6,61,7': { known: true, name: 'minecraft:air', boundingBox: 'empty' } }), feet).reason, 'OPEN_WALL')
  assert.equal(planPit(world({ '4,62,7': { known: true, name: 'minecraft:water', boundingBox: 'empty' } }), feet).reason, 'OPEN_WALL')
  assert.equal(planPit(world({ '5,62,7': { known: true, name: 'minecraft:sand', boundingBox: 'block' } }), feet).reason, 'NOT_DIGGABLE')
  assert.equal(planPit(world({ '5,60,7': { known: true, name: 'minecraft:lava', boundingBox: 'empty' } }), feet).reason, 'NO_FLOOR')
  assert.equal(planPit(world(), null).reason, 'POSITION_UNKNOWN')
})

test('a hold from the between-legs hook pauses the trip without a leg or a failure', async () => {
  let clock = 12000, legs = 0
  const state = { phase: 'spawned', health: 20, position: { x: 0, y: 65.62, z: 0 } }
  const lt = createLongTravel({
    getState: () => state,
    chunkTravel: { start: async () => { legs++ }, status: () => ({ busy: false, phase: 'arrived', serverConfirmed: true }) },
    beforeLeg: async () => dayPhase({ time: clock, source: 'server_sync_world_clocks' }).shelter ? { hold: true, phase: 'night', message: '夜', waitMs: 5 } : { hold: false },
    log: () => {}, save: async () => {}, pollMs: 5, damagePauseMs: 5
  })
  lt.start({ destination: { x: 500, z: 0 } })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(legs, 0, 'no leg starts at night')
  assert.equal(lt.status().phase, 'night')
  assert.equal(lt.status().failures, 0)
  clock = 24100
  const until = Date.now() + 2000
  while (Date.now() < until && legs === 0) await new Promise(r => setTimeout(r, 5))
  assert.ok(legs > 0, 'the trip continues in the morning')
  await lt.cancel?.()
})

test('the runtime wires the night stop and food between legs to the received clock only', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(source, /beforeLeg: async \(\{ signal \} = \{\}\) => travelBeforeLeg\(signal\)/)
  const hook = source.slice(source.indexOf('  async function travelBeforeLeg (signal) {'), source.indexOf('  function ensureLongTravel () {'))
  assert.match(hook, /NS\.dayPhase\(travelClock\(\)\)/)
  assert.match(hook, /if \(!phase\.known\) return \{ hold: true/)
  assert.match(hook, /prepGather\(\{ logs: 0, maxMs: 90000 \}\)/)
  const clock = source.slice(source.indexOf('  function travelClock () {'), source.indexOf('  async function travelNightPit'))
  assert.match(clock, /server_sync_world_clocks/)
  assert.doesNotMatch(clock, /Date\.now|command/, 'the clock is never guessed or set by command')
  assert.doesNotMatch(source.slice(source.indexOf('  async function travelNightPit'), source.indexOf('  function ensureLongTravel () {')), /command_request|\/time|\/tp/)
})
