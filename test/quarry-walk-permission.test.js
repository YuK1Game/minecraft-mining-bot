'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')

function fixture ({ preview, beforeStart, frame, travel = () => true } = {}) {
  const state = { position: { x: 0.5, y: 1.62, z: 0.5 } }
  const unknown = new Set(), starts = [], sent = [], previews = []
  const ports = {
    getState: () => structuredClone(state),
    getBlock: (x, y, z) => ({ known: !unknown.has(`${x},${y},${z}`), name: 'minecraft:air' }),
    getMovement: () => ({ phase: 'completed' }),
    movement: {
      preview: (target, options) => {
        previews.push({ target, options })
        return preview ? preview(target, state) : { ready: true, waypoints: [{ position: { x: state.position.x, y: state.position.y - 1.62, z: state.position.z } }, { position: target }] }
      },
      start: (target, options) => {
        starts.push({ target, options })
        beforeStart?.({ state, unknown })
        // Match movement.emitFrame: the synchronous guard runs before queue.
        const predicted = frame ?? target
        options.beforeInput?.({ phase: 'moving', predictedState: { position: predicted }, packetPosition: { ...predicted, y: predicted.y + 1.62 } })
        sent.push(predicted)
        state.position = { x: target.x, y: target.y + 1.62, z: target.z }
      }
    }
  }
  return { adapter: createQuarryRuntimeAdapter(ports), state, starts, sent, previews, unknown, travel }
}

test('walk rejects a forbidden native detour even when both endpoints are permitted', async () => {
  const f = fixture({ preview: target => ({ ready: true, waypoints: [{ position: { x: 0.5, y: 0, z: 2.5 } }, { position: target }] }), travel: p => p.z === 0 })
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: f.travel }), { code: 'QUARRY_TRAVEL_NOT_PERMITTED' })
  assert.equal(f.starts.length, 0)
})

test('walk rejects unknown head terrain in a native waypoint before starting', async () => {
  const f = fixture()
  f.unknown.add('1,1,0')
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: f.travel }), { code: 'QUARRY_TRAVEL_TERRAIN_UNKNOWN' })
  assert.equal(f.starts.length, 0)
})

test('walk preserves short segmentation for a known permitted long route', async () => {
  const f = fixture(), path = Array.from({ length: 19 }, (_, x) => ({ x, y: 0, z: 0 }))
  await f.adapter.moveTo(path.at(-1), { path, travel: p => p.x >= 0 && p.x <= 18 && p.z === 0 && p.y >= 0 && p.y <= 1 })
  assert.equal(f.starts.length, 3)
  assert.equal(f.sent.length, 3)
  assert.ok(f.starts.every(s => typeof s.options.beforeInput === 'function'))
})

test('the input guard rejects a changed native path before its first wire input', async () => {
  const f = fixture({ frame: { x: 1.5, y: 0, z: 1.1 }, travel: p => p.z === 0 })
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: f.travel }), { code: 'QUARRY_TRAVEL_NOT_PERMITTED' })
  assert.equal(f.starts.length, 1)
  assert.equal(f.sent.length, 0)
})

test('the input guard rereads terrain after preview and rejects newly unknown head space', async () => {
  const f = fixture({ beforeStart: ({ unknown }) => unknown.add('1,1,0') })
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: f.travel }), { code: 'QUARRY_TRAVEL_TERRAIN_UNKNOWN' })
  assert.equal(f.sent.length, 0)
})

test('a fractional jump checks actual head height instead of just integer feet plus one', async () => {
  const f = fixture({ frame: { x: 1.5, y: 0.4, z: 0.5 }, travel: p => p.y < 2 })
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: f.travel }), { code: 'QUARRY_TRAVEL_NOT_PERMITTED' })
  assert.equal(f.sent.length, 0)
})

test('abort after preview stops the guarded input without sending', async () => {
  const abort = new AbortController()
  const f = fixture({ beforeStart: () => abort.abort() })
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { signal: abort.signal, travel: f.travel }), { code: 'ABORTED' })
  assert.equal(f.sent.length, 0)
})

test('guarded preview requires finite complete waypoints and never accepts ready alone', async () => {
  for (const waypoints of [undefined, [], [{ position: { x: NaN, y: 0, z: 0.5 } }]]) {
    const f = fixture({ preview: () => ({ ready: true, waypoints }) })
    await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: f.travel }), { code: 'QUARRY_TRAVEL_ROUTE_UNCONFIRMED' })
    assert.equal(f.starts.length, 0)
  }
})

test('legacy movement without an explicit travel callback preserves its existing contract', async () => {
  const f = fixture({ preview: () => ({ ready: true }) })
  f.unknown.add('1,1,0')
  await f.adapter.moveTo({ x: 1, y: 0, z: 0 })
  assert.equal(f.sent.length, 1)
  assert.equal(f.starts[0].options.beforeInput, undefined)
})

test('an explicitly invalid travel guard fails before native planning', async () => {
  const f = fixture()
  await assert.rejects(() => f.adapter.moveTo({ x: 1, y: 0, z: 0 }, { travel: null }), { code: 'QUARRY_TRAVEL_GUARD_INVALID' })
  assert.equal(f.previews.length, 0)
  assert.equal(f.sent.length, 0)
})

test('the real native movement controller runs the supplied guard before player_auth_input queue', async t => {
  const { createMovement } = require('../src/movement')
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, runtimeEntityId: '41', positionUpdatedAt: 'server', position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: -90, pitch: 0 } }
  const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) }
  const sent = []
  const native = createMovement({ client: { queue: (name, packet) => { sent.push({ name, packet }); return { tick: packet.tick } } }, getState: () => structuredClone(state), world, startGame: { current_tick: 1000n }, startGameReceivedAt: 0, version: '1.26.60', clock: () => 20000 })
  t.after(() => native.stop())
  let allowed = true
  const adapter = createQuarryRuntimeAdapter({ getState: () => structuredClone(state), getBlock: world.getBlock, getMovement: () => native.snapshot(), movement: {
    preview: (target, options) => native.preview(target, options),
    start: (target, options) => { allowed = false; return native.start(target, options) }
  } })
  await assert.rejects(() => adapter.moveTo({ x: 1, y: 65, z: 0 }, { travel: () => allowed }), /QUARRY_TRAVEL_NOT_PERMITTED/)
  assert.equal(native.snapshot().phase, 'failed')
  assert.equal(sent.length, 0, 'actual movement.emitFrame rejected before client.queue')
})
