'use strict'

// The house's observed state, its repair and the use of its things, connected (user's instructions 2026-11-19,
// part C): the keeper (house-damage.js), the expedition's objective and steps (dragon-early.js, dragon-early-food.js
// with the real walk into the house, dragon-early-home.js), the gathering of materials (house-supply.js), the build
// (house-build.js) and the record on disk, over one block world with a virtual clock.
//
// On main 4b3090d the first of these fails: twenty minutes after a repair began the record said `done: true` with the
// blocks still missing, the objective went on as if the house were whole, and nothing looked for an hour.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHouseDamage, GIVE_UP_MS, AGAIN_MS } = require('../src/modes/house/house-damage')
const { createHouseBuild, houseDoc, loadHouseSync } = require('../src/modes/house/house-build')
const { pending, needsNow } = require('../src/modes/house/house-supply')
const { chestOf, bedOf } = require('../src/modes/house/house-spawn')
const { earlyObjective, runDragonEarly } = require('../src/modes/dragon-early')
const { provisionFood } = require('../src/modes/dragon-early-food')
const { approachHome } = require('../src/modes/dragon-early-home')
const { playerStages } = require('../src/modes/player-stages')
const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
const { createHouseWorld, ORIGIN } = require('./helpers/house-world')

const stack = (name, count, slot) => ({ name: 'minecraft:' + name, count, slot })
function scene ({ house = { origin: ORIGIN, done: true, spawn: true }, early = {} } = {}) {
  const w = createHouseWorld()
  const f = { w, clock: 1e6, feet: w.porch(), logs: [], reserved: [], opened: [], items: [stack('iron_pickaxe', 1, 0)], walks: true }
  f.shared = { playerHouse: house, botMode: 'player', playerWanted: true, lastSpawnSet: { position: bedOf(ORIGIN), type: 'player', dimension: 'overworld', at: 1 } }
  f.memory = { early }
  const inventory = () => ({ known: true, items: f.items })
  const ledger = createGoalLedger({ shared: f.shared, now: () => f.clock })
  ledger.open('early.home_reserve'); ledger.look({ value: 0, scope: 's' })
  f.keeper = createHouseDamage({ shared: f.shared, getBlock: w.getBlock, getFeet: () => f.feet, getInventory: inventory, now: () => f.clock, log: line => f.logs.push(line) })
  f.ctx = {
    signal: new AbortController().signal, cancelled: () => false, now: () => f.clock, sleep: async ms => { f.clock += ms }, log: line => f.logs.push(line),
    shared: f.shared, memory: f.memory, getFeet: () => f.feet, where: () => f.feet, getBlock: w.getBlock,
    hands: { walk: async to => { if (!f.walks) return false; f.feet = { ...to }; return true }, approach: async () => false, why: () => null },
    runtime: { inventory, armor: () => ({ known: true, worn: [] }), raw: () => ({ dimension: 'overworld' }) },
    goal: { fail: (failure, options) => ledger.fail(failure, options), spent: failure => ledger.spent(failure), step: key => ledger.step(key) },
    // The reserve itself (the open click, the 54 slots, the transfers) is dragon-supplies.js; here it only says which chest it was asked to use.
    supplies: { reserve: async at => { f.reserved.push({ ...at }); return f.stock?.(at) ?? { done: true, reason: 'stocked' } }, acquire: async () => ({ done: false, reason: 'acquire' }) },
    operations: {
      interactions: { useDoor: async () => {}, openFurnace: async at => { f.opened.push({ ...at }); throw new Error('かまどの画面を受信できません。') } },
      crafting: { closeContainer () {} }, furnace: {}, armor: { equipBest: async () => {} }, quarry: { travelStatus: () => ({ busy: false }) }
    }
  }
  f.house = () => f.shared.playerHouse
  f.objective = () => earlyObjective({ inventory: inventory(), worn: f.ctx.runtime.armor(), house: f.house(), memory: f.memory })
  f.supplying = () => pending({ mode: 'player', playing: true, shared: f.shared, state: { inventory: inventory() } })
  f.look = () => { f.keeper.tick(); f.clock += 5000; return f.keeper.tick() }
  f.pass = ms => { f.clock += ms; return f.keeper.tick() }
  f.early = async at => { if (at) f.feet = at; return runDragonEarly(f.ctx) }
  f.cook = async at => { if (at) f.feet = at; return provisionFood(f.ctx, 8) }
  f.said = pattern => f.logs.filter(line => pattern.test(line)).length
  return f
}
const WALL = 'p_060' // one plank of a wall

