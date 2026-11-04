'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createForaging } = require('../src/foraging')

const animal = (type, x, id = '2') => ({ runtimeId: id, kind: 'mob', entityType: `minecraft:${type}`, dimension: 'overworld', positionKnown: true, alive: true, hostile: false, position: { x, y: 65, z: 0.5 } })
const drop = (x, id = '3') => ({ runtimeId: id, kind: 'item', name: 'minecraft:porkchop', count: 1, dimension: 'overworld', positionKnown: true, alive: true, position: { x, y: 65.125, z: 0.5 } })

test('learning chicken foraging keeps unknown age explicit and only actual raw-chicken inventory gain completes it', async () => {
  const chicken = { ...animal('chicken', 1.5), uniqueId: '-200' }
  const f = fixture({ initialActors: [chicken], onHunt: ({ state, id }) => { state.inventory.items = [{ slot: 2, name: 'minecraft:chicken', count: 1 }]; return { phase: 'observed', targetRuntimeId: id, reaction: 'death_animation' } } })
  assert.equal(f.foraging.preview().ready, false)
  f.state.threatPolicy = 'online_learning'
  const preview = f.foraging.preview()
  assert.equal(preview.ready, true); assert.deepEqual(preview.target.yieldRisk, { foodYieldConfirmed: false, age: 'unknown' })
  const result = await f.foraging.execute({ targetRuntimeId: '2' })
  assert.equal(result.collected, true); assert.equal(result.foodGained, 1); assert.equal(result.confirmedBy, 'server_inventory')
  for (const change of [{ baby: true }, { isBaby: true }, { owned: true }, { ownerUniqueId: '-9' }, { customName: 'Pet' }, { nameTag: 'Pet' }, { protected: true }, { kind: 'player' }]) {
    const blocked = fixture({ initialActors: [{ ...chicken, ...change }] }); blocked.state.threatPolicy = 'online_learning'
    assert.equal(blocked.foraging.preview().ready, false, JSON.stringify(change))
  }
  const noYield = fixture({ initialActors: [chicken], onHunt: ({ list, id }) => { list.find(actor => actor.runtimeId === id).alive = false; return { phase: 'observed', targetRuntimeId: id, reaction: 'death_animation' } } })
  noYield.state.threatPolicy = 'online_learning'
  const empty = await noYield.foraging.execute({ targetRuntimeId: '2' })
  assert.equal(empty.collected, false); assert.equal(empty.foodGained, 0); assert.equal(empty.serverConfirmed, false)
})

