'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const { createWaterCounterattack } = require('../src/water-counterattack')
const observed = require('./fixtures/realm-water-counterattack.json')

function fixture (changes = {}) {
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, structuredClone(b)]))
  const world = { getBlock: (x, y, z) => changes.openWater ? { known: true, name: y < 60 ? 'minecraft:stone' : y < 63 ? 'minecraft:water' : 'minecraft:air', properties: y >= 60 && y < 63 ? { liquid_depth: 0 } : {}, boundingBox: y < 60 ? 'block' : 'empty', extra: [], position: { x, y, z } } : blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const navigator = createNavigator({ world, version: '1.26.60', allowWater: true })
  const actors = structuredClone(observed.enemies).map(e => ({ ...e, kind: 'mob', alive: true, hostile: true, positionKnown: true, dimension: 'overworld', ...(e.entityType === 'minecraft:creeper' ? { primed: false, charged: false, ignited: false, fuseLength: -1 } : {}) }))
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, position: structuredClone(observed.position), rawServerPosition: structuredClone(observed.rawServerPosition), rawServerPositionUpdatedAt: 1, positionSource: 'client_prediction', predicted: structuredClone(observed.predicted), inventory: { known: true, items: [] }, entities: actors, entityStats: { unknownPositions: 0 } }
  let motion = { phase: 'idle' }; const calls = []
  const movement = {
    preview: (target, opts) => navigator.plan(navigator.physics.fromServer(state), target, opts),
    start: (target, opts) => {
      calls.push({ type: 'move', target, opts })
      if (changes.replanOnce && calls.filter(c => c.type === 'move').length === 1) {
        const initial = navigator.physics.fromServer(state); const route = navigator.plan(initial, target, opts); const stepper = navigator.createStepper(route, initial, { maxTicks: 80 })
        let frame
        for (let i = 0; i < 12; i++) frame = stepper.next()
        state.position = navigator.physics.toServerPosition(frame.predictedState); state.rawServerPosition = structuredClone(state.position); state.rawServerPositionUpdatedAt = 2; state.positionSource = 'client_prediction'; state.predicted = { position: structuredClone(state.position), physicsState: structuredClone(frame.predictedState) }
      }
      motion = { phase: changes.phase ?? 'replan_required' }
    },
    snapshot: () => motion,
    stop: reason => calls.push({ type: 'stop', reason })
  }
  const combat = { physics: navigator.physics, previewWaterCreeper: () => typeof changes.preview === 'function' ? changes.preview(state) : ({ ready: changes.preview !== false, cooldownRemainingMs: 0 }), waterCreeperAttack: async (id, { signal } = {}) => { calls.push({ type: 'attack', id }); if (changes.onAttack) await changes.onAttack(state, signal); return { phase: 'observed', reaction: 'hurt_animation' } }, cancel: reason => calls.push({ type: 'cancel', reason }) }
  const shallowPoint = (point, surfaceY) => {
    try {
      if (!point || point.y < surfaceY - 1.6) return false
      for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
        const top = navigator.physics.blockAt({ x, y: surfaceY - 1, z }); if (!['water', 'flowing_water'].includes(top.name)) return false
        const head = navigator.physics.blockAt({ x, y: Math.floor(point.y + 1.62), z }); if (head.name !== 'air' || head.shapes.length) return false
        let floor = false
        for (let d = 1; d <= 4; d++) { const below = navigator.physics.blockAt({ x, y: surfaceY - 1 - d, z }); if (['water', 'flowing_water'].includes(below.name)) continue; floor = below.shapes.length > 0; break }
        if (!floor) return false
      }
      return true
    } catch { return false }
  }
  const verifyShallow = s => { try { return changes.shallow !== false && !!navigator.physics.waterSurface({ ...s.position, y: s.position.y - 1.62 }) } catch { return false } }
  const actor = createWaterCounterattack({ getState: () => structuredClone(state), world, version: '1.26.60', movement, combat, verifyShallow, shallowPoint })
  return { actor, state, blocks, calls }
}

test('recorded shallow-water position preflights a retreat before one counterattack', async () => {
  const f = fixture()
  const result = await f.actor.execute()
  assert.equal(result.attacked, true, JSON.stringify(result))
  assert.equal(result.escaped, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.reason, 'replan_required')
  assert.deepEqual(f.calls.filter(c => ['attack', 'move'].includes(c.type)).map(c => c.type), ['attack', 'move'])
})

