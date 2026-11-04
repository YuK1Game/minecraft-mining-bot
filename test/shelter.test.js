'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createShelter } = require('../src/shelter')
const { planShelter } = require('../src/shelter-planner')

const key = point => `${point.x},${point.y},${point.z}`
const block = name => ({ known: true, name: `minecraft:${name}`, runtimeId: name === 'air' ? 0 : name === 'dirt' ? 10 : 20, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })

test('online learning HP1 shelter retains received site and current inventory guards', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.shelter.preview({ radius: 0 }).ready, false)
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.shelter.preview({ radius: 0 }).ready, true)
  f.state.inventory.known = false; assert.equal(f.shelter.preview({ radius: 0 }).ready, false)
  f.state.inventory.known = true; f.state.lifecycle = { dead: true }
  assert.equal(f.shelter.preview({ radius: 0 }).ready, false)
  assert.equal(f.calls.length, 0)
})
function fixture (options = {}) {
  let time = 0
  let miningState = { phase: 'idle' }
  let movementState = { phase: 'idle' }
  let pendingDirt = 0
  let moveId = 0
  let reads = 0
  const calls = []
  const progress = []
  const overrides = new Map()
  const instances = []
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', realm: { id: 'local-test' }, dimension: 'overworld', connectionId: 'same-socket', startedAt: 'same-session', runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: 'initial', rawSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [] } }
  const world = { getBlock: (x, y, z) => overrides.get(`${x},${y},${z}`) ?? block(y < 65 ? 'stone' : x >= 1 && x <= 4 && z >= -2 && z <= 2 && y <= 67 ? y === 67 ? 'grass_block' : 'dirt' : 'air') }
  const set = (point, value) => overrides.set(key(point), typeof value === 'string' ? block(value) : value)
  const countDirt = () => state.inventory.items.filter(item => item.name === 'minecraft:dirt').reduce((sum, item) => sum + item.count, 0)
  const setDirt = count => {
    const item = state.inventory.items.find(item => item.name === 'minecraft:dirt')
    if (item) item.count = count
    else if (count) state.inventory.items.push({ slot: 1, name: 'minecraft:dirt', count })
  }
  const getState = () => { reads++; return structuredClone(state) }
  const mining = {
    preview: targets => { calls.push({ type: 'mine_preview', target: structuredClone(targets[0]) }); return { ready: true } },
    start: targets => {
      const point = targets[0]
      calls.push({ type: 'dig', target: structuredClone(point) })
      if (!options.ghostMining) { assert.ok(['minecraft:dirt', 'minecraft:grass_block'].includes(world.getBlock(point.x, point.y, point.z).name)); set(point, 'air'); pendingDirt++ }
      miningState = { phase: 'completed' }
      return miningState
    },
    stop: () => { calls.push({ type: 'mine_stop' }); miningState = { phase: 'stopped' } }
  }
  const movement = {
    preview: target => {
      calls.push({ type: 'move_preview', target: structuredClone(target) })
      const foot = { x: Math.floor(target.x), y: target.y, z: Math.floor(target.z) }
      return { ready: ['air'].includes(world.getBlock(foot.x, foot.y, foot.z).name.replace('minecraft:', '')) && world.getBlock(foot.x, foot.y + 1, foot.z).name === 'minecraft:air' }
    },
    start: target => {
      calls.push({ type: 'move', target: structuredClone(target) })
      if (!options.staleMovement) {
        state.position = { x: target.x, y: target.y + 1.62, z: target.z }
        state.positionSource = 'client_prediction'; state.positionUpdatedAt = `input-${++moveId}`
        state.predicted = { physicsState: { onGround: true, isInWater: false } }
      }
      if (!options.noPickup) { setDirt(countDirt() + pendingDirt); pendingDirt = 0 }
      movementState = { phase: 'awaiting_server_confirmation' }
      return movementState
    },
    stop: () => { calls.push({ type: 'move_stop' }); movementState = { phase: 'stopped' } }
  }
  const inventory = {
    equip: sourceSlot => {
      calls.push({ type: 'equip', sourceSlot })
      if (!options.ghostEquip) {
        const item = state.inventory.items.find(item => item.slot === sourceSlot)
        assert.equal(item?.name, 'minecraft:dirt')
        item.slot = state.rawSelectedSlot
        state.heldItem = structuredClone(item)
      }
      return { phase: 'completed', serverConfirmed: true }
    },
    cancel: () => calls.push({ type: 'inventory_cancel' }), snapshot: () => ({ busy: false })
  }
  const interactions = {
    previewPlace: data => {
      calls.push({ type: 'place_preview', target: structuredClone(data.position), slot: data.slot })
      const point = data.position
      assert.equal(Math.floor(state.position.x), 2, 'door placement must be performed from the inner cell')
      assert.equal(data.slot, state.rawSelectedSlot)
      assert.equal(world.getBlock(point.x, point.y, point.z).name, 'minecraft:air')
      assert.equal(world.getBlock(point.x, point.y - 1, point.z).boundingBox, 'block', 'the upper door needs the already received lower block')
      return { ready: true, expectedBlock: 'minecraft:dirt', position: point }
    },
    placeBlock: data => {
      calls.push({ type: 'place', target: structuredClone(data.position), slot: data.slot })
      set(data.position, 'dirt')
      if (!options.ghostSpend) setDirt(countDirt() - 1)
      return { phase: 'completed', confirmedBy: 'server_block_and_inventory' }
    },
    cancel: () => calls.push({ type: 'interaction_cancel' }), snapshot: () => ({ pendingOperation: null })
  }
  const common = { getState, world, planner: planShelter, mining, movement, getMining: () => miningState, getMovement: () => movementState, inventory, interactions, timeoutMs: 40, batchTimeoutMs: 1000, pickupTimeoutMs: 30, pollMs: 10, clock: () => time, delay: async milliseconds => { time += milliseconds }, onProgress: event => progress.push(structuredClone(event)) }
  const create = extra => { const controller = createShelter({ ...common, ...options.controller, ...extra }); instances.push(controller); return controller }
  const shelter = create()
  return { shelter, create, state, world, set, calls, progress, mining, movement, inventory, interactions, setDirt, countDirt, common, reads: () => reads, getMining: () => miningState, setMining: value => { miningState = value } }
}