function fixture ({ initialActors = [animal('pig', 50.5)], worldOverride, onMove, onHunt, onDelay, onMovementRead, onPreview } = {}) {
  let time = 1000
  const state = { phase: 'spawned', runtimeEntityId: '1', dimension: 'overworld', connectionId: 'fixture', startedAt: 'start', gameMode: 'survival', health: 3.43, position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, inventory: { known: true, items: [] } }
  state.rawServerPosition = { ...state.position }
  state.rawServerPositionUpdatedAt = time
  const list = structuredClone(initialActors)
  const world = { getBlock: (x, y, z) => worldOverride?.(x, y, z) ?? { known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', extra: [] } }
  let movementState = { phase: 'idle' }
  const moves = []; const previews = []; const hunts = []; const progress = []
  let movementStops = 0; let combatStops = 0
  const addFood = count => { state.inventory.items = [{ slot: 2, name: 'minecraft:porkchop', count }] }
  const movement = {
    preview: (target, options) => { previews.push({ target: structuredClone(target), options: { ...options } }); return onPreview?.({ state, list, target, options, previews }) ?? { ready: true } },
    start: (target, options) => {
      moves.push({ target: structuredClone(target), options: { ...options } })
      movementState = { phase: 'moving' }
      const handled = onMove?.({ state, list, target, options, addFood, setMovement: value => { movementState = value } })
      if (handled) return handled
      state.position = { ...target, y: target.y + 1.62 }; state.positionSource = 'client_prediction'; movementState = { phase: 'awaiting_server_confirmation', predictedPosition: { ...state.position }, onGround: true }
      return movementState
    },
    stop: () => { movementStops++; movementState = { phase: 'stopped' } }
  }
  const combat = {
    previewHunt: id => { const target = list.find(entity => entity.runtimeId === id); return { ready: !!target && target.kind === 'mob' && Math.hypot(target.position.x - state.position.x, target.position.y - state.position.y, target.position.z - state.position.z) <= 2.8, cooldownRemainingMs: 0 } },
    hunt: async id => { hunts.push(id); return await onHunt?.({ state, list, id, addFood }) ?? { phase: 'observed', targetRuntimeId: id, reaction: 'hurt_animation' } },
    cancel: () => { combatStops++ }
  }
  const foraging = createForaging({ getState: () => ({ ...state, entities: structuredClone(list) }), world, entities: { snapshot: () => structuredClone(list) }, movement, getMovement: () => { onMovementRead?.({ state, setMovement: value => { movementState = value } }); return structuredClone(movementState) }, combat, onProgress: value => progress.push(value), clock: () => time, delay: async ms => { time += ms; await onDelay?.({ state, list, addFood, time }) } })
  return { state, list, foraging, moves, previews, hunts, progress, addFood, advance: ms => { time += ms }, time: () => time, stops: () => ({ movementStops, combatStops }) }
}

test('known food drops take priority and only an actual inventory increase completes recovery', async () => {
  const f = fixture({ initialActors: [animal('pig', 2.5), drop(1.57)], onMove: ({ addFood }) => { addFood(1) } })
  assert.equal(f.foraging.preview().kind, 'drop')
  assert.equal(f.foraging.preview().target.runtimeId, '3')
  const result = await f.foraging.execute()
  assert.equal(f.hunts.length, 0)
  assert.equal(f.moves.length, 1)
  assert.equal(result.phase, 'completed')
  assert.equal(result.foodGained, 1)
  assert.equal(result.collected, true)
  assert.equal(result.confirmedBy, 'server_inventory')
  assert.equal(result.busy, false)
  assert.equal(f.foraging.snapshot().busy, false)
  assert.ok(f.moves.every(move => move.options.emergency === true && move.options.allowWater === false && move.options.maxDistance === 12))
})

test('known empty-box torches remain passable food pickup stances without pretending they are air', async () => {
  const torch = { known: true, name: 'minecraft:torch', boundingBox: 'empty', properties: { torch_facing_direction: 'top' }, extra: [] }
  const f = fixture({ initialActors: [drop(1.57)], worldOverride: (x, y, z) => y === 65 ? torch : undefined, onMove: ({ addFood }) => { addFood(1) } })
  const result = await f.foraging.execute()
  assert.equal(result.collected, true)
  assert.equal(result.foodGained, 1)
  assert.equal(f.moves.length, 1)
  assert.equal(torch.name, 'minecraft:torch')
  for (const change of [{ known: false }, { boundingBox: 'block' }, { extra: [{ name: 'minecraft:water' }] }, { name: 'minecraft:redstone_torch' }]) {
    const blocked = fixture({ initialActors: [drop(1.57)], worldOverride: (x, y, z) => y === 65 ? { ...torch, ...change } : undefined })
    const stopped = await blocked.foraging.execute()
    assert.equal(blocked.moves.length, 0, JSON.stringify(change))
    assert.equal(stopped.collected, false)
    assert.equal(stopped.serverConfirmed, false)
  }
})

test('received empty-box leaf litter permits a supported correction; unknown or solid litter does not', async () => {
  for (const [variant, expected] of [[{}, true], [{ known: false }, false], [{ boundingBox: 'block' }, false], [{ extra: [{ name: 'minecraft:water' }] }, false]]) {
    let starts = 0
    const litter = { known: true, name: 'minecraft:leaf_litter', boundingBox: 'empty', extra: [], ...variant }
    const f = fixture({ initialActors: [animal('pig', 6.5)], worldOverride: (x, y, z) => x === 0 && y === 65 && z === 0 ? litter : undefined, onMove: context => ++starts === 1 ? correction(context) : undefined })
    const result = await f.foraging.execute({ maxSteps: 2, maxHits: 0 })
    assert.equal(result.correctionRetries, expected ? 1 : 0, JSON.stringify(variant))
    assert.equal(result.collected, false)
  }
})

test('a disappearing item or a finished predicted walk never invents acquired food', async () => {
  const f = fixture({ initialActors: [drop(2.5)], onMove: ({ list }) => { list.splice(0) } })
  const result = await f.foraging.execute()
  assert.equal(result.phase, 'predicted')
  assert.equal(result.foodGained, 0)
  assert.equal(result.collected, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.state.inventory.items.length, 0)
})

test('a pig fifty blocks away is approached through at most three known land relays, then returned as predicted progress', async () => {
  const f = fixture()
  const result = await f.foraging.execute()
  assert.equal(f.moves.length, 3)
  let before = { x: 0.5, z: 0.5 }
  for (const move of f.moves) {
    assert.ok(Math.hypot(move.target.x - before.x, move.target.z - before.z) <= 12)
    assert.equal(move.options.emergency, true)
    assert.equal(move.options.allowWater, false)
    before = move.target
  }
  assert.ok(f.state.position.x > 25 && f.state.position.x < 35)
  assert.equal(result.phase, 'predicted')
  assert.equal(result.steps, 3)
  assert.equal(result.hits, 0)
  assert.equal(result.collected, false)
})

test('the latest prey identity and pose are read again after every observed hit and the batch never exceeds three hits', async () => {
  const f = fixture({ initialActors: [animal('cow', 1.5)], onHunt: ({ list, id }) => { list.find(entity => entity.runtimeId === id).position.x += 3; return { phase: 'observed', reaction: 'hurt_animation' } } })
  const result = await f.foraging.execute()
  assert.equal(f.hunts.length, 3)
  assert.ok(f.hunts.every(id => id === '2'))
  assert.ok(f.moves.length <= 3)
  assert.ok(f.state.position.x > 3)
  assert.equal(result.collected, false)
  assert.equal(result.hits, 3)
})

test('nearby hostiles, unknown actor positions, dead sessions and player/NPC/protected animals cannot start hunting', async () => {
  for (const extra of [animal('skeleton', 4.5, '9'), { ...animal('pig', 2, '9'), position: null, positionKnown: false }]) {
    const f = fixture({ initialActors: [animal('cow', 1.5), extra] })
    assert.equal(f.foraging.preview().ready, false)
    await assert.rejects(f.foraging.execute())
    assert.equal(f.moves.length, 0); assert.equal(f.hunts.length, 0)
  }
  for (const prey of [{ ...animal('cow', 1.5), kind: 'player' }, { ...animal('pig', 1.5), isNpc: true }, { ...animal('sheep', 1.5), protected: true }, { ...animal('pig', 1.5), natural: false }, { ...animal('cow', 1.5), ownerId: '5' }]) {
    const f = fixture({ initialActors: [prey] })
    assert.equal(f.foraging.preview().ready, false)
    const result = await f.foraging.execute()
    assert.equal(result.collected, false)
    assert.equal(f.hunts.length, 0)
  }
  const dead = fixture()
  dead.state.health = 0
  await assert.rejects(dead.foraging.execute(), error => error.code === 'NOT_ALIVE')
})

test('death, selected-slot changes and dimension changes during owned movement stop both controllers', async () => {
  for (const mutate of [state => { state.health = 0 }, state => { state.rawSelectedSlot = 1 }, state => { state.dimension = 'nether' }, state => { state.connectionId = 'another' }]) {
    const f = fixture({ onMove: ({ state }) => { mutate(state) } })
    await assert.rejects(f.foraging.execute())
    assert.equal(f.hunts.length, 0)
    assert.equal(f.foraging.snapshot().busy, false)
    assert.ok(f.stops().movementStops >= 1)
    assert.ok(f.stops().combatStops >= 1)
  }
})

test('unconfirmed hunting cools down that specific animal instead of sticking to it indefinitely', async () => {
  const f = fixture({ initialActors: [animal('cow', 1.5), animal('pig', 2.5, '3')], onHunt: () => ({ phase: 'requested', reaction: 'unconfirmed' }) })
  const result = await f.foraging.execute()
  assert.equal(result.hits, 1)
  assert.equal(result.collected, false)
  assert.equal(f.foraging.preview().target.runtimeId, '3')
  assert.equal(f.foraging.snapshot().excludedTargets[0].runtimeId, '2')
})

test('unknown, water or unsafe footing never produces a blind relay and the no-action preview is passive', async () => {
  for (const worldOverride of [() => ({ known: false }), (x, y) => ({ known: true, name: y < 65 ? 'minecraft:water' : 'minecraft:air', boundingBox: 'empty', extra: [] })]) {
    const f = fixture({ worldOverride })
    const before = structuredClone(f.state)
    assert.equal(f.foraging.preview().ready, true)
    assert.equal(f.moves.length, 0)
    const result = await f.foraging.execute()
    assert.equal(result.collected, false)
    assert.equal(f.moves.length, 0)
    assert.equal(f.previews.length, 0)
    assert.deepEqual(f.state, before)
  }
})

test('a hung movement is bounded by the real batch timeout and existing food is returned to eating without hunting', async () => {
  const hung = fixture({ onMove: () => new Promise(() => {}) })
  await assert.rejects(hung.foraging.execute({ timeoutMs: 100 }), error => error.code === 'TIMEOUT')
  assert.equal(hung.foraging.snapshot().busy, false)
  assert.ok(hung.stops().movementStops >= 1)
  const available = fixture()
  available.addFood(1)
  assert.equal(available.foraging.preview().recommendation, 'eat')
  const result = await available.foraging.execute()
  assert.equal(result.phase, 'observed')
  assert.equal(result.foodAvailable, true)
  assert.equal(result.foodGained, 0)
  assert.equal(available.moves.length, 0)
  await assert.rejects(available.foraging.execute({ maxSteps: 4 }), error => error.code === 'INVALID_LIMIT')
})

test('an observed hunt can lead to a newly received drop, but completion waits until the subsequent actual pickup', async () => {
  const f = fixture({ initialActors: [animal('pig', 1.5)], onHunt: ({ list }) => { list.splice(0, list.length, drop(1.5)); return { phase: 'observed', reaction: 'target_removed' } }, onMove: ({ addFood }) => { addFood(1) } })
  const result = await f.foraging.execute()
  assert.deepEqual(f.hunts, ['2'])
  assert.equal(f.moves.length, 1)
  assert.equal(result.phase, 'completed')
  assert.equal(result.foodGained, 1)
  assert.equal(result.confirmedBy, 'server_inventory')
})

test('a repeatedly reacting animal still has a cumulative hit budget across batches', async () => {
  const f = fixture({ initialActors: [animal('cow', 1.5)] })
  for (let batch = 0; batch < 4; batch++) {
    const result = await f.foraging.execute()
    assert.equal(result.collected, false)
    assert.ok(result.hits <= 3)
  }
  assert.equal(f.hunts.length, 12)
  assert.equal(f.foraging.preview().code, 'NO_KNOWN_FOOD_SOURCE')
  assert.equal(f.foraging.snapshot().excludedTargets[0].reason, 'target_hit_budget')
})

test('an inventory with no food and no collection capacity refuses hunting before spending a hit', async () => {
  const f = fixture({ initialActors: [animal('cow', 1.5)] })
  f.state.inventory.items = Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'minecraft:stone', count: 64 }))
  assert.equal(f.foraging.preview().code, 'INVENTORY_FULL')
  await assert.rejects(f.foraging.execute(), error => error.code === 'INVENTORY_FULL')
  assert.equal(f.hunts.length, 0)
  assert.equal(f.moves.length, 0)
})

