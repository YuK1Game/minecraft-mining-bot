'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { riseToSky } = require('../src/modes/player-rise')
const { underCover } = require('../src/modes/player-surface')
const heights = require('./fixtures/overhang-heights.json')

const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block' }
const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }

// The received terrain around the starter house (real Realm 2026-11-18 12:45
// JST, see player-sky-walk.test.js) and the Bot's hands over it. `walks`
// false: no walk moves the Bot.
function bot ({ x, y, z, walks = true }) {
  const cells = new Map(), at = { x: x + 0.5, y, z: z + 0.5 }, calls = []
  const block = (bx, by, bz) => {
    const set = cells.get(`${bx},${by},${bz}`)
    if (set) return set
    const top = heights.top[bz - heights.z0]?.[bx - heights.x0], under = heights.under[bz - heights.z0]?.[bx - heights.x0]
    if (top === undefined || by < 62) return { known: false }
    if (top === null) return air
    if (under == null) return by <= top ? stone : air
    return by <= under || by === top ? stone : air
  }
  cells.set(`${x},${y},${z}`, air); cells.set(`${x},${y + 1},${z}`, air)
  const ports = {
    feet: () => ({ ...at }), block, dirt: () => 64, why: () => null, canMine: () => true,
    walk: async target => { const cell = [Math.floor(target.x), Math.floor(target.z)].join(); if (walks || cell === [x, z].join()) Object.assign(at, target); calls.push('walk'); return walks },
    mine: async cell => { calls.push('mine'); cells.set(`${cell.x},${cell.y},${cell.z}`, air); return true },
    pillar: async (column, level) => { calls.push('pillar'); cells.set(`${x},${level},${z}`, { known: true, name: 'minecraft:dirt', boundingBox: 'block' }); cells.set(`${x},${level + 1},${z}`, air); cells.set(`${x},${level + 2},${z}`, air); at.y = level + 1; return { ok: true } }
  }
  const sky = () => !underCover(block, { x: at.x, y: at.y + 1.62, z: at.z })
  return { ports, at, calls, sky }
}

test('real terrain: out of the tunnel it climbs to the ground under the overhang and walks out to the open sky', async () => {
  const sim = bot({ x: -4906, y: 63, z: -4993 }), lines = []
  const out = await riseToSky({ ports: sim.ports, log: text => lines.push(text), sky: sim.sky, sleep: async () => {} })
  assert.equal(out.ok, true)
  assert.equal(out.steps, 6)
  assert.deepEqual(sim.at, { x: -4904.5, y: 70, z: -4992.5 })
  assert.equal(sim.sky(), true)
  assert.equal(sim.calls.filter(call => call === 'pillar').length, 6) // on the Realm: 26 here, up onto the overhang
  assert.ok(lines.some(text => /真上へ6段のぼりました。ここから空の見える場所へ歩いて出られる/.test(text)))
  assert.ok(lines.some(text => /空の見える場所へ歩いて出ます（1マス、-4905,70,-4993）/.test(text)))
})

test('real terrain: standing under the overhang it walks out and digs nothing', async () => {
  const sim = bot({ x: -4912, y: 67, z: -5000 })
  const out = await riseToSky({ ports: sim.ports, sky: sim.sky, sleep: async () => {} })
  assert.deepEqual(out, { ok: true, steps: 0, walked: 13 })
  assert.equal(sim.sky(), true)
  assert.ok(!sim.calls.includes('mine') && !sim.calls.includes('pillar'))
})

test('when the walk to the sky fails, the climb goes on to the ground overhead as before', async () => {
  const sim = bot({ x: -4906, y: 63, z: -4993, walks: false }), lines = []
  const out = await riseToSky({ ports: sim.ports, log: text => lines.push(text), sky: sim.sky, sleep: async () => {} })
  assert.equal(out.ok, true)
  assert.equal(sim.at.y, 89)
  assert.equal(sim.sky(), true)
  assert.ok(lines.some(text => /空の見える場所へ歩く途中で止まりました/.test(text)))
  assert.match(lines.at(-1), /真上へ20段のぼって地上へ出ました/)
})

test('an interruption ends it before anything is dug', async () => {
  const sim = bot({ x: -4906, y: 63, z: -4993 })
  const out = await riseToSky({ ports: sim.ports, sky: sim.sky, aborted: () => true, sleep: async () => {} })
  assert.deepEqual(out, { ok: false, reason: 'INTERRUPTED' })
  assert.deepEqual(sim.calls, [])
})
