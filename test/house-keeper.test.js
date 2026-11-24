'use strict'

// The keeper of the house (src/modes/house/house-damage.js): what is observed, and the clock of the repair, apart.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHouseDamage, GIVE_UP_MS, AGAIN_MS } = require('../src/modes/house/house-damage')
const { needHouse } = require('../src/modes/house/house-repair')
const { createHouseWorld, ORIGIN } = require('./helpers/house-world')

const stack = (name, count) => ({ name: 'minecraft:' + name, count })
function setup ({ house = { origin: ORIGIN, done: true, spawn: true }, items = [] } = {}) {
  const w = createHouseWorld()
  const f = { w, clock: 1e6, feet: w.porch(), logs: [], saved: [], items, scope: 'c1/overworld/1', dimension: 'overworld', inventory: true }
  f.shared = { playerHouse: house }
  f.keeper = createHouseDamage({ shared: f.shared, getBlock: w.getBlock, getFeet: () => f.feet, now: () => f.clock, log: line => f.logs.push(line),
    getInventory: () => f.inventory ? { known: true, items: f.items } : null, scope: () => f.scope, dimension: () => f.dimension, save: house => { f.saved.push(JSON.parse(JSON.stringify(house))) } })
  // Two looks, five seconds apart: an observation.
  f.look = () => { f.keeper.tick(); f.clock += 5000; return f.keeper.tick() }
  f.pass = ms => { f.clock += ms; return f.keeper.tick() }
  f.house = () => f.shared.playerHouse
  // A wall block, the door and the floor behind it gone; the repair then runs out of time.
  f.heldAfterBlast = () => { w.take('oak_door', 'p_039'); assert.equal(f.look(), 'reopened'); assert.equal(f.pass(GIVE_UP_MS), 'held') }
  return f
}

test('observed damage starts the repair and is saved; the build\'s `done` ends it', () => {
  const f = setup()
  f.w.take('oak_door', 'p_039')
  assert.equal(f.look(), 'reopened')
  assert.deepEqual(f.house().repair, { state: 'running', since: f.clock, steps: 2 })
  assert.equal(f.house().built, true, 'finished once: the stage stays reached')
  assert.deepEqual(f.saved.at(-1), f.house())
  f.w.mend(); f.shared.playerHouse = { ...f.house(), done: true } // house-build.js, from received blocks
  assert.equal(f.pass(2000), 'repaired')
  assert.equal(f.house().repair, null)
  assert.equal(f.house().done, true)
})

test('C4: unreceived cells, another dimension and a house out of sight give no verdict', () => {
  const f = setup()
  f.w.take('white_bed')
  f.w.hide('glass')
  assert.equal(f.look(), null)
  assert.equal(f.house().done, true)
  assert.equal(f.shared.playerHouseSeen.state, 'unknown')
  f.w.show(); f.dimension = 'nether'
  assert.equal(f.look(), null)
  f.dimension = 'overworld'; f.feet = { x: ORIGIN.x + 80, y: 77, z: ORIGIN.z }
  assert.equal(f.look(), null)
  assert.equal(f.house().done, true)
  assert.equal(f.shared.playerHouseSeen.state, 'unknown')
  // Received and near: decided now.
  f.feet = f.w.porch()
  assert.equal(f.look(), 'reopened')
  assert.equal(f.shared.playerHouseSeen.state, 'damaged')
  assert.equal(f.shared.playerHouseSeen.missing, 1)
})

test('another connection, dimension or life: what was observed is unknown until it is observed again', () => {
  const f = setup()
  f.look()
  assert.equal(f.shared.playerHouseSeen.state, 'complete')
  f.scope = 'c2/overworld/1'
  f.keeper.tick()
  assert.equal(f.shared.playerHouseSeen.state, 'unknown')
  f.pass(5000)
  assert.equal(f.shared.playerHouseSeen.state, 'complete')
})

// Real Realm 2026-11-20 21:54-22:56 JST (house at (9877,64,10138), 17-18 steps missing after a creeper): the repair
// ran out of time while the Bot stood a few steps outside the keeper's sight, was held as "not seen", and was
// looked at again at the next sight of the house: 2 minutes, 9 seconds and 8 seconds later, each time with the
// count it had already seen. The repair ran all but 19 seconds of an hour, and placed nothing.
test('a repair held out of sight is measured by what this life last saw of the house: the same count is not a reason', () => {
  const f = setup()
  f.w.take('oak_door', 'p_039')
  assert.equal(f.look(), 'reopened')
  f.w.away = true
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  assert.deepEqual(f.house().repair.basis, { missing: 2, short: null, seen: true })
  assert.match(f.logs.at(-1), /観測は破損のまま: 最後に見た時は残り 2 手/)
  assert.equal(f.house().done, false, 'not seen is not whole')
  f.w.away = false
  for (let t = 0; t < AGAIN_MS - 60000; t += 60000) assert.equal(f.pass(60000), null, 'the house as it was seen before: held')
  assert.equal(f.pass(60000), 'resumed', 'its time is up')
  // Seen changed after a hold taken out of sight: looked at again.
  f.w.away = true
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  f.w.away = false
  f.w.take('white_bed')
  f.keeper.tick()
  assert.equal(f.pass(5000), 'resumed')
  assert.match(f.logs.at(-1), /家の様子が変化・残り 3 手/)
})

