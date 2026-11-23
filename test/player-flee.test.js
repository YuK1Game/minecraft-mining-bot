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
  assert.equal(source.match(/reason: 'EMPTY_HANDED_AVOID' \}; if \(playerFleeing\(target, state\)\) return \{ allowed: false, reason: 'PLAYER_FLEE' \}/g)?.length, 2)
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

test('water between the two is not cover: a drowned in the pond is still run from (live 2026-11-18 05:09 JST)', () => {
  const { fleeThreats } = require('../src/modes/player-flee-threats')
  const { createCombatExposure } = require('../src/combat/combat-exposure')
  // A pond: water from x=2 to x=10 below y=64; the Bot stands on the bank, the drowned on the bottom.
  const block = (x, y, z) => y < 60 ? { known: true, name: 'minecraft:dirt', boundingBox: 'block' } : y < 64 && x >= 2 && x <= 10 ? { known: true, name: 'minecraft:water', boundingBox: 'empty' } : y < 64 ? { known: true, name: 'minecraft:dirt', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  const at = { x: 1.5, y: 65.62, z: 0.5 }
  const sight = options => actor => createCombatExposure({ world: { getBlock: block }, entities: {}, scopeOf: () => null, ...options }).evaluate(actor, { position: at }).evidence.sight
  const drowned = { entityType: 'minecraft:drowned', hostile: true, position: { x: 8.5, y: 60, z: 0.5 } }
  // Combat's own reading keeps water as "in the way"; the flee asks for solid cover only.
  assert.equal(sight({})(drowned), false)
  assert.equal(sight({ solidCover: true })(drowned), true)
  assert.deepEqual(fleeThreats({ hostiles: [drowned], sight: sight({ solidCover: true }) }), [drowned])
  // Seagrass in the water (a plant with a water layer) is no cover either; the bank itself is.
  const weeds = (x, y, z) => y === 62 && x >= 2 && x <= 10 ? { known: true, name: 'minecraft:seagrass', boundingBox: 'empty', extra: [{ name: 'minecraft:water' }] } : block(x, y, z)
  assert.equal(createCombatExposure({ world: { getBlock: weeds }, entities: {}, scopeOf: () => null, solidCover: true }).evaluate(drowned, { position: at }).evidence.sight, true)
  const behindBank = { ...drowned, position: { x: -6.5, y: 60, z: 0.5 } }
  assert.equal(sight({ solidCover: true })(behindBank), false)
  assert.deepEqual(fleeThreats({ hostiles: [behindBank], sight: sight({ solidCover: true }) }), [])
})

test('a hostile within melee contact is not held off by the stand-down', () => {
  const { caughtUp } = require('../src/modes/player-flee')
  const state = { position: { x: 0, y: 65.62, z: 0 } }
  assert.equal(caughtUp({ position: { x: 1.5, y: 64, z: 0 } }, state), true)
  assert.equal(caughtUp({ position: { x: 5, y: 64, z: 0 } }, state), false)
  assert.equal(caughtUp({ position: null }, state), false)
  assert.equal(caughtUp({ position: { x: 1, y: 64, z: 0 } }, {}), false)
})

test('armed and unable to heal (hunger under 18, no food): the Bot does not walk away', () => {
  const { fleeWanted } = require('../src/modes/player-flee')
  const { healing } = require('../src/modes/flee-healing')
  const hostiles = [{ entityType: 'minecraft:zombie', position: { x: 8, y: 64, z: 0 } }]
  const base = { health: 3.66, totem: false, hostiles, position: { x: 0, y: 65.62, z: 0 } }
  assert.equal(fleeWanted({ ...base, healing: false }), null)
  assert.ok(fleeWanted({ ...base, healing: true }), 'with food it still leaves')
  assert.ok(fleeWanted({ ...base, healing: null }), 'unknown is not "cannot heal"')
  assert.ok(fleeWanted({ ...base, healing: false, weaponless: true }), 'unarmed still leaves')
  const hasFood = inventory => inventory.items.some(item => /cooked/.test(item.name))
  assert.equal(healing({ hunger: 6, inventory: { known: true, items: [] }, hasFood }), false)
  assert.equal(healing({ hunger: 6, inventory: { known: true, items: [{ name: 'minecraft:cooked_beef', count: 1 }] }, hasFood }), true)
  assert.equal(healing({ hunger: 19, inventory: { known: true, items: [] }, hasFood }), true)
  assert.equal(healing({ hunger: null, inventory: { known: true, items: [] }, hasFood }), null)
  assert.equal(healing({ hunger: 6, inventory: null, hasFood }), null)
})

test('with no weapon, an archer or a witch is run from at any health within 12 m (live 2026-11-19 17:47 JST)', () => {
  const witch = x => ({ entityType: 'minecraft:witch', hostile: true, position: { x, y: 64, z: 0 } })
  const skeleton = x => ({ entityType: 'minecraft:skeleton', hostile: true, position: { x, y: 64, z: 0 } })
  const drowned = x => ({ entityType: 'minecraft:drowned', hostile: true, tridentThrower: true, position: { x, y: 64, z: 0 } })
  // Health 19 on the house's step, a witch 1.1 m away: the potions took it to 4 in six seconds.
  assert.equal(fleeWanted({ health: 19, weaponless: true, hostiles: [witch(1.1)], position: here })?.name, 'witch')
  assert.equal(fleeWanted({ health: 20, weaponless: true, hostiles: [skeleton(11)], position: here })?.name, 'skeleton')
  assert.equal(fleeWanted({ health: 20, weaponless: true, hostiles: [drowned(10)], position: here })?.name, 'drowned')
  assert.equal(fleeWanted({ health: 20, weaponless: true, hostiles: [skeleton(13)], position: here }), null)
  assert.equal(fleeWanted({ health: 20, weaponless: true, hostiles: [zombie(5)], position: here }), null, 'a walker only at health 10 or less, as before')
  assert.equal(fleeWanted({ health: 19, weaponless: false, hostiles: [witch(5)], position: here }), null, 'armed: combat has it')
})

test('"cannot heal, so stay" does not hold while being hit with no fight on (live 2026-11-19 18:02 JST)', async () => {
  const skeleton = { entityType: 'minecraft:skeleton', hostile: true, position: { x: 6.9, y: 64, z: 0 } }
  const make = at => {
    const s = { shared: { playerWanted: true, recentDamageNoPrimary: at == null ? null : { at } }, clock: 100000, position: { ...here }, logs: [], steps: 0 }
    s.flee = createPlayerFlee({
      getMode: () => 'player', shared: s.shared, log: text => s.logs.push(text), now: () => s.clock, sleep: async ms => { s.clock += ms },
      agent: { running: () => false, stop: () => {} }, travel: { status: () => ({ busy: false }), cancel: async () => {} },
      getState: () => ({ health: 5, position: s.position, totem: false, healing: false, inventory: { items: [{ name: 'minecraft:wooden_sword', count: 1 }] } }),
      hostiles: () => [skeleton], retreat: async () => { s.steps++; s.clock += 1000; s.position.x -= 12; return true }
    })
    return s
  }
  // Standing off, not hit: it stays, as before (the food work goes on).
  const quiet = make(null)
  assert.equal(await quiet.flee.tick(), false)
  assert.equal(quiet.flee.status().skip, 'no_threat')
  const old = make(100000 - 5000)
  assert.equal(await old.flee.tick(), false)
  // Hit a second ago: it leaves.
  const struck = make(100000 - 1000)
  assert.equal(await struck.flee.tick(), true)
  assert.ok(struck.steps >= 1)
  assert.match(struck.logs[0], /体力が少ないため敵から離れます（体力 5、skeleton 6\.9m）/)
})

test('hurt and just hit, a shooter out to 20 m is run from; a walker and an unhit Bot keep the 12 m (live 2026-11-24 04:06 JST)', async () => {
  const skeleton = x => ({ entityType: 'minecraft:skeleton', hostile: true, position: { x, y: 64, z: 0 } })
  assert.equal(fleeWanted({ health: 7, hostiles: [skeleton(14.5)], position: here }), null)
  assert.equal(fleeWanted({ health: 7, struck: true, hostiles: [skeleton(14.5)], position: here })?.name, 'skeleton')
  assert.equal(fleeWanted({ health: 7, struck: true, hostiles: [skeleton(21)], position: here }), null)
  assert.equal(fleeWanted({ health: 7, struck: true, hostiles: [zombie(14.5)], position: here }), null)
  assert.equal(fleeWanted({ health: 12, struck: true, hostiles: [skeleton(14.5)], position: here }), null)
  // The run itself: health 7 with a sword, the skeleton 14.5 m away, an arrow one second ago.
  const s = scene({ health: 7, retreat: s => { s.position.x -= 6; return true } })
  s.enemies = [skeleton(14.5)]
  s.clock = 100000
  assert.equal(await s.flee.tick(), false)
  assert.equal(s.flee.status().skip, 'no_threat')
  s.shared.recentDamageNoPrimary = { at: s.clock - 1000 }
  assert.equal(await s.flee.tick(), true)
  assert.match(s.logs[0], /体力が少ないため敵から離れます（体力 7、skeleton 14\.5m）/)
  assert.ok(Math.abs(s.position.x - 14.5) > 16)
})