function correction ({ state, setMovement }, advance = 0.1) {
  state.position = { ...state.position, x: state.position.x + advance }
  state.positionSource = 'correct_player_move_prediction'
  state.rawServerPosition = { ...state.position }
  state.rawServerPositionUpdatedAt++
  state.predicted = null
  setMovement({ phase: 'replan_required', lastAuthoritativePosition: { ...state.position } })
  return { phase: 'replan_required' }
}

test('a small fresh supported server correction retries the same candidate with a new preview and counts both starts', async () => {
  let starts = 0
  const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => ++starts === 1 ? correction(context) : undefined })
  const result = await f.foraging.execute({ maxSteps: 2, maxHits: 0 })
  assert.equal(f.moves.length, 2)
  assert.equal(f.previews.length, 2)
  assert.deepEqual(f.moves[0].target, f.moves[1].target)
  assert.equal(result.steps, 2)
  assert.equal(result.correctionRetries, 1)
  assert.deepEqual(result.excludedTargets, [])
  assert.equal(result.collected, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.state.inventory.items, [])
  assert.equal(f.progress.some(event => event.phase === 'replanning'), true)
})

test('three fresh initial corrections exhaust the original move budget without rejecting the food source or claiming arrival', async () => {
  const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => correction(context) })
  const result = await f.foraging.execute()
  assert.equal(result.steps, 3)
  assert.equal(result.correctionRetries, 3)
  assert.equal(f.moves.length, 3)
  assert.equal(f.previews.length, 3)
  assert.equal(result.hits, 0)
  assert.equal(result.collected, false)
  assert.match(result.reason, /次のbatch/)
  assert.deepEqual(result.excludedTargets, [])
  assert.equal(f.foraging.preview().ready, true)
})

