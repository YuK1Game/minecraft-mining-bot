'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createChunkTravel } = require('../src/chunk-travel')
const { observedScope } = require('../src/server-position-verifier')
const { originDisagreement, reconcileMoveOrigin, planningOrigin } = require('../src/move-origin')
const { setImmediate: turn } = require('node:timers/promises')
const copy = value => structuredClone(value)

// Live 2026-11-13 22:35: the last received server position (22:21, feet y71.84
// in the air) and the working prediction (feet y70) disagreed; a chunk move to
// the bot's own chunk failed before its first leg (CHUNK_TRAVEL_FAILED, legs=0).
test('a stale received position in the air triggers one witness of both origins; a mismatched prediction is discarded', async () => {
  const state = { position: { x: 1946.83, y: 71.62, z: -2037.26 }, rawServerPosition: { x: 1946.83, y: 73.46, z: -2037.26 }, rawServerPositionUpdatedAt: '2026-11-13T13:21:14.907Z' }
  const now = Date.parse('2026-11-13T13:35:34Z')
  const hasSupport = feet => Math.abs(feet.y - 70) < 1e-6
  assert.ok(originDisagreement(state, { now, hasSupport }))
  assert.equal(originDisagreement({ ...state, rawServerPosition: state.position, rawServerPositionUpdatedAt: new Date(now).toISOString() }, { now, hasSupport }), null, 'fresh and matching')
  const asked = [], discarded = []
  const result = await reconcileMoveOrigin({ state, now, hasSupport, discardPrediction: r => discarded.push(r),
    confirm: async feet => { asked.push(feet.y); return { serverConfirmed: Math.abs(feet.y - 70) < 1e-3 } } })
  assert.deepEqual(asked, [70, 71.84]); assert.equal(result.workingOk, true); assert.equal(result.receivedOk, false); assert.deepEqual(discarded, [])
  // The received one confirmed instead: the disproved prediction is discarded.
  const flipped = await reconcileMoveOrigin({ state, now, hasSupport, discardPrediction: r => discarded.push(r), confirm: async feet => ({ serverConfirmed: Math.abs(feet.y - 71.84) < 1e-3 }) })
  assert.equal(flipped.action, 'discarded_prediction'); assert.equal(discarded.length, 1)
})

test('live case 22:35: the chunk move from the same state reaches the chunk instead of failing before its first leg', async () => {
  let stalePrediction = true, discards = 0, clock = 100000
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'c', startedAt: '2026-11-13T12:49:48.473Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20,
    position: { x: 1946.83, y: 71.62, z: -2037.26 }, rawServerPosition: { x: 1946.83, y: 73.46, z: -2037.26 }, rawServerPositionUpdatedAt: '2026-11-13T13:21:14.907Z', inventory: { known: true, items: [] } }
  const steps = (from, to) => { const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z))), out = []; for (let i = 1; i <= n; i++) out.push({ position: { x: from.x + (to.x - from.x) * i / n, y: to.y, z: from.z + (to.z - from.z) * i / n }, action: 'walk', medium: 'land' }); return out }
  const here = () => ({ x: state.position.x, y: state.position.y - 1.62, z: state.position.z })
  const getBlock = (x, y, z) => ({ known: true, name: y < 70 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 70 ? 'block' : 'empty', extra: [] })
  // The runtime's planning entry: witness when needed, then an origin that a
  // mismatched prediction can no longer break.
  const fromServer = s => { if (stalePrediction) throw new Error('Prediction metadata does not match its working position'); return { position: { x: s.position.x, y: s.position.y - 1.62, z: s.position.z } } }
  const travel = createChunkTravel({
    getState: () => copy(state), getBlock, getMovement: () => ({ phase: 'idle', running: false }), generation: () => 1, jobIdentity: () => null, now: () => clock,
    sleep: async ms => { clock += Math.max(1, ms); await turn() }, uuid: () => '01234567-89ab-4cde-8123-456789abcdef', pollMs: 5,
    acquire: async () => {}, release: async () => {},
    planRoute: async target => {
      await reconcileMoveOrigin({ state, now: Date.parse('2026-11-13T13:35:34Z'), hasSupport: f => Math.abs(f.y - 70) < 1e-6, discardPrediction: () => {}, confirm: async f => ({ serverConfirmed: Math.abs(f.y - 70) < 1e-3 }) })
      const origin = planningOrigin({ fromServer, getState: () => state, discardPrediction: () => { stalePrediction = false; discards++ } })
      return { ready: true, origin: origin.position, target, waypoints: steps(origin.position, target) }
    },
    previewMove: async target => ({ ready: true, origin: here(), target, waypoints: steps(here(), target) }),
    startMove: (target, value) => { value.beforeInput(); state.position = { x: target.x, y: target.y + 1.62, z: target.z }; return { phase: 'awaiting_server_confirmation', running: false } },
    stopMove: () => {},
    confirmPosition: async (feet, value) => ({ serverConfirmed: true, kind: 'server_position_volume', scope: observedScope(state), feet: copy(feet), radius: value.radius, receivedAt: clock })
  })
  // An area next to the bot, so a route is planned (the failing path at 22:35).
  travel.start({ area: { x1: 121, z1: -127 } }); await travel.drain()
  const s = travel.status()
  assert.equal(s.phase, 'arrived', JSON.stringify(s.error))
  assert.equal(discards, 1, 'the mismatched prediction was discarded once')
})
