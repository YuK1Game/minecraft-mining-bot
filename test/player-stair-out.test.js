'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { gatherFill, arrives } = require('../src/modes/fill-source')
const { skyTarget, stairOut } = require('../src/modes/player-stair-out')
const { climbOut } = require('../src/modes/player-climb')
const { riseToSky } = require('../src/modes/player-rise')
const { buildWalk } = require('../src/modes/player-build-walk')
const { underCover } = require('../src/modes/player-surface')

const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
const named = name => ({ known: true, name: `minecraft:${name}`, boundingBox: 'block' })

// The shaft of 2026-11-19 18:45 JST: stone up to y 75, dirt at 76 and 77, the open sky above; the Bot at the
// bottom of its own shaft (0, 65..68, 0) on two cobblestones. `pickaxe` false: rock is mined by hand and drops nothing.
function shaft ({ pickaxe = false, pack = {}, extra = {} } = {}) {
  const cells = new Map(Object.entries(extra)), at = { x: 0.5, y: 65, z: 0.5 }, held = { ...pack }, calls = []
  const block = (x, y, z) => {
    const set = cells.get(`${x},${y},${z}`)
    if (set) return set
    if (x === 0 && z === 0 && y >= 65 && y <= 68) return air
    if (x === 0 && z === 0 && (y === 63 || y === 64)) return named('cobblestone')
    if (y > 77) return air
    return y >= 76 ? named('dirt') : named('stone')
  }
  const fill = () => (held.dirt ?? 0) + (held.cobblestone ?? 0)
  const drop = name => /dirt|grass/.test(name) ? 'dirt' : pickaxe && /stone$/.test(name) ? 'cobblestone' : null
  const soft = cell => /dirt|grass/.test(block(cell.x, cell.y, cell.z).name)
  const open = cell => { const got = drop(block(cell.x, cell.y, cell.z).name); cells.set(`${cell.x},${cell.y},${cell.z}`, air); if (got) held[got] = (held[got] ?? 0) + 1 }
  const ports = {
    feet: () => ({ ...at }), block, fill, dirt: () => held.dirt ?? 0, why: () => null, reason: () => 'refused', health: () => 20,
    canMine: cell => block(cell.x, cell.y, cell.z).boundingBox === 'block' && (pickaxe || soft(cell)),
    pick: async () => pickaxe,
    mine: async cell => { calls.push(`mine ${cell.x},${cell.y},${cell.z}`); open(cell); return true },
    canDig: cell => /stone$/.test(block(cell.x, cell.y, cell.z).name),
    dig: async cell => { calls.push(`dig ${cell.x},${cell.y},${cell.z}`); open(cell); return true },
    walk: async target => {
      const x = Math.floor(target.x), y = Math.floor(target.y + 0.001), z = Math.floor(target.z)
      const stands = block(x, y - 1, z).boundingBox === 'block' && block(x, y, z) === air && block(x, y + 1, z) === air
      if (stands && Math.abs(y - Math.floor(at.y)) <= 1) Object.assign(at, { x: target.x, y, z: target.z })
      calls.push(`walk ${x},${y},${z}`)
      return stands
    },
    pillar: async (column, level) => {
      const name = held.dirt ? 'dirt' : 'cobblestone'
      if (!fill()) return { ok: false, reason: 'NO_BLOCK' }
      held[name]--; calls.push(`pillar ${level}`)
      cells.set(`${column.x},${level},${column.z}`, named(name)); at.y = level + 1
      return { ok: true }
    }
  }
  const sky = () => !underCover(block, { x: at.x, y: at.y + 1.62, z: at.z })
  const build = (target, options) => buildWalk({ ports, target, ...options, log: () => {}, sleep: async () => {} })
  return { ports, at, calls, held, fill, sky, build, block }
}

test('a drop is counted when it is in the pack, not when the block is gone', async () => {
  let pack = 0, slept = 0
  assert.equal(await arrives({ fill: () => pack, had: 0, sleep: async () => { if (++slept === 3) pack = 1 } }), true)
  assert.equal(slept, 3)
  assert.equal(await arrives({ fill: () => 0, had: 0, sleep: async () => {} }), false)
})

test('with a pickaxe and nothing to stack, the wall beside the feet gives the blocks', async () => {
  const sim = shaft({ pickaxe: true }), lines = []
  const out = await gatherFill({ ports: sim.ports, want: 3, log: text => lines.push(text), sleep: async () => {} })
  assert.equal(out.ok, true)
  assert.equal(out.got, 3)
  assert.equal(sim.fill(), 3)
  assert.ok(sim.calls.filter(call => call.startsWith('mine')).every(call => !/^mine 0,/.test(call)), 'never the own column')
  assert.deepEqual({ x: Math.floor(sim.at.x), y: sim.at.y, z: Math.floor(sim.at.z) }, { x: 0, y: 65, z: 0 })
  assert.match(lines[0], /足の横のブロックを 3 個掘って 3 個拾いました/)
})