test('C1: a damaged house whose repair runs out of time stays damaged; only the repair is held', () => {
  const f = scene()
  assert.equal(f.w.pick(WALL)[0].item, 'oak_planks')
  f.w.take(WALL, 'oak_door')
  assert.equal(f.look(), 'reopened')
  assert.equal(f.objective().id, 'base')
  assert.equal(f.objective().label, '壊れた本拠点を直します。')
  assert.equal(f.objective().legacy, true, 'the ordinary build repairs it')
  assert.equal(f.supplying(), true)
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  assert.equal(f.house().done, false, 'the blocks are still missing: not done')
  assert.equal(f.shared.playerHouseSeen.state, 'damaged')
  assert.equal(f.house().repair.state, 'held')
  assert.equal(f.said(/家の修理が 20 分で終わらないため保留します（観測は破損のまま: 残り 2 手/), 1)
  // The work goes on, the materials are no longer gathered for the walls, and the stage stays reached.
  assert.equal(f.objective().id, 'home_spawn')
  assert.equal(f.objective().legacy, false)
  assert.equal(f.supplying(), false)
  assert.equal(playerStages({ known: true, items: f.items }, null, f.house(), null).stages.find(stage => stage.id === 'base').reached, true)
  for (let t = 0; t < AGAIN_MS - 60000; t += 60000) assert.equal(f.pass(60000), null)
  assert.equal(f.house().done, false)
  assert.equal(f.pass(60000), 'resumed', 'looked at again when its time is up')
  assert.equal(f.objective().id, 'base')
})

// Real Realm 2026-11-20 21:54-22:56 JST: each hold was taken a few steps out of the keeper's sight and was looked at
// again at the next sight of the house (2 minutes, 9 seconds, 8 seconds later). The expedition had the work for 19
// seconds of that hour.
test('C1: a repair that runs out of time out of sight stays held when the Bot comes back to the house it had seen', () => {
  const f = scene()
  f.w.take(WALL, 'oak_door')
  assert.equal(f.look(), 'reopened')
  const porch = f.feet
  f.feet = { x: ORIGIN.x + 24, y: ORIGIN.y + 1, z: ORIGIN.z + 3 } // gathering wood for the repair
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  assert.equal(f.said(/保留します（観測は破損のまま: 最後に見た時は残り 2 手/), 1)
  f.feet = porch
  for (let t = 0; t < 10 * 60000; t += 5000) assert.equal(f.pass(5000), null)
  assert.equal(f.house().repair.state, 'held')
  assert.equal(f.objective().id, 'home_spawn', 'the expedition keeps the work')
  assert.equal(f.objective().legacy, false)
  assert.equal(f.supplying(), false)
  assert.equal(f.said(/保留していた家の修理を見直します/), 0)
})

test('C2: with a wall open and the bed, the chest, the furnace and the way in standing, the steps store and cook', async () => {
  const f = scene()
  f.w.take(WALL, 'oak_door')
  f.look(); f.pass(GIVE_UP_MS)
  assert.equal(f.house().repair.state, 'held')
  // The respawn bed.
  const spawn = await f.early(f.w.beside('p_173'))
  assert.equal(spawn.reason, '本拠点のベッドと設定済みの復帰地点を確認しました。')
  assert.equal(f.memory.early.spawnReady, true)
  // The reserve chest: large chest A, as received.
  f.stock = () => ({ done: false, reason: 'iron_sword を予備用に補給します。', missing: { name: 'iron_sword', count: 1 } })
  assert.equal((await f.early(f.w.beside('p_174'))).reason, 'iron_sword を予備用に補給します。')
  assert.deepEqual(f.reserved, [chestOf(ORIGIN)])
  assert.deepEqual(f.memory.early.reserveAt, chestOf(ORIGIN))
  // The cook: the first furnace, opened by the cook itself.
  f.items.push(stack('beef', 2, 1), stack('coal', 1, 2))
  const cook = await f.cook(f.w.beside('p_179'))
  assert.deepEqual(f.opened, [f.w.at('p_179')])
  assert.equal(cook.result.code, 'COOK_NOTHING', 'the furnace was used; this one refused')
  // Nothing of this reopened the whole repair or wrote the house whole.
  assert.equal(f.house().repair.state, 'held')
  assert.equal(f.house().done, false)
  assert.notEqual(f.objective().id, 'base')
})

