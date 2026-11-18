'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createPlayerStorage } = require('../src/modes/player-storage')
const { createReturnSim } = require('./helpers/player-return-sim')

// Real storage -> storage ports -> container ports -> chest packet receipts.
// Only the server's placements, inventory and window packets are simulated.
function fixture ({ count = 2, windowSize = null, interruptAfterFirst = false, storageOptions = {} } = {}) {
  const sim = createReturnSim({ items: [[0, 'chest', count]], stopLagMs: 0 })
  const placed = []
  const apply = sim.chest.applyPacket
  sim.chest.applyPacket = (name, packet) => {
    if (name === 'inventory_content' && typeof packet.window_id === 'number' && windowSize != null) packet = { ...packet, input: packet.input.slice(0, windowSize) }
    apply(name, packet)
  }
  sim.operations.interactions.placeBlock = async ({ position, slot }) => {
    const held = sim.inventory().items.find(item => item.slot === slot)
    assert.equal(held?.name, 'minecraft:chest')
    assert.ok(held.count > 0)
    placed.push({ ...position })
    sim.placeChest(position.x, position.y, position.z)
    const dx = position.x + 0.5 - sim.body.x, dz = position.z + 0.5 - sim.body.z
    const facing = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 4 : 5) : (dz > 0 ? 2 : 3)
    sim.setBlock(position.x, position.y, position.z, 'minecraft:chest', { properties: { facing_direction: facing } })
    if (held.count > 1) sim.give(slot, 'chest', held.count - 1)
    else { sim.bag[slot] = structuredClone(sim.bag.find(item => item.network_id === 0)); sim.resync() }
    if (interruptAfterFirst && placed.length === 1) sim.shared.playerWanted = false
    return { phase: 'completed', confirmedBy: 'server_block_and_inventory' }
  }
  const { storagePorts: hands, hands: movement } = sim.mount()
  const mountStorage = () => createPlayerStorage({
    getMode: () => sim.mode, shared: sim.shared, hands,
    agent: { objective: {}, start: async () => {}, stop () {}, settled: () => true },
    getBlock: sim.getBlock, getFeet: sim.getFeet, getInventory: sim.inventory,
    walk: target => movement.walk(target),
    now: sim.now, sleep: sim.sleep, log: line => sim.log.push(line), ...storageOptions
  })
  return { sim, storage: mountStorage(), placed, hands, mountStorage }
}

test('one held chest without materials never starts a new single chest', async () => {
  const f = fixture({ count: 1 })
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 0)
})

test('two adjacent chest blocks with a received 27-slot window are not a large chest', async () => {
  const f = fixture({ windowSize: 27 })
  f.sim.placeChest(1, 64, 0)
  f.sim.placeChest(1, 64, 1)
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 0, 'unconfirmed adjacent boxes must not trigger extra placement')
  assert.ok(f.sim.events.some(event => event.kind === 'open'))
})

test('a new pair completes only after a 54-slot server window is received', async () => {
  const f = fixture()
  const at = await f.storage.chest()
  assert.ok(at, f.sim.log.join('\n'))
  assert.equal(f.placed.length, 2)
  assert.ok(f.sim.events.some(event => event.kind === 'open'))
  const receipt = await f.hands.inspect(at)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.evidence.slotCount, 54)
})

test('interruption after the first half resumes that half and places only the missing chest', async () => {
  const f = fixture({ interruptAfterFirst: true })
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 1)
  const first = f.placed[0]
  f.sim.shared.playerWanted = true
  assert.deepEqual(await f.storage.chest(), first)
  assert.equal(f.placed.length, 2)
  assert.equal(f.sim.held('chest'), 0)
})

test('after moving to the other side, the missing half is placed from the received chest facing', async () => {
  const f = fixture({ interruptAfterFirst: true })
  assert.equal(await f.storage.chest(), null)
  const first = f.placed[0], facing = f.sim.getBlock(first.x, first.y, first.z).properties.facing_direction
  Object.assign(f.sim.body, { x: first.x + 2.5, y: first.y, z: first.z + 0.5 })
  f.sim.shared.playerWanted = true
  assert.deepEqual(await f.storage.chest(), first, f.sim.log.join('\n'))
  assert.equal(f.placed.length, 2)
  const second = f.placed[1]
  assert.equal(f.sim.getBlock(second.x, second.y, second.z).properties.facing_direction, facing)
  assert.ok(f.sim.events.some(event => event.kind === 'walk'))
})

