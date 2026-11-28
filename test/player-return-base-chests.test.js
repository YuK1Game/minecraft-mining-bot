'use strict'

// Taking the kit back out reaches every chest of the base (src/modes/base-chests.js).
// Real Realm 2026-11-18: the chest on record moved each time one filled up; the
// diamonds lay in an earlier chest, and the trip to take them out opened only
// the chest on record and the house's second chest.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { baseChests } = require('../src/modes/base-chests')

const feet = { x: 6.5, y: GROUND, z: 1.5 }
// A raw stack as the server holds it: made in the bag, then moved over.
const stack = (sim, name, count) => { sim.give(35, name, count); const made = structuredClone(sim.bag[35]); return made }
const rubble = (sim, at, name = 'cobblestone') => { const slots = sim.storeOf(at); for (let slot = 0; slot < slots.length; slot++) slots[slot] = stack(sim, name, 64) }
const lines = (sim, pattern) => sim.log.filter(line => pattern.test(line))

// The chest on record full of rubble, an earlier chest 6 blocks off with the diamonds, the Bot after a death.
function base ({ shutEarlier = false, stock = true } = {}) {
  const sim = createReturnSim({ feet, items: [] })
  const record = sim.placeChest(5, GROUND, 0)
  const earlier = sim.placeChest(5, GROUND, 6)
  sim.shared.playerBase = record
  rubble(sim, record)
  if (stock) {
    sim.storeOf(earlier)[3] = stack(sim, 'diamond', 20)
    sim.storeOf(earlier)[4] = stack(sim, 'oak_log', 12)
  } else rubble(sim, earlier, 'tuff')
  if (shutEarlier) sim.setBlock(earlier.x, earlier.y + 1, earlier.z, 'minecraft:cobblestone')
  sim.worn = { known: true, worn: [] }
  sim.die(feet)
  sim.agent.running = true
  return { sim, record, earlier }
}
const done = runtime => out => out === true || runtime.base.status().active === false

test('the chests of the base are found from the received blocks; one under a block is left out', () => {
  const { sim, record, earlier } = base()
  const other = sim.placeChest(-3, GROUND, 2)
  const far = sim.placeChest(40, GROUND, 0)
  sim.setBlock(other.x, other.y + 1, other.z, 'minecraft:cobblestone')
  const found = baseChests(sim.getBlock, [record])
  assert.deepEqual(found, [record, earlier].map(at => ({ x: at.x, y: at.y, z: at.z })))
  assert.ok(!found.some(at => at.x === far.x), 'a chest 35 blocks off is not of the base')
})

test('diamonds banked in an earlier chest are taken out: the chest on record held only rubble', async () => {
  const { sim, earlier } = base()
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('diamond') > 0 && !sim.shared.playerReturn, ms: 240000 })
  assert.equal(sim.held('diamond'), 20, sim.log.slice(-30).join('\n'))
  assert.equal(sim.held('oak_log'), 10, 'wood up to the kit')
  assert.equal(sim.stored(earlier, 'diamond'), 0)
  assert.equal(sim.shared.playerReturn ?? null, null, 'the trip ended')
  assert.equal(lines(sim, /RESTOCK_UNCONFIRMED/).length, 0, sim.log.join('\n'))
})

test('nothing wanted in any chest: each is opened once, and no second trip starts', async () => {
  const { sim } = base({ stock: false })
  const runtime = sim.mount()
  await sim.run(runtime, { ms: 300000 })
  const opened = sim.events.filter(event => event.kind === 'open')
  assert.ok(opened.length >= 2, 'both chests were opened')
  assert.ok(opened.length <= 3, `opened ${opened.length} times in five minutes`)
  assert.equal(sim.shared.playerReturn ?? null, null)
  assert.equal(sim.held('diamond'), 0)
})