test('constructor and read-only planning send no world actions and preserve the full 3x2 room for a later phase', () => {
  const f = fixture()
  assert.equal(f.reads(), 0)
  assert.equal(f.calls.length, 0)
  const preview = f.shelter.preview({ radius: 0 })
  assert.equal(preview.ready, true)
  assert.equal(preview.expansion.length, 10)
  assert.equal(preview.usable, undefined)
  assert.equal(f.calls.length, 0)
})

test('minimal construction verifies four soil digs, two grounded moves, real dirt pickup and lower-to-upper closure', async () => {
  const f = fixture()
  const raw = structuredClone(f.state.rawServerPosition)
  const result = await f.shelter.execute({ radius: 0 })
  assert.equal(result.phase, 'completed')
  assert.equal(result.busy, false)
  assert.equal(result.closed, true)
  assert.equal(result.inside, true)
  assert.equal(result.usable, true)
  assert.equal(result.established, true)
  assert.equal(result.structureIntact, true)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.positionServerConfirmed, false)
  assert.equal(result.roomReady, false)
  assert.deepEqual(f.calls.filter(call => call.type === 'dig').map(call => call.target), [{ x: 1, y: 66, z: 0 }, { x: 1, y: 65, z: 0 }, { x: 2, y: 66, z: 0 }, { x: 2, y: 65, z: 0 }])
  assert.deepEqual(f.calls.filter(call => call.type === 'move').map(call => call.target.x), [1.5, 2.5])
  assert.deepEqual(f.calls.filter(call => call.type === 'place').map(call => call.target.y), [65, 66])
  assert.equal(f.countDirt(), 2, 'four received pickups minus two observed spends')
  assert.equal(f.shelter.memo().placements.length, 2)
  assert.ok(f.progress.some(event => event.memo?.placements.length === 2))
  assert.deepEqual(f.state.rawServerPosition, raw)
  assert.equal(f.world.getBlock(3, 65, 0).name, 'minecraft:dirt', 'room expansion is not silently performed')
})