test('C3: a broken bed is repaired alone; the record does not make it usable', async () => {
  const f = scene()
  f.w.take(WALL, 'white_bed')
  const before = needsNow({ shared: f.shared, state: { inventory: { known: true, items: f.items } }, getBlock: f.w.getBlock })
  // The record still says done: the step reads the bed's blocks.
  const step = await f.early(f.w.beside('p_173'))
  assert.equal(step.result.code, 'HOME_FACILITY_REPAIR')
  assert.equal(f.memory.early.spawnReady, undefined)
  const { left, ...record } = f.house()
  assert.deepEqual(record, { origin: ORIGIN, done: false, spawn: false, built: true, repair: { state: 'running', since: f.clock, need: 'bed', focus: ['p_173'] } })
  assert.ok(left && left.white_bed === 1, 'what the gathering last saw missing stays in the record')
  assert.equal(f.said(/家のベッドが壊れているため、そこだけ先に直します（1 手）/), 1)
  assert.equal(f.objective().id, 'base')
  assert.equal(f.supplying(), true)
  // Only the bed's materials are gathered (three wool, three planks), not the wall's.
  const focused = needsNow({ shared: f.shared, state: { inventory: { known: true, items: f.items } }, getBlock: f.w.getBlock })
  assert.deepEqual(focused.total, { logs: 1, cobblestone: 0, sand: 0, wool: 3, coal: 0 })
  assert.ok(before.total.logs >= focused.total.logs)
  // The build puts the bed back; the keeper holds the wall and the step goes on.
  f.w.mend('white_bed')
  assert.equal(f.pass(2000), 'held')
  assert.equal(f.house().done, false)
  assert.equal(f.objective().id, 'home_spawn')
  // The respawn point is set again at the bed (setSpawn is the existing step; here the server's notice is given).
  f.shared.playerHouse = { ...f.house(), spawn: true }
  assert.equal((await f.early(f.w.beside('p_173'))).reason, '本拠点のベッドと設定済みの復帰地点を確認しました。')
})

test('C3: half of large chest A gone: chest B is used; both gone: the chests are repaired, nothing is opened', async () => {
  const f = scene({ early: { spawnReady: true } })
  const [a1, a2, b1, b2] = f.w.pick('chest')
  f.w.take(a2.id)
  await f.early(f.w.beside(b1.id))
  assert.deepEqual(f.reserved, [b1.position])
  assert.deepEqual(f.memory.early.reserveAt, b1.position)
  assert.equal(f.said(/使えるほう \(-4896, 77, -4990\) に予備装備を置きます/), 1)
  assert.equal(f.house().done, true, 'the thing the step needs stands: nothing is written')
  // Chest A is put back later: the kit stays in the chest it was put in.
  f.w.mend(a2.id)
  delete f.memory.early.reserveReady
  await f.early(f.w.beside(b1.id))
  assert.deepEqual(f.reserved.at(-1), b1.position)

  const g = scene({ early: { spawnReady: true } })
  g.w.take(a1.id, a2.id, b2.id)
  const step = await g.early(g.w.beside(a1.id))
  assert.equal(step.result.code, 'HOME_FACILITY_REPAIR')
  assert.deepEqual(g.reserved, [], 'the completion record alone opens no chest')
  assert.equal(g.house().done, false)
  assert.deepEqual(g.house().repair.focus, [b2.id], 'the pair nearest to whole')
  assert.equal(g.objective().id, 'base')
})

test('C3: a chest that stands and gives no 54 slots three times is left for the other one', async () => {
  const f = scene({ early: { spawnReady: true } })
  const [a1, , b1] = f.w.pick('chest')
  f.stock = at => at.x === a1.position.x ? { done: false, reason: '予備のラージチェストの54枠を受信できません（27枠）。', unread: '27枠' } : { done: true, reason: 'stocked' }
  for (let i = 0; i < 3; i++) {
    const step = await f.early(f.w.beside(a1.id))
    assert.equal(step.result.code, 'CHEST_NOT_READ')
    f.clock += 21000
  }
  assert.equal(f.said(/54枠を 3 回とも受信できなかったため、このチェストは使いません（27枠）/), 1)
  // The fourth step does not open chest A again: it uses chest B (indoors, within reach of the same stand).
  const opened = f.reserved.length
  await f.early(f.w.beside(a1.id))
  assert.deepEqual(f.reserved.slice(opened), [b1.position])
  assert.equal(f.memory.early.reserveReady, true)
})

test('C3: the first furnace gone: the cook uses the second; both gone: a furnace is repaired, nothing is cooked', async () => {
  const f = scene()
  f.items.push(stack('beef', 2, 1), stack('coal', 1, 2))
  f.w.take('p_179')
  await f.cook(f.w.beside('p_180'))
  assert.deepEqual(f.opened, [f.w.at('p_180')])
  assert.equal(f.house().done, true)
  f.w.take('p_180')
  const cook = await f.cook(f.w.beside('p_180'))
  assert.equal(cook.result.code, 'HOME_FACILITY_REPAIR')
  assert.deepEqual(cook.result.remaining, { step: 'cook', cooked: 8, raw: 2 })
  assert.equal(f.opened.length, 1)
  assert.equal(f.house().repair.need, 'furnace')
  assert.deepEqual(f.house().repair.focus, ['p_179'])
})

