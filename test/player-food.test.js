'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerFood } = require('../src/modes/player-food')

const inv = items => ({ known: true, items: items.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) })
const roof = (x, y, z) => y >= 15 && y <= 16 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' }

function job ({ hunger = 14, items = [['stone', 3]], getBlock = roof, climbed = { ok: true } } = {}) {
  const calls = [], lines = []
  const food = createPlayerFood({
    getMode: () => 'player', shared: { playerWanted: true }, log: text => lines.push(text), sleep: async () => {},
    getHunger: () => hunger, getState: () => ({ position: { x: 0.5, y: 13.6, z: 0.5 }, inventory: inv(items) }), getBlock,
    climb: async () => { calls.push('climb'); return climbed },
    agent: { objective: {}, start: async () => { calls.push('start') }, stop: () => calls.push('stop') }
  })
  return { food, calls, lines }
}

test('no food, hungry, under a roof: the autonomy stops, the Bot climbs out, play goes on (live 2026-11-17 08:16-08:20 JST)', async () => {
  const f = job()
  assert.equal(await f.food.tick(), true)
  assert.deepEqual(f.calls, ['stop', 'climb', 'start'])
  assert.match(f.lines.join('\n'), /食料がなく満腹度が 14/)
  assert.equal(await f.food.tick(), null, 'five minutes between tries')
})

test('nothing with food held, hunger above 14, or open sky', async () => {
  assert.equal(await job({ items: [['bread', 1]] }).food.tick(), null)
  assert.equal(await job({ hunger: 15 }).food.tick(), null)
  assert.equal(await job({ getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }) }).food.tick(), null)
})

test('the house build waits while hungry with no food (live 2026-11-17 08:26-08:29 JST)', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/modes/mode-runtime'), 'utf8')
  const house = source.slice(source.indexOf('const house = createHouseBuild('))
  assert.match(house.slice(0, house.indexOf('onDone')), /blocked: \(\) => [^\n]*hungryWithoutFood\(\)/)
})

test('on open ground, a food source the forage cannot step to: long travel to it, then play goes on (live 2026-11-17 08:32-08:35 JST)', async () => {
  const calls = [], lines = []
  let busy = false
  const food = createPlayerFood({
    getMode: () => 'player', shared: { playerWanted: true }, log: text => lines.push(text), sleep: async () => { busy = false },
    getHunger: () => 12, getState: () => ({ position: { x: 0.5, y: 65.6, z: 0.5 }, inventory: inv([['stone', 3]]) }), getBlock: () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty' }),
    climb: async () => { calls.push('climb'); return { ok: true } }, prey: () => ({ x: -26.5, y: 71, z: 18.4 }),
    travel: { to: async input => { calls.push(input); busy = true }, status: () => ({ busy }), cancel: async () => {} },
    agent: { objective: {}, start: async () => { calls.push('start') }, stop: () => calls.push('stop') }
  })
  assert.equal(await food.tick(), true)
  assert.deepEqual(calls, ['stop', { destination: { x: -27, z: 18 } }, 'start'])
  assert.match(lines.join('\n'), /食料源 \(-27, 18\) へ長距離移動/)
})
