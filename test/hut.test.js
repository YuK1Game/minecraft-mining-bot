'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHut } = require('../src/hut')
const { createHutPlanner } = require('../src/hut-planner')
const { createNavigator } = require('../src/navigation')

const key = point => `${point.x},${point.y},${point.z}`
const block = name => ({ known: true, name: `minecraft:${name}`, properties: {}, runtimeId: name === 'air' ? 0 : 1, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })

function fixture (options = {}) {
  let time = 0; let tick = 0; let pendingDirt = 0; let reads = 0
  let miningState = { phase: 'idle' }; let movementState = { phase: 'idle' }
  const calls = []; const progress = []; const overrides = new Map()
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', realm: { id: 'hut-test' }, startedAt: 'session', connectionId: 'socket', runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 'initial', positionSource: 'start_game', rawSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:dirt', count: options.dirt ?? 17 }] }, entities: [] }
  const world = { getBlock: (x, y, z) => overrides.get(`${x},${y},${z}`) ?? block(y < 64 ? 'stone' : y === 64 ? 'grass_block' : 'air') }
  const set = (point, value) => overrides.set(key(point), typeof value === 'string' ? block(value) : value)
  const countDirt = () => state.inventory.items.filter(item => item.name === 'minecraft:dirt').reduce((sum, item) => sum + item.count, 0)
  const setDirt = count => { const current = state.inventory.items.find(item => item.name === 'minecraft:dirt'); if (current) current.count = count; else state.inventory.items.push({ name: 'minecraft:dirt', slot: 0, count }) }
  const getState = () => { reads++; return structuredClone(state) }
  const planner = createHutPlanner({ world, getState, getEntities: () => state.entities })
  const navigator = createNavigator({ world })
  const visible = (point, ignored) => {
    const eye = state.position; const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
    if (distance > 4.5) return false
    for (let index = 0; index < Math.ceil(distance / 0.05); index++) { const ratio = index / Math.ceil(distance / 0.05); const cell = { x: Math.floor(eye.x + (point.x - eye.x) * ratio), y: Math.floor(eye.y + (point.y - eye.y) * ratio), z: Math.floor(eye.z + (point.z - eye.z) * ratio) }; if ((!ignored || key(cell) !== key(ignored)) && world.getBlock(cell.x, cell.y, cell.z).name !== 'minecraft:air') return false }
    return true
  }
  const mining = {
    preview: targets => { const p = targets[0]; calls.push({ type: 'mine_preview', position: structuredClone(p) }); return { ready: visible({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, p) } },
    start: targets => { const p = targets[0]; calls.push({ type: 'mine', position: structuredClone(p) }); if (!options.ghostMining) { set(p, 'air'); pendingDirt++ }; miningState = { phase: 'completed' }; return miningState },
    stop: () => { calls.push({ type: 'mine_stop' }); miningState = { phase: 'stopped' } }
  }
  const movement = {
    preview: (target, settings) => {
      calls.push({ type: 'move_preview', target: structuredClone(target), settings })
      const initial = navigator.physics.fromServer(state)
      return navigator.plan(initial, target, { maxDistance: settings.maxDistance ?? 8 })
    },
    start: target => {
      calls.push({ type: 'move', target: structuredClone(target) })
      if (!options.staleMovement) { state.position = { x: target.x, y: target.y + 1.62, z: target.z }; state.positionUpdatedAt = `working-${++tick}`; state.positionSource = 'client_prediction'; state.predicted = { physicsState: { onGround: true, isInWater: false } } }
      if (!options.noPickup && pendingDirt) { setDirt(countDirt() + pendingDirt); pendingDirt = 0 }
      movementState = { phase: 'awaiting_server_confirmation' }; return movementState
    },
    stop: () => { calls.push({ type: 'move_stop' }); movementState = { phase: 'stopped' } }
  }
  const inventory = { equip: slot => { calls.push({ type: 'equip', slot }); const item = state.inventory.items.find(item => item.slot === slot && item.name === 'minecraft:dirt'); item.slot = state.rawSelectedSlot; state.heldItem = structuredClone(item); return { phase: 'completed', serverConfirmed: true } }, cancel: () => calls.push({ type: 'inventory_cancel' }), snapshot: () => ({ busy: false }) }
  const interactions = {
    previewPlace: data => {
      calls.push({ type: 'place_preview', position: structuredClone(data.position) })
      const p = data.position
      const support = { ...p, y: p.y - 1 }
      return { ready: state.position.y > p.y + 0.01 && world.getBlock(p.x, p.y, p.z).name === 'minecraft:air' && world.getBlock(support.x, support.y, support.z).boundingBox === 'block' && visible({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, support), expectedBlock: 'minecraft:dirt', position: p }
    },
    placeBlock: data => { calls.push({ type: 'place', position: structuredClone(data.position), eyeY: state.position.y }); if (!options.ghostBlock) set(data.position, 'dirt'); if (!options.ghostSpend) setDirt(countDirt() - 1); return { phase: 'completed' } },
    cancel: () => calls.push({ type: 'placement_cancel' }), snapshot: () => ({ pendingOperation: null })
  }
  const shared = { getState, world, planner, mining, getMining: () => miningState, movement, getMovement: () => movementState, inventory, interactions, maxActions: 64, maxTotalActions: 512, timeoutMs: 60, batchTimeoutMs: 20000, pickupTimeoutMs: 50, pollMs: 10, clock: () => time, delay: async milliseconds => { time += milliseconds }, onProgress: event => progress.push(structuredClone(event)), ...options.controller }
  const create = extra => createHut({ ...shared, ...extra })
  const hut = create()
  return { hut, create, state, world, set, calls, progress, planner, mining, movement, inventory, interactions, setDirt, countDirt, reads: () => reads, setMining: value => { miningState = value } }
}

test('hut constructor is passive and preview requires seventeen actual dirt with an immutable known timeline', () => {
  const f = fixture()
  assert.equal(f.reads(), 0)
  assert.equal(f.calls.length, 0)
  const plan = f.hut.preview({ radius: 0 })
  assert.equal(plan.ready, true, plan.reason)
  assert.equal(plan.steps.filter(step => step.type === 'place').length, 19)
  assert.equal(plan.materials.initialRequired, 17)
  assert.equal(plan.serverConfirmed, false)
  f.setDirt(16)
  assert.equal(f.hut.preview({ radius: 0 }).code, 'MATERIAL_MISSING')
  assert.equal(f.calls.length, 0)
})

test('flat hut builds nineteen placements, recovers its two temporary dirt and verifies a real closed one-cell interior', async () => {
  const f = fixture()
  const raw = structuredClone(f.state.rawServerPosition)
  const plan = f.hut.preview({ radius: 0 })
  const result = await f.hut.execute({ radius: 0 })
  assert.equal(result.phase, 'completed')
  assert.equal(result.closed, true)
  assert.equal(result.inside, true)
  assert.equal(result.usable, true)
  assert.equal(result.established, true)
  assert.equal(result.structureIntact, true)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.positionServerConfirmed, false)
  assert.equal(result.positionSource, 'client_prediction')
  assert.equal(f.countDirt(), 0)
  assert.equal(f.calls.filter(call => call.type === 'place').length, 19)
  assert.deepEqual(f.calls.filter(call => call.type === 'mine').map(call => call.position), [...plan.temporaryPillar].reverse())
  const permanent = plan.buildCells.filter(p => f.world.getBlock(p.x, p.y, p.z).name === 'minecraft:dirt')
  assert.equal(permanent.length, 17)
  assert.ok(plan.temporaryPillar.every(p => f.world.getBlock(p.x, p.y, p.z).name === 'minecraft:air'))
  const roof = f.calls.find(call => call.type === 'place' && key(call.position) === key(plan.roof))
  assert.ok(roof.eyeY > roof.position.y, 'roof is placed from above by climbing ordinary one-block supports')
  assert.deepEqual(f.state.rawServerPosition, raw)
})