test('C3: no walk in, and the doorway\'s floor received as gone: the entrance is repaired', async () => {
  const f = scene({ early: { spawnReady: true } })
  f.w.take('oak_door', 'p_039', 'p_046')
  f.walks = false
  // The way that digs and stacks was tried a moment ago and rests (dragon-early-home.js): no other way in right now.
  f.shared.dragonHomeInner = { until: Infinity }; f.shared.dragonHomeWalk = { until: Infinity }
  assert.equal(await approachHome(f.ctx, chestOf(ORIGIN)), false)
  assert.equal(f.house().repair.need, 'entrance')
  assert.deepEqual([...f.house().repair.focus].sort(), ['p_039', 'p_046'])
  assert.equal(f.house().done, false)
  // With the floor standing a walk that does not arrive asks for nothing.
  const g = scene({ early: { spawnReady: true } })
  g.w.take('oak_door'); g.walks = false
  // Here the doorway still has its stands, so the rest that counts is the one of the way to the entrance.
  g.shared.dragonHomeInner = { until: Infinity, entrance: true }; g.shared.dragonHomeWalk = { until: Infinity }
  assert.equal(await approachHome(g.ctx, chestOf(ORIGIN)), false)
  assert.equal(g.house().done, true)
  assert.equal(g.house().repair, undefined)
})

test('C4: while the cells a step needs are not received nothing is decided; it is decided when they are', async () => {
  const f = scene({ early: { spawnReady: true } })
  const [a1, a2, b1, b2] = f.w.pick('chest')
  f.w.take(a1.id, a2.id, b1.id, b2.id)
  f.w.hide('chest')
  const record = JSON.stringify(f.house())
  const waiting = await f.early(f.w.beside(a1.id))
  assert.equal(waiting.result.code, 'HOME_FACILITY_UNKNOWN')
  assert.equal(waiting.result.retry.kind, 'terrain_received')
  assert.deepEqual(f.reserved, [])
  assert.equal(f.look(), null, 'the keeper has no verdict either')
  assert.equal(JSON.stringify(f.house()), record, 'neither broken nor whole is written')
  assert.equal(f.objective().id, 'home_reserve', 'the goal stays')
  f.w.show()
  assert.equal((await f.early()).result.code, 'HOME_FACILITY_REPAIR')
  assert.equal(f.house().repair.need, 'chest')
})

test('C5: a record of before that says done is checked against the received blocks before anything is used', async () => {
  const old = loadHouseSync('x', { io: { readFileSync: () => JSON.stringify({ version: 1, origin: ORIGIN, done: true, spawn: true, savedAt: '2026-11-19T04:00:00.000Z' }) } })
  assert.deepEqual(old, { origin: { ...ORIGIN }, done: true, spawn: true })
  const f = scene({ house: old, early: { spawnReady: true } })
  const [a1, a2, b1] = f.w.pick('chest')
  f.w.take(a1.id, a2.id, b1.id, 'oak_door', 'p_039')
  assert.equal(f.objective().id, 'home_reserve', 'the record alone: the house looks whole')
  const step = await f.early(f.w.beside(a1.id))
  assert.equal(step.result.code, 'HOME_FACILITY_REPAIR')
  assert.deepEqual(f.reserved, [], 'a chest that is not there is not used')
  assert.equal(f.house().done, false)
  assert.equal(f.house().built, true)
  // Written back and read again: the same record, with the repair.
  assert.deepEqual(loadHouseSync('x', { io: { readFileSync: () => JSON.stringify(houseDoc(f.house(), f.clock)) } }), f.house())
  // The keeper, near the house, observes the rest of the damage without the record's help.
  const g = scene({ house: { ...old } })
  g.w.take('oak_door', 'p_039')
  assert.equal(g.look(), 'reopened')
  assert.equal(g.house().done, false)
})

