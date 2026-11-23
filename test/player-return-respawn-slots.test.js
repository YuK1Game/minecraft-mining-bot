'use strict'

// Right after a respawn the main slots are not received yet; the return for the kit waits for them.
// Real Realm 2026-11-23, house (9877,64,10138), base chest (9880,65,10139), the Bot respawned at the bed beside it:
//   15:39:25.681 死亡後の通常リスポーン: confirmed
//   15:39:28.349 帰還[rmwswb7fg] を始めます（拠点のチェストからダイヤと資材を取り出します）
//   15:39:28.383 チェスト (9880, 65, 10139) から取り出せませんでした（CONTAINER_OPEN_REFUSED: 持ち物全体の実スタックIDが必要です。）
//   15:39:28.391 チェスト (9881, 65, 10139) から取り出せませんでした（同じ）
//   15:39:28.392 収納の確認 → チェストへ接近（KIT_CHEST_CHOSEN）   15:39:30.896 家のドアから外へ出ました
//   15:39:38〜53 チェストへ接近に失敗: CHEST_UNREACHED CONTAINER_NOT_IN_REACH ×4, then zombies, 15:41:09 dead again.
// and the same two refusals 2.4 s after the second respawn (15:41:26.517 / 15:41:28.962).
// The refusal is the chest module's (actions/chest.js: every one of the 36 main slots needs a received stack). The
// single inventory record forgets the slots of the life before, and they come back with the idle resync, three
// seconds of missing slots at the earliest. The host's rows read "known, nothing held" all the while.
// Real: the base, the return, the container ports, the chest module, the reader of the chest work (chest-pack.js).
// Stand-ins: the server, the walking, the house (test/helpers/player-return-sim.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSim, GROUND } = require('./helpers/player-return-sim')
const { createChestPack, mainReceived } = require('../src/modes/chest-pack')
const { createChest } = require('../src/actions/chest')

const naked = { known: true, worn: [{ piece: 'helmet', name: null }, { piece: 'chestplate', name: null }, { piece: 'leggings', name: null }, { piece: 'boots', name: null }] }

function respawned ({ slotsAfterMs }) {
  const gear = [[0, 'stone_sword', 1], [1, 'stone_pickaxe', 1], [2, 'iron_helmet', 1], [3, 'cooked_beef', 12]]
  const sim = createReturnSim({ feet: { x: 3.5, y: GROUND, z: 30.5 }, items: gear })
  const house = sim.buildHouse({ x: 0, y: GROUND, z: 0 }), o = house.origin
  const A = { x: o.x + 3, y: o.y + 1, z: o.z + 1 }, B = { x: o.x + 5, y: o.y + 1, z: o.z + 3 }
  // The kit lies in the chest on record, beside the bed; another chest of the base stands outside the door.
  sim.placeChest(A.x, A.y, A.z)
  gear.forEach((_, index) => { sim.storeOf(A)[index] = structuredClone(sim.bag[index]) })
  const outside = sim.placeChest(o.x + 1, o.y, o.z + 11, { fill: 3 })
  sim.spares.push(outside)
  sim.shared.playerBase = A
  sim.worn = naked
  const bed = { x: o.x + 3.5, y: o.y + 1, z: o.z + 3.5 }
  sim.die(bed, { slotsAfterMs })
  sim.agent.running = true
  return { sim, A, B, outside, bed, diedAt: sim.clock, runtime: sim.mount() }
}

