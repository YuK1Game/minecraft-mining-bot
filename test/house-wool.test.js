'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHouseWool } = require('../src/modes/house/house-wool')

const inv = items => ({ known: true, items: items.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) })

function job ({ sheep = true, items = [['stone_pickaxe', 1]], gains = 3 } = {}) {
  let inventory = inv(items)
  const calls = [], lines = []
  const wool = createHouseWool({
    getMode: () => 'player', shared: { playerWanted: true }, log: text => lines.push(text), sleep: async () => {},
    getState: () => ({ position: { x: 0, y: 65, z: 0 }, inventory }), getBlock: () => null,
    actors: () => sheep ? [{ entityType: 'minecraft:sheep', position: { x: 10, y: 64, z: 3 } }] : [],
    gather: async input => { calls.push(input); inventory = inv([...items, ['white_wool', gains]]) },
    agent: { objective: {}, start: async () => { calls.push('start') }, stop: () => calls.push('stop'), settled: () => true }
  })
  return { wool, calls, lines }
}

test('a sheep near and wool short: the autonomy stops, sheep are hunted, play goes on', async () => {
  const f = job()
  assert.equal(await f.wool.tick(), true)
  assert.deepEqual(f.calls, ['stop', { logs: 0, wool: 3, maxMs: 120000 }, 'start'])
  assert.match(f.lines.join('\n'), /羊毛 3 個を得ました/)
})

test('no sheep near, no pickaxe, or the wool held: nothing happens', async () => {
  assert.equal(await job({ sheep: false }).wool.tick(), null)
  assert.equal(await job({ items: [] }).wool.tick(), null)
  assert.equal(await job({ items: [['stone_pickaxe', 1], ['white_wool', 3]] }).wool.tick(), null)
})
