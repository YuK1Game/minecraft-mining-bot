'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { selectCarriedStorage, carriedContainerKey } = require('../src/quarry-inventory')

const copy = value => structuredClone(value)
const extra = () => ({ has_nbt: 'false', can_place_on: [], can_destroy: [] })
const airItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: extra() })
const item = (id, count, stack) => ({ ...airItem(), network_id: id, count, has_stack_id: true, stack_id: stack })
const key = p => `${p.x},${p.y},${p.z}`
const names = new Map([[1, 'minecraft:chest'], [2, 'minecraft:undyed_shulker_box'], [3, 'minecraft:dirt'], [4, 'minecraft:stone'], [5, 'minecraft:grass_block']])

function carriedBox (slots, stackId, { wrongContents = false, missingNBT = false } = {}) {
  const raw = item(2, 1, stackId)
  if (missingNBT) return raw
  const contents = slots.flatMap((raw, slot) => raw.count ? [{ Slot: { type: 'byte', value: slot }, Name: { type: 'string', value: names.get(raw.network_id) }, Count: { type: 'byte', value: raw.count + (wrongContents ? 1 : 0) }, Damage: { type: 'short', value: raw.metadata ?? 0 } }] : [])
  raw.extra = { ...extra(), has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: contents } } } } } }
  return raw
}

