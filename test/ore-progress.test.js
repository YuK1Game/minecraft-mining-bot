'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAutonomy } = require('../src/autonomy')
const { nextDiamondAction } = require('../src/diamond-planner')

function scene (hooks = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'socket', runtimeEntityId: '41', dimension: 'overworld', health: 20, gameMode: 'survival', position: { x: 15.5, y: 65.62, z: 0.5 }, entities: [], inventory: { known: true, items: [{ name: 'minecraft:iron_pickaxe', slot: 0, count: 1, durabilityKnown: true, durabilityRemaining: 250 }] }, rawSelectedSlot: 0, selectedSlot: 0, heldItem: { name: 'minecraft:iron_pickaxe', slot: 0, count: 1 }, world: { initialized: true, loadedSections: 27 }, capabilities: { prospect: true, explore: true, mine_ore: true, tunnel: true } }
  const observations = { blocks: [], ores: { coal: [], iron: [], diamond: [] }, entities: [], crafting: { previews: {} }, capabilities: state.capabilities }
  const calls = []
  const actions = {
    prospect: async decision => {
      calls.push({ type: 'prospect', resource: decision.resource })
      return hooks.prospect ? hooks.prospect(state, decision) : { ok: true, phase: 'completed', serverConfirmed: true, confirmedBy: 'server_block_observations', known: 4096, unknown: 0, ores: { coal: [], iron: [], diamond: [] } }
    },
    explore: async decision => { calls.push({ type: 'explore', resource: decision.resource }); state.position.x += 2; return { ok: true, phase: 'completed', explored: true } },
    tunnel: async decision => { calls.push({ type: 'tunnel', target: { ...decision.target } }); return hooks.tunnel(state, decision) }
  }
  const autonomy = createAutonomy({ getState: () => structuredClone(state), observe: () => structuredClone(observations), actions, planAction: nextDiamondAction, intervalMs: 60000 })
  return { state, observations, calls, autonomy }
}

test('a completed empty ore scan leads to bounded exploration and a fresh scan after changing chunk', async t => {
  const f = scene(); t.after(() => f.autonomy.stop())
  f.autonomy.start({ objective: 'diamond', diamondCount: 1, maxExplorations: 1 })
  for (let i = 0; i < 3; i++) await f.autonomy.tick()
  assert.deepEqual(f.calls.map(call => call.type), ['prospect', 'explore', 'prospect'])
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.equal(f.autonomy.snapshot().progress.emptyProspects.length, 2)
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
  assert.equal(f.calls.filter(call => call.type === 'explore').length, 1)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:diamond'), false)
})

test('unconfirmed or incomplete scan returns cannot authorize ore exploration', async t => {
  for (const mode of ['unconfirmed', 'missing_observations', 'session_changed', 'moved']) {
    const f = scene({ prospect: state => {
      if (mode === 'session_changed') state.connectionId = 'other'
      if (mode === 'moved') state.position.x += 2
      return { ok: true, phase: 'completed', serverConfirmed: mode !== 'unconfirmed', confirmedBy: 'server_block_observations', ...(mode === 'missing_observations' ? {} : { known: 4096, unknown: 0, ores: { coal: [], iron: [], diamond: [] } }) }
    } }); t.after(() => f.autonomy.stop())
    f.autonomy.start({ objective: 'diamond' }); await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().progress.emptyProspects.length, 0, mode)
    assert.equal(f.calls.some(call => call.type === 'explore'), false, mode)
  }
})

test('an empty prospect receipt is ignored after a Realm or connection change', async t => {
  for (const mode of ['realm', 'connection']) {
    const f = scene(); t.after(() => f.autonomy.stop())
    f.autonomy.start({ objective: 'diamond' }); await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().progress.emptyProspects.length, 1)
    if (mode === 'realm') f.state.realm.id = '99'
    else f.state.connectionId = 'other'
    await f.autonomy.tick()
    assert.deepEqual(f.calls.map(call => call.type), ['prospect', 'prospect'], mode)
    assert.equal(f.autonomy.snapshot().progress.emptyProspects.length, 1, mode)
  }
})

test('an explicit unreachable diamond vein is excluded and another observed vein is selected', async t => {
  const first = { x: 16, y: 62, z: 0 }, second = { x: 19, y: 62, z: 0 }
  const f = scene({ tunnel: (state, decision) => {
    if (decision.target.x === first.x) throw Object.assign(new Error('No complete route'), { code: 'NO_SAFE_ROUTE' })
    return { ok: true, phase: 'completed', serverConfirmed: false }
  } }); t.after(() => f.autonomy.stop())
  f.observations.ores.diamond = [first, second].map(position => ({ known: true, name: 'minecraft:diamond_ore', position, requiresTunnel: true }))
  f.autonomy.start({ objective: 'diamond', maxRetries: 0 }); await f.autonomy.tick(); await f.autonomy.tick()
  assert.deepEqual(f.calls.filter(call => call.type === 'tunnel').map(call => call.target), [first, second])
  assert.equal(f.autonomy.snapshot().phase, 'running')
  const excluded = f.autonomy.snapshot().progress.excludedResources
  assert.equal(excluded.length, 1)
  assert.equal(excluded[0].resource, 'diamond')
  assert.deepEqual(excluded[0].position, first)
  assert.equal(typeof excluded[0].scope, 'string')
})

test('ore exclusions require NO_SAFE_ROUTE in the original scope and do not survive a scope change', async t => {
  for (const mode of ['other_error', 'during_change', 'after_change']) {
    let failed = false
    const f = scene({ tunnel: state => {
      if (failed) return { ok: true, phase: 'completed' }
      failed = true
      if (mode === 'during_change') state.connectionId = 'other'
      throw Object.assign(new Error('Route rejected'), { code: mode === 'other_error' ? 'PREVIEW_REJECTED' : 'NO_SAFE_ROUTE' })
    } }); t.after(() => f.autonomy.stop())
    const position = { x: 16, y: 62, z: 0 }
    f.observations.ores.diamond = [{ known: true, name: 'minecraft:diamond_ore', position, requiresTunnel: true }]
    f.autonomy.start({ objective: 'diamond', maxRetries: 0 }); await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().progress.excludedResources.length, mode === 'after_change' ? 1 : 0, mode)
    if (mode === 'after_change') {
      f.state.realm.id = '99'; f.state.connectionId = 'other'
      await f.autonomy.tick()
      assert.equal(f.autonomy.snapshot().progress.excludedResources.length, 0)
      assert.deepEqual(f.calls.filter(call => call.type === 'tunnel').map(call => call.target), [position, position])
    }
  }
})