test('C6: a held repair of the bed is looked at again when the wool is there, and the step goes on when the bed stands', async () => {
  const f = scene()
  f.w.take('white_bed')
  await f.early(f.w.beside('p_173'))
  assert.equal(f.house().repair.need, 'bed')
  // No wool: twenty minutes pass and the bed's repair is held.
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  assert.deepEqual(f.house().repair.basis.short, { logs: 1, cobblestone: 0, sand: 0, wool: 3, coal: 0 })
  assert.equal(f.objective().id, 'home_spawn')
  // The step does not ask again and again: it answers that the bed's repair is held.
  for (let i = 0; i < 3; i++) {
    const step = await f.early(f.w.beside('p_173'))
    assert.equal(step.result.code, 'HOME_FACILITY_HELD')
    assert.equal(step.result.retry.kind, 'supplies_changed')
    assert.equal(f.house().repair.state, 'held')
    assert.equal(f.pass(2000), null)
  }
  // Wool of one colour, three: the kind that was short is all there.
  f.items.push(stack('white_wool', 3, 3))
  assert.equal(f.pass(2000), 'resumed')
  assert.equal(f.said(/保留していた家の修理を見直します（材料がそろった/), 1)
  assert.deepEqual(f.house().repair, { state: 'running', since: f.clock, need: 'bed', focus: ['p_173'] })
  assert.equal(f.objective().id, 'base')
  // The bed is placed (house-build.js): the repair is held again, done or not, and the step uses the bed.
  f.w.mend('white_bed')
  assert.equal(f.pass(2000), 'held')
  f.shared.playerHouse = { ...f.house(), spawn: true }
  assert.equal((await f.early(f.w.beside('p_173'))).reason, '本拠点のベッドと設定済みの復帰地点を確認しました。')
  assert.equal(f.memory.early.spawnReady, true)
})

// The build itself, limited to the thing that was asked for.
function building ({ missing, items, house }) {
  const w = createHouseWorld()
  w.take(...missing)
  const feet = { x: ORIGIN.x + 3.5, y: ORIGIN.y + 1, z: ORIGIN.z + 4.5 }
  const held = items.map(([name, count], slot) => stack(name, count, slot))
  const shared = { playerWanted: true, playerHouse: house }, placed = []
  let clock = 1e6
  const ports = {
    craft: async () => false, why: () => null, reset () {}, mine: async () => false,
    inspectChest: async () => ({ status: 'completed', evidence: { slotCount: 54 } }),
    place: async (name, plan) => {
      const step = w.steps.find(one => one.position.x === plan.position.x && one.position.y === plan.position.y && one.position.z === plan.position.z)
      const pile = held.find(item => item.name === name && item.count > 0)
      assert.ok(pile, name); pile.count--; placed.push(step.id); w.mend(step.id)
      return true
    }
  }
  const build = createHouseBuild({
    getMode: () => 'player', shared, ports, hands: { walk: async stand => { Object.assign(feet, stand); return true }, approach: async () => true },
    getBlock: (x, y, z) => y < ORIGIN.y ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : w.getBlock(x, y, z), getFeet: () => ({ ...feet }), getPosition: () => ({ ...feet, y: feet.y + 1.62 }), getInventory: () => ({ known: true, items: held }),
    agent: { objective: {}, stop () {}, start: async () => {}, settled: () => true }, climb: async () => ({ ok: true }),
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} }, now: () => clock, sleep: async ms => { clock += ms }
  })
  return { build, shared, placed, w, tick: async ms => { clock += ms ?? 0; return build.tick() } }
}

test('the build of a repair asked for one thing places that thing only; a held repair places nothing; a whole repair places the rest', async () => {
  const items = [['iron_pickaxe', 1], ['bed', 1], ['oak_planks', 4]]
  const f = building({ missing: [WALL, 'white_bed'], items, house: { origin: ORIGIN, done: false, spawn: true, built: true, repair: { state: 'running', since: 1e6, need: 'bed', focus: ['p_173'] } } })
  await f.tick()
  assert.deepEqual(f.placed, ['p_173'], 'the wall waits although its planks are held')
  assert.equal(f.shared.playerHouse.done, false)
  // Held (the keeper, as soon as the bed stands): the build does not come back for the wall.
  f.shared.playerHouse = { ...f.shared.playerHouse, repair: { state: 'held', since: 1e6, heldAt: 1e6, until: 9e9, tried: {}, basis: { missing: 1, short: null, seen: true } } }
  assert.equal(await f.tick(700000), null)
  assert.deepEqual(f.placed, ['p_173'])
  // Looked at again (its time, or the materials): the whole repair places the wall, and the build alone writes done.
  f.shared.playerHouse = { ...f.shared.playerHouse, repair: { state: 'running', since: 2e6 } }
  await f.tick()
  assert.deepEqual(f.placed, ['p_173', WALL])
  assert.equal(f.shared.playerHouse.done, true)
  assert.equal(f.shared.playerHouse.built, true)
})