function fixture (kind = 'shulker', options = {}) {
  let time = 1000, sequence = 100, open = null, activeSlots = null, activePosition = null, mining = { phase: 'idle' }, controller, pickup = null
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'one', startedAt: '2026-11-05T00:00:00Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, inventory: { known: true } }
  const bag = Array.from({ length: 36 }, airItem), blocks = new Map(), containers = new Map(), events = [], checkpoints = []
  bag[0] = item(3, 16, 10); bag[14] = item(kind === 'shulker' ? 2 : 1, kind === 'double_chest' ? 2 : 1, 20)
  const items = () => bag.flatMap((raw, slot) => raw.count ? [{ slot, name: names.get(raw.network_id), count: raw.count, stackId: raw.stack_id, networkId: raw.network_id, metadata: raw.metadata }] : [])
  const getState = () => ({ ...copy(state), inventory: { ...state.inventory, items: items() } })
  const getBlock = (x, y, z) => options.unknownWorld ? { known: false } : copy(blocks.get(`${x},${y},${z}`) ?? { known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', runtimeId: y < 65 ? 1 : 0, boundingBox: y < 65 ? 'block' : 'empty', extra: [] })
  const crafting = { inventorySnapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, inventory: items(), openContainer: copy(open) }), rawItem: slot => slot >= 0 && slot < 36 ? copy(bag[slot]) : null, itemNameOf: id => names.get(id), closeContainer: () => { events.push({ type: 'close' }); open = null } }
  let windowEpoch = 0, openedScope = null
  const chest = {
    open: async (position, slot, { expectedSlots }) => {
      events.push({ type: 'open', expectedSlots, position: copy(position) }); activePosition = copy(position)
      const count = options.wrongSize ?? expectedSlots
      if (!containers.has(key(position))) containers.set(key(position), Array.from({ length: count }, (_, slot) => options.full ? item(3, 64, 200 + slot) : airItem()))
      activeSlots = containers.get(key(position)); open = { id: 7, type: 'container', coordinates: copy(position) }
      windowEpoch++
      openedScope = { profile: state.profile, realmId: String(state.realm.id), connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), dimension: state.dimension, life: state.lifecycle.deathId }
      return { serverConfirmed: true, confirmedBy: 'server_container_open_and_full_content', windowId: 7, slotCount: count, position: copy(position), scope: copy(openedScope) }
    },
    snapshot: () => ({ contentsKnown: !!open && !options.unknownContents, slotCount: activeSlots?.length, observationSource: 'server_inventory_content', window: { id: 7, type: 'container', position: copy(activePosition), epoch: windowEpoch, scope: copy(openedScope), replayed: false } }),
    rawItem: slot => activeSlots?.[slot] ? copy(activeSlots[slot]) : null,
    depositItem: async ({ sourceSlot, count, chestSlot, expectedName }) => {
      events.push({ type: 'deposit', sourceSlot, count, chestSlot })
      if (options.rejectDeposit) throw Object.assign(new Error('server rejected request'), { code: 'SERVER_REJECTED' })
      const before = copy(bag[sourceSlot]), destination = activeSlots[chestSlot]
      bag[sourceSlot] = before.count === count ? airItem() : { ...before, count: before.count - count, stack_id: ++sequence }
      activeSlots[chestSlot] = { ...before, count: destination.count + count, stack_id: ++sequence }
      return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, operation: 'deposit_item', count, item: expectedName, position: copy(activePosition), playerSlot: sourceSlot, chestSlot, requestId: -sequence, confirmedBy: 'matching_response_and_actual_inventory_slots' }
    }
  }
  const dependencies = {
    getState, getBlock, crafting, chest, previewMove: options.previewMove,
    interactions: { placeBlock: async ({ position, slot }) => {
      events.push({ type: 'place', position: copy(position), slot })
      const before = bag[slot], name = names.get(before.network_id)
      blocks.set(key(position), { known: true, name, runtimeId: before.network_id + 300, boundingBox: 'block', extra: [] })
      if (!options.missingSpend) bag[slot] = before.count === 1 ? airItem() : { ...before, count: before.count - 1, stack_id: ++sequence }
      return { phase: 'completed', confirmedBy: 'server_block_and_inventory', position: copy(position), blockName: name }
    } },
    equip: async slot => {
      events.push({ type: 'equip', slot })
      if (options.hangEquip) return new Promise(() => {})
      const before = bag[slot]; bag[slot] = bag[0]; bag[0] = before; state.rawSelectedSlot = 0
      open = { id: 0, type: 'inventory' }
      return { phase: 'completed', serverConfirmed: true, slot: 0, sourceSlot: slot }
    },
    moveTo: async position => {
      events.push({ type: 'move', position: copy(position) }); state.position = { x: position.x + 0.5, y: position.y + 1.62, z: position.z + 0.5 }
      if (pickup) { pickup(); pickup = null }
      return { phase: 'completed', serverConfirmed: false }
    },
    mine: async target => {
      events.push({ type: 'mine', target: copy(target) })
      assert.equal(controller.ownsShulker(getState(), target, getBlock(target.x, target.y, target.z)), true)
      blocks.set(key(target), { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] })
      assert.equal(controller.ownsShulker(getState(), target, getBlock(target.x, target.y, target.z)), true)
      mining = { phase: 'completed', blockCleared: true, serverConfirmed: true, collected: false }
      const collect = () => {
        if (options.noPickup) return
        const slot = bag.findIndex(raw => raw.count === 0)
        bag[slot] = carriedBox(containers.get(key(target)), options.reusedStackId ?? ++sequence, options)
      }
      if (options.pickupOnMove) pickup = collect; else collect()
      return copy(mining)
    },
    getMining: () => copy(mining), stopMining: () => { events.push({ type: 'stopMining' }); mining = { phase: 'stopped' } },
    getEntities: () => options.entities?.() ?? [], cancelAction: kind => events.push({ type: 'cancel', kind }), now: () => time, sleep: async ms => { time += ms }
  }
  controller = createQuarryPortableStorage(dependencies)
  const request = { jobId: 'job', operationId: 'job:storage:1', selection: selectCarriedStorage(items()), deposits: [{ slot: 0, name: 'minecraft:dirt', count: 8 }], inventoryPolicy: { keepSealBlocks: 0 } }
  const run = (extra = {}, input = request) => controller.storeCarried(copy(input), { canPlace: () => true, onCheckpoint: async cp => { checkpoints.push(copy(cp)); if (extra.onCheckpoint) await extra.onCheckpoint(cp) }, ...extra })
  return { state, bag, blocks, containers, events, checkpoints, request, run, controller, getState, getBlock, crafting, items, dependencies }
}

function shiftFloor (f, dy) {
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
    if (x === 0 && z === 0) continue // Preserve the bot's received current footing.
    for (let offset = 0; offset < Math.abs(dy); offset++) f.blocks.set(key({ x, y: dy > 0 ? 65 + offset : 64 - offset, z }), { known: true, name: dy > 0 ? 'minecraft:stone' : 'minecraft:air', runtimeId: dy > 0 ? 1 : 0, boundingBox: dy > 0 ? 'block' : 'empty', extra: [] })
  }
}

