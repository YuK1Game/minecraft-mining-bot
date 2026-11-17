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

test('the wait after a stuck run ends when a hostile comes two metres closer', async () => {
  const s = scene({ retreat: () => false })
  s.enemies = [zombie(9)]
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /30秒は離れ直しません/)
  s.enemies = [zombie(8)]
  assert.equal(await s.flee.tick(), false)
  s.enemies = [zombie(9), creeper(6.5)]
  assert.equal(await s.flee.tick(), true)
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

test('in play with a weapon in the received inventory, the empty-handed rule does not hold combat back', () => {
  const { armedInPlay } = require('../src/modes/player-flee')
  const sword = { items: [{ name: 'minecraft:wooden_sword', count: 1 }] }, pick = { items: [{ name: 'minecraft:wooden_pickaxe', count: 1 }] }
  assert.equal(armedInPlay({ playerWanted: true }, sword), true)
  assert.equal(armedInPlay({ playerWanted: true }, pick), false)
  assert.equal(armedInPlay({ playerWanted: true }, null), false)
  assert.equal(armedInPlay({ playerWanted: true, inventoryUncertain: true }, sword), false)
  assert.equal(armedInPlay({}, sword), false)
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/runtime/quarry-runtime.js'), 'utf8')
  assert.match(source, /function quarryCanSelectTarget[^\n]*!emptyHandedAllows\(target, state\)/)
  assert.match(source, /function quarryCanContinue[^\n]*!emptyHandedAllows\(target, state\)/)
})

const phantom = (x, y = 68.6, id = 7) => ({ entityType: 'minecraft:phantom', hostile: true, runtimeId: id, position: { x, y, z: 0 } })

test('a run that walked and did not get away waits, and the hostile it could not leave does not start the next one', async () => {
  // Live 2026-11-18 04:31-04:34 JST: a phantom overhead stayed at 6.3 m through nine runs.
  const s = scene({ retreat: s => { s.position.x -= 3; s.enemies = [phantom(s.position.x + 4.3)]; return true } })
  s.enemies = [phantom(4.3)]
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-2), /離れても敵との距離が開きません（\d+歩、phantom 6\.3m）/)
  assert.match(s.logs.at(-1), /離れられない敵のため.*30秒は離れ直しません/)
  assert.equal(s.shared.playerFlee, null)
  const runs = s.flags.length
  // It dives: still not run from, and combat is not told to stand down.
  s.enemies = [phantom(s.position.x + 3.8, 65)]
  assert.equal(await s.flee.tick(), false)
  assert.equal(s.flee.status().skip, 'kept_up_rest')
  // Hurt by it: the same.
  s.health = 3
  assert.equal(await s.flee.tick(), false)
  assert.equal(s.flags.length, runs)
  // Another hostile within reach of a run, while hurt since: a new run.
  s.enemies = [phantom(s.position.x + 4.3), { ...zombie(s.position.x + 9), runtimeId: 9 }]
  assert.equal(await s.flee.tick(), true)
  assert.ok(s.flags.length > runs)
})

test('another hostile ends that wait only when it is two metres nearer or the Bot is hurt again', async () => {
  const s = scene({ retreat: s => { s.position.x -= 3; s.enemies = [phantom(s.position.x + 4.3)]; return true } })
  s.enemies = [phantom(4.3)]
  assert.equal(await s.flee.tick(), true)
  const other = distance => ({ ...zombie(s.position.x + distance), runtimeId: 9 })
  s.enemies = [phantom(s.position.x + 4.3), other(9)]
  assert.equal(await s.flee.tick(), false)
  assert.equal(s.flee.status().skip, 'stuck_rest')
  s.enemies = [phantom(s.position.x + 4.3), other(4)]
  assert.equal(await s.flee.tick(), true)
})

test('after that wait the run is tried once more and the wait doubles; a run that gets away ends it', async () => {
  let follows = true
  const s = scene({ retreat: s => { s.position.x -= 3; if (follows) s.enemies = [phantom(s.position.x + 4.3)]; return true } })
  s.enemies = [phantom(4.3)]
  assert.equal(await s.flee.tick(), true)
  s.clock += 30001
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /60秒は離れ直しません/)
  s.clock += 60001
  follows = false
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs.at(-1), /敵から離れました/)
  // Nothing is remembered of it: the next hostile is run from at once.
  s.enemies = [phantom(s.position.x + 4.3)]
  assert.equal(await s.flee.tick(), true)
})

test('a shooter or a flyer behind received blocks is not run from; unreceived blocks are not cover', () => {
  const { fleeThreats } = require('../src/modes/player-flee-threats')
  const { createCombatExposure } = require('../src/combat/combat-exposure')
  const wall = new Set(['2,64,0', '2,65,0', '2,66,0'])
  const world = known => ({ getBlock: (x, y, z) => wall.has(`${x},${y},${z}`) ? (known ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: false }) : { known: true, name: 'minecraft:air', boundingBox: 'empty' } })
  const at = { x: 0.5, y: 65.62, z: 0.5 }
  const sight = known => actor => createCombatExposure({ world: world(known), entities: {}, scopeOf: () => null }).evaluate(actor, { position: at }).evidence.sight
  const mob = (name, x = 8.5, z = 0.5) => ({ entityType: `minecraft:${name}`, hostile: true, position: { x, y: 64, z } })
  const names = list => list.map(actor => actor.entityType.replace('minecraft:', ''))
  const all = [mob('skeleton'), mob('witch'), mob('phantom'), mob('zombie'), mob('creeper')]
  // Behind the wall: the walker and the creeper stay, the three that attack along a line do not.
  assert.deepEqual(names(fleeThreats({ hostiles: all, sight: sight(true) })), ['zombie', 'creeper'])
  // The same wall not received: nothing is known to be in the way.
  assert.deepEqual(names(fleeThreats({ hostiles: all, sight: sight(false) })), ['skeleton', 'witch', 'phantom', 'zombie', 'creeper'])
  // In the open, to the side of the wall.
  assert.deepEqual(names(fleeThreats({ hostiles: [mob('skeleton', 0.5, 8.5)], sight: sight(true) })), ['skeleton'])
  // No route to the Bot, as before; a creeper counts whatever is known.
  assert.deepEqual(names(fleeThreats({ hostiles: [mob('zombie'), mob('creeper')], unreachable: () => true })), ['creeper'])
  assert.deepEqual(fleeThreats({ hostiles: null }), [])
})
