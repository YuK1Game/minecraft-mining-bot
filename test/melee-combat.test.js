'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createPhysics } = require('../src/physics')
const { createMovement } = require('../src/movement')
const { buildStationaryInput } = require('../src/input')
const { createMeleeCombat, descendingCriticalFrame } = require('../src/melee-combat')

const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const rawItem = (networkId, stackId) => ({ ...air(), network_id: networkId, count: 1, has_stack_id: true, stack_id: stackId })
const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }) }
const nativePhysics = createPhysics({ world, version: '1.26.60' })
function fixture ({ health = 20, weaponSlot = 0, noWeapon = false, equipConfirmed = true, useNative = false, testContext, noHopReceipt = false, hopProof = null, previewDenied = null, freshInput = false, inputReceipt = true, simulatedWall = false, onSleep = null, onAttack = null, ...options } = {}) {
  let time = 0; let tick = freshInput ? null : 1000n; let sent = 0; let running = false; let ordinarySending = false; let getInputCalls = 0; let movement = null; let melee
  const wallBase = Date.now(), modelWall = () => simulatedWall ? wallBase + time : Date.now()
  const state = { profile: 'bot', realm: { id: '21225335' }, connectionId: 'melee-fixture', startedAt: 'fixture-start', runtimeEntityId: '1', phase: 'spawned', dimension: 'overworld', gameMode: 'survival', health, position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, rawServerSelectedSlot: 0, inventory: { known: true }, lifecycle: { deathId: 0 }, rotation: { yaw: -90, pitch: 0 }, positionSource: 'server_post_move', positionUpdatedAt: 1, rawServerPositionUpdatedAt: 1 }
  const rawState = structuredClone(state); const origin = structuredClone(state)
  const publish = prediction => { const stamp = new Date(modelWall()).toISOString(); state.position = structuredClone(prediction.position); state.predicted = { ...structuredClone(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: stamp }; state.positionSource = 'client_prediction'; state.positionServerConfirmed = false; state.positionUpdatedAt = stamp }
  const modelPose = () => { const physical = nativePhysics.fromServer({ ...state, positionSource: 'server_post_move', predicted: null }); publish({ position: structuredClone(state.position), feetPosition: physical.position, velocity: physical.velocity, onGround: physical.onGround, physicsState: physical }) }
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 2.2, y: 65, z: 0.5 }, positionSource: 'move_entity' }
  const actors = [target]; const blocks = new Map(); const packets = []; const attacks = []; const equips = []
  const bag = new Map(Array.from({ length: 36 }, (_, i) => [i, air()])); if (!noWeapon) bag.set(weaponSlot, rawItem(300, 40))
  const names = new Map([[300, 'minecraft:wooden_sword'], [301, 'minecraft:netherite_sword'], [302, 'minecraft:netherite_axe']])
  const items = () => [...bag].filter(([, r]) => r.count).map(([slot, r]) => ({ slot, name: names.get(r.network_id), count: r.count, stackId: r.stack_id }))
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, inventory: items() }), rawItem: slot => bag.has(slot) ? structuredClone(bag.get(slot)) : null }
  const client = { queue: (name, params) => {
    packets.push({ at: time, name, params: structuredClone(params), ordinary: ordinarySending })
    if (name === 'player_auth_input') return noHopReceipt && !ordinarySending ? undefined : inputReceipt || !ordinarySending ? { tick: params.tick } : undefined
    if (name === 'mob_equipment') { state.rawSelectedSlot = state.rawServerSelectedSlot = params.selected_slot; rawState.rawSelectedSlot = rawState.rawServerSelectedSlot = params.selected_slot; melee?.applyPacket(name, params) }
    if (name === 'inventory_transaction') { const m = movement?.snapshot(); attacks.push({ at: time, params: structuredClone(params), movement: m, position: structuredClone(state.position) }); onAttack?.({ melee, state, rawState, target, actors, attacks, bag, observe }) }
  } }
  const observe = (name, packet) => melee.applyPacket(name, packet)
  const queueNormalInput = () => {
    const aim = input.aim ?? { x: 2.2, y: 65.9, z: 0.5 }; const dx = aim.x - state.position.x, dy = aim.y - state.position.y, dz = aim.z - state.position.z
    const next = (tick ?? 1000n) + 1n; const packet = buildStationaryInput({ position: state.position, yaw: Math.atan2(-dx, dz) * 180 / Math.PI, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI, tick: next })
    ordinarySending = true; const receipt = client.queue('player_auth_input', packet); ordinarySending = false
    if (receipt?.tick === next) { tick = next; sent++; if (state.positionSource === 'client_prediction') publish(state.predicted) }
  }
  const input = { lookAt: p => { input.aim = structuredClone(p) }, start: () => { running = true; queueNormalInput() }, stop: () => { running = false }, stats: () => ({ running, sent, tick: tick == null ? undefined : String(tick), target: null, lastError: null }) }
  if (useNative) {
    testContext.mock.timers.enable({ apis: ['setInterval'] })
    movement = createMovement({ world, physics: nativePhysics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => time, getState: () => ({ ...structuredClone(origin), health: state.health, dead: state.dead }), client, onPrediction: publish })
    testContext.after(() => movement.stop())
  }
  melee = createMeleeCombat({ client, getState: () => state, getRawState: () => rawState, world: { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? world.getBlock(x, y, z) }, entities: { snapshot: () => structuredClone(actors) }, crafting,
    equip: async slot => { equips.push(slot); if (equipConfirmed) { const r = bag.get(slot), old = bag.get(0); bag.set(0, r); bag.set(slot, old) }; return { serverConfirmed: equipConfirmed } }, getInput: () => { if (movement?.snapshot().running) throw new Error('Generic input requested during active native hop'); getInputCalls++; return input },
    ...(useNative ? { previewHop: p => previewDenied ? { ready: false, reason: previewDenied } : movement.previewHop(p), startHop: p => movement.startHop(p), getMovement: () => hopProof ? hopProof(movement.snapshot()) : movement.snapshot(), stopHop: (reason, hopId) => { if (movement.snapshot().criticalHopId === hopId) movement.stop(reason) } } : {}),
    now: () => time, wallNow: modelWall, sleep: async (ms, signal) => { if (signal?.aborted) throw new Error('aborted'); time += ms; if (useNative) testContext.mock.timers.tick(ms); if (running) queueNormalInput(); onSleep?.({ melee, state, rawState, target, actors, bag, blocks, time, observe, movement }); await turn(); if (signal?.aborted) throw new Error('aborted') }, ...options })
  return { melee, state, rawState, target, actors, bag, blocks, packets, attacks, equips, input, movement, observe, modelPose, getInputCalls: () => getInputCalls }
}