test('storage chooses an observed reachable upper or lower ledge when the current layer has no footprint', async () => {
  for (const dy of [1, -1, 2, -2]) for (const kind of ['shulker', 'double_chest']) {
    const previews = []
    const f = fixture(kind, { previewMove: stand => { previews.push(copy(stand)); return { ready: true } } })
    shiftFloor(f, dy)
    const result = await f.run()
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.checkpoint.stand.y, 65 + dy)
    assert.ok(result.checkpoint.positions.every(position => position.y === result.checkpoint.stand.y))
    assert.deepEqual(previews, [result.checkpoint.stand], 'preview only runs after finding valid geometry')
    assert.deepEqual(f.events.find(event => event.type === 'move').position, result.checkpoint.stand)
  }
})

test('storage prefers the current footing and skips unreachable standing cells without moving to them', async () => {
  for (const firstReady of [true, false]) {
    const previews = []
    const f = fixture('single_chest', { previewMove: stand => { previews.push(copy(stand)); return { ready: firstReady || previews.length > 1 } } })
    const result = await f.run()
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.deepEqual(previews[0], { x: 0, y: 65, z: 0 })
    assert.equal(previews.length, firstReady ? 1 : 2)
    assert.deepEqual(result.checkpoint.stand, previews.at(-1))
    assert.equal(f.events.filter(event => event.type === 'move').length, firstReady ? 0 : 1)
    if (!firstReady) assert.deepEqual(f.events.find(event => event.type === 'move').position, previews[1])
  }
  const previews = [], blocked = fixture('single_chest', { previewMove: stand => { previews.push(key(stand)); return { ready: false } } })
  const result = await blocked.run()
  assert.equal(result.reason, 'STORAGE_SITE_UNOBSERVED')
  assert.equal(new Set(previews).size, previews.length, 'unreachable stands are previewed only once')
  assert.equal(blocked.events.length, 0)
})

test('unknown one- and two-level ledge support or headroom is rejected before preview or any mutation', async () => {
  for (const [dy, unknownY] of [[1, 65], [1, 67], [2, 66], [2, 68], [-2, 62], [-2, 64]]) {
    let previews = 0
    const f = fixture('shulker', { previewMove: () => { previews++; return { ready: true } } })
    shiftFloor(f, dy)
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
      if (x === 0 && z === 0) continue
      f.blocks.set(key({ x, y: unknownY, z }), { known: false })
    }
    const result = await f.run()
    assert.equal(result.reason, 'STORAGE_SITE_UNOBSERVED', JSON.stringify(result))
    assert.equal(previews, 0)
    assert.equal(f.events.length, 0)
  }
})

test('a ledge two levels above or below is never adopted without a ready movement route', async () => {
  for (const dy of [2, -2]) {
    const previews = []
    const f = fixture('shulker', { previewMove: stand => { previews.push(copy(stand)); return { ready: false, reason: 'NO_PATH' } } })
    shiftFloor(f, dy)
    const result = await f.run()
    assert.equal(result.reason, 'STORAGE_SITE_UNOBSERVED', JSON.stringify(result))
    assert.ok(previews.length > 0)
    assert.ok(previews.every(stand => stand.y === 65 + dy))
    assert.equal(f.events.length, 0)
  }
})

test('single and double carried chests require their exact fresh size, cap deposits and remain in the world', async () => {
  for (const kind of ['single_chest', 'double_chest']) {
    const f = fixture(kind), result = await f.run()
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.serverConfirmed, true)
    assert.deepEqual(result.deposited, [{ name: 'minecraft:dirt', count: 8 }])
    assert.equal(f.events.filter(e => e.type === 'place').length, kind === 'double_chest' ? 2 : 1)
    assert.equal(f.events.find(e => e.type === 'open').expectedSlots, kind === 'double_chest' ? 54 : 27)
    assert.equal(result.storage[0].slotCount, kind === 'double_chest' ? 54 : 27)
    assert.equal(f.events.some(e => e.type === 'mine'), false)
    assert.ok(result.checkpoint.placed.every(p => f.getBlock(p.position.x, p.position.y, p.position.z).name === 'minecraft:chest'))
    assert.equal(f.items().find(i => i.name === 'minecraft:dirt').count, 8, 'equip moved the deposit stack, but its identity and requested limit were retained')
    assert.ok(f.checkpoints.some(cp => cp.intent?.type === 'place')); assert.ok(f.checkpoints.some(cp => cp.intent?.type === 'deposit'))
  }
})