test('an existing single chest without received facing is not extended blindly', async () => {
  const f = fixture({ interruptAfterFirst: true })
  await f.storage.chest()
  const first = f.placed[0]
  f.sim.setBlock(first.x, first.y, first.z, 'minecraft:chest')
  f.sim.shared.playerWanted = true
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 1)
  assert.equal(f.storage.pendingChest(first), true)
})

function checkpoint (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'player-large-chest-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'pairs.json')
}

test('a process restart restores the half-pair record, scoped to its world, and completes it with one held chest', async t => {
  const file = checkpoint(t)
  let world = 'world-one'
  const f = fixture({ interruptAfterFirst: true, storageOptions: { file, worldScope: () => world } })
  assert.equal(await f.storage.chest(), null)
  const first = f.placed[0]
  assert.equal(JSON.parse(fs.readFileSync(file)).pairs.length, 1)
  delete f.sim.shared.playerChestPairs
  const resumed = f.mountStorage()
  assert.equal(resumed.pendingChest(first), true)
  world = 'world-two'
  assert.equal(resumed.pendingChest(first), false)
  world = 'world-one'
  f.sim.shared.playerWanted = true
  assert.equal(resumed.canMakeChest(), true, 'one held item completes a recorded half')
  assert.deepEqual(await resumed.chest(), first)
  assert.equal(f.placed.length, 2)
  assert.equal(resumed.pendingChest(first), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).pairs, [])
})

test('reservation save failure prevents the first placement', async t => {
  const f = fixture({ storageOptions: { file: checkpoint(t), worldScope: () => 'world', write: async () => { throw new Error('disk full') } } })
  assert.equal(await f.storage.chest(), null)
  assert.deepEqual(f.placed, [])
  assert.match(f.sim.log.join('\n'), /保存できない/)
})

test('completion save failure retains the pending pair and retries its 54-slot receipt without new placement', async t => {
  const file = checkpoint(t), { writeDurableJson } = require('../src/common/durable-json')
  let failCompletion = true
  const f = fixture({ storageOptions: { file, worldScope: () => 'world', write: async (file, value) => { if (failCompletion && !value.pairs.length) throw new Error('disk full'); return writeDurableJson(file, value) } } })
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 2)
  assert.equal(f.storage.pendingChest(f.placed[0]), true)
  assert.equal(JSON.parse(fs.readFileSync(file)).pairs.length, 1)
  failCompletion = false
  assert.deepEqual(await f.storage.chest(), f.placed[0])
  assert.equal(f.placed.length, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).pairs, [])
})

test('a newly placed but unjoined pair stays pending and does not cause a third placement', async () => {
  const f = fixture({ windowSize: 27 })
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 2)
  assert.equal(f.storage.pendingChest(f.placed[0]), true)
  assert.equal(await f.storage.chest(), null)
  assert.equal(f.placed.length, 2)
})

test('a synchronous placement preflight refusal can try another pair before any block was sent', async () => {
  const f = fixture(), place = f.sim.operations.interactions.placeBlock
  let tries = 0
  f.sim.operations.interactions.placeBlock = options => {
    if (++tries === 1) throw new Error('preflight refused')
    return place(options)
  }
  assert.ok(await f.storage.chest())
  assert.equal(tries, 3)
  assert.equal(f.placed.length, 2)
})

for (const wireSent of [false, true]) test(`a queued placement without a server result keeps its pair pending (wireSent=${wireSent})`, async () => {
  const f = fixture()
  let tries = 0
  f.sim.operations.interactions.placeBlock = async () => {
    tries++
    throw Object.assign(new Error('server confirmation missing'), { details: { placementFailure: { transactionQueued: true, wireSent, serverRejected: false, notSent: !wireSent } } })
  }
  assert.equal(await f.storage.chest(), null)
  assert.equal(tries, 1)
  assert.equal(f.sim.shared.playerChestPairs.pairs.length, 1)
})