test('near current trusted working reach, alive>0 and no players/passive targets; raw remains an anchor', async () => {
  const f = fixture({ health: 1 }); assert.equal(f.melee.preview('70').ready, true)
  f.rawState.position.x = -8; f.modelPose()
  const preview = f.melee.preview('70'); assert.equal(preview.ready, true); assert.ok(preview.rawDistance > 2.8); assert.equal(preview.rawAnchor.usedForCurrentGeometry, false)
  const r = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 }); assert.equal(r.hitsRequested, 1); assert.equal(r.serverConfirmed, false)
  for (const change of [{ entityType: 'minecraft:player', kind: 'player' }, { entityType: 'minecraft:cow', hostile: false }, { uniqueId: '' }, { positionKnown: false }, { dimension: 'nether' }]) { const p = fixture(); Object.assign(p.target, change); assert.equal(p.melee.preview('70').ready, false) }
})
test('public melee denies forged, stale, future, mismatched and unscoped current models before any input or attack', () => {
  const invalid = [
    f => { f.state.predicted = null },
    f => { f.state.predicted.position.x += 0.01 },
    f => { f.state.predicted.physicsState.position.y += 0.01 },
    f => { f.state.predicted.physicsState.velocity.x = NaN },
    f => { f.state.predicted.velocity = { ...f.state.predicted.velocity, x: f.state.predicted.velocity.x + 0.01 } },
    f => { f.state.predicted.onGround = !f.state.predicted.onGround },
    f => { f.state.positionUpdatedAt = f.state.predicted.updatedAt = new Date(Date.now() - 201).toISOString() },
    f => { f.state.positionUpdatedAt = f.state.predicted.updatedAt = new Date(Date.now() + 1000).toISOString() },
    f => { f.state.predicted.updatedAt = 'not-a-date' },
    f => { f.state.positionUpdatedAt = 1 },
    f => { f.state.predicted.serverConfirmed = true },
    f => { f.state.positionSource = 'untrusted_pose' },
    f => { f.rawState.connectionId = 'old-connection' },
    f => { f.rawState.lifecycle.deathId++ },
    f => { f.rawState.health = 0 },
    f => { f.rawState.position.x = NaN }
  ]
  for (const mutate of invalid) {
    const f = fixture(); f.modelPose(); mutate(f)
    assert.equal(f.melee.preview('70').ready, false)
    assert.equal(f.packets.length, 0)
  }
  const received = fixture(); received.rawState.position.x = -8
  assert.equal(received.melee.preview('70').code, 'POSE_UNTRUSTED', 'an authoritative label cannot hide a different current pose')
})
test('repeated ordinary melee retains its own real neutral producer through650ms instead of requiring external idle freshness', async () => {
  const f = fixture({ simulatedWall: true, cooldownMs: 650 }); f.rawState.position.x = -8; f.modelPose()
  const result = await f.melee.engage('70', { critical: false, maxHits: 2, durationMs: 3000 })
  assert.equal(result.hitsRequested, 2, JSON.stringify(result))
  assert.ok(f.attacks[1].at - f.attacks[0].at >= 650)
  assert.ok(f.packets.filter(packet => packet.name === 'player_auth_input').length > 20)
  assert.equal(f.input.stats().running, false)
  assert.equal(result.serverConfirmed, false)
})
test('known blocked/unknown LOS and actual player/friendly aim interceptors prevent melee', () => {
  const f = fixture(); f.blocks.set('1,66,0', { known: false }); assert.equal(f.melee.preview('70').code, 'LOS_BLOCKED')
  const p = fixture(); p.actors.push({ ...p.target, runtimeId: '71', uniqueId: '-701', kind: 'player', entityType: 'minecraft:player', position: { x: 1.3, y: 65, z: 0.5 } }); assert.equal(p.melee.preview('70').code, 'FRIENDLY_IN_PATH')
  const friendly = fixture(); friendly.actors.push({ ...friendly.target, runtimeId: '71', uniqueId: '-701', entityType: 'minecraft:cow', hostile: false, position: { x: 1.3, y: 65, z: 0.5 } }); assert.equal(friendly.melee.preview('70').code, 'FRIENDLY_IN_PATH')
})