test('short partial batches resume the exact same observed passage without mining completed air twice', async () => {
  const f = fixture()
  const first = await f.shelter.execute({ radius: 0, maxActions: 3 })
  assert.equal(first.partial, true)
  assert.equal(first.goalComplete, false)
  assert.equal(first.usable, false)
  assert.equal(f.calls.filter(call => call.type === 'dig').length, 2)
  const saved = f.shelter.memo()
  assert.doesNotThrow(() => JSON.stringify(saved))
  const resumed = f.create({ memo: saved })
  assert.equal(resumed.preview().resumeReady, true)
  assert.equal(resumed.snapshot().canResume, true)
  const result = await resumed.execute()
  assert.equal(result.usable, true)
  assert.equal(f.calls.filter(call => call.type === 'dig').length, 4)
  assert.equal(f.calls.filter(call => call.type === 'dig' && call.target.x === 1).length, 2)
})

test('explicit restore is passive, copies the saved partial memo and resumes against the current world', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0, maxActions: 3 })
  const saved = f.shelter.memo()
  const restored = f.create()
  const calls = f.calls.length
  const reads = f.reads()
  const progress = f.progress.length
  assert.deepEqual(restored.restoreMemo(saved), { restored: true, requiresWorldValidation: true, pendingReconciliation: false })
  assert.equal(f.calls.length, calls)
  assert.equal(f.reads(), reads, 'restore itself does not access the live state or send anything')
  assert.equal(f.progress.length, progress, 'restoring history cannot trigger a save/restore progress loop')
  saved.site.entry.x = 999
  saved.cleared.length = 0
  assert.equal(restored.memo().site.entry.x, 1)
  assert.equal(restored.memo().cleared.length, 2)
  assert.equal(restored.snapshot().phase, 'idle')
  assert.equal(restored.snapshot().usable, false)
  assert.equal(restored.preview().resumeReady, true)
  assert.equal((await restored.execute()).usable, true)
  assert.equal(f.calls.filter(call => call.type === 'dig').length, 4)
})

test('restored success history needs present geometry and scope; later restores never overwrite existing memory', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0 })
  const saved = f.shelter.memo()
  const restored = f.create()
  assert.deepEqual(restored.restoreMemo(null), { restored: false, code: 'NO_SAVED_MEMO', requiresWorldValidation: true })
  assert.throws(() => restored.restoreMemo({ version: 99 }), error => error.code === 'INVALID_MEMO')
  assert.equal(restored.memo(), null)
  f.set({ x: 2, y: 67, z: 0 }, { known: false })
  const before = f.calls.length
  const result = restored.restoreMemo(saved)
  assert.equal(result.restored, true)
  assert.equal(Object.hasOwn(result, 'usable'), false)
  assert.equal(Object.hasOwn(result, 'serverConfirmed'), false)
  assert.equal(restored.snapshot().usable, false)
  assert.equal(restored.preview().ready, false)
  f.set({ x: 2, y: 67, z: 0 }, 'grass_block')
  assert.equal(restored.snapshot().usable, true)
  const original = restored.memo()
  assert.equal(restored.restoreMemo({ version: 99 }).code, 'MEMORY_ALREADY_PRESENT')
  assert.deepEqual(restored.memo(), original)
  f.state.realm.id = 'different-world'
  assert.equal(restored.snapshot().usable, false)
  assert.equal(restored.preview().code, 'SITE_SCOPE_CHANGED')
  assert.equal(f.calls.length, before)
})