test('shulker recovery needs received air and a new inventory box with all27 content slots matching', async () => {
  const f = fixture('shulker', { pickupOnMove: true }), result = await f.run()
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.recovered, true)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  assert.ok(f.events.some(e => e.type === 'move'))
  assert.equal(f.getBlock(...['x', 'y', 'z'].map(axis => result.checkpoint.positions[0][axis])).name, 'minecraft:air')
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
  assert.deepEqual(result.deposited, [{ name: 'minecraft:dirt', count: 8 }])
  assert.equal(f.controller.ownsShulker(f.getState(), f.events.find(e => e.type === 'mine').target, { known: true, name: 'minecraft:air' }), false, 'the completed action no longer authorizes mining')
})

test('a full shulker is recovered with unchanged contents and its new carried key is exhausted', async () => {
  const f = fixture('shulker', { full: true }), result = await f.run()
  assert.equal(result.status, 'full', JSON.stringify(result)); assert.equal(result.recovered, true); assert.deepEqual(result.deposited, [])
  const box = f.items().find(i => i.name === 'minecraft:undyed_shulker_box')
  assert.deepEqual(result.exhaustedShulkerKeys, [carriedContainerKey(box)])
  assert.notEqual(result.exhaustedShulkerKeys[0], f.request.selection.key)
})

test('unknown placement, wrong double size, missing spend and rejected transfers fail without mining a container', async () => {
  for (const options of [{ unknownWorld: true }, { wrongSize: 27 }, { missingSpend: true }, { rejectDeposit: true }, { unknownContents: true }]) {
    const f = fixture('double_chest', options), result = await f.run()
    assert.equal(result.status, 'blocked', JSON.stringify({ options, result })); assert.equal(result.serverConfirmed, false)
    assert.equal(f.events.some(e => e.type === 'mine'), false)
    if (options.unknownWorld) assert.equal(f.events.length, 0)
    if (options.wrongSize || options.missingSpend || options.unknownContents) assert.equal(f.events.some(e => e.type === 'deposit'), false)
  }
})

test('unknown or wrong recovered contents, absent inventory gain and reused stack IDs never count as pickup', async () => {
  for (const options of [{ wrongContents: true }, { missingNBT: true }, { noPickup: true }, { reusedStackId: 80 }]) {
    const f = fixture('shulker', options)
    if (options.reusedStackId) f.bag[25] = item(2, 1, 80)
    const result = await f.run()
    assert.equal(result.status, 'blocked', JSON.stringify({ options, result })); assert.equal(result.recovered, false)
    assert.equal(result.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
    assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
  }
})

test('a confirmed placed checkpoint resumes without another placement, while foreign replacement and changed life are refused', async () => {
  for (const change of ['resume', 'foreign', 'life']) {
    const f = fixture('single_chest'), abort = new AbortController()
    const paused = await f.run({ signal: abort.signal, onCheckpoint: async cp => { if (cp.stage === 'placed') abort.abort() } })
    assert.equal(paused.status, 'blocked'); assert.equal(paused.checkpoint.placed.length, 1)
    const request = { ...f.request, checkpoint: paused.checkpoint }
    if (change === 'foreign') f.blocks.get(key(paused.checkpoint.positions[0])).runtimeId++
    if (change === 'life') f.state.lifecycle.deathId++
    const result = await f.run({}, request)
    assert.equal(result.status, change === 'resume' ? 'completed' : 'blocked', JSON.stringify(result))
    if (change === 'life') assert.equal(result.reason, 'STORAGE_SCOPE_CHANGED')
    assert.equal(f.events.filter(e => e.type === 'place').length, 1)
    assert.equal(f.events.some(e => e.type === 'mine'), false)
  }
})

test('a saved unconfirmed place intent never adopts an existing block or repeats its item spend', async () => {
  const f = fixture('shulker', { missingSpend: true }), first = await f.run()
  assert.equal(first.status, 'blocked'); assert.equal(first.checkpoint.intent.type, 'place')
  const result = await f.run({}, { ...f.request, checkpoint: first.checkpoint })
  assert.equal(result.reason, 'STORAGE_ACTION_UNCONFIRMED')
  assert.equal(f.events.filter(e => e.type === 'place').length, 1); assert.equal(f.events.some(e => e.type === 'mine'), false)
})

test('persistence failure and abort before dispatch stop the next mutation; abort also ends an unresponsive equip', async () => {
  const persistence = fixture('single_chest')
  const failed = await persistence.run({ onCheckpoint: async cp => { if (cp.intent?.type === 'place') throw new Error('disk unavailable') } })
  assert.equal(failed.reason, 'STORAGE_PERSISTENCE_FAILED'); assert.equal(persistence.events.some(e => e.type === 'place'), false)
  const aborted = fixture('single_chest'), signal = new AbortController()
  const stopped = await aborted.run({ signal: signal.signal, onCheckpoint: async cp => { if (cp.intent?.type === 'place') signal.abort() } })
  assert.equal(stopped.reason, 'STORAGE_ABORTED'); assert.equal(aborted.events.some(e => e.type === 'place'), false)
  const hanging = fixture('single_chest', { hangEquip: true }), interrupt = new AbortController(), task = hanging.run({ signal: interrupt.signal })
  while (!hanging.events.some(e => e.type === 'equip')) await turn()
  interrupt.abort()
  assert.equal((await task).reason, 'STORAGE_ABORTED')
  assert.ok(hanging.events.some(e => e.type === 'cancel' && e.kind === 'equip')); assert.equal(hanging.events.some(e => e.type === 'place'), false)
})

test('a checkpoint after received air can finish from a later observed NBT update without breaking again', async () => {
  const f = fixture('shulker', { missingNBT: true }), first = await f.run()
  assert.equal(first.checkpoint.stage, 'awaiting_recovery'); assert.equal(first.recovered, false)
  const box = f.items().find(i => i.name === 'minecraft:undyed_shulker_box')
  f.bag[box.slot] = carriedBox(f.containers.get(key(first.checkpoint.positions[0])), box.stackId)
  const result = await f.run({}, { ...f.request, checkpoint: first.checkpoint })
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.recovered, true)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
})