test('known coplayer five metres off the existing melee ray permits NPC combat while unknown player scope or position fails closed', async () => {
  const f = fixture(), player = { ...f.target, runtimeId: '71', uniqueId: '-701', kind: 'player', entityType: 'minecraft:player', hostile: false, position: { x: 0.5, y: 65, z: 5.5 } }
  f.actors.push(player)
  assert.equal(f.melee.preview('70').ready, true)
  const result = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  assert.equal(result.hitsRequested, 1)
  assert.equal(String(f.attacks[0].params.transaction.transaction_data.entity_runtime_id), '70')
  for (const change of [{ positionKnown: false }, { position: null }, { runtimeId: null }, { dimension: null }]) {
    const blocked = fixture(); blocked.actors.push({ ...player, ...change })
    assert.equal(blocked.melee.preview('70').code, 'ACTOR_UNKNOWN', JSON.stringify(change))
  }
  assert.equal(f.melee.preview('71').code, 'INVALID_TARGET')
})
test('highest Bedrock weapon equips with real server proof; unconfirmed equip sends no attack', async () => {
  const f = fixture(); f.bag.set(14, rawItem(301, 42)); const r = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  assert.deepEqual(f.equips, [14]); assert.equal(f.attacks[0].params.transaction.transaction_data.held_item.network_id, 301); assert.equal(r.attempts[0].provenNormalDamage, 9)
  const bad = fixture({ weaponSlot: 14, equipConfirmed: false }); const result = await bad.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 }); assert.equal(result.code, 'EQUIP_UNCONFIRMED'); assert.equal(bad.attacks.length, 0)
})
test('ordinary fallback queues a real aimed input tick before normal 1.26.60 entity-use attack', async () => {
  const f = fixture({ freshInput: true }); const result = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  assert.equal(f.attacks.length, 1); assert.equal(result.attempts[0].criticalAttempt, false); assert.equal(result.attempts[0].hitConfirmed, false); assert.ok(f.packets.findIndex(p => p.name === 'player_auth_input') < f.packets.findIndex(p => p.name === 'inventory_transaction'))
  const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60'); const packet = f.attacks[0]
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'inventory_transaction', params: packet.params })).data.params
  assert.equal(decoded.transaction.transaction_type, 'item_use_on_entity'); assert.equal(decoded.transaction.transaction_data.action_type, 'attack'); assert.equal(String(decoded.transaction.transaction_data.entity_runtime_id), '70'); assert.equal(decoded.transaction.transaction_data.hotbar_slot, 0)
  assert.equal(result.serverConfirmed, false); assert.equal(result.botCausedDeath, null)
  const noReceipt = fixture({ inputReceipt: false }); assert.equal((await noReceipt.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })).code, 'INPUT_UNCONFIRMED'); assert.equal(noReceipt.attacks.length, 0)
})
test('native single-hop critical is requested only on an actually queued descending airborne frame', async t => {
  const f = fixture({ useNative: true, testContext: t }); const result = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(f.attacks.length, 1, JSON.stringify(result)); const hit = f.attacks[0]; const proof = hit.movement
  assert.equal(proof.route.operation, 'critical_hop'); assert.equal(proof.queuedReceiptConfirmed, true); assert.ok(proof.physicsState.velocity.y < 0); assert.equal(proof.physicsState.onGround, false); assert.ok(f.packets.some(p => p.name === 'player_auth_input' && String(p.params.tick) === proof.queuedTick))
  assert.equal(result.attempts[0].criticalAttempt, true); assert.equal(result.attempts[0].criticalHitConfirmed, false); assert.equal(result.serverConfirmed, false); assert.equal(f.getInputCalls(), 0)
  assert.equal(f.packets.filter(p => p.name === 'player_auth_input' && p.params.input_data.includes('start_jumping')).length, 1)
  assert.equal(f.movement.snapshot().physicsState.onGround, true)
})