test('an earlier chest that never opens (a block on its lid) starts no trip of its own', async () => {
  const { sim, record } = base({ shutEarlier: true })
  const runtime = sim.mount()
  await sim.run(runtime, { ms: 120000 })
  const trips = lines(sim, /拠点のチェストからダイヤと資材を取り出します/).length
  assert.ok(trips <= 1, sim.log.join('\n'))
  assert.equal(sim.shared.playerReturn ?? null, null, sim.log.slice(-20).join('\n'))
  assert.ok(sim.events.filter(event => event.kind === 'open').every(event => event.detail?.x === record.x && event.detail?.z === record.z))
})

test('what was received of a chest stays known when the chest ports are made again with the same memory', async () => {
  const { createContainerPorts } = require('../src/modes/return/container-ports')
  const { sim, earlier } = base()
  Object.assign(sim.body, { x: earlier.x + 1.5, y: GROUND, z: earlier.z + 0.5 })
  const memory = { seen: new Map() }
  const ports = () => createContainerPorts({ operations: sim.operations, getInventory: sim.inventory, now: sim.now, sleep: sim.sleep, memory })
  const first = ports()
  assert.equal(first.contents(earlier), null, 'not opened yet: unknown')
  assert.equal((await first.inspect(earlier, { cargo: () => [] })).status, 'completed')
  const again = ports()
  assert.equal(again.contents(earlier).filter(slot => slot.name === 'minecraft:diamond').reduce((sum, slot) => sum + slot.count, 0), 20)
  assert.equal(again.room(earlier), null, 'the room is asked of the chest again')
  assert.equal(createContainerPorts({ operations: sim.operations, getInventory: sim.inventory, now: sim.now, sleep: sim.sleep }).contents(earlier), null)
})

// Live 2026-11-19 18:26:07 JST: the chest on record (outside the door) had been blown up with the others
// around it; four chests stood in the house. The trip found "no chest", had no wood for a new one, and was held.
test('the chest on record is gone: a chest standing at the base takes its place, and nothing is built', async () => {
  const sim = createReturnSim({ feet: { x: 3.5, y: GROUND, z: 18.5 }, items: [[0, 'stone_sword', 1], [1, 'stone_pickaxe', 1], [2, 'cobblestone', 64], [3, 'cobblestone', 64], [4, 'tuff', 30], [5, 'bone', 20]] })
  const o = sim.buildHouse({ x: 0, y: GROUND, z: 0 }).origin
  const A = { x: o.x + 3, y: o.y + 1, z: o.z + 1 }, B = { x: o.x + 5, y: o.y + 1, z: o.z + 3 }
  sim.placeChest(A.x, A.y, A.z, { fill: 10 })
  sim.storeOf(B)[0] = stack(sim, 'diamond', 6)
  sim.give(35, 'emerald', 2)
  sim.shared.playerBase = { x: o.x + 4, y: o.y - 1, z: o.z + 10 } // nothing stands there any more
  sim.worn = { known: true, worn: [] }
  sim.agent.running = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('diamond') > 0 && !sim.shared.playerReturn, ms: 240000 })
  assert.equal(lines(sim, /がなくなっていたため、拠点に立っているチェスト .* を使います/).length, 1, sim.log.join('\n'))
  assert.deepEqual(sim.shared.playerBase, B, 'the record moved to a chest that stands')
  assert.equal(lines(sim, /NO_CHEST_MATERIAL|作り直します/).length, 0, sim.log.join('\n'))
  assert.equal(sim.held('diamond'), 6, 'the kit came out of the chests that stand')
  assert.equal(sim.held('tuff') + sim.held('emerald'), 0, 'and the cargo went in')
  assert.equal(sim.events.filter(event => event.kind === 'place').length, 0)
})

test('with no chest standing at the base at all, a new one is still made', async () => {
  const sim = createReturnSim({ feet: { x: 3.5, y: GROUND, z: 6.5 }, items: [[0, 'stone_sword', 1], [1, 'stone_pickaxe', 1], [2, 'cobblestone', 64], [3, 'cobblestone', 64], [4, 'tuff', 30], [5, 'bone', 20], [6, 'chest', 2], [7, 'emerald', 3]] })
  sim.shared.playerBase = { x: 4, y: GROUND, z: 2 }
  sim.agent.running = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('tuff') === 0, ms: 240000 })
  assert.equal(lines(sim, /拠点のチェストがなくなっていたため、作り直します/).length >= 1, true, sim.log.join('\n'))
  assert.equal(sim.held('tuff'), 0, sim.log.join('\n'))
})