test('a short-grass stand accepted by site planning is also accepted when the placed shulker is recovered', async () => {
  const f = fixture('shulker')
  const feet = { x: Math.floor(f.state.position.x), y: Math.floor(f.state.position.y - 1.62 + 1e-3), z: Math.floor(f.state.position.z) }
  f.blocks.set(key(feet), { known: true, name: 'minecraft:short_grass', runtimeId: 900, boundingBox: 'empty', extra: [] })
  const result = await f.run()
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.recovered, true)
  assert.equal(f.getBlock(feet.x, feet.y, feet.z).name, 'minecraft:short_grass', 'the plant under the feet is never mined')
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
})

test('nearby loose drops that merge into existing plain stacks do not block recovering the box; new kinds still need a slot', async () => {
  for (const kind of ['dirt', 'grass']) {
    const drops = [0, 1, 2].map(i => ({ kind: 'item', alive: true, dimension: 'overworld', positionKnown: true, position: { x: 1.5, y: 65, z: 0.5 + i * 0.2 }, count: 1, runtimeId: String(500 + i), uniqueId: String(-500 - i), networkId: kind === 'dirt' ? 3 : 5, name: kind === 'dirt' ? 'minecraft:dirt' : 'minecraft:grass_block' }))
    const f = fixture('shulker', { entities: () => copy(drops) })
    for (let slot = 1; slot < 36; slot++) if (slot !== 14) f.bag[slot] = item(4, 64, 1000 + slot) // a full inventory: only the box slot frees up
    const result = await f.run()
    if (kind === 'dirt') {
      assert.equal(result.status, 'completed', JSON.stringify(result.details ?? result.reason)); assert.equal(result.recovered, true)
    } else {
      assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
      assert.equal(f.events.some(e => e.type === 'mine'), false, 'the box is not broken without room')
    }
  }
})

test('a storage stand with fewer loose drops in pickup reach is preferred over the nearest one', async () => {
  const drops = [0, 1, 2].map(i => ({ kind: 'item', alive: true, dimension: 'overworld', positionKnown: true, position: { x: -2.5, y: 65, z: 0.5 + i * 0.3 }, count: 1, runtimeId: String(600 + i), uniqueId: String(-600 - i), networkId: 5, name: 'minecraft:grass_block' }))
  const plain = await fixture('shulker').run()
  assert.equal(plain.status, 'completed'); assert.deepEqual(plain.checkpoint.stand, { x: 0, y: 65, z: 0 }, 'without drops the current footing is kept')
  const f = fixture('shulker', { entities: () => copy(drops) }), result = await f.run()
  assert.equal(result.status, 'completed', JSON.stringify(result.reason))
  const s = result.checkpoint.stand
  assert.ok(Math.hypot(-2.5 - s.x - 0.5, 0.8 - s.z - 0.5) > 3.5, JSON.stringify(s))
  assert.ok(f.events.some(e => e.type === 'move'))
})

