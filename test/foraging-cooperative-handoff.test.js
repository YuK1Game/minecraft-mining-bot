'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { setTimeout: sleep } = require('node:timers/promises')
const { createForaging } = require('../src/foraging'), { createInput } = require('../src/input'), { createMovement } = require('../src/movement')

function scene () {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, runtimeEntityId: '1', lifecycle: { deathId: 0 }, connectionId: 'same', startedAt: 'start', health: 20, gameMode: 'survival', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, rawSelectedSlot: 0, positionUpdatedAt: 1, inventory: { known: true, items: [] } }
  const target = { runtimeId: '2', uniqueId: '-2', kind: 'mob', entityType: 'minecraft:cow', dimension: 'overworld', alive: true, hostile: false, positionKnown: true, position: { x: 8.5, y: 65, z: 0.5 } }
  const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', properties: {}, extra: [] }) }
  return { state, target, world }
}
test('production Input can run between a burst of planning phases before the unchanged Native handoff gate', async t => {
  // Advance a model clock, rather than burn CPU to recreate the observed
  // 300ms synchronous chain. Only real macrotasks pump actual Input intervals.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = scene(), epoch = Date.now(), controller = new AbortController(), packets = []
  let time = 0, cursor = null, previews = 0, startAge = null, movementStarted = false, finished = false
  t.mock.method(Date, 'now', () => epoch + time)
  const client = { queue: (name, packet) => { packets.push({ name, packet }); return { tick: packet.tick } } }
  const queued = frame => { if (frame.receiptConfirmed) cursor = { tick: String(frame.tick), queuedAt: Date.now() } }
  const startGame = { current_tick: 1000n, server_authoritative_block_breaking: true, player_gamemode: 'survival' }
  const input = createInput({ client, getState: () => f.state, version: '1.26.60', startGame, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: () => cursor, onQueuedFrame: queued })
  const native = createMovement({ client, getState: () => f.state, world: f.world, version: '1.26.60', startGame, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: () => cursor, onQueuedFrame: queued })
  t.after(() => { input.stop(); native.stop() })
  const target = { x: 2.5, y: 65, z: 0.5 }; assert.equal(native.preview(target).ready, true)
  input.start()
  const foraging = createForaging({ getState: () => ({ ...f.state, entities: [f.target] }), world: f.world, entities: { snapshot: () => [f.target] },
    movement: { preview: () => { time += 35; return { ready: ++previews >= 7 } }, start: point => {
      startAge = Date.now() - cursor.queuedAt; input.stop(false)
      native.start(point, { emergency: true, maxDistance: 12 }); movementStarted = true
      controller.abort(new Error('fixture_complete_after_real_handoff')); return native.snapshot()
    }, stop: () => native.stop() }, getMovement: () => native.snapshot(), combat: { previewHunt: () => ({ ready: false }), hunt: () => assert.fail('no attack'), cancel: () => {} }, clock: () => epoch + time })
  const work = foraging.execute({ targetRuntimeId: '2' }, { signal: controller.signal }).finally(() => { finished = true })
  const rejected = assert.rejects(work, /fixture_complete_after_real_handoff/)
  let pumped = 0
  while (!finished) { await sleep(0); const elapsed = time - pumped; if (elapsed > 0) { pumped = time; t.mock.timers.tick(elapsed) } }
  await rejected
  assert.equal(previews, 7); assert.equal(movementStarted, true); assert.ok(startAge <= 200, String(startAge)); assert.ok(input.stats().sent > 1)
  assert.equal(input.stats().lastError, null); assert.ok(packets.filter(p => p.name === 'player_auth_input').length > 1)
  assert.equal(foraging.snapshot().foodGained, 0); assert.equal(foraging.snapshot().serverConfirmed, false)
})
for (const mode of ['cancel', 'scope', 'life', 'uid', 'death']) test(`a ${mode} change while yielding prevents any movement or hunt dispatch`, async () => {
  const f = scene(), controller = new AbortController(); let starts = 0, previews = 0, scheduled = false
  const foraging = createForaging({ getState: () => {
    if (!scheduled) { scheduled = true; setTimeout(() => {
      if (mode === 'cancel') controller.abort(new Error('cancelled_during_yield'))
      if (mode === 'scope') f.state.connectionId = 'new'
      if (mode === 'life') f.state.lifecycle.deathId++
      if (mode === 'uid') f.target.uniqueId = '-999'
      if (mode === 'death') { f.state.health = 0; f.state.dead = true }
    }, 0) }
    return { ...structuredClone(f.state), entities: [structuredClone(f.target)] }
  }, world: f.world, entities: { snapshot: () => [f.target] }, movement: { preview: () => { previews++; return { ready: true } }, start: () => { starts++; return { phase: 'completed' } }, stop: () => {} }, getMovement: () => ({ phase: 'idle' }), combat: { previewHunt: () => ({ ready: false }), hunt: () => assert.fail('no hunt'), cancel: () => {} } })
  await assert.rejects(foraging.execute({ targetRuntimeId: '2' }, { signal: controller.signal }))
  assert.equal(starts, 0); assert.equal(previews, 0); assert.equal(foraging.snapshot().foodGained, 0)
})