test('successive real Native critical hops overlap their ascent with cooldown but request hits only at least650ms apart', async t => {
  const f = fixture({ useNative: true, testContext: t, cooldownMs: 650 })
  const result = await f.melee.engage('70', { maxHits: 3, durationMs: 4000 })
  assert.equal(result.hitsRequested, 3, JSON.stringify(result))
  assert.ok(result.attempts.every(attempt => attempt.criticalAttempt === true && attempt.criticalHitConfirmed === false))
  for (let index = 1; index < f.attacks.length; index++) {
    const spacing = f.attacks[index].at - f.attacks[index - 1].at
    assert.ok(spacing >= 650 && spacing <= 750, String(spacing))
  }
  assert.equal(f.packets.filter(packet => packet.name === 'player_auth_input' && packet.params.input_data.includes('start_jumping')).length, 3)
  assert.ok(f.attacks.every(attack => attack.movement.queuedReceiptConfirmed && attack.movement.physicsState.velocity.y < -0.001 && !attack.movement.physicsState.onGround))
  assert.equal(f.movement.snapshot().onGround, true)
  assert.equal(result.serverConfirmed, false)
  t.diagnostic(`actual Native critical request times: ${f.attacks.map(attack => attack.at).join(', ')}ms`)
})

test('knockback outside both actual hit poses tracks privately until the owned Native hop lands, then hands back out-of-reach', async t => {
  const f = fixture({ useNative: true, testContext: t, onAttack: ({ target }) => { target.position.x = 4 } })
  const result = await f.melee.engage('70', { maxHits: 3, durationMs: 3000 })
  assert.equal(result.hitsRequested, 1, JSON.stringify(result))
  assert.equal(result.outcome, 'out_of_reach')
  assert.equal(f.movement.snapshot().onGround, true, 'the physical hop lands before an approach can take ownership')
  assert.equal(f.getInputCalls(), 0)
  assert.equal(f.melee.preview('70').outcome, 'out_of_reach', 'normal range admission remains2.8')
})

test('initial getAim callback may track a just-knocked-away bound NPC during admitted hop startup without an out-of-reach attack', async t => {
  let f
  f = fixture({ useNative: true, testContext: t, startHop: options => { f.target.position.x = 4; return f.movement.startHop(options) } })
  assert.equal(f.melee.preview('70').ready, true)
  const result = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(result.hitsRequested, 0, JSON.stringify(result))
  assert.equal(result.outcome, 'out_of_reach')
  assert.equal(f.movement.snapshot().onGround, true)
  assert.equal(f.getInputCalls(), 0)
})

