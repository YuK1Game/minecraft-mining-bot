'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProspecting } = require('../src/prospecting')

test('prospecting sends only bounded read requests and records actual ores, preserving unknown blocks', async () => {
  const packets = []
  const state = { phase: 'spawned', dimension: 'overworld', position: { x: 8.5, y: 65.62, z: 8.5 } }
  const blocks = new Map([['4,0,4', 'minecraft:diamond_ore'], ['3,1,3', 'minecraft:iron_ore'], ['2,2,2', 'minecraft:coal_ore']])
  const world = { getBlock: (x, y, z) => x === 15 && z === 15 ? { known: false } : { known: true, name: blocks.get(`${x},${y},${z}`) ?? 'minecraft:stone', runtimeId: 1, extra: [] } }
  const prospect = createProspecting({ client: { queue: (name, data) => packets.push({ name, data }) }, getState: () => state, world, delay: async () => {}, yieldNow: async () => {} })
  const result = await prospect.scan({ minY: 0, maxY: 2, chunkRadius: 0 })
  assert.equal(packets.length, 1)
  assert.equal(packets[0].name, 'subchunk_request')
  assert.deepEqual(packets[0].data.requests, [{ x: 0, y: 0, z: 0 }])
  assert.deepEqual(result.ores.diamond[0].position, { x: 4, y: 0, z: 4 })
  assert.equal(result.ores.iron.length, 1)
  assert.equal(result.unknown, 3)
  assert.equal(result.phase, 'ready')
})

test('invalid dimensions or unbounded scans cannot send requests', async () => {
  let sent = 0
  const prospect = createProspecting({ client: { queue: () => sent++ }, getState: () => ({ phase: 'spawned', dimension: 'nether', position: { x: 0, y: 64, z: 0 } }), world: { getBlock: () => ({ known: false }) } })
  await assert.rejects(prospect.scan({ chunkRadius: 2 }))
  await assert.rejects(prospect.scan())
  assert.equal(sent, 0)
})

test('a capped scan keeps nearby deep ores instead of discarding them for higher distant ores', async () => {
  const state = { phase: 'spawned', dimension: 'overworld', position: { x: 8.5, y: 0.5, z: 8.5 } }
  const ores = new Set(['8,0,8', '9,0,8', '0,8,0', '1,8,0', '2,8,0', '3,8,0', '4,8,0', '5,8,0'])
  const world = { getBlock: (x, y, z) => ({ known: true, name: ores.has(`${x},${y},${z}`) ? 'minecraft:diamond_ore' : 'minecraft:stone', runtimeId: 1, extra: [] }) }
  const prospect = createProspecting({ client: { queue: () => {} }, getState: () => state, world, delay: async () => {}, yieldNow: async () => {} })
  const result = await prospect.scan({ minY: 0, maxY: 8, chunkRadius: 0, maxResults: 2 })
  assert.deepEqual(result.ores.diamond.map(ore => ore.position), [{ x: 8, y: 0, z: 8 }, { x: 9, y: 0, z: 8 }])
})

test('a scan cannot publish ore results after its connection, dimension or spawn changes', async () => {
  for (const changed of ['dimension', 'connectionId', 'runtimeEntityId', 'phase']) {
    for (const stage of ['request', 'scan']) {
      const state = { phase: 'spawned', dimension: 'overworld', connectionId: 'a', startedAt: 'a', runtimeEntityId: '1', position: { x: 8, y: 65, z: 8 } }
      const change = () => { state[changed] = changed === 'dimension' ? 'nether' : changed === 'phase' ? 'disconnected' : 'different' }
      const world = { getBlock: () => ({ known: true, name: 'minecraft:diamond_ore', runtimeId: 1, extra: [] }) }
      const prospect = createProspecting({ client: { queue: () => {} }, getState: () => state, world, delay: async () => { if (stage === 'request') change() }, yieldNow: async () => { if (stage === 'scan') change() } })
      await assert.rejects(prospect.scan({ minY: 0, maxY: 2, chunkRadius: 0 }), /接続またはディメンション/)
      assert.equal(prospect.snapshot().phase, 'failed', `${changed} ${stage}`)
    }
  }
})