test('a movement snapshot correction is judged against the fresh state read after that snapshot', async () => {
  let starts = 0; let reads = 0
  const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: () => ++starts === 1 ? { phase: 'moving' } : undefined, onMovementRead: context => { if (++reads === 1) correction(context) } })
  const result = await f.foraging.execute({ maxSteps: 2, maxHits: 0 })
  assert.equal(result.steps, 2)
  assert.equal(result.correctionRetries, 1)
  assert.deepEqual(result.excludedTargets, [])
})

test('a fresh correction may settle briefly before a bounded replan', async () => {
  let starts = 0
  const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => {
    if (++starts !== 1) return
    const result = correction(context); context.state.predicted = { physicsState: { onGround: false } }; return result
  }, onDelay: ({ state, time }) => { if (time >= 1150) state.predicted.physicsState.onGround = true } })
  const result = await f.foraging.execute({ maxSteps: 2, maxHits: 0 })
  assert.equal(f.moves.length, 2)
  assert.equal(result.correctionRetries, 1)
  assert.equal(result.serverConfirmed, false)
})

test('an enemy appearing while waiting for a correction stops the replan', async () => {
  const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => {
    const result = correction(context); context.state.predicted = { physicsState: { onGround: false } }; return result
  }, onDelay: ({ list }) => { list.push({ ...animal('zombie', 2, '9'), hostile: true }) } })
  await assert.rejects(f.foraging.execute(), error => error.code === 'NEARBY_THREAT')
  assert.equal(f.moves.length, 1)
  assert.equal(f.hunts.length, 0)
})