test('a repair held with nothing observed in this life is looked at again when the house is received whole', () => {
  const f = setup()
  f.w.take('oak_door', 'p_039')
  assert.equal(f.look(), 'reopened')
  // Another life, away from the house until the repair's time is up.
  f.scope = 'c1/overworld/2'; f.w.away = true
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  assert.deepEqual(f.house().repair.basis, { missing: null, short: null, seen: false })
  assert.match(f.logs.at(-1), /観測は破損のまま: 家は未確認/)
  assert.equal(f.house().done, false, 'not seen is not whole')
  assert.equal(f.pass(60000), null)
  f.w.away = false
  f.keeper.tick()
  assert.equal(f.pass(5000), 'resumed')
  assert.match(f.logs.at(-1), /保留していた家の修理を見直します（家全体を受信・残り 2 手）/)
})

test('C6: a held repair runs again when a kind of material that was short is all there, not for one more of a kind still short', () => {
  const f = setup({ items: [stack('iron_pickaxe', 1)] })
  f.heldAfterBlast()
  // The floor block and a door (six planks: two logs).
  assert.deepEqual(f.house().repair.basis.short, { logs: 2, cobblestone: 1, sand: 0, wool: 0, coal: 0 })
  f.items.push(stack('oak_log', 1))
  assert.equal(f.pass(2000), null, 'one log of two')
  f.inventory = false
  assert.equal(f.pass(2000), null, 'an inventory not received says nothing')
  f.inventory = true
  f.items.push(stack('cobblestone', 4))
  assert.equal(f.pass(2000), 'resumed')
  assert.match(f.logs.at(-1), /保留していた家の修理を見直します（材料がそろった・残り 2 手）/)
  assert.equal(f.house().repair.state, 'running')
  assert.equal(f.house().done, false)
})

test('C6: a held repair runs again when the house is observed to have changed', () => {
  const f = setup()
  f.heldAfterBlast()
  f.w.take('white_bed')
  f.keeper.tick()
  assert.equal(f.pass(5000), 'resumed')
  assert.match(f.logs.at(-1), /家の様子が変化・残り 3 手/)
})

test('a repair a job asked for is held as soon as that thing stands; the walls wait', () => {
  const f = setup()
  f.w.take('white_bed', 'oak_planks')
  assert.equal(f.pass(2000), null)
  const before = f.saved.length
  assert.equal(needHouse(f.shared, f.w.getBlock, 'bed', { now: f.clock }).state, 'repair')
  assert.equal(f.saved.length, before, 'the job writes the record, it does not save it')
  assert.equal(f.pass(2000), null)
  assert.equal(f.saved.at(-1).repair.need, 'bed', 'the keeper saves what the job asked for: it is still there after a restart')
  assert.deepEqual(f.saved.at(-1), f.house())
  f.w.mend('white_bed') // the build, limited to the bed's step
  assert.equal(f.pass(2000), 'held')
  const repair = f.house().repair
  assert.equal(repair.state, 'held')
  assert.equal(repair.need, undefined, 'met: nothing was tried in vain')
  assert.deepEqual(repair.tried, {})
  assert.equal(f.house().done, false, 'the walls are still open')
  assert.match(f.logs.at(-1), /家のベッドが直ったため、残りの修理は保留して作業に戻ります（残り \d+ 手/)
})

test('a repair a job asked for that runs out of time keeps the thing first, and is marked as tried', () => {
  const f = setup()
  f.w.take('white_bed')
  needHouse(f.shared, f.w.getBlock, 'bed', { now: f.clock })
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  const held = f.house().repair
  assert.equal(held.need, 'bed'); assert.deepEqual(held.focus, ['p_173']); assert.deepEqual(held.tried, { bed: f.clock })
  assert.match(f.logs.at(-1), /家のベッドの修理が 20 分で終わらないため保留します/)
  assert.equal(needHouse(f.shared, f.w.getBlock, 'bed', { now: f.clock + 1000 }).state, 'held')
  assert.equal(f.pass(AGAIN_MS), 'resumed')
  assert.deepEqual(f.house().repair, { state: 'running', since: f.clock, need: 'bed', focus: ['p_173'] })
})

