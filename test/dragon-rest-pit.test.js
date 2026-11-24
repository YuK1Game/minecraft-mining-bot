'use strict'

// The expedition's wait for health is taken under a lid (src/modes/dragon-rest-pit.js; dragon-heal.js; the step's
// order in dragon-runtime.js).
// Real Realm 2026-11-23 JST (house at (9877,64,10138), goal early.diamond held, the clock fixed at noon): from
// 09:35:41 a phantom took 3.1 at every swoop — 13.7 → 10.6, 09:36:25 9.0 → 5.9, 09:36:51 8.9 → 5.8, 09:37:19
// 8.8 → 5.7 at feet (9905, 71, 10089) on grass, 09:38:08 5.7 → 2.6 —, each hit was answered by 「被弾したため、
// 攻撃を中断して退避します。」 and a wait where it stood; hunger was 19 at 09:36:43. Meanwhile it moved 60 m west
// to a skeleton, a zombie and a creeper; dead at 09:38:11 with the diamond sword and pickaxe.
// Real here: the expedition's runtime (dragon-runtime.js: the health wait's turn, the step's order, the guard),
// the wait (dragon-heal.js), the rest pit (dragon-rest-pit.js), the long trip's pit (runtime/long-travel-runtime.js
// travelNightPit, travel/night-stop.js planPit).
// Stand-ins: the server (a column of blocks: a mined block is air and its drop is in the bag, the body falls into
// the cell mined under it, a placement is the received block and one item less), the early step, the meal, the
// walk, and the climb out (player-climb.js has its own tests): it mines the lid and stands the Bot on its pillar.
// The stand-in's mining refuses rock without a pickaxe of its tier in the hand, by the dig rules the real check
// reads (quarry-rules.js; actions/mining.js 「適切なツルハシの装備を確認できません」), and its equip swaps the
// row into the selected slot. Their success is not the game's.
// Before (main ee3d626, the first scene): no block is mined, the wait stands on the grass at health 5.9.
// The last scene joins the ordinary shelter (player-shelter.js) and the expedition's wait for the ordinary jobs
// (crew-busy.js): a recorded pit counted as the shelter's work, for which the expedition waits.
// The pickaxe scenes (travel/pit-tool.js): real Realm 2026-11-23 17:52:56 and 18:00:36 JST, on stone with the
// stone sword in the hand: 「回復の穴を作れませんでした（DIG_REFUSED:適切なツルハシの装備を確認できません: stone）」.
// Before (main ce70959) the first of them ends with that line and no block mined.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createWorld } = require('./helpers/dragon-goal-world')
const { createLongTravelRuntime } = require('../src/runtime/long-travel-runtime')
const { pitSite, resting, REST, RETRY_MS } = require('../src/modes/dragon-rest-pit')
const { WAIT } = require('../src/modes/dragon-heal')
const { createPlayerShelter } = require('../src/modes/player-shelter')
const { crewBusy } = require('../src/modes/crew-busy')
const { blockRule, toolOf } = require('../src/quarry/quarry-rules')