test('the kit is taken from the chest beside the bed once the slots are received; nothing is opened before (15:39:28 JST)', async () => {
  const { sim, A, runtime, diedAt, bed } = respawned({ slotsAfterMs: 6000 })
  const armed = value => value === true || (sim.held('stone_sword') === 1 && sim.held('stone_pickaxe') === 1)
  assert.equal(await sim.run(runtime, { until: armed, ms: 120000 }), true, sim.log.join('\n'))
  assert.equal(sim.log.some(line => /CONTAINER_OPEN_REFUSED|実スタックID/.test(line)), false, sim.log.join('\n'))
  assert.equal(sim.log.some(line => /別のチェストを試します|CHEST_UNREACHED/.test(line)), false, sim.log.join('\n'))
  const opens = sim.events.filter(event => event.kind === 'open' || event.kind === 'open_refused')
  assert.ok(opens.length >= 1 && opens.every(event => event.at >= diedAt + 6000), 'no open click before the slots are received: ' + JSON.stringify(opens.map(event => event.at - diedAt)))
  assert.deepEqual(opens.filter(event => event.kind === 'open').map(event => `${event.detail.x},${event.detail.y},${event.detail.z}`).slice(0, 1), [`${A.x},${A.y},${A.z}`])
  // The kit is in the hands before the door is touched (the chest outside is looked at afterwards).
  const kinds = sim.events.map(event => event.kind), door = kinds.indexOf('door')
  assert.ok(door < 0 || door > kinds.lastIndexOf('transfer', door) && kinds.slice(0, door).filter(kind => kind === 'transfer').length >= 4, kinds.join(' '))
  assert.ok(bed)
  assert.equal(sim.held('iron_helmet'), 1)
  assert.equal(sim.held('cooked_beef'), 12)
  assert.equal(sim.stored(A, 'stone_sword'), 0)
})

test('slots that stay unreceived hold the goal for the inventory; no chest is charged with it', async () => {
  const { sim, runtime } = respawned({ slotsAfterMs: 10 * 60000 })
  await sim.run(runtime, { until: () => false, ms: 100000 })
  assert.equal(sim.events.some(event => ['open', 'open_refused', 'door', 'transfer'].includes(event.kind)), false, JSON.stringify(sim.events.map(event => event.kind)))
  assert.equal(sim.log.some(line => /CONTAINER_OPEN_REFUSED|別のチェストを試します|CHEST_UNREACHED/.test(line)), false, sim.log.join('\n'))
  const goal = sim.goal(runtime)
  assert.ok(!goal || (goal.unopened ?? []).length + (goal.unreached ?? []).length + (goal.full ?? []).length === 0, JSON.stringify(goal))
  assert.equal(sim.held('stone_sword'), 0)
})

test('the reader of the chest work: the rows, and nothing while a main slot has no received stack or a transfer is open', () => {
  const stack = { network_id: 5, count: 3, has_stack_id: true, stack_id: 9 }, air = { network_id: 0, count: 0, has_stack_id: false }
  const rows = { known: true, items: [] }
  let missing = 7, uncertain = false
  const pack = createChestPack({ uncertain: () => uncertain, rawItem: slot => slot === missing ? null : slot === 0 ? stack : air, inventory: () => rows })
  assert.equal(pack(), null, 'slot 7 is not received')
  missing = -1
  assert.equal(pack(), rows)
  uncertain = true
  assert.equal(pack(), null)
  assert.equal(mainReceived(() => { throw new Error('gone') }), false)
  assert.equal(mainReceived(slot => slot === 35 ? { network_id: 5, count: 1 } : air), false, 'a stack without its received id is not received')
})

test('the chest module names its own inventory refusals, and the port reads them as the inventory, not the chest', async () => {
  const sim = createReturnSim({ feet: { x: 6.5, y: GROUND, z: 1.5 }, items: [[0, 'cobblestone', 8]] })
  const at = sim.placeChest(5, GROUND, 0)
  sim.die({ x: 6.5, y: GROUND, z: 1.5 }, { slotsAfterMs: 5000 })
  assert.throws(() => sim.chest.open(at), error => error.code === 'INVENTORY_UNKNOWN' && /実スタックID/.test(error.message))
  // A port wired to the host's rows (as before 2026-11-23) still answers "the inventory", from the module's code.
  const { createStoragePorts } = require('../src/modes/player-storage-ports')
  const ports = createStoragePorts({ operations: sim.operations, disposed: () => false, getBlock: sim.getBlock, getFeet: sim.getFeet, getInventory: sim.inventory, held: () => false, sleep: sim.sleep, now: sim.now })
  const out = await ports.withdraw(at, () => [], {})
  assert.equal(out.status, 'blocked', JSON.stringify(out))
  assert.equal(out.code, 'INVENTORY_UNKNOWN')
  assert.equal(out.retry?.kind, 'inventory_update')
  assert.equal(typeof createChest, 'function')
})