test('bounded confirmed batches resume from memo without repeating placements or upgrading uncertain pending writes', async () => {
  const f = fixture({ controller: { maxActions: 4 } })
  let controller = f.hut
  let result
  for (let batch = 0; batch < 30; batch++) {
    result = await controller.execute({ radius: 0 })
    if (result.phase === 'completed') break
    assert.equal(result.phase, 'predicted')
    assert.equal(result.partial, true)
    assert.equal(result.busy, false)
    controller = f.create({ memo: controller.memo() })
  }
  assert.equal(result.phase, 'completed')
  assert.equal(f.calls.filter(call => call.type === 'place').length, 19)
  const memo = controller.memo()
  memo.pendingPlacement = { position: memo.site.doorCells[0], beforeDirt: 1 }
  const ambiguous = f.create({ memo })
  assert.equal(ambiguous.preview().code, 'PLACEMENT_UNCERTAIN')
  assert.equal(ambiguous.memo().pendingPlacement.requiresReconciliation, true)
})

test('own door reopens upper then lower and return recloses the same established hut', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  const site = f.hut.memo().site
  const previous = f.calls.length
  const left = await f.hut.leave()
  assert.equal(left.closed, false)
  assert.equal(left.inside, false)
  assert.equal(left.established, true)
  assert.equal(left.structureIntact, true)
  assert.equal(left.usable, false)
  assert.deepEqual(f.calls.slice(previous).filter(call => call.type === 'mine').map(call => call.position), [...site.doorCells].reverse())
  const returned = await f.hut.execute()
  assert.equal(returned.closed, true)
  assert.equal(returned.inside, true)
  assert.equal(f.calls.filter(call => call.type === 'place').length, 21, 'return only replaces the two own door blocks')
})