test('a target knocked beyond the private16m aim bound gets no far aim or hit while its existing Native hop still lands', async t => {
  let f; const aims = []
  f = fixture({ useNative: true, testContext: t, onAttack: ({ target }) => { target.position.x = 20 }, startHop: options => f.movement.startHop({ ...options, getAim: () => { const point = options.getAim(); aims.push(structuredClone(point)); return point } }) })
  const result = await f.melee.engage('70', { maxHits: 3, durationMs: 3000 })
  assert.equal(result.hitsRequested, 1); assert.equal(result.outcome, 'out_of_reach')
  assert.equal(f.movement.snapshot().onGround, true)
  assert.ok(aims.every(point => Math.hypot(point.x - f.rawState.position.x, point.y - f.rawState.position.y, point.z - f.rawState.position.z) <= 16))
})

test('owned-hop private tracking never bypasses UID/type/life/death/weapon or actual receipt checks', async t => {
  for (const mode of ['uid', 'type', 'life', 'death', 'weapon', 'receipt']) await t.test(mode, async t => {
    let receiptLost = false
    const f = fixture({ useNative: true, testContext: t, hopProof: motion => receiptLost ? { ...motion, queuedReceiptConfirmed: false } : motion, onAttack: ({ target, state, rawState, bag, observe }) => {
      target.position.x = 4
      if (mode === 'uid') target.uniqueId = '-replacement'
      if (mode === 'type') target.entityType = 'minecraft:skeleton'
      if (mode === 'life') { state.lifecycle.deathId++; rawState.lifecycle.deathId++; observe('set_entity_data', {}) }
      if (mode === 'death') { state.health = rawState.health = 0; observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 0 }] }) }
      if (mode === 'weapon') bag.set(0, rawItem(301, 99))
      if (mode === 'receipt') receiptLost = true
    } })
    const result = await f.melee.engage('70', { maxHits: 3, durationMs: 3000 })
    assert.equal(result.hitsRequested, 1, JSON.stringify(result))
    assert.equal(result.serverConfirmed, false); assert.equal(result.targetDead, false)
    assert.equal(result.attempts[0].criticalHitConfirmed, false)
    if (mode === 'receipt') assert.equal(f.movement.snapshot().onGround, true)
  })
})
test('missing real receipt proof waits for the native landing and falls back to ordinary hit', async t => {
  const f = fixture({ useNative: true, testContext: t, noHopReceipt: true }); const result = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(f.attacks.length, 1); assert.equal(result.attempts[0].criticalAttempt, false); assert.equal(f.movement.snapshot().physicsState.onGround, true); assert.equal(f.getInputCalls(), 2, 'ordinary acquisition plus current-owner recheck after landing')
})
test('critical waits until descent also brings the working body back inside actual 3.0 reach', async t => {
  const f = fixture({ useNative: true, testContext: t }); f.target.position.x = 3.1
  const result = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(result.attempts[0].criticalAttempt, true, JSON.stringify(result)); const eye = f.attacks[0].position; const aim = { ...f.target.position, y: f.target.position.y + 0.9 }
  assert.ok(Math.hypot(eye.x - aim.x, eye.y - aim.y, eye.z - aim.z) <= 3.0); assert.ok(f.attacks[0].movement.velocity.y < 0)
})
test('native critical at HP1 is permitted, and positive damage during a hop does not cancel the whole fight', async t => {
  let damaged = false
  const f = fixture({ useNative: true, testContext: t, onSleep: ({ state, rawState, movement, observe }) => { if (!damaged && movement.snapshot().onGround === false) { damaged = true; state.health = rawState.health = 1; observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 1 }] }) } } })
  const result = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(result.hitsRequested, 1, JSON.stringify(result)); assert.equal(f.state.health, 1); assert.notEqual(result.code, 'NOT_ALIVE'); assert.equal(result.targetDead, false)
})
test('water/roof/unknown hop rejection uses ordinary fallback without inventing a jump or critical', async t => {
  const f = fixture({ useNative: true, testContext: t, previewDenied: 'known water / unknown roof' }); const r = await f.melee.engage('70', { maxHits: 1, durationMs: 2000 })
  assert.equal(r.attempts[0].criticalAttempt, false); assert.equal(f.packets.filter(p => p.params?.input_data?.includes('start_jumping')).length, 0); assert.equal(f.getInputCalls(), 2, 'ordinary acquisition plus current-owner recheck')
})
test('critical-proof helper rejects stale, rising, landed, wet, wrong-hop and mismatched-body frames', () => {
  const valid = { criticalHopId: 1, route: { operation: 'critical_hop' }, phase: 'moving', running: true, queuedReceiptConfirmed: true, queuedTick: '123', queuedAt: 1000, onGround: false, velocity: { x: 0, y: -0.1, z: 0 }, physicsState: { position: { x: 0.5, y: 66, z: 0.5 }, velocity: { x: 0, y: -0.1, z: 0 }, onGround: false } }; const options = { wallNow: 1000, workingPosition: { x: 0.5, y: 67.62, z: 0.5 } }
  const previous = { criticalHopId: 1, tick: '122', queuedAt: 950, position: { x: 0.5, y: 67.72, z: 0.5 }, packetY: Math.fround(67.72), receiptConfirmed: true, onGround: false }
  const current = { criticalHopId: 1, tick: '123', queuedAt: 1000, position: { x: 0.5, y: 67.62, z: 0.5 }, packetY: Math.fround(67.62), receiptConfirmed: true, onGround: false }
  valid.criticalHopQueuedPair = { criticalHopId: 1, previous, current, deltaY: current.packetY - previous.packetY }
  assert.equal(descendingCriticalFrame(valid, 1, options), true)
  for (const mutate of [m => { m.queuedAt = 700 }, m => { m.queuedReceiptConfirmed = false }, m => { m.criticalHopId = 2 }, m => { m.physicsState.velocity.y = 0.1; m.velocity.y = 0.1 }, m => { m.physicsState.onGround = true }, m => { m.physicsState.isInWater = true }, m => { m.physicsState.position.x = 4 }, m => { m.phase = 'stopped' }]) { const m = structuredClone(valid); mutate(m); assert.equal(descendingCriticalFrame(m, 1, options), false) }
})
test('damage alone does not cancel repeated melee and normal cooldown remains 600-750ms', async () => {
  const f = fixture({ cooldownMs: 650, health: 2, onAttack: ({ state, rawState, attacks }) => { if (attacks.length === 1) { state.health = rawState.health = 1 } } }); const r = await f.melee.engage('70', { critical: false, maxHits: 3, durationMs: 4000 })
  assert.equal(r.hitsRequested, 3); assert.equal(f.state.health, 1); for (let i = 1; i < f.attacks.length; i++) assert.ok(f.attacks[i].at - f.attacks[i - 1].at >= 650)
})
test('server death of the bound target stops further attacks without claiming our damage attribution', async () => {
  const f = fixture({ onAttack: ({ attacks, observe }) => { if (attacks.length === 2) observe('update_attributes', { runtime_entity_id: 70n, attributes: [{ name: 'minecraft:health', current: 0 }] }) } }); const r = await f.melee.engage('70', { critical: false, maxHits: 5, durationMs: 6000 })
  assert.equal(r.code, 'TARGET_DEAD'); assert.equal(r.serverConfirmed, true); assert.equal(r.hitsRequested, 2); assert.equal(r.botCausedDeath, null); assert.equal(r.attempts.every(a => !a.hitConfirmed), true)
})
test('runtime identity reuse, far movement and despawn are not a server-confirmed kill', async () => {
  const changed = fixture({ onAttack: ({ target, observe }) => { target.uniqueId = '-999'; observe('entity_event', { runtime_entity_id: 70n, event_id: 'death_animation' }) } }); const a = await changed.melee.engage('70', { critical: false, maxHits: 3, durationMs: 4000 }); assert.equal(a.code, 'TARGET_CHANGED'); assert.equal(a.targetDead, false)
  const far = fixture({ onAttack: ({ target }) => { target.position.x = 10 } }); const b = await far.melee.engage('70', { critical: false, maxHits: 3, durationMs: 4000 }); assert.equal(b.outcome, 'out_of_reach'); assert.equal(b.targetDead, false)
  const removed = fixture({ onAttack: ({ observe }) => observe('remove_entity', { entity_id_self: -700n }) }); const c = await removed.melee.engage('70', { critical: false, maxHits: 3, durationMs: 4000 }); assert.equal(c.code, 'TARGET_REMOVED'); assert.equal(c.serverConfirmed, false)
})
test('natural attacker death, respawn/scope change and cancel stop subsequent attack requests', async () => {
  for (const mode of ['death', 'respawn', 'scope', 'cancel']) { const f = fixture({ onAttack: ({ melee, state, rawState, observe }) => { if (mode === 'death') { state.health = rawState.health = 0; state.dead = true; observe('update_attributes', { runtime_entity_id: 1n, attributes: [{ name: 'minecraft:health', current: 0 }] }) } else if (mode === 'respawn') observe('respawn', {}); else if (mode === 'scope') { state.connectionId = rawState.connectionId = 'replacement'; observe('set_entity_data', {}) } else melee.cancel('fixture cancel') } }); const r = await f.melee.engage('70', { critical: false, maxHits: 3, durationMs: 4000 }); assert.equal(r.hitsRequested, 1); assert.equal(r.targetDead, false) }
})
test('fists fallback attacks using the actual empty hand at positive critical health', async () => {
  const f = fixture({ noWeapon: true, health: 1 }); const r = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 2000 })
  assert.equal(r.attempts[0].weapon, 'minecraft:air'); assert.equal(f.attacks[0].params.transaction.transaction_data.held_item.network_id, 0); assert.equal(f.attacks[0].params.transaction.transaction_data.held_item.count, 0)
})

