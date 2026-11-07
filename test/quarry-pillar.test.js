'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const { createQuarryPillar, serverPose } = require('../src/quarry-pillar')
const { createInteractions } = require('../src/interactions')

function fixture ({ dirt = 64, extraDirt = 0, placement = 'both', position = true, delay = 50, interrupt = null, realPlacement = false, onEquip = null, oracle = null, staleRaw = false, clockStamp = false } = {}) {
  const blocks = new Map(), snapshots = [], placements = [], releases = []
  let clock = 0, tick = 0, owner = null, pending = null, transaction = null, interactions, pillar, lastFrame, unknownHead = false, oracleCalls = 0
  const items = [{ slot: 0, name: 'minecraft:dirt', count: dirt, stackId: 1 }, ...(extraDirt ? [{ slot: 10, name: 'minecraft:dirt', count: extraDirt, stackId: 2 }] : [])]
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, profile: 'test', realm: { id: 'realm' }, connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 1 },
    position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, rotation: { yaw: 0, pitch: 90 }, inventory: { known: true, items } }
  if (staleRaw) state.rawServerPositionUpdatedAt = -10000
  const getBlock = (x, y, z) => unknownHead && x === 0 && z === 0 && y === 67 ? { known: false } : ({ known: true, name: blocks.get(`${x},${y},${z}`) ?? (y < 65 ? 'minecraft:stone' : 'minecraft:air'), boundingBox: blocks.has(`${x},${y},${z}`) || y < 65 ? 'block' : 'empty', position: { x, y, z }, properties: {}, extra: [] })
  const physics = createPhysics({ world: { getBlock }, version: '1.26.60' })
  function drive () {
    if (!input.running) return
    const frame = pillar.frame({ state, rotation: state.rotation, tick: BigInt(++tick) })
    lastFrame = frame
    if (!frame) return
    pillar.onQueuedFrame({ tick: BigInt(tick), receiptConfirmed: true, modeled: true, producer: 'input', controls: frame.controls, packetPosition: frame.position, predictedState: frame.predictedState })
    frame.commitPrediction()
    if (transaction) {
      const sent = transaction; transaction = null
      const data = sent.value.data, target = { ...data.block_position, y: data.block_position.y + 1 }
      pending = { options: { position: target, slot: data.hotbar_slot }, due: clock + delay, resolve: () => interactions.applyPacket('update_block', {}), reject: () => {} }
      sent.onSent?.()
    }
    if (position && frame.predictedState.onGround && frame.predictedState.position.y > state.rawServerPosition.y - 1.62 + 0.5) {
      state.rawServerPosition = { ...frame.position }; state.rawServerPositionUpdatedAt = clockStamp ? clock : state.rawServerPositionUpdatedAt + 1
    }
  }
  const input = { running: false, start () { if (input.running) return; input.running = true; drive() }, stop () { input.running = false; transaction = null },
    lookAt: () => state.rotation, sendTransaction: (value, callbacks) => { transaction = { value, onSent: callbacks?.onSent } }, stats: () => ({ running: input.running }) }
  const sleep = async () => {
    clock += 50
    if (interrupt) interrupt({ clock, state, get owner () { return owner }, takeover () { owner = 'combat' }, makeUnknown () { unknownHead = true }, pillar, input, interactions })
    if (pending && clock >= pending.due) {
      const p = pending; pending = null
      if (placement !== 'inventory_only' && placement !== 'neither') blocks.set(`${p.options.position.x},${p.options.position.y},${p.options.position.z}`, 'minecraft:dirt')
      if (placement !== 'block_only' && placement !== 'neither') {
        const item = state.inventory.items.find(i => i.slot === p.options.slot); item.count--
        state.inventory.items = state.inventory.items.filter(i => i.count > 0)
      }
      p.resolve({ phase: 'completed', confirmedBy: 'server_block_and_inventory' })
    }
    drive()
    await Promise.resolve()
  }
  if (realPlacement) {
    const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, inventory: state.inventory.items }), applyPacket () {}, rawItem: slot => {
      const item = state.inventory.items.find(i => i.slot === slot)
      return item ? { network_id: 1, count: item.count, metadata: 0, has_stack_id: true, stack_id: item.stackId, block_runtime_id: 1 } : { network_id: 0, count: 0, metadata: 0, has_stack_id: false }
    } }
    interactions = createInteractions({ client: { queue () {} }, getState: () => state, world: { getBlock }, crafting, getInput: () => input, onUncertain: () => { state.inventory.uncertain = true } })
  }
  pillar = createQuarryPillar({ getState: () => state, getBlock, getPhysics: () => physics, getInput: () => input,
    ...(oracle ? { confirmPosition: async (feet, options) => {
      const count = ++oracleCalls, receipt = { serverConfirmed: true, kind: 'server_position_volume', feet: { ...feet }, radius: 0.12, requestId: 'position-' + count, receivedAt: new Date(clock).toISOString(), scope: JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, state.dimension, String(state.runtimeEntityId), state.lifecycle.deathId]) }
      return typeof oracle === 'function' ? oracle({ feet, options, receipt, state, clock, count, pillar }) : receipt
    } } : {}),
    equipDirt: async slot => {
      if (slot > 8) { const source = state.inventory.items.find(i => i.slot === slot); source.slot = 0 }
      onEquip?.(state)
      return { slot: 0 }
    },
    acquireInput: ({ token }) => { owner = token }, ownsInput: token => owner === token,
    releaseInput: token => { if (owner === token) { releases.push(token); owner = null; input.stop() } },
    onPrediction: prediction => { state.position = { ...prediction.position }; state.positionSource = 'client_prediction'; state.predicted = prediction },
    placeBlock: options => {
      assert.ok(state.position.y - 1.62 > options.position.y + 1, 'the ordinary placement begins only after the body clears the target')
      placements.push(structuredClone(options))
      if (realPlacement) return interactions.placeBlock(options)
      return new Promise((resolve, reject) => { pending = { options, due: clock + delay, resolve, reject } })
    }, cancelPlace: reason => { interactions?.cancel(reason); if (pending) { pending.reject(new Error(reason)); pending = null } }, now: () => clock, sleep, timeoutMs: 1200 })
  const step = (feetY = 65, checkpoint) => pillar.step({ jobId: 'job', operationId: 'exit', column: { x: 0, z: 0 }, feetY, ...(checkpoint ? { checkpoint } : {}) }, { onCheckpoint: cp => snapshots.push(cp) })
  return { step, pillar, state, getBlock, blocks, placements, releases, snapshots, get oracleCalls () { return oracleCalls }, get lastFrame () { return lastFrame }, get owner () { return owner } }
}

