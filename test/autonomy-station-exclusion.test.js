'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAutonomy } = require('../src/survival/autonomy')

test('a station whose standing place has no route is excluded instead of ending the run', async t => {
  const state = { phase: 'spawned', health: 20, inventory: { known: true, items: [] }, entities: [], position: { x: 0, y: 64, z: 0 }, capabilities: { move_to: true } }
  const station = { x: 5, y: 67, z: 3 }
  let moves = 0, other = 0
  const agent = createAutonomy({
    getState: () => structuredClone(state), observe: async () => ({ blocks: [] }),
    planAction: (current, observations) => (observations.progress?.excludedResources ?? []).some(entry => entry.resource === 'crafting_table')
      ? { type: 'probe', reason: 'made here' }
      : { type: 'move_to', stage: 'crafting_table', resource: 'crafting_table', reason: 'test', target: { x: 5.5, y: 67, z: 2.5 }, stationTarget: station },
    actions: { move_to: async () => { moves++; throw Object.assign(new Error('No known safe standing position has a valid route'), { code: 'NO_SAFE_ROUTE' }) }, probe: async () => { other++; return { ok: true, phase: 'completed' } } }
  })
  t.after(() => agent.stop())
  agent.start({ objective: 'diamond' })
  for (let n = 0; n < 12 && other === 0; n++) await agent.tick()
  const snapshot = agent.snapshot()
  assert.ok(moves > 0)
  assert.equal(other > 0, true, snapshot.reason)
  assert.deepEqual(snapshot.progress.excludedResources.filter(entry => entry.resource === 'crafting_table').map(entry => entry.position), [station])
})