test('return to a full base completes an interrupted half before it records or deposits into that chest', async () => {
  const f = fixture({ interruptAfterFirst: true })
  const base = f.sim.placeChest(-2, 64, 0, { fill: 54 })
  f.sim.placeChest(-2, 64, 1, { fill: 54 })
  f.sim.storeOf(base).forEach((item, index, slots) => { if (!item.count) slots[index] = structuredClone(slots[0]) })
  f.sim.shared.playerBase = base
  f.sim.give(1, 'diamond', 64)
  assert.equal(await f.storage.chest({ full: [base] }), null)
  const first = f.placed[0]
  assert.equal(f.storage.pendingChest(first), true)
  f.sim.shared.playerWanted = true
  const runtime = f.sim.mount({ chest: options => f.storage.chest(options), canBuild: () => f.storage.canMakeChest(), pendingChest: at => f.storage.pendingChest(at) })
  await f.sim.run(runtime, { ms: 120000, until: () => f.sim.stored(first, 'diamond') > 0 })
  assert.equal(f.placed.length, 2, f.sim.log.join('\n'))
  assert.equal(f.storage.pendingChest(first), false, f.sim.log.join('\n'))
  assert.ok(f.sim.stored(first, 'diamond') > 0, f.sim.log.join('\n'))
  assert.deepEqual(f.sim.shared.playerBase, first)
})

test('a late reservation write and a reloaded runtime preserve both unfinished pairs', async t => {
  const { createChestPairs } = require('../src/modes/player-chest-pairs')
  const shared = {}, writes = [], finish = []
  const options = { shared, file: checkpoint(t), worldScope: () => 'world', write: async (file, value) => { writes.push(structuredClone(value)); await new Promise(resolve => finish.push(resolve)) } }
  const old = createChestPairs(options), reloaded = createChestPairs(options)
  const first = old.begin([{ x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }])
  const second = reloaded.begin([{ x: 10, y: 64, z: 0 }, { x: 10, y: 64, z: 1 }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 1)
  finish[0]()
  assert.equal(await first, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 2)
  assert.equal(writes[1].pairs.length, 2)
  finish[1]()
  assert.equal(await second, true)
  assert.equal(shared.playerChestPairs.pairs.length, 2)
})

test('an unconfirmed send is not repeated after inventory resync or restart; a late block completes only its missing half', async t => {
  const f = fixture({ count: 3, storageOptions: { file: checkpoint(t), worldScope: () => 'world' } })
  const place = f.sim.operations.interactions.placeBlock, requests = []
  f.sim.operations.interactions.placeBlock = options => {
    requests.push({ ...options.position })
    if (requests.length !== 1) return place(options)
    // The server consumed the first chest, but its block update is delayed.
    // Inventory confirmation alone must not authorize another placement.
    f.sim.give(options.slot, 'chest', 2)
    return Promise.reject(Object.assign(new Error('block receipt delayed'), { details: { placementFailure: { transactionQueued: true, wireSent: true, serverRejected: false } } }))
  }
  assert.equal(await f.storage.chest(), null)
  f.sim.resync()
  assert.equal(await f.storage.chest(), null)
  assert.equal(requests.length, 1)
  delete f.sim.shared.playerChestPairs
  const resumed = f.mountStorage()
  assert.equal(await resumed.chest(), null)
  assert.equal(requests.length, 1)
  const first = requests[0]
  f.sim.placeChest(first.x, first.y, first.z)
  f.sim.setBlock(first.x, first.y, first.z, 'minecraft:chest', { properties: { facing_direction: 4 } })
  assert.deepEqual(await resumed.chest(), first)
  assert.equal(requests.length, 2)
  assert.notDeepEqual(requests[1], first)
  assert.equal(f.sim.held('chest'), 1)
  assert.equal(resumed.pendingChest(first), false)
})