test('one pillar step needs received dirt, real consumption and a fresh received landing pose', async () => {
  const f = fixture()
  const result = await f.step()
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.placements.length, 1)
  assert.deepEqual(f.placements[0].position, { x: 0, y: 65, z: 0 })
  assert.equal(result.checkpoint.beforeDirt - result.checkpoint.afterDirt, 1)
  assert.equal(f.state.rawServerPosition.y, 67.62)
  assert.deepEqual(f.snapshots.map(s => s.phase), ['intent', 'completed'])
  assert.equal(f.releases.length, 1)
})

test('the real ordinary placement oracle works during the apex without relaxing its 0.3m movement limit', async () => {
  const f = fixture({ realPlacement: true })
  const result = await f.step()
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.checkpoint.confirmedBy, 'server_block_inventory_and_position')
  assert.equal(f.placements.length, 1)
})

test('two consecutive steps use the confirmed support and change an exhausted dirt stack normally', async () => {
  const f = fixture({ dirt: 1, extraDirt: 64 })
  const first = await f.step()
  assert.equal(first.status, 'completed', JSON.stringify(first))
  const second = await f.step(66)
  assert.equal(second.status, 'completed', JSON.stringify(second))
  assert.deepEqual(f.placements.map(p => p.position.y), [65, 66])
  assert.equal(f.state.inventory.items[0].count, 63)
  assert.equal(second.checkpoint.beforeCount, 64)
})

test('a complete 64-block stack is consumed once per confirmed step before switching stacks', async () => {
  const f = fixture({ dirt: 64, extraDirt: 2 })
  for (let i = 0; i < 65; i++) {
    const result = await f.step(65 + i)
    assert.equal(result.status, 'completed', `step ${i}: ${JSON.stringify(result)}`)
  }
  assert.equal(f.placements.length, 65)
  assert.equal(f.state.inventory.items[0].count, 1)
})