test('unchanged, stale and client-only correction evidence cannot authorize a controller retry', async () => {
  for (const mode of ['unchanged', 'stale', 'client_only']) {
    const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => {
      const stamp = context.state.rawServerPositionUpdatedAt
      const result = correction(context)
      if (mode === 'unchanged') context.state.rawServerPositionUpdatedAt = stamp
      if (mode === 'stale') context.state.rawServerPositionUpdatedAt = stamp - 1
      if (mode === 'client_only') { context.state.positionSource = 'client_prediction'; context.state.rawServerPositionUpdatedAt = stamp }
      return result
    } })
    const result = await f.foraging.execute()
    assert.equal(f.moves.length, 1)
    assert.equal(result.excludedTargets[0].reason, 'NO_MOVEMENT_PROGRESS')
    assert.equal(result.correctionEvidence.fresh, false, mode)
    assert.equal(result.correctionEvidence.ready, false, mode)
    assert.equal(result.collected, false)
  }
})

test('new unknown support, water, airborne physics or a rejected live preview stop correction retries', async () => {
  for (const mode of ['unknown', 'water', 'airborne', 'preview']) {
    let corrected = false
    const f = fixture({ initialActors: [animal('pig', 6.5)], worldOverride: (x, y, z) => corrected && x === 0 && y === 64 && z === 0 && mode !== 'preview' && mode !== 'airborne' ? mode === 'unknown' ? { known: false } : { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] } : undefined, onMove: context => {
      const result = correction(context); corrected = true
      if (mode === 'airborne') context.state.predicted = { physicsState: { onGround: false } }
      return result
    }, onPreview: ({ previews }) => mode === 'preview' && previews.length > 1 ? { ready: false, reason: 'route changed' } : undefined })
    const result = await f.foraging.execute()
    assert.equal(f.moves.length, 1)
    assert.equal(result.collected, false)
    assert.equal(f.hunts.length, 0)
    if (mode === 'airborne') assert.equal(result.correctionEvidence.workingSupported, false)
  }
})

