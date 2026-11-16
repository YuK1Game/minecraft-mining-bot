'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createObserver } = require('../src/survival/runner')

// Real Realm 2026-11-16 21:30 JST: the diamond planner asked to preview the
// diamond pickaxe 42 times; the observation previewed only a fixed list, so
// the planner never saw the answer and asked again.
test('an output the planner previewed is observed again on the next observation', async () => {
  const state = { phase: 'spawned', startedAt: 's', dimension: 'overworld', health: 20, position: { x: 0.5, y: 65.62, z: 0.5 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:diamond', count: 18 }] }, crafting: { authority: true } }
  const asked = []
  const request = async (method, path, body) => {
    if (method === 'GET') return { blocks: [] }
    asked.push(body.output)
    return body.output === 'minecraft:diamond_pickaxe' ? { ready: false, needsCraftingTable: true } : { ready: false }
  }
  const previewCache = new Map([['minecraft:diamond_pickaxe', { digest: 'x', times: 1, preview: { ready: false, needsCraftingTable: true } }]])
  const observer = createObserver({ request, refreshState: async () => structuredClone(state), getState: () => state, previewCache, scanRadius: 1, below: 1, above: 1 })
  const observation = await observer.observe()
  assert.ok(asked.includes('minecraft:diamond_pickaxe'))
  assert.equal(observation.crafting.previews['minecraft:diamond_pickaxe'].needsCraftingTable, true)
})