test('a block alone, an inventory change alone, or predictions without a received pose never completes a step', async () => {
  for (const options of [{ placement: 'block_only' }, { placement: 'inventory_only' }, { position: false }]) {
    const f = fixture(options), result = await f.step()
    assert.equal(result.status, 'blocked', JSON.stringify(options))
    assert.equal(result.serverConfirmed, false)
    assert.equal(f.placements.length, 1)
    assert.notEqual(result.checkpoint?.phase, 'completed')
    if (options.position === false) assert.equal(result.reason, 'ASCENT_POSITION_UNCONFIRMED')
  }
})

test('delayed placement does not insert a forecast block and an unfinished checkpoint is not resent', async () => {
  const f = fixture({ delay: 1000 })
  const first = await f.step()
  assert.equal(first.status, 'blocked')
  assert.equal(f.getBlock(0, 65, 0).name, 'minecraft:air')
  assert.equal(f.placements.length, 1)
  const resumed = await f.step(65, first.checkpoint)
  assert.equal(resumed.reason, 'ASCENT_UNCERTAIN_STEP')
  assert.equal(f.placements.length, 1)
})

test('combat takeover prevents the old step cleanup from stopping the new input owner', async () => {
  const f = fixture({ interrupt: c => { if (c.clock === 150) c.takeover() } })
  const result = await f.step()
  assert.equal(result.status, 'blocked')
  assert.equal(result.reason, 'ASCENT_INPUT_CHANGED')
  assert.equal(f.owner, 'combat')
  assert.equal(f.releases.length, 0)
})

test('equipment waits cannot reuse an origin changed by a different same-life movement', async () => {
  const f = fixture({ onEquip: state => { state.rawServerPosition = { x: 2.5, y: 66.62, z: 0.5 }; state.rawServerPositionUpdatedAt++ } })
  const result = await f.step()
  assert.equal(result.reason, 'ASCENT_ORIGIN_CHANGED')
  assert.equal(f.placements.length, 0)
  assert.equal(f.snapshots.length, 0)
})

test('cancelling an unsent real placement clears the shared input transaction before another owner can send it', async () => {
  const f = fixture({ realPlacement: true, interrupt: c => { if (c.clock === 150) c.pillar.cancel('RELOAD') } })
  const result = await f.step()
  assert.equal(result.status, 'blocked')
  assert.equal(f.placements.length, 1)
  assert.equal(f.getBlock(0, 65, 0).name, 'minecraft:air')
  assert.equal(f.state.inventory.items[0].count, 64)
  assert.equal(f.releases.length, 1)
})

test('death, reload cancellation and received unknown headroom block without an extra placement', async () => {
  for (const kind of ['death', 'reload', 'unknown', 'inventory']) {
    const f = fixture({ interrupt: c => {
      if (c.clock !== 50) return
      if (kind === 'death') { c.state.dead = true; c.state.lifecycle.deathId++ }
      else if (kind === 'reload') c.pillar.cancel('RELOAD')
      else if (kind === 'unknown') c.makeUnknown()
      else c.state.inventory.uncertain = true
    } })
    const result = await f.step()
    assert.equal(result.status, 'blocked', kind)
    assert.equal(f.placements.length, 0, kind)
  }
})

test('motion hints and input receipts cannot masquerade as server positions', () => {
  assert.equal(serverPose({ position: { x: 1, y: 2, z: 3 }, positionSource: 'client_prediction', positionUpdatedAt: 5, lastServerMotion: { accepted: true, onGround: true, velocity: { x: 0, y: 0, z: 0 } } }), null)
})

test('a fresh server position volume confirms consecutive steps without forging raw poses or stamps', async () => {
  const f = fixture({ position: false, oracle: true, staleRaw: true })
  const original = { position: { ...f.state.rawServerPosition }, stamp: f.state.rawServerPositionUpdatedAt }
  const first = await f.step(), second = await f.step(66)
  assert.equal(first.status, 'completed', JSON.stringify(first))
  assert.equal(second.status, 'completed', JSON.stringify(second))
  assert.equal(f.oracleCalls, 6, 'each start, post-equip origin and landing gets a new response')
  assert.equal(second.checkpoint.confirmedBy, 'server_block_inventory_and_position_volume')
  assert.equal(second.checkpoint.modelSeedSource, 'working_prediction_with_server_position_volume')
  assert.equal(second.checkpoint.position, undefined)
  assert.equal(second.checkpoint.positionStamp, undefined)
  assert.equal(second.checkpoint.positionVolume.feet.y, 67)
  assert.equal(second.checkpoint.originPositionEvidence.feet.y, 66)
  assert.deepEqual(f.state.rawServerPosition, original.position)
  assert.equal(f.state.rawServerPositionUpdatedAt, original.stamp)
})