test('a known hut can be approached from beyond eight blocks within the twelve-block movement bound', async () => {
  const f = fixture(); await f.hut.execute({ radius: 0 }); const site = f.hut.memo().site; await f.hut.leave()
  const dx = Math.sign(site.outsideStandpoint.x - site.insideStandpoint.x)
  const dz = Math.sign(site.outsideStandpoint.z - site.insideStandpoint.z)
  f.state.position = { x: site.insideStandpoint.x + dx * 9, y: site.insideStandpoint.y + 1.62, z: site.insideStandpoint.z + dz * 9 }
  f.state.positionUpdatedAt = 'far-origin'
  const before = f.calls.length; const result = await f.hut.execute()
  assert.equal(result.closed, true)
  const preview = f.calls.slice(before).find(call => call.type === 'move_preview')
  assert.equal(preview.settings.maxDistance, 12)
})

test('received blocks without inventory spend, or spend without blocks, never become ownership receipts', async () => {
  for (const option of ['ghostSpend', 'ghostBlock']) {
    const f = fixture({ [option]: true })
    await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
    assert.equal(f.hut.snapshot().usable, false)
    assert.equal(f.hut.memo().placements.length, 0)
    assert.equal(f.hut.memo().pendingPlacement.requiresReconciliation, true)
    assert.equal(f.hut.snapshot().busy, false)
  }
  const mismatch = fixture()
  mismatch.interactions.previewPlace = data => ({ ready: true, position: data.position, expectedBlock: 'minecraft:cobblestone' })
  await assert.rejects(mismatch.hut.execute({ radius: 0 }), error => error.code === 'PLACEMENT_PREVIEW_REJECTED')
  assert.equal(mismatch.calls.filter(call => call.type === 'place').length, 0)
})

test('two received pillar destructions without actual dirt pickup cannot close the hut', async () => {
  const f = fixture({ noPickup: true })
  await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.equal(f.calls.filter(call => call.type === 'mine').length, 2)
  assert.equal(f.calls.filter(call => call.type === 'place').length, 17)
  assert.equal(f.hut.snapshot().closed, false)
  assert.equal(f.hut.snapshot().established, false)
})

test('changed geometry, foreign dirt and mobs at a placement cannot be promoted into a safe own hut', async () => {
  const foreign = fixture()
  const plan = foreign.hut.preview({ radius: 0 })
  foreign.set(plan.walls[0], 'dirt')
  assert.equal(foreign.hut.preview({ site: plan }).ready, false)
  const mob = fixture()
  const site = mob.hut.preview({ radius: 0 })
  const originalPreview = mob.interactions.previewPlace
  mob.interactions.previewPlace = data => {
    const preview = originalPreview(data)
    if (preview.ready) mob.state.entities = [{ runtimeId: '77', kind: 'mob', positionKnown: true, alive: true, position: { x: data.position.x + 0.5, y: data.position.y, z: data.position.z + 0.5 } }]
    return preview
  }
  await assert.rejects(mob.hut.execute({ site }), error => error.code === 'ACTOR_COLLISION')
  assert.equal(mob.calls.filter(call => call.type === 'place').length, 0)
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  f.set(f.hut.memo().site.roof, 'air')
  assert.equal(f.hut.snapshot().usable, false)
  assert.equal(f.hut.snapshot().structureIntact, false)
})

