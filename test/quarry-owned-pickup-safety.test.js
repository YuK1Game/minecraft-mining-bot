'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const file = require.resolve('./quarry-portable-storage.test'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports={fixture,item,airItem,carriedBox,names}\n', file)
const { fixture, item, carriedBox, names } = loaded.exports
names.set(6, 'minecraft:arrow')

function scene ({ ordinary = [], neverPickup = false, wrongNBT = false, noRoute = false, longRoute = false, unsafe = false, foreign = false, refillAfterBreak = false, drift = false } = {}) {
  const f = fixture('shulker', { noPickup: true })
  f.bag[0].count = 8
  for (let slot = 0; slot < 36; slot++) if (!f.bag[slot].count) f.bag[slot] = item(6, 64, 1000 + slot)
  let actors = copy(ordinary), broken = false, owned = null, owner = 1, sequence = 9000
  const originalMine = f.dependencies.mine, originalMove = f.dependencies.moveTo, originalBlock = f.dependencies.getBlock
  const extra = [], writes = []
  const dependencies = {
    ...f.dependencies,
    getEntities: () => copy(actors),
    getBlock: (x, y, z) => unsafe && broken && owned && x === Math.floor(owned.position.x) && y === owned.position.y - 1.125 && z === Math.floor(owned.position.z) ? { known: false } : originalBlock(x, y, z),
    captureActionOwner: () => owner,
    runActionOwned: (captured, fn) => { if (captured !== owner) throw Object.assign(Error('owner changed'), { code: 'STORAGE_ACTION_OWNER_CHANGED' }); return fn() },
    mine: async target => {
      const result = await originalMine(target); broken = true
      owned = { kind: 'item', runtimeId: '900', uniqueId: '-900', name: 'minecraft:undyed_shulker_box', networkId: 2, count: 1, alive: true, positionKnown: true, dimension: foreign ? 'nether' : 'overworld', position: { x: target.x + 0.43, y: target.y + 0.125, z: target.z - 0.29 } }
      actors.push(owned)
      if (refillAfterBreak) for (let slot = 0; slot < 36; slot++) if (!f.bag[slot].count) f.bag[slot] = item(4, 1, ++sequence)
      return result
    },
    moveTo: async (target, options) => {
      const result = await originalMove(target, options)
      if (broken) {
        extra.push(copy(target))
        const feet = { x: f.state.position.x, y: f.state.position.y - 1.62, z: f.state.position.z }
        const close = Math.abs(feet.x - owned.position.x) <= 0.6 && Math.abs(feet.z - owned.position.z) <= 0.6 && Math.abs(feet.y - owned.position.y) <= 0.5
        if (close && !neverPickup) {
          const slot = f.bag.findIndex(raw => !raw.count)
          assert.ok(slot >= 0)
          const mine = f.events.find(event => event.type === 'mine')
          f.bag[slot] = carriedBox(f.containers.get(key(mine.target)), ++sequence, { wrongContents: wrongNBT })
          actors = actors.filter(entity => entity.runtimeId !== owned.runtimeId)
        } else if (close && drift) owned.position.z = owned.position.z < 0.5 ? 1.29 : -0.29
      }
      return result
    }
  }
  if (noRoute || longRoute) {
    dependencies.getPath = async (origin, target) => noRoute ? null : [origin, { x: origin.x + 20, y: origin.y, z: origin.z }, target]
    dependencies.travel = () => true
  }
  const controller = createQuarryPortableStorage(dependencies)
  f.controller.ownsShulker = (...args) => controller.ownsShulker(...args)
  const run = (checkpoint, callback = null) => controller.storeCarried({ ...copy(f.request), ...(checkpoint ? { checkpoint: copy(checkpoint) } : {}) }, { canPlace: () => true, onCheckpoint: async cp => { writes.push(copy(cp)); if (callback) await callback(cp) } })
  return { f, run, writes, extra, actors: () => actors, owned: () => owned, takeover: () => { owner++ }, broken: () => broken }
}
const ground = (runtimeId, position = { x: 1.2, y: 65.125, z: 0.5 }, extra = {}) => ({ kind: 'item', alive: true, runtimeId: String(runtimeId), uniqueId: String(-runtimeId), name: 'minecraft:stone', networkId: 4, count: 1, dimension: 'overworld', positionKnown: true, position, ...extra })

test('a box .79 from the old fixed center is recovered at the adjacent .21 center using actual inventory and NBT', async () => {
  const h = scene(), result = await h.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.recovered, true)
  assert.equal(result.checkpoint.pickupSafetyVisits, 1)
  assert.equal(h.extra.length, 2, 'one original center move and one actual-item visit')
  const last = h.extra.at(-1), item = h.owned()
  assert.ok(Math.abs(last.z + 0.5 - item.position.z) < 0.22)
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
})