test('fresh matching raw echoes preserve the original route without sending a position command', async () => {
  const f = fixture({ position: true, clockStamp: true, oracle: () => { throw new Error('unexpected position query') } })
  const result = await f.step()
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.checkpoint.confirmedBy, 'server_block_inventory_and_position')
  assert.equal(f.oracleCalls, 0)
})

test('a failed, expired, duplicate or mismatched oracle receipt cannot authorize a jump', async () => {
  for (const modify of [r => ({ ...r, serverConfirmed: false }), r => ({ ...r, kind: 'queued_command' }), r => ({ ...r, receivedAt: new Date(-1).toISOString() }), r => ({ ...r, feet: { ...r.feet, y: r.feet.y + 1 } }), r => ({ ...r, radius: 0.2 }), r => ({ ...r, scope: 'another-scope' }), r => ({ ...r, requestId: 'reused-id' })]) {
    const f = fixture({ position: false, staleRaw: true, oracle: ({ receipt }) => modify(receipt) })
    const result = await f.step()
    assert.equal(result.status, 'blocked')
    assert.equal(result.serverConfirmed, false)
    assert.equal(f.placements.length, 0)
  }
})

test('oracle confirmation checks scope again and does not seed from a prediction outside its actual volume', async () => {
  for (const change of [c => { c.state.lifecycle.deathId++ }, c => { c.state.position.x += 1 }, c => { c.pillar.cancel('RELOAD') }]) {
    const f = fixture({ position: false, staleRaw: true, oracle: c => { change(c); return c.receipt } })
    const result = await f.step()
    assert.equal(result.status, 'blocked')
    assert.equal(f.placements.length, 0)
  }
})

test('a negative landing oracle after real placement leaves an uncertain intent which is never resent', async () => {
  const f = fixture({ position: false, staleRaw: true, oracle: ({ receipt, count }) => count === 3 ? { ...receipt, serverConfirmed: false } : receipt })
  const first = await f.step()
  assert.equal(first.reason, 'ASCENT_POSITION_UNCONFIRMED')
  assert.equal(f.placements.length, 1)
  const retry = await f.step(65, first.checkpoint)
  assert.equal(retry.reason, 'ASCENT_UNCERTAIN_STEP')
  assert.equal(f.placements.length, 1)
})

test('pillar timing diagnostics keep the last 16 queued model frames and placement response timing', async () => {
  const f = fixture({ position: false })
  const result = await f.step(), d = result.checkpoint.diagnostics
  assert.equal(result.reason, 'ASCENT_POSITION_UNCONFIRMED')
  assert.equal(d.framesPredictionOnly, true)
  assert.equal(d.frames.length, 16)
  assert.ok(d.frames.every(frame => typeof frame.tick === 'string' && Number.isFinite(frame.feetY) && Number.isFinite(frame.queuedAt)))
  assert.ok(d.placementStartedAt >= d.placementTriggeredAt)
  assert.ok(d.placementRespondedAt >= d.placementStartedAt)
  assert.equal(d.placementResponse.confirmedBy, 'server_block_and_inventory')
  assert.ok(d.frames.some(frame => frame.placedBlock && frame.landed))
  assert.deepEqual(f.pillar.snapshot().diagnostics, d)
})

test('placement diagnostics expose the prior working frame and retain a normal 0.3m rejection reason', async () => {
  const f = fixture({ realPlacement: true, delay: 1000, interrupt: c => { if (c.clock === 500) c.interactions.applyPacket('update_attributes', {}) } })
  const result = await f.step(), d = result.checkpoint.diagnostics
  assert.equal(result.status, 'blocked')
  assert.equal(f.placements.length, 1)
  const trigger = d.frames.find(frame => frame.tick === d.placementTriggeredTick)
  assert.ok(trigger.workingFeetYBeforeFrame < trigger.feetY)
  assert.ok(trigger.predictionCommittedAt <= d.placementStartedAt)
  assert.ok(Math.abs(d.placementStartedWorkingFeetY - trigger.feetY) < 1e-6)
  assert.equal(d.placementResponse.phase, 'failed')
  assert.match(d.placementResponse.reason, /位置.*変わりました/)
  assert.equal(d.failureObservation.inventoryUncertain, true)
  assert.equal(d.failureObservation.dirt, 64)
})