test('received air alone cannot supply imaginary dirt and no door is placed before actual pickup', async () => {
  const f = fixture({ noPickup: true })
  await assert.rejects(f.shelter.execute({ radius: 0 }), error => error.code === 'PICKUP_NOT_CONFIRMED')
  assert.equal(f.calls.filter(call => call.type === 'place').length, 0)
  assert.equal(f.countDirt(), 0)
  assert.equal(f.shelter.snapshot().usable, false)
  assert.ok(f.shelter.memo().cleared.length === 4)
})

test('a completed mining controller without received air cannot advance into the hill', async () => {
  const f = fixture({ ghostMining: true })
  await assert.rejects(f.shelter.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.equal(f.calls.filter(call => call.type === 'move').length, 0)
  assert.equal(f.calls.filter(call => call.type === 'place').length, 0)
  assert.equal(f.calls.filter(call => call.type === 'mine_stop').length, 1)
  assert.equal(f.calls.filter(call => call.type === 'move_stop').length, 0, 'an unowned controller cannot be stopped')
})

test('shelter accepts a matching dirt selection and keeps actual block-and-consumption proof', async () => {
  for (const corrupt of [false, true]) {
    const f = fixture(); f.setDirt(1)
    Object.assign(f.state.inventory.items[0], { stackId: 82, networkId: 3, metadata: 0 })
    f.inventory.equip = async slot => {
      const item = f.state.inventory.items.find(item => item.slot === slot)
      f.state.rawSelectedSlot = f.state.selectedSlot = slot; f.state.heldItem = { ...item }
      return { phase: 'completed', sourceSlot: slot, slot, selectionSent: true, serverConfirmed: false, selectedItem: { ...item, stackId: item.stackId + Number(corrupt) } }
    }
    if (corrupt) await assert.rejects(f.shelter.execute({ radius: 0 }), error => error.code === 'EQUIPMENT_NOT_CONFIRMED')
    else await f.shelter.execute({ radius: 0 })
    assert.equal(f.shelter.memo().placements.length, corrupt ? 0 : 2)
  }
})

test('unconfirmed slot swaps cannot use a different hotbar selection to place the doorway', async () => {
  const f = fixture({ ghostEquip: true })
  await assert.rejects(f.shelter.execute({ radius: 0 }), error => error.code === 'EQUIPMENT_NOT_CONFIRMED')
  assert.equal(f.calls.filter(call => call.type === 'place').length, 0)
  assert.equal(f.shelter.memo().placements.length, 0)
})

test('an interrupted placement is not retried or owned until both received dirt and real inventory spend agree', async () => {
  const f = fixture({ ghostSpend: true })
  await assert.rejects(f.shelter.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.equal(f.shelter.memo().placements.length, 0)
  const pending = f.shelter.memo()
  assert.equal(pending.pendingPlacement.beforeDirt, 4)
  assert.equal(f.shelter.snapshot().established, false)
  await assert.rejects(f.shelter.execute(), error => error.code === 'PLACEMENT_UNCERTAIN')
  assert.equal(f.calls.filter(call => call.type === 'place').length, 1)
  f.setDirt(3) // A later authoritative full inventory supplies the missing proof.
  f.interactions.placeBlock = data => { f.calls.push({ type: 'place', target: structuredClone(data.position) }); f.set(data.position, 'dirt'); f.setDirt(f.countDirt() - 1); return { phase: 'completed' } }
  const resumed = f.create({ memo: pending })
  assert.equal((await resumed.execute()).usable, true)
  assert.equal(f.calls.filter(call => call.type === 'place').length, 2, 'the uncertain lower door is confirmed, never spent a second time')
})

test('leaving opens only the two confirmed own dirt doors top-to-bottom and reaches fresh grounded outside', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0 })
  const before = f.calls.length
  const raw = structuredClone(f.state.rawServerPosition)
  const result = await f.shelter.leave()
  assert.deepEqual(f.calls.slice(before).filter(call => call.type === 'dig').map(call => call.target), [{ x: 1, y: 66, z: 0 }, { x: 1, y: 65, z: 0 }])
  assert.equal(result.established, true)
  assert.equal(result.structureIntact, true)
  assert.equal(result.geometryVerified, true)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.inside, false)
  assert.equal(result.entranceClosed, false)
  assert.equal(result.usable, false)
  assert.equal(Math.floor(f.state.position.x), 0)
  assert.deepEqual(f.state.rawServerPosition, raw)
  assert.equal(f.world.getBlock(2, 64, 0).name, 'minecraft:stone', 'own floor and surrounding soil remain intact')
})