test('brief eye-height changes can make the strike reachable without waiting through an imminent fuse', async () => {
  let previews = 0
  const f = fixture({ preview: () => ++previews <= 2 ? { ready: false, errors: ['対象が安全な近接範囲3.2ブロックの外にいます。'] } : { ready: true, cooldownRemainingMs: 0 } })
  const result = await f.actor.execute()
  assert.equal(result.attacked, true, JSON.stringify(result))
  assert.ok(previews >= 3)
  let blockedPreviews = 0
  const blocked = fixture({ preview: state => { blockedPreviews++; state.entities.find(e => e.runtimeId === '27').primed = true; state.entities.find(e => e.runtimeId === '27').fuseLength = 10; return { ready: false, errors: ['対象が安全な近接範囲3.2ブロックの外にいます。'] } } })
  blocked.state.entities.find(e => e.runtimeId === '27').primed = true; blocked.state.entities.find(e => e.runtimeId === '27').fuseLength = 10
  const stopped = await blocked.actor.execute()
  assert.equal(stopped.attacked, undefined)
  assert.equal(blockedPreviews, 1)
})

test('counterattack refuses missing water, preview or known terrain before an attack', async () => {
  for (const mode of ['water', 'preview', 'terrain', 'health']) {
    const f = fixture({ shallow: mode !== 'water', preview: mode !== 'preview' })
    if (mode === 'terrain') f.blocks.clear()
    if (mode === 'health') f.state.health = 19
    const result = await f.actor.execute()
    assert.equal(result.attacked, undefined, mode)
    assert.equal(f.calls.some(c => c.type === 'attack'), false, mode)
  }
})

test('a new danger or damage after a strike prevents the retreat input', async () => {
  for (const mode of ['damage', 'new_actor', 'identity']) {
    const f = fixture({ onAttack: async state => {
      if (mode === 'damage') state.health = 19
      if (mode === 'new_actor') state.entities.push({ runtimeId: '999', uniqueId: '999', entityType: 'minecraft:zombie', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { ...state.position } })
      if (mode === 'identity') state.entities.find(a => a.runtimeId === '27').uniqueId = 'changed'
    } })
    const result = await f.actor.execute()
    assert.equal(result.attacked, true, mode)
    assert.equal(result.escaped, false, mode)
    assert.equal(f.calls.some(c => c.type === 'move'), false, mode)
  }
})

test('the pushed creeper may leave the danger radius while its identity remains tracked', async () => {
  const f = fixture({ onAttack: async state => { state.entities.find(e => e.runtimeId === '27').position.x -= 6 } })
  const result = await f.actor.execute()
  assert.equal(result.attacked, true, JSON.stringify(result))
  assert.equal(result.reason, 'replan_required', JSON.stringify(result))
  assert.equal(result.escaped, false)
  assert.equal(f.calls.some(c => c.type === 'move'), true)
})

test('the server hurt event can precede the first knockback position', async () => {
  const f = fixture({ onAttack: async state => { setTimeout(() => { state.entities.find(e => e.runtimeId === '27').position.x -= 1 }, 60) } })
  f.state.entities.find(e => e.runtimeId === '27').position.x = -6.85
  const result = await f.actor.execute()
  assert.equal(result.attacked, true, JSON.stringify(result))
  assert.equal(result.reason, 'replan_required', JSON.stringify(result))
  assert.equal(f.calls.some(c => c.type === 'move'), true)
})

test('a fresh server correction with real progress replans the remaining water counterattack once', async () => {
  const f = fixture({ replanOnce: true, openWater: true })
  f.state.position = { x: 0.5, y: 64.2, z: 0.5 }; f.state.rawServerPosition = structuredClone(f.state.position); f.state.predicted = null; f.state.positionSource = 'start_game'
  f.state.entities = [
    { runtimeId: '27', uniqueId: '27', entityType: 'minecraft:creeper', kind: 'mob', alive: true, hostile: true, positionKnown: true, dimension: 'overworld', primed: false, charged: false, position: { x: -3, y: 62, z: 0.5 } },
    { runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', kind: 'mob', alive: true, hostile: true, positionKnown: true, dimension: 'overworld', primed: false, charged: false, position: { x: -3, y: 62, z: -4.5 } }
  ]
  const result = await f.actor.execute()
  assert.equal(result.attacked, true, JSON.stringify(result))
  assert.equal(result.escaped, false)
  assert.equal(f.calls.filter(c => c.type === 'move').length, 2, JSON.stringify({ result, position: f.state.position, calls: f.calls.filter(c => c.type === 'move') }))
})

test('new observations are checked against the entire route before movement begins', async () => {
  for (const mode of ['knockback', 'secondary_closer', 'new_enemy']) {
    const f = fixture({ onAttack: async state => { setImmediate(() => {
      if (mode === 'knockback') state.entities.find(e => e.runtimeId === '27').position.x -= 0.4
      if (mode === 'secondary_closer') state.entities.find(e => e.runtimeId === '9').position = { ...state.position }
      if (mode === 'new_enemy') state.entities.push({ runtimeId: '999', uniqueId: '999', entityType: 'minecraft:zombie', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { ...state.position } })
    }) } })
    const result = await f.actor.execute()
    assert.equal(result.attacked, true, mode)
    assert.equal(f.calls.some(c => c.type === 'move'), mode === 'knockback', JSON.stringify({ mode, result }))
    assert.equal(result.escaped, false)
  }
})