test('health, death, unknown world, actor ownership and abort stop construction without phantom completion', async () => {
  for (const [change, code] of [[f => { f.state.health = 4 }, 'LOW_HEALTH'], [f => { f.state.dead = true }, 'NOT_READY'], [f => { f.state.inventory.known = false }, 'INVENTORY_UNKNOWN'], [f => { f.setMining({ phase: 'mining' }) }, 'BUSY']]) {
    const f = fixture(); change(f); await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === code); assert.equal(f.calls.filter(call => call.type === 'place').length, 0)
  }
  const f = fixture()
  const controller = new AbortController()
  let began
  const entered = new Promise(resolve => { began = resolve })
  f.interactions.placeBlock = () => { began(); return new Promise(() => {}) }
  const work = f.hut.execute({ radius: 0 }, { signal: controller.signal })
  const stopped = assert.rejects(work, /cancel hut/)
  await entered
  await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === 'BUSY')
  controller.abort(new Error('cancel hut'))
  await stopped
  assert.equal(f.hut.snapshot().busy, false)
  assert.ok(f.calls.some(call => call.type === 'placement_cancel'))
  assert.equal(f.hut.memo().placements.length, 0)
})

test('extra starting dirt does not replace the required two-item actual pillar recovery', async () => {
  const normal = fixture({ dirt: 20 })
  await normal.hut.execute({ radius: 0 })
  assert.equal(normal.countDirt(), 3, 'net material spend is seventeen after recovery and closure')
  const missed = fixture({ dirt: 20, noPickup: true })
  await assert.rejects(missed.hut.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.equal(missed.countDirt(), 3)
  assert.equal(missed.hut.memo().reclaimBaseline, 3)
  assert.equal(missed.hut.snapshot().closed, false)
})

test('unreceived air and stale working movement cannot finish a hut timeline', async () => {
  for (const option of ['ghostMining', 'staleMovement']) {
    const f = fixture({ [option]: true })
    await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === (option === 'staleMovement' ? 'REPLAN_REQUIRED' : 'TIMEOUT'))
    assert.equal(f.hut.snapshot().usable, false)
    assert.equal(f.hut.snapshot().established, false)
    assert.equal(f.hut.snapshot().busy, false)
  }
})

test('health and session changes are observed while an asynchronous placement is pending', async () => {
  for (const [change, code] of [[f => { f.state.health = 19 }, 'TOOK_DAMAGE'], [f => { f.state.dimension = 'nether' }, 'SESSION_CHANGED']]) {
    const f = fixture({ controller: { timeoutMs: 1000, pollMs: 5 } })
    f.interactions.placeBlock = () => { change(f); return new Promise(() => {}) }
    await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === code)
    assert.equal(f.hut.snapshot().busy, false)
    assert.equal(f.hut.snapshot().usable, false)
    assert.equal(f.hut.memo().placements.length, 0)
    assert.ok(f.calls.some(call => call.type === 'placement_cancel'))
  }
})

test('unknown/protected terrain and unknown actors remain untrusted after memo replay', async () => {
  const f = fixture()
  const site = f.hut.preview({ radius: 0 })
  f.set(site.preserved.floor[0].position, { known: false })
  assert.equal(f.hut.preview({ site }).ready, false)
  assert.equal(f.calls.length, 0)
  const actor = fixture()
  actor.state.entities = [{ runtimeId: '77', kind: 'mob', alive: true, positionKnown: false, position: null }]
  await assert.rejects(actor.hut.execute({ radius: 0 }), error => error.code === 'ACTOR_POSITION_UNKNOWN')
  assert.equal(actor.calls.filter(call => call.type === 'place').length, 0)
  const existing = fixture()
  await existing.hut.execute({ radius: 0 })
  const memo = existing.hut.memo()
  existing.state.dimension = 'nether'
  assert.equal(existing.hut.snapshot().usable, false)
  existing.state.dimension = 'overworld'
  existing.set(memo.site.roof, { ...block('dirt'), protected: true })
  assert.equal(existing.hut.snapshot().usable, false)
  assert.equal(existing.create({ memo }).preview().ready, false)
})