const SRC = path.resolve(__dirname, '..', 'src')
const full = name => 'minecraft:' + name
const block = name => ({ known: true, name: full(name), boundingBox: name === 'air' ? 'empty' : 'block' })
const HOUSE = { x: 9877, y: 64, z: 10138 }
// As at 09:36 JST: the diamond sword and pickaxe.
const TOOLS = () => [{ slot: 0, name: full('diamond_sword'), count: 1, durabilityKnown: true, durabilityRemaining: 1421 }, { slot: 1, name: full('diamond_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: 1551 }]
const DUG = /体力 5\.9 のため、ふたをした穴の中で回復を待ちます/, OUT = /体力が戻ったので、穴を出ます/

// Grass at y 70 (the feet stand in y 71), dirt under it, stone from y 66 down. holes: cells that are air.
// surface / rock: the top block's height and the highest stone, for a scene that stands on rock.
function ground ({ feet = { x: 9905.5, y: 71, z: 10089.5 }, holes = [], bag = [...TOOLS(), { slot: 2, name: full('cooked_mutton'), count: 3 }], refuse = null, surface = 70, rock = 66 } = {}) {
  const key = (x, y, z) => `${x},${y},${z}`
  const changed = new Map(holes.map(cell => [key(cell.x, cell.y, cell.z), 'air']))
  const getBlock = (x, y, z) => block(changed.get(key(x, y, z)) ?? (y > surface ? 'air' : y <= rock ? 'stone' : y === surface ? 'grass_block' : 'dirt'))
  const g = { feet: { ...feet }, bag, mined: [], placed: [], walks: [], equips: [], getBlock, hunger: 19, meals: 0, retreats: 0, health: 5.9, hostile: 13.1 }
  const give = name => { const row = bag.find(item => item.name === full(name)); if (row) row.count++; else bag.push({ slot: bag.length, name: full(name), count: 1 }) }
  g.operations = {
    mining: { start ([cell]) {
      if (refuse) throw new Error(refuse)
      const name = getBlock(cell.x, cell.y, cell.z).name.replace('minecraft:', '')
      // Rock needs a pickaxe of its tier in the hand (the selected slot is 0).
      const rule = blockRule(full(name)), tool = toolOf(bag.find(item => item.slot === 0 && item.count > 0))
      if (rule?.needs === 'pickaxe' && !(tool?.kind === 'pickaxe' && tool.tier >= rule.tier)) throw new Error(`適切なツルハシの装備を確認できません: ${name}`)
      changed.set(key(cell.x, cell.y, cell.z), 'air'); g.mined.push({ x: cell.x, y: cell.y, z: cell.z })
      give(name === 'stone' ? 'cobblestone' : 'dirt')
      // The body falls into the cell mined under it.
      if (cell.x === Math.floor(g.feet.x) && cell.z === Math.floor(g.feet.z) && cell.y === Math.round(g.feet.y) - 1) g.feet.y = cell.y
    } },
    interactions: { placeBlock: async ({ position, slot }) => {
      const row = bag.find(item => item.slot === slot && item.count > 0)
      if (!row || getBlock(position.x, position.y, position.z).boundingBox !== 'empty') throw new Error('設置できません。')
      row.count--; changed.set(key(position.x, position.y, position.z), row.name.replace('minecraft:', '')); g.placed.push({ ...position })
    } },
    // Through the inventory into the selected slot: the two rows change places.
    inventory: { equip: async slot => {
      const row = bag.find(item => item.slot === slot && item.count > 0), was = bag.find(item => item.slot === 0 && item.count > 0)
      if (!row) throw new Error('持ち替える物がありません。')
      g.equips.push(row.name.replace('minecraft:', ''))
      if (was && was !== row) was.slot = slot
      row.slot = 0
      return { phase: 'completed', slot: 0, sourceSlot: slot, selectedSlotChanged: false }
    } },
    food: {
      preview: () => bag.some(item => /cooked_/.test(item.name) && item.count > 0) ? g.hunger < 20 ? { ready: true } : { ready: false, code: 'HUNGER_FULL' } : { ready: false, code: 'FOOD_NOT_IN_INVENTORY' },
      eat: async () => { g.meals++; bag.find(item => /cooked_/.test(item.name) && item.count > 0).count--; g.hunger = 20 },
      snapshot: () => ({ hunger: g.hunger })
    }
  }
  const items = () => bag.filter(item => item.count > 0)
  // The long trip's own runtime over this column: only its pit is called.
  g.trip = createLongTravelRuntime({
    require: name => require(path.resolve(SRC, name)), host: { world: { getBlock }, shared: {}, log: () => {} }, operations: g.operations,
    working: () => ({ position: { x: g.feet.x, y: g.feet.y + 1.62, z: g.feet.z }, inventory: { items: items() }, heldItem: items().find(item => item.slot === 0) ?? null, health: g.health })
  })
  g.items = items
  // The shared climb: through the lid, up on its own pillar to the ground it dug through.
  g.climb = shared => async () => {
    g.climbedWith = shared.travelNight?.cover ?? null
    const x = Math.floor(g.feet.x), z = Math.floor(g.feet.z)
    for (let y = Math.round(g.feet.y); y <= surface; y++) changed.set(key(x, y, z), 'dirt')
    g.feet.y = surface + 1
  }
  return g
}

async function expedition (t, g, { house = { done: true, origin: HOUSE }, cells = () => new Map(), climbs = true } = {}) {
  const w = await createWorld(t, {
    items: g.bag, getBlock: g.getBlock,
    live: () => ({ health: g.health, position: { x: g.feet.x, y: g.feet.y + 1.62, z: g.feet.z }, inventory: { known: true, items: g.items() } }),
    more: { travel: () => ({ travelNightPit: g.trip.travelNightPit, retreatFromHostiles: async () => { g.retreats++ } }), nearestHostile: () => g.hostile },
    ports: (signal, shared) => ({
      shared, signal, cancelled: () => signal.aborted, log: line => w.lines.push(line), operations: g.operations, getBlock: g.getBlock, getFeet: () => ({ ...g.feet }),
      cells, walk: async target => { g.walks.push({ ...target }); Object.assign(g.feet, target); return true }, rise: climbs ? g.climb(shared) : async () => {}
    }),
    step: async () => { w.next = (w.next ?? 0) + 1; return { done: false, reason: '次の作業をしています。' } }
  })
  w.boot({ playerHouse: house, travelLastDamageAt: 0 })
  w.look = async () => { w.rt.tick(); await w.rt.settled(); w.at += 2000 }
  return w
}

test('as at 09:36:25 JST: health 5.9, hunger 19, the phantom 13 m off: the wait digs the covered pit and stays in it', async t => {
  const g = ground(), w = await expedition(t, g)
  await w.look()
  assert.deepEqual(g.mined, [70, 69, 68].map(y => ({ x: 9905, y, z: 10089 })), 'three cells straight down')
  assert.deepEqual(g.placed, [{ x: 9905, y: 70, z: 10089 }], 'the lid in the top cell')
  assert.equal(g.feet.y, 68)
  assert.deepEqual(w.shared.travelNight.cover, { x: 9905, y: 70, z: 10089 })
  assert.equal(resting(w.shared), true)
  assert.equal(w.said(DUG).length, 1)
  assert.equal(g.retreats, 0)
  // A zombie stands on the lid and the last hit was two seconds ago: the wait stays and eats; it does not retreat.
  w.threatened = true; g.hostile = 2.4; w.shared.travelLastDamageAt = Date.now() - 2000
  await w.look()
  assert.equal(g.retreats, 0)
  assert.equal(g.meals, 1)
  assert.equal(g.feet.y, 68)
  assert.equal(resting(w.shared), true)
  assert.equal(g.mined.length, 3, 'nothing more is dug')
  assert.equal(w.next ?? 0, 0, 'no other work begins from the pit')
})

test('health 18: the record is cleared first, the shared climb goes up through the lid, and the work goes on', async t => {
  const g = ground(), w = await expedition(t, g)
  await w.look()
  assert.equal(resting(w.shared), true)
  g.health = 18.2; g.hostile = Infinity
  await w.look()
  assert.equal(g.climbedWith, null, 'the climb runs with no pit recorded (it stops while one is)')
  assert.equal(g.feet.y, 71)
  assert.equal(resting(w.shared), false)
  assert.equal(w.shared.travelNight.cover, null)
  assert.equal(w.said(OUT).length, 1)
  await w.look()
  assert.equal(w.next, 1, 'the next work begins')
})

test('a climb that leaves it under the lid: the lid is mined, and the record stays cleared', async t => {
  const g = ground(), w = await expedition(t, g, { climbs: false })
  await w.look()
  g.health = 18.2
  await w.look()
  assert.deepEqual(g.mined.at(-1), { x: 9905, y: 70, z: 10089 })
  assert.equal(g.getBlock(9905, 70, 10089).boundingBox, 'empty')
  assert.equal(w.said(/穴のふたを開けました/).length, 1)
  assert.equal(resting(w.shared), false)
})

test('an enemy within 10 m, a hit with an enemy near, hunger that does not regenerate with no meal: no pit, the wait as before', async t => {
  const near = ground(), a = await expedition(t, near)
  near.hostile = 6.2
  await a.look()
  assert.equal(near.mined.length, 0)
  const hit = ground(), b = await expedition(t, hit)
  hit.hostile = 3.9; b.threatened = true; b.shared.travelLastDamageAt = Date.now() - 2000
  await b.look()
  assert.equal(hit.mined.length, 0)
  assert.equal(hit.retreats, 1, 'the retreat first, as before')
  const hungry = ground({ bag: TOOLS() }), c = await expedition(t, hungry)
  hungry.hunger = 15
  await c.look()
  assert.equal(hungry.mined.length, 0)
  // Health 10 or more is not badly hurt (the ordinary play's own line, player-shelter.js REST_BELOW).
  const fine = ground(), d = await expedition(t, fine)
  fine.health = 10.6
  await d.look()
  assert.equal(fine.mined.length, 0)
})

test('on a slope the pit is dug at the nearest cell it can walk to where the walls stand', async t => {
  // The cell west of the feet is open two down: the pit's wall is missing here.
  const g = ground({ holes: [{ x: 9904, y: 70, z: 10089 }, { x: 9904, y: 69, z: 10089 }] })
  const cells = () => new Map([[1, { x: 9905, y: 71, z: 10089 }], [2, { x: 9906, y: 71, z: 10089 }], [3, { x: 9907, y: 71, z: 10089 }]])
  const w = await expedition(t, g, { cells })
  await w.look()
  assert.deepEqual(g.walks, [{ x: 9906.5, y: 71, z: 10089.5 }], 'one cell east: the nearest whose four walls stand')
  assert.deepEqual(w.shared.travelNight.cover, { x: 9906, y: 70, z: 10089 })
  assert.equal(resting(w.shared), true)
})

test('in the house no pit is dug and nothing walks out for one; a pit is not planned through a block of the house', async t => {
  // On the floor of the house (its origin is the floor's north-west corner); the ground outside the door can be walked to.
  const g = ground({ feet: { x: HOUSE.x + 3.5, y: 71, z: HOUSE.z + 3.5 } })
  const w = await expedition(t, g, { house: { done: true, origin: { ...HOUSE, y: 70 } }, cells: () => new Map([[1, { x: HOUSE.x + 3, y: 71, z: HOUSE.z + 8 }]]) })
  await w.look()
  assert.equal(g.mined.length, 0)
  assert.deepEqual(g.walks, [])
  assert.equal(w.rt.status().reason, WAIT)
  // Pure: on the roof over the corner post the three cells down are blocks of the house; one column outside they are not.
  const origin = { x: 0, y: 70, z: 0 }
  const solid = (x, y, z) => block(y <= 74 ? 'cobblestone' : 'air')
  assert.equal(pitSite({ getBlock: solid, feet: { x: 0.5, y: 75, z: 0.5 }, house: { origin } }), null)
  assert.deepEqual(pitSite({ getBlock: solid, feet: { x: 0.5, y: 75, z: 0.5 }, house: null }), { x: 0.5, y: 75, z: 0.5, walk: false }, 'the same column with no house')
  assert.deepEqual(pitSite({ getBlock: solid, feet: { x: -0.5, y: 75, z: 0.5 }, house: { origin } }), { x: -0.5, y: 75, z: 0.5, walk: false })
})

test('a pit that could not be dug is said once and not tried again for the rest; the wait goes on as before', async t => {
  const g = ground({ refuse: '射程内の採掘面への視線が遮られているか、未取得です。' }), w = await expedition(t, g)
  await w.look()
  assert.equal(w.said(/回復の穴を作れませんでした（DIG_REFUSED/).length, 1)
  assert.equal(resting(w.shared), false)
  assert.equal(g.meals, 1, 'the meal of the wait in the open')
  for (let passed = 2000; passed < RETRY_MS; passed += 2000) await w.look()
  assert.equal(w.said(/回復の穴を作れませんでした/).length, 1)
  await w.look()
  assert.equal(w.said(/回復の穴を作れませんでした/).length, 2)
})

test('inside with nothing left to feed the wait: out, and the next look goes for food', async t => {
  const g = ground({ bag: TOOLS() }), w = await expedition(t, g)
  await w.look()
  assert.equal(resting(w.shared), true, 'hunger 19 regenerates: the pit is dug with no food')
  g.hunger = 17
  await w.look()
  assert.equal(w.said(/食べられる物がなくなったため、穴を出ます/).length, 1)
  assert.equal(resting(w.shared), false)
  assert.equal(g.feet.y, 71)
})

test('a pit left behind by a death is forgotten: nothing climbs and no lid is mined from the bed', async t => {
  const g = ground(), w = await expedition(t, g)
  await w.look()
  assert.equal(resting(w.shared), true)
  // The next life stands at its bed with full health; the record still names the pit.
  Object.assign(g.feet, { x: HOUSE.x + 3.5, y: 65, z: HOUSE.z + 3.5 }); g.health = 20; g.climbedWith = undefined
  const mined = g.mined.length
  await w.look()
  assert.equal(resting(w.shared), false)
  assert.equal(g.climbedWith, undefined)
  assert.equal(g.mined.length, mined)
  assert.equal(w.said(OUT).length, 0)
})

test("a pit of the long trip or of the ordinary play is not the expedition's: it is left to their own rules", () => {
  assert.equal(resting({ travelNight: { cover: { x: 0, y: 70, z: 0 }, reason: 'rest' } }), false)
  assert.equal(resting({ travelNight: { cover: { x: 0, y: 70, z: 0 }, reason: 'night', owner: 'dragon' } }), false, 'a rest pit at dusk is the night pit')
  assert.equal(resting({ travelNight: { cover: null, reason: 'rest', owner: 'dragon' } }), false)
  assert.equal(resting({ travelNight: { cover: { x: 0, y: 70, z: 0 }, reason: 'rest', owner: 'dragon' } }), true)
  assert.equal(REST, '体力回復のため、ふたをした穴の中で待ちます。')
})

test("the expedition does not wait for the ordinary shelter over its own pit; the ordinary play takes the pit over with its first tick", async () => {
  const shared = { playerWanted: true, travelNight: { cover: { x: 9905, y: 70, z: 10089 }, reason: 'rest', owner: 'dragon', pitTried: 0 } }
  const stops = []
  const shelter = createPlayerShelter({
    getMode: () => 'player', shared, agent: { objective: {}, start: async () => {}, stop: reason => { stops.push(reason) }, running: () => true },
    getClock: () => ({ time: 30000, source: 'server_sync_world_clocks' }), getVitals: () => ({ health: 5.9, hunger: 19 }), dig: async () => ({ ok: false }), uncover: async () => true
  })
  assert.equal(shelter.status().active, false)
  assert.equal(crewBusy([shelter]), false, 'the expedition goes on stepping in its pit')
  // The same record without the owner (the long trip's rest pit) is the shelter's, as before.
  assert.equal(crewBusy([createPlayerShelter({ getMode: () => 'player', shared: { playerWanted: true, travelNight: { ...shared.travelNight, owner: undefined } }, agent: {}, getClock: () => null, getVitals: () => ({}), dig: async () => ({}), uncover: async () => true })]), true)
  // The ordinary play works again: its tick keeps the pit by its own rules.
  assert.deepEqual(await shelter.tick(), { action: 'stay', reason: 'rest' })
  assert.equal(shared.travelNight.owner, null)
  assert.equal(resting(shared), false)
  assert.equal(shelter.status().active, true)
  assert.deepEqual(stops, [REST])
})

// As at 17:52:56 JST: on stone at (9904, 62, 10142), the stone sword in the hand, one stone pickaxe with 24 uses
// and six with 2, no food, hunger that regenerates.
const WORN = () => [
  { slot: 0, name: full('stone_sword'), count: 1, durabilityKnown: true, durabilityRemaining: 122 },
  ...[9, 16, 17, 20, 21, 28].map(slot => ({ slot, name: full('stone_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: 2 })),
  { slot: 27, name: full('stone_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: 24 },
  { slot: 1, name: full('cobblestone'), count: 49 }
]
const ROCK = { feet: { x: 9904.5, y: 62, z: 10142.5 }, surface: 61, rock: 61 }

test('as at 17:52:56 JST: on stone with the sword in the hand: the working stone pickaxe is held first and the pit is dug', async t => {
  const g = ground({ ...ROCK, bag: WORN() }), w = await expedition(t, g)
  await w.look()
  assert.deepEqual(w.said(/回復の穴を作れませんでした/), [])
  assert.deepEqual(g.equips[0], 'stone_pickaxe')
  assert.equal(g.bag.some(item => item.name === full('stone_pickaxe') && item.durabilityRemaining >= 1 && item.slot <= 8), true, 'a working stone pickaxe is equipped into hotbar')
  assert.equal(g.equips.filter(name => name === 'stone_pickaxe').length, 1, 'held once for the three cells')
  assert.deepEqual(g.mined, [61, 60, 59].map(y => ({ x: 9904, y, z: 10142 })))
  assert.deepEqual(g.placed, [{ x: 9904, y: 61, z: 10142 }], 'the lid')
  assert.equal(resting(w.shared), true)
})

test('only reserved diamond pickaxe: the pit is not begun (no half-dug hole), and the line says why', async t => {
  const reserved = [
    { slot: 0, name: full('stone_sword'), count: 1, durabilityKnown: true, durabilityRemaining: 122 },
    { slot: 9, name: full('diamond_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: 2 },
    { slot: 1, name: full('cobblestone'), count: 49 }
  ]
  const g = ground({ ...ROCK, bag: reserved }), w = await expedition(t, g)
  await w.look()
  assert.deepEqual(g.mined, [])
  assert.deepEqual(g.equips, [])
  assert.equal(w.said(/回復の穴を作れませんでした（NO_WORKING_PICKAXE:stone）/).length, 1)
  assert.equal(resting(w.shared), false)
})

test('dirt and grass leave the hand as it is: the sword stays, as before', async t => {
  const g = ground({ bag: WORN() }), w = await expedition(t, g)
  await w.look()
  assert.deepEqual(g.mined, [70, 69, 68].map(y => ({ x: 9905, y, z: 10089 })))
  assert.equal(g.equips.includes('stone_pickaxe'), false)
  assert.equal(resting(w.shared), true)
})