test('correction retries keep the batch deadline and stop on damage, session changes or cancellation', async () => {
  const deadline = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => { const result = correction(context); deadline.advance(60); return result } })
  await assert.rejects(deadline.foraging.execute({ timeoutMs: 100 }), error => error.code === 'TIMEOUT')
  assert.equal(deadline.moves.length, 2)
  assert.equal(deadline.foraging.snapshot().busy, false)
  for (const [mutate, code] of [
    [state => { state.health -= 0.1 }, 'TOOK_DAMAGE'],
    [state => { state.connectionId = 'different' }, 'SESSION_CHANGED']
  ]) {
    const f = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => { const result = correction(context); mutate(context.state); return result } })
    await assert.rejects(f.foraging.execute(), error => error.code === code)
    assert.equal(f.moves.length, 1)
  }
  const controller = new AbortController()
  const aborted = fixture({ initialActors: [animal('pig', 6.5)], onMove: context => { const result = correction(context); controller.abort(new Error('cancel food retry')); return result } })
  await assert.rejects(aborted.foraging.execute({}, { signal: controller.signal }), /cancel food retry/)
  assert.equal(aborted.moves.length, 1)
})


test('an explicit eligible target overrides nearest prey while omitted target preserves the original order', async () => {
  const f = fixture({ initialActors: [animal('pig', 1.5, '2'), animal('cow', 2.5, '3')] })
  assert.equal(f.foraging.preview().target.runtimeId, '2')
  assert.equal(f.foraging.preview({ targetRuntimeId: 3n }).target.runtimeId, '3')
  const result = await f.foraging.execute({ targetRuntimeId: '3', maxSteps: 0, maxHits: 1 })
  assert.deepEqual(f.hunts, ['3'])
  assert.equal(result.requestedTargetRuntimeId, '3')
  assert.equal(result.collected, false)
  assert.deepEqual(f.state.inventory.items, [])
})

test('invalid, unknown and ineligible explicit targets are refused without falling back to another prey', async () => {
  for (const id of [null, -1, '-1', '1.2', true, {}, Number.MAX_SAFE_INTEGER + 1, '18446744073709551616']) {
    const f = fixture({ initialActors: [animal('pig', 1.5)] })
    assert.equal(f.foraging.preview({ targetRuntimeId: id }).code, 'INVALID_TARGET_ID')
    await assert.rejects(f.foraging.execute({ targetRuntimeId: id }), error => error.code === 'INVALID_TARGET_ID')
    assert.equal(f.hunts.length, 0)
  }
  for (const target of [
    animal('cow', 100.5, '3'), { ...animal('cow', 2.5, '3'), dimension: 'nether' },
    { ...animal('cow', 2.5, '3'), protected: true }, { ...animal('cow', 2.5, '3'), owned: true },
    { ...animal('cow', 2.5, '3'), tamed: true }, { ...animal('cow', 2.5, '3'), alive: false },
    { ...animal('cow', 2.5, '3'), isNpc: true }, { ...animal('cow', 2.5, '3'), kind: 'player' },
    { ...animal('cow', 2.5, '3'), positionKnown: false, position: null }
  ]) {
    const f = fixture({ initialActors: [animal('pig', 1.5, '2'), target] })
    assert.equal(f.foraging.preview({ targetRuntimeId: '3' }).ready, false)
    await assert.rejects(f.foraging.execute({ targetRuntimeId: '3' }))
    assert.equal(f.hunts.length, 0)
    assert.equal(f.moves.length, 0)
  }
  const missing = fixture()
  assert.equal(missing.foraging.preview({ targetRuntimeId: '999' }).code, 'FORAGING_TARGET_UNAVAILABLE')
})

test('explicit selection cannot bypass an existing cooldown or a threat interruption', async () => {
  const cooled = fixture({ initialActors: [animal('cow', 1.5, '2')], onHunt: () => ({ phase: 'requested' }) })
  await cooled.foraging.execute({ targetRuntimeId: '2' })
  assert.equal(cooled.foraging.preview({ targetRuntimeId: '2' }).code, 'FORAGING_TARGET_UNAVAILABLE')
  await assert.rejects(cooled.foraging.execute({ targetRuntimeId: '2' }), error => error.code === 'FORAGING_TARGET_UNAVAILABLE')
  const unsafe = fixture({ initialActors: [animal('pig', 20.5, '2'), animal('cow', -25.5, '3'), { ...animal('creeper', 13.5, '9'), hostile: true }] })
  await assert.rejects(unsafe.foraging.execute({ targetRuntimeId: '2' }), error => error.code === 'NEARBY_THREAT')
  assert.equal(unsafe.moves.length, 1)
  assert.equal(unsafe.hunts.length, 0)
})