test('a never-returning placement has a strict deadline and the lifetime budget survives later batches', async () => {
  const hung = fixture({ controller: { timeoutMs: 25 } })
  hung.interactions.placeBlock = () => new Promise(() => {})
  const began = Date.now()
  await assert.rejects(hung.hut.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.ok(Date.now() - began < 1000)
  assert.equal(hung.hut.snapshot().busy, false)
  const limited = fixture({ controller: { maxTotalActions: 1 } })
  await assert.rejects(limited.hut.execute({ radius: 0 }), error => error.code === 'ACTION_LIMIT')
  assert.equal(limited.calls.filter(call => call.type === 'place').length, 1)
  await assert.rejects(limited.hut.execute({ radius: 0 }), error => error.code === 'ACTION_LIMIT')
  assert.equal(limited.calls.filter(call => call.type === 'place').length, 1)
})

test('the hut timeline cannot remove its own floor, omit recovery or reopen an unowned door', async () => {
  const f = fixture()
  const plan = f.hut.preview({ radius: 0 })
  const forged = structuredClone(plan)
  forged.steps.find(step => step.type === 'mine').position = forged.preserved.floor[0].position
  assert.equal(f.create({ planner: () => forged }).preview().code, 'INVALID_PLAN')
  const missingBarrier = { ...structuredClone(plan), steps: plan.steps.filter(step => step.type !== 'wait_material') }
  assert.equal(f.create({ planner: () => missingBarrier }).preview().code, 'INVALID_PLAN')
  await f.hut.execute({ radius: 0 })
  const memo = f.hut.memo()
  const door = memo.site.doorCells[0]
  memo.placements = memo.placements.filter(receipt => key(receipt.position) !== key(door))
  const restored = f.create({ memo })
  const before = f.calls.filter(call => call.type === 'mine').length
  await assert.rejects(restored.leave())
  assert.equal(f.calls.filter(call => call.type === 'mine').length, before)
})

test('confirmed own dirt walls, roof and door may grow grass without losing the closed hut or rebuilding it', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  const before = f.hut.memo()
  for (const position of before.site.buildCells) f.set(position, 'grass_block')
  const grown = f.hut.snapshot()
  assert.equal(grown.established, true)
  assert.equal(grown.structureIntact, true)
  assert.equal(grown.geometryVerified, true)
  assert.equal(grown.closed, true)
  assert.equal(grown.usable, true)
  assert.equal(grown.serverConfirmed, true)
  assert.equal(f.hut.preview().ready, true)
  const places = f.calls.filter(call => call.type === 'place').length
  const digs = f.calls.filter(call => call.type === 'mine').length
  const resumed = f.create({ memo: before })
  assert.equal(resumed.preview().ready, true)
  assert.equal(resumed.snapshot().usable, true)
  const result = await resumed.execute()
  assert.equal(result.usable, true)
  assert.equal(f.calls.filter(call => call.type === 'place').length, places)
  assert.equal(f.calls.filter(call => call.type === 'mine').length, digs)
  assert.equal(f.countDirt(), 0)
  assert.deepEqual(resumed.memo().placements, before.placements, 'natural growth adds neither a new ownership receipt nor items')
})

test('the own grass-grown door reopens normally, yields actual dirt and can be closed again', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  const site = f.hut.memo().site
  for (const point of [...site.doorCells, site.roof]) f.set(point, 'grass_block')
  const previous = f.calls.length
  const left = await f.hut.leave()
  assert.equal(left.closed, false)
  assert.equal(left.established, true)
  assert.equal(left.structureIntact, true)
  assert.deepEqual(f.calls.slice(previous).filter(call => call.type === 'mine').map(call => call.position), [...site.doorCells].reverse())
  assert.equal(f.countDirt(), 2)
  const returned = await f.hut.execute()
  assert.equal(returned.usable, true)
  assert.equal(f.countDirt(), 0)
  assert.ok(site.doorCells.every(point => f.world.getBlock(point.x, point.y, point.z).name === 'minecraft:dirt'))
})

