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

const creeper = x => ({ entityType: 'minecraft:creeper', hostile: true, position: { x, y: 64, z: 0 } })

test('with no weapon: a creeper within 8 m at any health, any hostile at health 10 or less', () => {
  const { unarmed } = require('../src/modes/player-flee')
  assert.equal(unarmed(null), true)
  assert.equal(unarmed({ items: [{ name: 'minecraft:oak_log', count: 3 }, { name: 'minecraft:wooden_pickaxe', count: 1 }] }), true)
  assert.equal(unarmed({ items: [{ name: 'minecraft:wooden_sword', count: 1 }] }), false)
  assert.equal(unarmed({ items: [{ name: 'minecraft:bow', count: 1 }] }), false)
  assert.equal(fleeWanted({ health: 20, weaponless: true, hostiles: [creeper(7)], position: here })?.name, 'creeper')
  assert.equal(fleeWanted({ health: 20, weaponless: true, hostiles: [creeper(9), zombie(3)], position: here }), null)
  assert.equal(fleeWanted({ health: 20, weaponless: false, hostiles: [creeper(4)], position: here }), null)
  assert.equal(fleeWanted({ health: 10, weaponless: true, hostiles: [zombie(11)], position: here })?.name, 'zombie')
  assert.equal(fleeWanted({ health: 10, weaponless: false, hostiles: [zombie(4)], position: here }), null)
  let asked = 0
  assert.equal(fleeWanted({ health: 20, weaponless: true, totem: () => { asked++; return true }, hostiles: [creeper(4)], position: here }), null)
  assert.equal(fleeWanted({ health: 20, weaponless: true, totem: () => { asked++; return true }, hostiles: [], position: here }), null)
  assert.equal(asked, 1)
})

test('a trip in progress is cancelled before the first step', async () => {
  const s = scene({ health: 20, retreat: s => { s.position.x -= 12; return true } })
  s.enemies = [creeper(5)]
  assert.equal(await s.flee.tick(), true)
  assert.deepEqual(s.travel, ['cancel'])
  assert.match(s.logs[0], /武器がないため敵から離れます/)
})

function scene ({ mode = 'player', wanted = true, health = 5, retreat } = {}) {
  const s = { health, shared: { playerWanted: wanted }, clock: 0, enemies: [zombie(4)], stops: [], logs: [], flags: [], running: true, position: { ...here }, travel: [], travelBusy: true, inventory: health > 8 ? { items: [] } : { items: [{ name: 'minecraft:wooden_sword', count: 1 }] } }
  s.flee = createPlayerFlee({
    getMode: () => mode, shared: s.shared, log: text => s.logs.push(text), now: () => s.clock,
    sleep: async ms => { s.clock += ms },
    agent: { running: () => s.running, stop: reason => { s.running = false; s.stops.push(reason) } },
    getState: () => ({ health: s.health, position: s.position, totem: false, inventory: s.inventory }),
    travel: { status: () => ({ busy: s.travelBusy }), cancel: async () => { s.travel.push('cancel'); s.travelBusy = false } },
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

test('a run with no step is not tried again for 30 s, 60 s, 2 min, unless the Bot is hurt again', async () => {
  const s = scene({ retreat: () => false })
  assert.equal(await s.flee.tick(), true)
  assert.equal(s.flags.length, 3)
  assert.equal(s.shared.playerFlee, null)
  assert.match(s.logs.at(-2), /その場で戦います（0歩）/)
  assert.match(s.logs.at(-1), /30秒は離れ直しません/)
  s.clock += 29000
  assert.equal(await s.flee.tick(), false)
  s.clock += 1001
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /60秒は離れ直しません/)
  s.clock += 59000
  assert.equal(await s.flee.tick(), false)
  s.health = 3 // hurt since the stuck run
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /120秒は離れ直しません/)
  s.clock += 120001
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /120秒は離れ直しません/)
})

test('steps that stop starting after a first step hand back to combat for five seconds', async () => {
  let calls = 0
  const s = scene({ retreat: s => { if (calls++) return false; s.position.x -= 2; return true } })
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /その場で戦います（1歩）/)
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

test('armed and in melee contact the Bot keeps fighting; unarmed it still runs', () => {
  const here = { x: 0, y: 65.62, z: 0 }
  const drowned = d => ({ entityType: 'minecraft:drowned', position: { x: d, y: 64, z: 0 } })
  assert.equal(fleeWanted({ health: 6.4, hostiles: [drowned(1.1)], position: here }), null)
  assert.equal(fleeWanted({ health: 6.4, hostiles: [drowned(5)], position: here })?.name, 'drowned')
  assert.equal(fleeWanted({ health: 6.4, hostiles: [drowned(1.1)], position: here, weaponless: true })?.name, 'drowned')
})
