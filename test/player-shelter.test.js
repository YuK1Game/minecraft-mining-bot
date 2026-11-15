'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerShelter, shelterDecision } = require('../src/modes/player-shelter')
const { playerActivity, modeState } = require('../scripts/lib/player-activity')

const clock = dayTime => ({ time: 240000 + dayTime, source: 'server_sync_world_clocks' })
const fine = { health: 20, hunger: 20 }

test('decision: dusk digs, an unknown clock digs nothing, morning leaves', () => {
  assert.deepEqual(shelterDecision({ pit: {}, clock: clock(6000), vitals: fine, hostileDistance: Infinity, now: 1e6, wanted: true }), { action: 'none' })
  assert.deepEqual(shelterDecision({ pit: {}, clock: clock(11600), vitals: fine, hostileDistance: 3, now: 1e6, wanted: true }), { action: 'dig', reason: 'night' })
  assert.deepEqual(shelterDecision({ pit: {}, clock: { time: null, source: 'unknown' }, vitals: fine, hostileDistance: Infinity, now: 1e6, wanted: true }), { action: 'none' })
  assert.deepEqual(shelterDecision({ pit: { cover: {}, reason: 'night' }, clock: clock(18000), vitals: fine, now: 1e6, wanted: true }), { action: 'stay', reason: 'night' })
  assert.deepEqual(shelterDecision({ pit: { cover: {}, reason: 'night' }, clock: clock(300), vitals: fine, now: 1e6, wanted: true }), { action: 'leave' })
  assert.deepEqual(shelterDecision({ pit: { cover: {}, reason: 'night' }, clock: { time: null, source: 'unknown' }, vitals: fine, now: 1e6, wanted: true }), { action: 'stay', reason: 'night' })
})

test('decision: rest only when hurt, fed and nothing close; it ends healed or hungry; dusk turns it into the night', () => {
  const at = (vitals, hostileDistance = Infinity, extra = {}) => shelterDecision({ pit: {}, clock: clock(6000), vitals, hostileDistance, now: 1e6, wanted: true, ...extra })
  assert.deepEqual(at({ health: 8, hunger: 19 }), { action: 'dig', reason: 'rest' })
  assert.deepEqual(at({ health: 8, hunger: 19 }, 6), { action: 'none' }, 'never dig beside an enemy')
  assert.deepEqual(at({ health: 8, hunger: 12 }), { action: 'none' }, 'no natural healing below hunger 18')
  assert.deepEqual(at({ health: 12, hunger: 20 }), { action: 'none' })
  assert.deepEqual(at({ health: null, hunger: 20 }), { action: 'none' })
  assert.deepEqual(shelterDecision({ pit: { playerTriedAt: 990000 }, clock: clock(6000), vitals: { health: 8, hunger: 19 }, now: 1e6, wanted: true }), { action: 'none' }, 'one try a minute')
  const resting = vitals => shelterDecision({ pit: { cover: {}, reason: 'rest' }, clock: clock(6000), vitals, now: 1e6, wanted: true })
  assert.deepEqual(resting({ health: 12, hunger: 19 }), { action: 'stay', reason: 'rest' })
  assert.deepEqual(resting({ health: 18, hunger: 19 }), { action: 'leave' })
  assert.deepEqual(resting({ health: 9, hunger: 17 }), { action: 'leave' })
  assert.deepEqual(shelterDecision({ pit: { cover: {}, reason: 'rest' }, clock: clock(12000), vitals: { health: 20, hunger: 20 }, now: 1e6, wanted: true }), { action: 'stay', reason: 'night' })
})

function fixture () {
  const calls = [], shared = { playerWanted: true }, logs = []
  const world = { time: 6000, vitals: { ...fine }, running: true, digOk: true, travel: false, mode: 'player' }
  const shelter = createPlayerShelter({
    getMode: () => world.mode, shared, log: line => logs.push(line), now: () => 1e6,
    agent: { objective: { objective: 'diamond' }, start: async options => { calls.push('start'); world.running = true }, stop: () => { calls.push('stop'); world.running = false }, running: () => world.running },
    recovery: { cancel: () => calls.push('recovery.cancel') },
    getClock: () => clock(world.time), getVitals: () => world.vitals, hostileDistance: () => Infinity, travelBusy: () => world.travel,
    dig: async () => { calls.push('dig'); return world.digOk ? { ok: true, cover: { x: 1, y: 64, z: 2 } } : { ok: false, reason: 'OPEN_WALL' } },
    uncover: async cover => { calls.push('uncover'); return true }
  })
  return { shelter, shared, calls, logs, world }
}

test('a night: stop playing, dig and cover, wait, open in the morning and play on', async () => {
  const f = fixture()
  assert.equal((await f.shelter.tick()).action, 'none')
  f.world.time = 11600
  await f.shelter.tick()
  assert.deepEqual(f.calls, ['recovery.cancel', 'stop', 'dig'])
  assert.deepEqual(f.shared.travelNight.cover, { x: 1, y: 64, z: 2 })
  assert.deepEqual(f.shelter.status(), { active: true, reason: '夜のため、ふたをした穴の中で朝まで待ちます。' })
  f.world.time = 20000
  await f.shelter.tick()
  assert.equal(f.calls.length, 3, 'nothing happens during the night')
  f.world.time = 500
  await f.shelter.tick()
  assert.deepEqual(f.calls.slice(3), ['uncover', 'start'])
  assert.equal(f.shared.travelNight.cover, null)
  assert.equal(f.shelter.status().active, false)
})

test('no pit possible: say why and keep playing; a trip in progress and a stopped player are left alone', async () => {
  const f = fixture()
  f.world.time = 11600; f.world.digOk = false
  await f.shelter.tick()
  assert.deepEqual(f.calls, ['recovery.cancel', 'stop', 'dig', 'start'])
  assert.match(f.logs[0], /OPEN_WALL/)
  const g = fixture(); g.world.time = 11600; g.world.travel = true
  assert.equal(await g.shelter.tick(), null)
  g.world.travel = false; g.shared.playerWanted = false
  assert.equal(await g.shelter.tick(), null)
  g.shared.playerWanted = true; g.world.mode = 'quarry'
  assert.equal(await g.shelter.tick(), null)
  assert.deepEqual(g.calls, [])
})

test('a pit the trip dug holds the player until morning', async () => {
  const f = fixture()
  f.shared.travelNight = { cover: { x: 1, y: 64, z: 2 }, reason: 'night', pitTried: 1 }
  f.world.time = 15000
  await f.shelter.tick()
  assert.deepEqual(f.calls, ['stop'])
  assert.equal(f.shelter.status().active, true)
})

test('activity band shows the shelter', () => {
  assert.equal(playerActivity(modeState({ mode: 'player', player: { running: true, phase: 'sheltering', reason: '夜', stages: [] } })).label, 'プレイヤーモード: 避難中')
})