test('a specified prey disappearing without a death/remove observation never switches prey or claims nearby food', async () => {
  const f = fixture({ initialActors: [animal('pig', 5.5, '2'), animal('cow', 6.5, '3')], onMove: ({ list }) => { list.splice(0, 1, drop(5.5, '8')) } })
  await assert.rejects(f.foraging.execute({ targetRuntimeId: '2' }), error => error.code === 'FORAGING_TARGET_UNAVAILABLE')
  assert.equal(f.moves.length, 1)
  assert.deepEqual(f.hunts, [])
  assert.deepEqual(f.state.inventory.items, [])
  assert.equal(f.foraging.snapshot().collected, false)
})

test('observed death/removal permits only known eligible food drops within eight blocks of the specified prey', async () => {
  for (const reaction of ['death_animation', 'target_removed']) {
    const f = fixture({ initialActors: [animal('pig', 1.5, '2'), animal('cow', 2.5, '3')], onHunt: ({ list, id }) => {
      list.splice(0, 1, drop(1.5, '8'), drop(10.5, '9'), { ...drop(1.6, '10'), protected: true })
      return { phase: 'observed', targetRuntimeId: id, reaction }
    }, onMove: ({ list, addFood }) => { if (list.some(entity => entity.runtimeId === '8')) addFood(1) } })
    const result = await f.foraging.execute({ targetRuntimeId: '2' })
    assert.deepEqual(f.hunts, ['2'])
    assert.equal(result.target.runtimeId, '8')
    assert.equal(result.foodGained, 1)
    assert.equal(result.collected, true)
    assert.equal(result.confirmedBy, 'server_inventory')
  }
  const none = fixture({ initialActors: [animal('pig', 1.5, '2'), animal('cow', 2.5, '3')], onHunt: ({ list, id }) => { list.splice(0, 1, drop(10.5, '9')); return { phase: 'observed', targetRuntimeId: id, reaction: 'target_removed' } } })
  const result = await none.foraging.execute({ targetRuntimeId: '2' })
  assert.deepEqual(none.hunts, ['2'])
  assert.equal(none.moves.length, 0)
  assert.equal(result.collected, false)
  assert.deepEqual(none.state.inventory.items, [])
})

test('same-ID actor replacement stops an explicit selection instead of attacking the replacement', async () => {
  const f = fixture({ initialActors: [{ ...animal('pig', 5.5, '2'), uniqueId: 'original' }], onMove: ({ list }) => { list[0] = { ...animal('pig', 5.5, '2'), uniqueId: 'different' } } })
  await assert.rejects(f.foraging.execute({ targetRuntimeId: '2' }), error => error.code === 'FORAGING_TARGET_CHANGED')
  assert.equal(f.hunts.length, 0)
})

test('explicit prey selection still honors death observed in the current actor snapshot and does not infer inventory', async () => {
  const f = fixture({ initialActors: [animal('pig', 5.5, '2'), animal('cow', 6.5, '3')], onMove: ({ list }) => {
    if (list[0].alive !== false) { list[0].alive = false; list[0].lastEvent = { event: 'death_animation' }; list.push(drop(5.5, '8')) }
  } })
  const result = await f.foraging.execute({ targetRuntimeId: '2', maxSteps: 2 })
  assert.deepEqual(f.hunts, [])
  assert.equal(result.target.runtimeId, '8')
  assert.equal(result.collected, false)
  assert.deepEqual(f.state.inventory.items, [])
})

test('candidate diagnostics distinguish zero footing candidates from bounded origin/route preview rejection', async () => {
  const noCandidates = fixture({ worldOverride: () => ({ known: false }) })
  const empty = await noCandidates.foraging.execute()
  assert.equal(empty.candidateCount, 0)
  assert.deepEqual(empty.rejectedPreviews, [])
  const refused = fixture({ onPreview: () => ({ ready: false, code: 'NO_SAFE_ROUTE', reason: 'The current footprint has no known safe support' }) })
  const result = await refused.foraging.execute()
  assert.equal(result.candidateCount, 24)
  assert.equal(result.steps, 0)
  assert.equal(result.rejectedPreviews.length, 6)
  for (const entry of result.rejectedPreviews) {
    assert.deepEqual(Object.keys(entry).sort(), ['candidate', 'code', 'errors'])
    assert.equal(entry.code, 'NO_SAFE_ROUTE')
    assert.deepEqual(entry.errors, ['The current footprint has no known safe support'])
  }
})