test('loss of memo ownership or changed door material blocks leave without breaking arbitrary blocks', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0 })
  const memo = f.shelter.memo()
  memo.placements = []
  const noOwnership = f.create({ memo })
  const before = f.calls.length
  await assert.rejects(noOwnership.leave(), error => error.code === 'OWN_ENTRANCE_UNCONFIRMED')
  assert.equal(f.calls.length, before)
  f.set({ x: 1, y: 66, z: 0 }, 'stone')
  const changed = f.calls.length
  await assert.rejects(f.shelter.leave(), error => ['SITE_CHANGED', 'DOOR_CHANGED'].includes(error.code))
  assert.equal(f.calls.length, changed)
})

test('cached closure receipts cannot keep a damaged or unknown shelter marked usable', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0 })
  assert.equal(f.shelter.snapshot().usable, true)
  f.set({ x: 2, y: 67, z: 0 }, { known: false })
  assert.equal(f.shelter.snapshot().usable, false)
  assert.equal(f.shelter.snapshot().structureIntact, false)
  assert.equal(f.shelter.preview().ready, false)
  f.set({ x: 2, y: 67, z: 0 }, 'grass_block')
  f.set({ x: 3, y: 65, z: 1 }, 'lava')
  assert.equal(f.shelter.snapshot().usable, true, 'an unbuilt future room behind the intact minimum walls is outside the initial refuge')
  f.set({ x: 2, y: 66, z: 0 }, { ...f.world.getBlock(2, 66, 0), extra: [block('water')] })
  assert.equal(f.shelter.snapshot().usable, false, 'liquid inside the actual minimum refuge still invalidates it')
})

test('future expansion cells cannot count as inside for either a new minimum plan or a legacy larger room plan', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0 })
  const memo = f.shelter.memo()
  delete memo.site.minimumInterior
  f.set({ x: 3, y: 65, z: 1 }, 'air')
  f.set({ x: 3, y: 66, z: 1 }, 'air')
  f.state.position = { x: 3.5, y: 66.62, z: 1.5 }
  const legacy = f.create({ memo })
  assert.equal(legacy.snapshot().inside, false)
  assert.equal(legacy.snapshot().structureIntact, true, 'the minimum refuge remains intact despite the separate future space')
  const invalid = structuredClone(memo)
  invalid.site.minimumInterior = { footCells: [memo.site.inner, { x: 3, y: 65, z: 1 }], bodyCells: memo.site.initialSteps[1].clearance }
  const expandedByClaim = f.create({ memo: invalid })
  assert.equal(expandedByClaim.snapshot().inside, false)
})

test('a minimal refuge closes successfully while future stone and unknown expansion cells remain untouched', async () => {
  const f = fixture()
  f.set({ x: 3, y: 65, z: 0 }, 'stone')
  f.set({ x: 3, y: 66, z: 0 }, 'stone')
  f.set({ x: 3, y: 65, z: 1 }, { known: false })
  const preview = f.shelter.preview({ radius: 0 })
  assert.equal(preview.ready, true)
  assert.equal(preview.minimumInterior.footCells.length, 1)
  assert.equal(preview.expansionPlan.ready, false)
  const result = await f.shelter.execute({ radius: 0 })
  assert.equal(result.usable, true)
  assert.equal(result.roomReady, false)
  assert.equal(f.world.getBlock(3, 65, 0).name, 'minecraft:stone')
  assert.equal(f.world.getBlock(3, 65, 1).known, false)
  assert.ok(f.calls.filter(call => call.type === 'dig').every(call => call.target.x <= 2 && call.target.z === 0))
})

