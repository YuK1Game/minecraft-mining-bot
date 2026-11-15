'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerFlee, fleeWanted } = require('../src/modes/player-flee')
const { runtimeSource } = require('./helpers/runtime-source')

const zombie = (x, z = 0) => ({ entityType: 'minecraft:zombie', hostile: true, position: { x, y: 64, z } })
const here = { x: 0, y: 65.62, z: 0 }

test('flee is wanted only when badly hurt, with a hostile near and no totem', () => {
  assert.deepEqual(fleeWanted({ health: 5.85, hostiles: [zombie(20), zombie(4)], position: here }), { distance: 4, name: 'zombie' })
  assert.equal(fleeWanted({ health: 9, hostiles: [zombie(4)], position: here }), null)
  assert.equal(fleeWanted({ health: 0, hostiles: [zombie(4)], position: here }), null)
  assert.equal(fleeWanted({ health: 5, totem: true, hostiles: [zombie(4)], position: here }), null)
  assert.equal(fleeWanted({ health: 5, hostiles: [zombie(13)], position: here }), null)
  assert.equal(fleeWanted({ health: undefined, hostiles: [zombie(4)], position: here }), null)
  assert.equal(fleeWanted({ health: 5, hostiles: [zombie(4)], position: null }), null)
})

function scene ({ mode = 'player', wanted = true, health = 5, retreat } = {}) {
  const s = { shared: { playerWanted: wanted }, clock: 0, enemies: [zombie(4)], stops: [], logs: [], flags: [], running: true, position: { ...here } }
  s.flee = createPlayerFlee({
    getMode: () => mode, shared: s.shared, log: text => s.logs.push(text), now: () => s.clock,
    sleep: async ms => { s.clock += ms },
    agent: { running: () => s.running, stop: reason => { s.running = false; s.stops.push(reason) } },
    getState: () => ({ health, position: s.position, totem: false }),
    hostiles: () => s.enemies,
    retreat: async () => { s.flags.push(s.shared.playerFlee?.until > s.clock); s.clock += 1000; return retreat(s) }
  })
  return s
}

test('steps away until nothing hostile is within 16 m, with combat standing down only meanwhile', async () => {
  const s = scene({ retreat: s => { s.position.x -= 8; return true } })
  assert.equal(await s.flee.tick(), true)
  assert.equal(s.flags.length, 2) // 4 m -> 12 m -> 20 m
  assert.ok(s.flags.every(Boolean))
  assert.equal(s.shared.playerFlee, null)
  assert.equal(s.stops.length, 1)
  assert.equal(s.flee.status().active, false)
  assert.match(s.logs.at(-1), /離れました（2歩）/)
})

test('three steps that cannot start hand back to combat for five seconds', async () => {
  const s = scene({ retreat: () => false })
  assert.equal(await s.flee.tick(), true)
  assert.equal(s.flags.length, 3)
  assert.equal(s.shared.playerFlee, null)
  assert.match(s.logs.at(-1), /その場で戦います/)
  assert.equal(await s.flee.tick(), false)
  s.clock += 5001
  assert.equal(await s.flee.tick(), true)
})

test('a throwing step counts as failed and the flag is cleared', async () => {
  const s = scene({ retreat: () => { throw new Error('busy') } })
  assert.equal(await s.flee.tick(), true)
  assert.equal(s.shared.playerFlee, null)
})

test('nothing happens outside player mode, when not playing, healthy, or in a covered pit', async () => {
  for (const options of [{ mode: 'quarry' }, { wanted: false }, { health: 12 }]) {
    const s = scene({ ...options, retreat: () => true })
    assert.equal(await s.flee.tick(), false)
    assert.equal(s.flags.length, 0)
  }
  const s = scene({ retreat: () => true })
  s.shared.travelNight = { cover: { x: 0, y: 66, z: 0 } }
  assert.equal(await s.flee.tick(), false)
})

test('the flee ends after twenty seconds', async () => {
  const s = scene({ retreat: () => true })
  assert.equal(await s.flee.tick(), true)
  assert.equal(s.flags.length, 20)
})

test('the combat work guard stands down while the flee flag is live', () => {
  const source = runtimeSource()
  assert.equal(source.match(/reason: 'EMPTY_HANDED_AVOID' \}; if \(playerFleeing\(\)\) return \{ allowed: false, reason: 'PLAYER_FLEE' \}/g)?.length, 2)
})