test('a planned deposit whose surplus disappeared is closed at zero and the box is still recovered', async () => {
  const f = fixture('shulker')
  const input = { ...f.request, inventoryPolicy: { keepSealBlocks: 0, keepExitDirt: 8 } }
  let changed = false
  const result = await f.run({ onCheckpoint: async cp => { if (!changed && cp.plan?.length && cp.opened && !cp.deposited.length) { changed = true; const d = f.bag.findIndex(r => r.network_id === 3); f.bag[d] = { ...f.bag[d], count: 8, stack_id: 9999 } } } }, input)
  assert.equal(changed, true)
  assert.equal(result.status, 'completed', JSON.stringify(result.reason)); assert.equal(result.recovered, true)
  assert.deepEqual(result.deposited, [])
  assert.equal(f.events.filter(e => e.type === 'deposit').length, 0)
  assert.equal(f.bag.find(r => r.network_id === 3).count, 8, 'the kept dirt never moves')
})

test('drops without a known numeric network id, or without room in an existing stack, need their own slot', async () => {
  // An unknown id, and stone whose existing stacks are all full.
  for (const bad of [{ networkId: undefined }, { networkId: 4, name: 'minecraft:stone' }]) {
    const drops = [{ kind: 'item', alive: true, dimension: 'overworld', positionKnown: true, position: { x: 1.5, y: 65, z: 0.5 }, count: 1, runtimeId: '700', uniqueId: '-700', networkId: 3, name: 'minecraft:dirt', ...bad }]
    const f = fixture('shulker', { entities: () => copy(drops) })
    for (let slot = 1; slot < 36; slot++) if (slot !== 14) f.bag[slot] = item(4, 64, 1000 + slot)
    const result = await f.run()
    assert.equal(result.status, 'blocked', JSON.stringify(bad)); assert.equal(result.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
    assert.equal(f.events.some(e => e.type === 'mine'), false)
  }
})

test('live case 2026-11-11: a cow on the box cell before placement is waited out; one that stays is recorded and refused', async () => {
  for (const [stays, expected] of [[3, 'completed'], [20, 'blocked']]) {
    let f = null, cowCalls = 0
    f = fixture('shulker', { pickupOnMove: true, entities: () => {
      const cp = f?.checkpoints.at(-1)
      if (cp?.positions?.length && !(cp.placed ?? []).length && cowCalls < stays) {
        cowCalls++
        const p = cp.positions[0]
        return [{ kind: 'mob', name: 'minecraft:cow', runtimeId: '99', alive: true, positionKnown: true, position: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 } }]
      }
      return []
    } })
    const result = await f.run()
    assert.equal(result.status, expected, JSON.stringify(result.reason))
    if (expected === 'blocked') {
      assert.equal(result.reason, 'STORAGE_SITE_CHANGED')
      assert.match(result.checkpoint.siteIssue.cause, /^ENTIT/)
      assert.equal(result.checkpoint.placed.length, 0, 'nothing was placed')
    } else assert.ok(result.checkpoint.siteWaits.some(w => w.mobOverlap), 'the wait for the mob was recorded')
  }
})

test('live case 2026-11-12: a box cell with a live mob next to it is passed over for another site', async () => {
  const base = fixture('shulker', { pickupOnMove: true }), plain = await base.run()
  assert.equal(plain.status, 'completed', JSON.stringify(plain.reason))
  const chosen = plain.checkpoint.positions[0]
  let mobs = [{ kind: 'mob', name: 'minecraft:chicken', runtimeId: '77', alive: true, positionKnown: true, position: { x: chosen.x + 0.5, y: chosen.y, z: chosen.z - 0.6 } }]
  const f = fixture('shulker', { pickupOnMove: true, entities: () => mobs })
  const result = await f.run()
  assert.equal(result.status, 'completed', JSON.stringify(result.reason))
  const next = result.checkpoint.positions[0]
  assert.ok(Math.hypot(next.x + 0.5 - mobs[0].position.x, next.z + 0.5 - mobs[0].position.z) > 1.5, 'the chosen cell is away from the chicken')
})