test('by hand, rock gives nothing and is left alone; a block a base protects and unreceived cells too', async () => {
  const bare = shaft()
  const none = await gatherFill({ ports: bare.ports, want: 2, sleep: async () => {} })
  assert.deepEqual([none.ok, none.code, bare.calls.length], [false, 'NOTHING_TO_MINE', 0])
  const kept = shaft({ pickaxe: true, extra: { '1,66,0': { ...named('cobblestone'), natural: false }, '1,65,0': { known: false } } })
  await gatherFill({ ports: kept.ports, want: 1, sleep: async () => {} })
  assert.ok(!kept.calls.includes('mine 1,66,0') && !kept.calls.includes('mine 1,65,0'))
  assert.equal(kept.fill(), 1)
  // Dirt beside the feet is taken by hand.
  const earth = shaft({ extra: { '-1,65,0': named('dirt') } })
  const got = await gatherFill({ ports: earth.ports, want: 1, sleep: async () => {} })
  assert.deepEqual([got.ok, earth.held.dirt, earth.calls[0]], [true, 1, 'mine -1,65,0'])
})

test('the climb takes blocks from the wall when it holds none, and comes out', async () => {
  const sim = shaft({ pickaxe: true }), lines = []
  const out = await climbOut({ ports: sim.ports, log: text => lines.push(text), sleep: async () => {} })
  assert.equal(out.ok, true, lines.join('\n'))
  assert.equal(sim.at.y, 78)
  assert.equal(sim.sky(), true)
})

test('the nearest ground under the open sky: received columns only, never a roof it built', () => {
  const sim = shaft()
  const plan = skyTarget({ block: sim.block, feet: sim.at })
  assert.equal(plan.target.y, 78)
  assert.equal(plan.done(plan.target), true)
  assert.equal(plan.done({ x: 0, y: 65, z: 0 }), false)
  // The run of a straight stair is its rise (13): a target right beside the shaft would cost a spiral.
  assert.ok(Math.abs(plan.target.x) + Math.abs(plan.target.z) >= 10)
  const dark = (x, y, z) => y > 90 ? { known: false } : sim.block(x, y, z)
  assert.equal(skyTarget({ block: dark, feet: sim.at }), null)
  const roofed = (x, y, z) => y === 78 ? named('oak_planks') : sim.block(x, y, z)
  assert.equal(skyTarget({ block: roofed, feet: sim.at }), null)
})

test('live 2026-11-19 18:45 JST: nothing to stack and no pickaxe: a stair is mined by hand to the surface', async () => {
  const sim = shaft(), lines = []
  const out = await riseToSky({ ports: sim.ports, log: text => lines.push(text), sky: sim.sky, sleep: async () => {}, build: sim.build })
  assert.equal(out.ok, true, lines.join('\n'))
  assert.equal(out.stair, true)
  assert.equal(sim.sky(), true)
  assert.equal(sim.at.y, 78)
  assert.ok(lines.some(line => /NO_DIRT/.test(line)))
  assert.ok(lines.some(line => /へ段を掘って出ます/.test(line)))
  assert.ok(sim.calls.some(call => call.startsWith('dig')), 'rock by hand')
  assert.ok(!sim.calls.some(call => call.startsWith('pillar')), 'nothing was stacked')
})

test('without the way that digs and stacks, or with no sky in reach, the answer of the climb stands', async () => {
  const sim = shaft()
  const out = await riseToSky({ ports: sim.ports, sky: sim.sky, sleep: async () => {} })
  assert.deepEqual([out.ok, out.reason], [false, 'NO_DIRT'])
  const lines = []
  const none = await stairOut({ ports: { ...sim.ports, block: (x, y, z) => y > 90 ? { known: false } : sim.block(x, y, z) }, build: sim.build, log: text => lines.push(text) })
  assert.deepEqual([none.ok, none.reason], [false, 'NO_SKY_TARGET'])
  assert.match(lines[0], /空の見える地面が受信した範囲にありません/)
  // An interrupted climb is not followed by a stair.
  let asked = 0
  const stopped = await riseToSky({ ports: sim.ports, sky: sim.sky, sleep: async () => {}, aborted: () => true, build: async () => { asked++; return { ok: true } } })
  assert.equal(stopped.ok, false)
  assert.equal(asked, 0)
})