test('a received own temporary pillar may change to grass before its two real dirt items are recovered', async () => {
  const f = fixture()
  const site = f.hut.preview({ radius: 0 })
  const place = f.interactions.placeBlock
  f.interactions.placeBlock = data => {
    const response = place(data)
    if (key(data.position) === key(site.roof)) for (const point of site.temporaryPillar) f.set(point, 'grass_block')
    return response
  }
  const result = await f.hut.execute({ radius: 0 })
  assert.equal(result.usable, true)
  assert.equal(f.hut.memo().recoveredTemporaryDirt, true)
  assert.equal(f.countDirt(), 0)
  assert.ok(site.temporaryPillar.every(point => f.world.getBlock(point.x, point.y, point.z).name === 'minecraft:air'))
})

test('grass without the exact receipt or with an unresolved pending write is not owned, and missing/unsafe shell remains invalid', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  const original = f.hut.memo()
  const wall = original.site.walls[0]
  f.set(wall, 'grass_block')
  const noReceipt = structuredClone(original)
  noReceipt.placements = noReceipt.placements.filter(receipt => key(receipt.position) !== key(wall))
  const unowned = f.create({ memo: noReceipt })
  assert.equal(unowned.snapshot().usable, false)
  assert.equal(unowned.preview().ready, false)
  const pending = structuredClone(original)
  pending.pendingPlacement = { position: wall, beforeDirt: 1, requiresReconciliation: true }
  const uncertain = f.create({ memo: pending })
  assert.equal(uncertain.snapshot().usable, false)
  assert.equal(uncertain.preview().code, 'PLACEMENT_UNCERTAIN')
  const malformedPending = structuredClone(original)
  malformedPending.pendingPlacement = { requiresReconciliation: true }
  assert.equal(f.create({ memo: malformedPending }).snapshot().usable, false)
  const count = f.calls.length
  for (const value of ['water', 'air', { known: false }]) {
    f.set(wall, value)
    assert.equal(f.hut.snapshot().usable, false)
    assert.equal(f.hut.snapshot().structureIntact, false)
    const preview = f.hut.preview()
    assert.notEqual(preview.usable, true, 'a repair proposal never confirms the missing shell')
    assert.notEqual(preview.structureIntact, true)
  }
  assert.equal(f.calls.length, count)
  assert.equal(f.countDirt(), 0)
})

function pendingMemo (f) {
  const site = f.hut.preview({ radius: 0 })
  return { version: 1, kind: 'soil_hut', scope: { realmId: f.state.realm.id, dimension: f.state.dimension }, site, placements: [], stepIndex: 0, totalActions: 1, established: false, recoveredTemporaryDirt: false, pendingPlacement: { position: structuredClone(site.walls[0]), item: 'minecraft:dirt', beforeDirt: 17, requestId: 12, serverConfirmed: false, requiresReconciliation: true } }
}

test('explicit reconciliation abandons only a replayed received-empty target without changing inventory, pose, cursor, receipts or completion', () => {
  const f = fixture(); const saved = pendingMemo(f); const hut = f.create({ memo: saved })
  const baseline = structuredClone(f.state); const oldMemo = hut.memo(); const beforeCalls = f.calls.length
  assert.equal(hut.preview().code, 'PLACEMENT_UNCERTAIN')
  assert.equal(hut.memo().pendingPlacement.requiresReconciliation, true)
  const result = hut.reconcileEmptyPlacement()
  assert.equal(result.action, 'abandon_empty_target')
  assert.equal(result.placementConfirmed, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.requiresWorldValidation, true)
  assert.deepEqual(result.abandonedPlacement, oldMemo.pendingPlacement)
  assert.deepEqual(hut.memo(), { ...oldMemo, pendingPlacement: null })
  assert.deepEqual(f.state, baseline)
  assert.equal(f.calls.length, beforeCalls)
  assert.equal(hut.snapshot().usable, false)
  assert.equal(hut.snapshot().established, false)
  const event = f.progress.at(-1)
  assert.equal(event.stage, 'abandon_empty_target')
  assert.equal(event.memo.pendingPlacement, null)
  assert.deepEqual(event.abandonedPlacement, oldMemo.pendingPlacement)
  result.abandonedPlacement.position.x += 100
  result.memo.placements.push({ forged: true })
  assert.deepEqual(hut.memo(), { ...oldMemo, pendingPlacement: null })
  assert.throws(() => hut.reconcileEmptyPlacement(), error => error.code === 'PLACEMENT_NOT_REPLAYED')
})