test('a target forecast to walk out of reach before the descent gets an immediate ordinary hit instead of a wasted hop', async t => {
  let f
  const entities = velocity => ({ snapshot: () => structuredClone(f.actors), motion: id => id === '70' ? { velocity, stationary: false } : null })
  f = fixture({ useNative: true, testContext: t, entities: entities({ x: 0.45, y: 0, z: 0 }) })
  const away = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(away.hitsRequested, 1, JSON.stringify(away))
  assert.equal(away.attempts[0].criticalAttempt, false)
  assert.equal(f.packets.filter(p => p.name === 'player_auth_input' && p.params.input_data.includes('start_jumping')).length, 0)
})

test('a stationary or slowly approaching target still receives the descending critical hit', async t => {
  let f
  f = fixture({ useNative: true, testContext: t, entities: { snapshot: () => structuredClone(f.actors), motion: () => ({ velocity: { x: -0.05, y: 0, z: 0 }, stationary: false }) } })
  const result = await f.melee.engage('70', { maxHits: 1, durationMs: 3000 })
  assert.equal(f.attacks.length, 1, JSON.stringify(result))
  assert.equal(result.attempts[0].criticalAttempt, true)
  assert.ok(f.attacks[0].movement.physicsState.velocity.y < 0)
})
test('a model pose a tick stale at the input handover waits for the next fresh frame, but a pose that never refreshes still stops with no attack', async () => {
  let refreshed = false
  const f = fixture({ simulatedWall: true, onSleep: ({ time }) => { if (!refreshed && time >= 50) { refreshed = true; f.modelPose() } } })
  f.rawState.position.x = -8; f.modelPose()
  f.state.positionUpdatedAt = f.state.predicted.updatedAt = new Date(Date.parse(f.state.predicted.updatedAt) - 300).toISOString()
  assert.equal(f.melee.preview('70').code, 'POSE_UNTRUSTED')
  const r = await f.melee.engage('70', { critical: false, maxHits: 1, durationMs: 3000 })
  assert.equal(refreshed, true); assert.equal(r.hitsRequested, 1, JSON.stringify(r)); assert.equal(f.attacks.length, 1)
  const stale = fixture({ simulatedWall: true }); stale.rawState.position.x = -8; stale.modelPose()
  stale.state.positionUpdatedAt = stale.state.predicted.updatedAt = new Date(Date.parse(stale.state.predicted.updatedAt) - 300).toISOString()
  await assert.rejects(stale.melee.engage('70', { critical: false, maxHits: 1, durationMs: 3000 }), e => e.code === 'POSE_UNTRUSTED')
  assert.equal(stale.attacks.length, 0)
})
test('default melee spams: plain hits go out about every 100ms (Bedrock has no attack cooldown)', async () => {
  const f = fixture()
  const r = await f.melee.engage('70', { critical: false, maxHits: 4, durationMs: 3000 })
  assert.equal(r.hitsRequested, 4)
  for (let i = 1; i < f.attacks.length; i++) { const gap = f.attacks[i].at - f.attacks[i - 1].at; assert.ok(gap >= 100 && gap < 300, String(gap)) }
})