test('a disk-restored pending placement cannot gain ownership from a coincidental old inventory difference', async () => {
  const f = fixture()
  await f.shelter.execute({ radius: 0 })
  const memo = f.shelter.memo()
  memo.pendingPlacement = { position: memo.site.doorCells[1].position, item: 'minecraft:dirt', beforeDirt: f.countDirt() + 1, requiresReconciliation: true, serverConfirmed: false }
  const restarted = f.create()
  assert.equal(restarted.restoreMemo(memo).pendingReconciliation, true)
  const before = f.calls.length
  assert.equal(restarted.snapshot().usable, false)
  assert.equal(restarted.snapshot().established, false)
  assert.equal(restarted.preview().code, 'PLACEMENT_RECONCILIATION_REQUIRED')
  await assert.rejects(restarted.execute(), error => error.code === 'PLACEMENT_RECONCILIATION_REQUIRED')
  await assert.rejects(restarted.leave(), error => error.code === 'PLACEMENT_RECONCILIATION_REQUIRED')
  assert.equal(f.calls.length, before)
  assert.equal(restarted.memo().pendingPlacement.requiresReconciliation, true)
})

test('health, stale movement and action budgets stop unsafe or unbounded work', async () => {
  const low = fixture()
  low.state.health = 6
  await assert.rejects(low.shelter.execute({ radius: 0 }), error => error.code === 'LOW_HEALTH')
  assert.equal(low.calls.length, 0)
  const hurt = fixture()
  const mine = hurt.mining.start
  hurt.mining.start = targets => { const result = mine(targets); hurt.state.health = 19; return result }
  await assert.rejects(hurt.shelter.execute({ radius: 0 }), error => error.code === 'TOOK_DAMAGE')
  assert.equal(hurt.calls.filter(call => call.type === 'place').length, 0)
  const stale = fixture({ staleMovement: true })
  await assert.rejects(stale.shelter.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.equal(stale.calls.filter(call => call.type === 'place').length, 0)
  assert.equal(stale.calls.filter(call => call.type === 'move_stop').length, 1)
  const bounded = fixture({ controller: { maxTotalActions: 4 } })
  await assert.rejects(bounded.shelter.execute({ radius: 0 }), error => error.code === 'ACTION_LIMIT')
  assert.equal(bounded.shelter.memo().totalActions, 4)
})

test('reentrant calls are rejected and cancellation stops only the mining stream owned by this batch', async () => {
  const f = fixture()
  let started = false
  f.mining.start = () => { started = true; f.setMining({ phase: 'mining' }); return new Promise(() => {}) }
  const controller = new AbortController()
  const pending = f.shelter.execute({ radius: 0 }, { signal: controller.signal })
  for (let index = 0; index < 30 && !started; index++) await Promise.resolve()
  assert.equal(started, true)
  assert.throws(() => f.shelter.restoreMemo(f.shelter.memo()), error => error.code === 'BUSY')
  await assert.rejects(f.shelter.execute(), error => error.code === 'BUSY')
  const reason = new Error('stop owned shelter work')
  controller.abort(reason)
  await assert.rejects(pending, reason)
  assert.equal(f.calls.filter(call => call.type === 'mine_stop').length, 1)
  assert.equal(f.calls.filter(call => call.type === 'move_stop').length, 0)
  assert.equal(f.calls.filter(call => call.type === 'interaction_cancel').length, 0)
  const other = fixture()
  other.setMining({ phase: 'mining' })
  await assert.rejects(other.shelter.execute(), error => error.code === 'BUSY')
  assert.equal(other.calls.length, 0, 'pre-existing work is never taken over or stopped')
})