test('reconciliation refuses nonempty, layered, unknown, protected or out-of-site targets and unconfirmed inventory or mismatched scope', () => {
  const cases = [
    f => { f.set(f.saved.pendingPlacement.position, 'dirt') },
    f => { f.set(f.saved.pendingPlacement.position, 'grass_block') },
    f => { f.set(f.saved.pendingPlacement.position, 'water') },
    f => { f.set(f.saved.pendingPlacement.position, 'lava') },
    f => { f.set(f.saved.pendingPlacement.position, { known: false }) },
    f => { f.set(f.saved.pendingPlacement.position, { ...block('air'), extra: [{ name: 'minecraft:water' }] }) },
    f => { f.set(f.saved.pendingPlacement.position, { ...block('air'), extra: [{ name: 'minecraft:air' }] }) },
    f => { f.set(f.saved.pendingPlacement.position, { ...block('air'), protected: true }) },
    f => { f.state.inventory.known = false },
    f => { f.state.inventory.uncertain = true },
    f => { f.state.dimension = 'nether' },
    f => { f.state.realm.id = 'different' },
    f => { f.state.realm = null },
    f => { f.saved.scope.realmId = null },
    f => { f.saved.scope.profile = 'different' },
    f => { f.saved.ownerProfile = 'different' },
    f => { f.saved.pendingPlacement.position = { x: 99, y: 65, z: 99 } }
  ]
  for (const change of cases) {
    const f = fixture(); f.saved = pendingMemo(f); change(f)
    const hut = f.create({ memo: f.saved }); const baseline = hut.memo(); const stateBefore = structuredClone(f.state)
    assert.throws(() => hut.reconcileEmptyPlacement())
    assert.deepEqual(hut.memo(), baseline)
    assert.deepEqual(f.state, stateBefore)
    assert.equal(f.calls.length, 0)
    assert.equal(f.progress.length, 0)
  }
})

test('reconciliation cannot consume a live or merely failed request and rejects foreign in-flight controller ownership', async () => {
  const f = fixture({ ghostBlock: true })
  await assert.rejects(f.hut.execute({ radius: 0 }), error => error.code === 'TIMEOUT')
  assert.equal(f.hut.memo().pendingPlacement.requiresReconciliation, true)
  assert.throws(() => f.hut.reconcileEmptyPlacement(), error => error.code === 'PLACEMENT_NOT_REPLAYED')
  const replay = f.hut.memo()
  for (const extra of [
    { getMining: () => ({ phase: 'mining' }) },
    { getMovement: () => ({ phase: 'moving' }) },
    { inventory: { ...f.inventory, snapshot: () => ({ busy: true }) } },
    { interactions: { ...f.interactions, snapshot: () => ({ pendingOperation: { id: 1 } }) } }
  ]) {
    const hut = f.create({ memo: replay, ...extra }); const baseline = hut.memo()
    assert.throws(() => hut.reconcileEmptyPlacement(), error => error.code === 'BUSY')
    assert.deepEqual(hut.memo(), baseline)
  }
  const active = fixture({ controller: { timeoutMs: 1000 } })
  let entered; const started = new Promise(resolve => { entered = resolve })
  active.interactions.placeBlock = () => { entered(); return new Promise(() => {}) }
  const operation = active.hut.execute({ radius: 0 })
  await started
  assert.throws(() => active.hut.reconcileEmptyPlacement(), error => error.code === 'BUSY')
  const rejected = assert.rejects(operation, error => error.code === 'ABORTED')
  await active.hut.stop('test stop'); await rejected
})

test('a restored historically completed hut with received-air doors recloses only after explicit abandonment and two fresh dirt spends', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  const saved = f.hut.memo()
  for (const point of saved.site.doorCells) f.set(point, 'air')
  f.setDirt(4)
  saved.established = false
  saved.previouslyEstablished = true
  saved.pendingPlacement = { position: saved.site.doorCells[0], item: 'minecraft:dirt', beforeDirt: 999, serverConfirmed: false, requiresReconciliation: true }
  const restored = f.create({ memo: saved })
  assert.equal(restored.snapshot().usable, false)
  assert.equal(restored.preview().code, 'PLACEMENT_UNCERTAIN')
  const before = f.calls.length
  const abandoned = restored.reconcileEmptyPlacement()
  assert.equal(abandoned.memo.established, false)
  assert.equal(restored.snapshot().usable, false)
  assert.equal(f.countDirt(), 4)
  assert.deepEqual(abandoned.memo.placements, saved.placements)
  const result = await restored.execute()
  assert.equal(result.established, true)
  assert.equal(result.closed, true)
  assert.equal(result.inside, true)
  assert.equal(result.usable, true)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.countDirt(), 2)
  assert.deepEqual(f.calls.slice(before).filter(call => call.type === 'place').map(call => call.position), saved.site.doorCells)
  assert.equal(restored.memo().placements.length, saved.placements.length)
  assert.equal(f.calls.slice(before).some(call => call.type === 'mine'), false)
})