// The same scene's other half: every chest was "opened" from where the Bot stood and refused at once.
test('a preview that refuses for a reason that is not the place does not make a far chest reachable; what did not open is said', async () => {
  const { sim, record, earlier } = base()
  sim.server.hand = '対象スロットの持ち物をまだ取得できていません。'
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => lines(sim, /から取り出せませんでした/).length >= 2, ms: 120000 })
  const refused = sim.events.filter(event => event.kind === 'open_refused')
  const near = (event, chest) => Math.hypot(event.detail.from.x - (chest.x + 0.5), event.detail.from.z - (chest.z + 0.5))
  const far = refused.filter(event => event.detail.x === earlier.x && event.detail.z === earlier.z)
  assert.ok(far.length >= 1, sim.log.join('\n'))
  assert.ok(far.every(event => near(event, earlier) <= 4.5), 'the far chest was walked to before its open was tried')
  assert.equal(lines(sim, new RegExp(`チェスト \\(${record.x}, ${record.y}, ${record.z}\\) から取り出せませんでした（CONTAINER_OPEN_REFUSED: 対象スロット`)).length >= 1, true, sim.log.join('\n'))
  assert.equal(lines(sim, new RegExp(`チェスト \\(${earlier.x}, ${earlier.y}, ${earlier.z}\\) から取り出せませんでした`)).length >= 1, true, sim.log.join('\n'))
  // Once the hand is confirmed again, the same chests give.
  sim.server.hand = null
  await sim.run(runtime, { until: () => sim.held('diamond') > 0, ms: 2400000 })
  assert.equal(sim.held('diamond'), 20, sim.log.slice(-30).join('\n'))
})

// Live 2026-11-27 12:44:33 JST: three distinct chests at the base returned CONTAINER_FULL in a row;
// store() cleared goal.target to null before returning, so laps.back collapsed all three to target='-',
// triggering a false STAGE_LOOP hold before reaching the fourth chest with room.
test('three distinct chests filling up in a row do not trigger a false STAGE_LOOP hold', async () => {
  const sim = createReturnSim({
    feet: { x: 5.5, y: GROUND, z: 2.5 },
    items: [[0, 'stone_sword', 1], [1, 'stone_pickaxe', 1], [2, 'cobblestone', 64], [3, 'cobblestone', 64], [4, 'tuff', 30], [5, 'bone', 20], [6, 'emerald', 3]]
  })
  const c1 = sim.placeChest(4, GROUND, 1)
  const c2 = sim.placeChest(6, GROUND, 1)
  const c3 = sim.placeChest(4, GROUND, 3)
  const c4 = sim.placeChest(6, GROUND, 3)
  // Fill c1, c2, c3 so each has 26 slots of cobblestone and 1 partial slot of tuff (63/64):
  // each chest triggers store -> CONTAINER_FULL (c1, c2, c3 are three distinct targets).
  for (const chest of [c1, c2, c3]) {
    rubble(sim, chest, 'cobblestone')
    sim.storeOf(chest)[0] = stack(sim, 'tuff', 63)
  }
  sim.shared.playerBase = c1
  sim.agent.running = true
  const runtime = sim.mount()
  await sim.run(runtime, { until: () => sim.held('tuff') === 0 && sim.held('bone') === 0 && !sim.shared.playerReturn, ms: 120000 })
  assert.equal(lines(sim, /STAGE_LOOP/).length, 0, sim.log.join('\n'))
  assert.equal(sim.held('tuff'), 0, sim.log.join('\n'))
  assert.equal(sim.held('bone'), 0, sim.log.join('\n'))
  assert.ok(sim.stored(c4, 'bone') > 0, 'cargo reached the fourth chest with room')
})
