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