test('historical completion never authorizes reclosure with unknown, broken or unowned shell, blocked interior or unrecovered pillar', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  const original = f.hut.memo()
  for (const point of original.site.doorCells) f.set(point, 'air')
  f.setDirt(4)
  const cases = [
    { position: original.site.walls[0], block: { known: false } },
    { position: original.site.walls[0], block: block('air') },
    { position: original.site.roof, block: block('stone') },
    { position: original.site.temporaryPillar[0], block: block('stone') },
    { change: memo => { memo.placements = memo.placements.filter(item => key(item.position) !== key(original.site.walls[0])) } },
    { change: memo => { memo.recoveredTemporaryDirt = false } },
    { change: memo => { memo.placements = memo.placements.filter(item => key(item.position) !== key(original.site.doorCells[1])) } }
  ]
  for (const issue of cases) {
    const saved = structuredClone(original)
    saved.established = false; saved.previouslyEstablished = true
    saved.pendingPlacement = { position: saved.site.doorCells[0], item: 'minecraft:dirt', beforeDirt: 2, requiresReconciliation: true }
    issue.change?.(saved)
    if (issue.position) f.set(issue.position, issue.block)
    const restored = f.create({ memo: saved })
    restored.reconcileEmptyPlacement()
    const before = f.calls.length
    await assert.rejects(restored.execute())
    assert.equal(restored.memo().established, false)
    assert.equal(restored.snapshot().usable, false)
    assert.equal(f.calls.slice(before).some(call => ['place', 'mine', 'move', 'equip'].includes(call.type)), false)
    assert.equal(f.countDirt(), 4)
    if (issue.position) f.set(issue.position, original.site.temporaryPillar.some(point => key(point) === key(issue.position)) ? 'air' : 'dirt')
  }
})

test('a late terminal correction re-reads the actual pose and requests a fresh route instead of placing with the body outside the interior', async () => {
  const f = fixture()
  await f.hut.execute({ radius: 0 })
  await f.hut.leave()
  const saved = f.hut.memo(); const start = f.movement.start
  let lastTarget = null
  f.movement.start = target => { lastTarget = structuredClone(target); return start(target) }
  const restored = f.create({ memo: saved, getMovement: async () => {
    if (!lastTarget) return { phase: 'idle' }
    // The move first predicts the exact target. Its completed-status await then
    // receives the same 0.329-block doorway correction observed in the field.
    f.state.position = { x: lastTarget.x - 0.01046, y: lastTarget.y + 1.62, z: lastTarget.z + 0.328946 }
    f.state.positionUpdatedAt = 'fresh-server-correction'
    f.state.positionSource = 'correct_player_move_prediction'
    return { phase: 'awaiting_server_confirmation' }
  } })
  const before = f.calls.length; const dirt = f.countDirt(); const raw = structuredClone(f.state.rawServerPosition)
  await assert.rejects(restored.execute(), error => error.code === 'REPLAN_REQUIRED')
  assert.equal(restored.snapshot().busy, false)
  assert.equal(restored.snapshot().inside, false)
  assert.equal(restored.snapshot().usable, false)
  assert.equal(restored.memo().pendingPlacement, null)
  assert.equal(f.calls.slice(before).some(call => ['place', 'place_preview', 'equip'].includes(call.type)), false)
  assert.equal(f.countDirt(), dirt)
  assert.equal(f.state.positionUpdatedAt, 'fresh-server-correction')
  assert.equal(f.state.position.z, saved.site.insideStandpoint.z + 0.328946)
  assert.deepEqual(f.state.rawServerPosition, raw)
})