test('C5: a record not done and finished once is a repair with the repair\'s limit; never finished, it is the first build', () => {
  const f = setup({ house: { origin: ORIGIN, done: false, spawn: true, built: true } })
  f.w.take('oak_door')
  assert.equal(f.keeper.tick(), null)
  assert.deepEqual(f.house().repair, { state: 'running', since: f.clock })
  assert.equal(f.pass(GIVE_UP_MS), 'held')
  // A first build has no limit. A bed that stands (the respawn point is set before the house is finished) does not
  // make it a repair, and nothing writes that the house was finished.
  for (const house of [{ origin: ORIGIN, done: false }, { origin: ORIGIN, done: false, spawn: true }]) {
    const g = setup({ house })
    g.w.take('oak_door')
    assert.equal(g.pass(GIVE_UP_MS * 3), null)
    assert.equal(g.house().repair, undefined)
    assert.equal(g.house().built, undefined)
  }
})

test('the repair record of the code before (shared.playerHouseRepair) is read once after a reload', () => {
  const f = setup({ house: { origin: ORIGIN, done: false, spawn: true } })
  f.shared.playerHouseRepair = { open: true, since: f.clock - GIVE_UP_MS + 60000, steps: 2 }
  f.w.take('oak_door')
  assert.equal(f.keeper.tick(), null)
  assert.equal(f.shared.playerHouseRepair, undefined)
  assert.equal(f.house().repair.since, f.clock - GIVE_UP_MS + 60000)
  assert.equal(f.pass(60000), 'held')
})

test('a repair looked at again only because its time was up, and held with the same count, waits twice as long each time (live 2026-11-24 05:11-07:45 JST)', () => {
  const { hold, resume, review, AGAIN_MS } = require('../src/modes/house/house-repair')
  const getBlock = () => null
  let house = { origin: { x: 0, y: 64, z: 0 }, done: false, built: true, repair: { state: 'running', since: 0 } }
  const waits = []
  let now = 0
  for (let round = 0; round < 4; round++) {
    house = hold(house, { now, missing: 1, short: { logs: 0 } })
    waits.push(house.repair.until - now)
    now = house.repair.until
    assert.equal(review(house.repair, { now, sight: { missing: 1 }, short: { logs: 0 } }), 'TIME')
    house = resume(house, { now, getBlock, why: 'TIME' })
  }
  assert.deepEqual(waits, [AGAIN_MS, 2 * AGAIN_MS, 4 * AGAIN_MS, 4 * AGAIN_MS])
  // A different count, or a look for another reason, starts from the first wait again.
  const other = hold(house, { now, missing: 3, short: { logs: 0 } })
  assert.equal(other.repair.until - now, AGAIN_MS)
  const seen = hold(resume(hold(house, { now, missing: 1 }), { now, getBlock, why: 'OBSERVED' }), { now, missing: 1 })
  assert.equal(seen.repair.until - now, AGAIN_MS)
})

test('while house-build is actively running, the keeper does not hold mid-run or treat own door removal as new damage', () => {
  let active = false
  const w = createHouseWorld()
  const clock = { now: 1e6 }
  const shared = { playerHouse: { origin: ORIGIN, done: true, spawn: true } }
  const keeper = createHouseDamage({ shared, getBlock: w.getBlock, getFeet: () => w.porch(), building: () => active, now: () => clock.now })
  w.take('p_039')
  keeper.tick(); clock.now += 5000
  assert.equal(keeper.tick(), 'reopened')
  active = true
  // Even past GIVE_UP_MS, do not hold while the builder is mid-run.
  clock.now += GIVE_UP_MS + 1000
  assert.equal(keeper.tick(), null)
  assert.equal(shared.playerHouse.repair.state, 'running')
  // Builder temporarily removes its own door while working, then finishes and puts it back.
  w.take('oak_door')
  clock.now += 5000
  assert.equal(keeper.tick(), null)
  w.mend('oak_door')
  active = false
  // Once the builder stops, the keeper holds cleanly with the steady-state missing count (1).
  assert.equal(keeper.tick(), 'held')
  assert.equal(shared.playerHouse.repair.state, 'held')
  assert.equal(shared.playerHouse.repair.basis.missing, 1)
  // If another builder run were somehow active while held, transient door removal still does not wake the repair.
  active = true
  w.take('oak_door')
  keeper.tick(); clock.now += 5000
  assert.equal(keeper.tick(), null)
  assert.equal(shared.playerHouse.repair.state, 'held')
})