test('two nearby ordinary drop stacks plus the owned box require three free slots before any break', async () => {
  const h = scene({ ordinary: [ground(11), ground(12, { x: 1.3, y: 68.2, z: 1 })] }), result = await h.run()
  assert.equal(result.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
  assert.equal(result.details.freeSlots, 2)
  assert.equal(result.details.requiredFreeSlots, 3)
  assert.equal(h.broken(), false)
  assert.equal(h.f.getBlock(result.checkpoint.positions[0].x, 65, result.checkpoint.positions[0].z).name, 'minecraft:undyed_shulker_box')
})

test('unknown local item name, count or position never permits breaking an intact box', async () => {
  for (const bad of [{ name: null, networkId: 999 }, { count: null }, { positionKnown: false, position: null }]) {
    const h = scene({ ordinary: [ground(15, undefined, bad)] }), result = await h.run()
    assert.equal(result.reason, 'STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
    assert.equal(h.broken(), false)
  }
})

test('an unsafe neighbor cell does not become an assumed pickup destination', async () => {
  const h = scene({ unsafe: true }), result = await h.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.recovered, false)
  assert.equal(h.extra.length, 1, 'only the original safe center may be visited')
})

test('no path to the actual item never sends a pickup move or replays the break', async () => {
  const h = scene({ noRoute: true }), first = await h.run()
  assert.equal(first.status, 'blocked')
  assert.equal(h.extra.length, 0)
  const again = await h.run(first.checkpoint)
  assert.equal(again.status, 'blocked')
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
})

test('an out-of-corridor detour is rejected even when the endpoint cell is safe', async () => {
  const h = scene({ longRoute: true }), result = await h.run()
  assert.equal(result.status, 'blocked')
  assert.equal(h.extra.length, 0)
})

test('a foreign-dimension box entity cannot authorize movement or recovery credit', async () => {
  const h = scene({ foreign: true }), result = await h.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.recovered, false)
  assert.equal(h.extra.length, 0)
})

test('actual item visits never turn wrong box contents into success', async () => {
  const h = scene({ wrongNBT: true }), result = await h.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.recovered, false)
  assert.equal(result.serverConfirmed, false)
})

test('at most two actual-item visits are persisted and a later resume cannot reset the bound', async () => {
  const h = scene({ neverPickup: true, drift: true }), first = await h.run()
  assert.equal(first.status, 'blocked')
  assert.equal(first.checkpoint.pickupSafetyVisits, 2)
  assert.equal(h.extra.length, 3)
  const again = await h.run(first.checkpoint)
  assert.equal(again.status, 'blocked')
  assert.equal(h.extra.length, 3)
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
})

test('received zero free slots after AIR stops before every pickup movement', async () => {
  const h = scene({ refillAfterBreak: true }), result = await h.run()
  assert.equal(result.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
  assert.equal(result.checkpoint.stage, 'awaiting_recovery')
  assert.equal(h.extra.length, 0)
})

test('an ownership change while persisting the visit prevents that movement', async () => {
  const h = scene()
  const result = await h.run(null, cp => { if (cp.pickupSafetyVisits === 1) h.takeover() })
  assert.equal(result.reason, 'STORAGE_ACTION_OWNER_CHANGED')
  assert.equal(h.extra.length, 1)
  assert.equal(result.recovered, false)
})

test('unknown headroom introduced during visit persistence stops movement at its dispatch boundary', async () => {
  const h = scene()
  const result = await h.run(null, cp => {
    if (cp.pickupSafetyVisits === 1) {
      const stand = cp.pickupSafetyStands.at(-1)
      h.f.blocks.set(key({ ...stand, y: stand.y + 1 }), { known: false })
    }
  })
  assert.equal(result.reason, 'STORAGE_PICKUP_ROUTE_UNCONFIRMED')
  assert.equal(h.extra.length, 1)
  assert.equal(result.recovered, false)
})

test('far ordinary drops are ignored and only the selected owned box is excluded from the one-box reserve', async () => {
  const far = scene({ ordinary: [ground(22, { x: 100, y: 65, z: 100 })] })
  assert.equal((await far.run()).status, 'completed')
  const extraBox = ground(23, { x: 1.2, y: 65.125, z: 0.5 }, { name: 'minecraft:undyed_shulker_box', networkId: 2 })
  const h = scene({ ordinary: [extraBox, ground(24)] }), result = await h.run()
  assert.equal(result.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
  assert.equal(result.details.requiredFreeSlots, 3)
  assert.equal(h.broken(), false)
})

test('the pre-break entity baseline excludes pre-existing same-colour boxes from owned-item visits', async () => {
  const old = ground(111, { x: 2.43, y: 65.125, z: -0.29 }, { name: 'minecraft:undyed_shulker_box', networkId: 2 })
  const h = scene({ ordinary: [old] }), result = await h.run()
  assert.equal(result.status, 'completed', result.reason)
  assert.deepEqual(result.checkpoint.pickupEntityBaseline.runtimeIds, ['111'])
  assert.equal(result.checkpoint.pickupItemBinding.entityRuntimeId, '900')
  assert.equal(result.checkpoint.pickupFallback.entityRuntimeId, '900')
  const missing = scene({ ordinary: [ground(112, { x: 100, y: 65, z: 100 }, { runtimeId: null })] })
  const blocked = await missing.run()
  assert.equal(blocked.reason, 'STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
  assert.equal(missing.broken(), false)
})

test('a legacy AIR checkpoint without the entity baseline gains no widened visits and never replays the break', async () => {
  const h = scene({ neverPickup: true }), first = await h.run(), cp = copy(first.checkpoint)
  for (const field of ['pickupEntityBaseline', 'pickupCenterVisited', 'pickupSafetyVisits', 'pickupSafetyStands', 'pickupFallback', 'pickupItemBinding']) delete cp[field]
  const moves = h.extra.length, result = await h.run(cp)
  assert.equal(result.status, 'blocked')
  assert.equal(h.extra.length, moves)
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
})

test('a bound item disappearing cannot be replaced by a different new entity on a later resume', async () => {
  const h = scene({ neverPickup: true }), first = await h.run()
  h.owned().runtimeId = '901'; h.owned().uniqueId = '-901'
  const moves = h.extra.length, result = await h.run(first.checkpoint)
  assert.equal(result.status, 'blocked')
  assert.equal(result.checkpoint.pickupItemBinding.entityRuntimeId, '900')
  assert.equal(h.extra.length, moves)
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
})
