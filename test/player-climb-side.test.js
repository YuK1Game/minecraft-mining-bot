'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sidestep, dryColumn, dryColumns } = require('../src/modes/player-climb-side')
const { climbOut } = require('../src/modes/player-climb')

const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block' }, air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }, water = { known: true, name: 'minecraft:water', boundingBox: 'empty' }
// Stone everywhere up to y 60, air above. The Bot stands at (0, 43, 0) in a two-high gap. A pool of
// water lies on the stone at y 47-49 over x -2..2, z -2..2 (the real Realm 2026-11-16 15:12 JST).
function world ({ pool = 2, extra = {} } = {}) {
  const cells = new Map(Object.entries(extra)), at = { x: 0.5, y: 43, z: 0.5 }, calls = []
  let fill = 64
  const block = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (cells.has(key)) return cells.get(key)
    if (y >= 47 && y <= 49 && Math.abs(x) <= pool && Math.abs(z) <= pool) return water
    if (y > 60) return air
    return stone
  }
  cells.set('0,43,0', air); cells.set('0,44,0', air); cells.set('0,45,0', air)
  const beside = cell => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => /water|gravel/.test(block(cell.x + dx, cell.y + dy, cell.z + dz).name))
  const ports = {
    feet: () => ({ ...at }), block, dirt: () => fill, why: () => null, reason: () => '対象の隣に液体・落下ブロックなどがあります。',
    canMine: cell => !beside(cell),
    mine: async cell => { calls.push(`mine ${cell.x},${cell.y},${cell.z}`); cells.set(`${cell.x},${cell.y},${cell.z}`, air); return true },
    walk: async target => { const open = (x, y, z) => block(x, y, z).boundingBox === 'empty'; const x = Math.floor(target.x), z = Math.floor(target.z); if (open(x, target.y, z) && open(x, target.y + 1, z)) { at.x = target.x; at.z = target.z } return true },
    pillar: async (column, y) => { cells.set(`${column.x},${y},${column.z}`, { known: true, name: 'minecraft:dirt', boundingBox: 'block' }); at.y = y + 1; fill--; return { ok: true } }
  }
  return { ports, calls, at, block }
}

test('a column is dry only when nothing above it, or beside its way up, is liquid, falling or unreceived', () => {
  const { block } = world()
  assert.equal(dryColumn(block, 0, 43, 0), false) // under the pool
  assert.equal(dryColumn(block, 3, 43, 0), false) // beside the pool
  assert.equal(dryColumn(block, 4, 43, 0), true)
  const gravel = world({ extra: { '4,50,0': { known: true, name: 'minecraft:gravel', boundingBox: 'block' } } })
  assert.equal(dryColumn(gravel.block, 4, 43, 0), false)
  const unknown = world({ extra: { '4,48,0': { known: false } } })
  assert.equal(dryColumn(unknown.block, 4, 43, 0), false)
  assert.equal(dryColumns(block, 0, 43, 0)[0].steps, 4)
})

test('under water: drifts sideways to the nearest dry column and the climb goes on from there', async () => {
  const sim = world()
  const first = await climbOut({ ports: sim.ports, sleep: async () => {} })
  assert.equal(first.reason, 'CANNOT_MINE')
  const logs = []
  const moved = await sidestep({ ports: sim.ports, log: text => logs.push(text) })
  assert.equal(moved.ok, true)
  assert.equal(Math.abs(Math.floor(sim.at.x)) + Math.abs(Math.floor(sim.at.z)), 4)
  assert.equal(sim.at.y, 43)
  assert.match(logs[0], /横へ4マス掘ってから上がります/)
  assert.ok(sim.calls.length >= 8 && sim.calls.every(call => [43, 44].includes(Number(call.split(',')[1]))))
  const out = await climbOut({ ports: sim.ports, sleep: async () => {} })
  assert.equal(out.ok, true)
  assert.equal(sim.at.y, 61)
})

test('no dry column near, or a drift the mining check refuses: says why and stays', async () => {
  const wide = world({ pool: 12 })
  const logs = []
  assert.equal((await sidestep({ ports: wide.ports, log: text => logs.push(text) })).reason, 'NO_DRY_COLUMN')
  assert.match(logs[0], /見つかりません/)
  const shut = world()
  shut.ports.canMine = () => false
  const out = await sidestep({ ports: shut.ports, log: text => logs.push(text) })
  assert.equal(out.reason, 'DRIFT_REFUSED')
  assert.deepEqual(shut.calls, [])
  assert.equal(shut.at.x, 0.5)
  const stopped = world()
  assert.equal((await sidestep({ ports: stopped.ports, aborted: () => true })).reason, 'INTERRUPTED')
})

test('under leaves: a column with leaves in its way up is not chosen, and the drift does not cut leaves', async () => {
  const leaf = { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block' }
  // No pool; a tree crown at y 62 over x -3..3, z -3..3 (the real Realm 2026-11-16 16:16 JST).
  const crown = {}
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) crown[`${x},62,${z}`] = leaf
  const sim = world({ pool: -1, extra: crown })
  assert.equal(dryColumn(sim.block, 0, 43, 0), false)
  assert.equal(dryColumn(sim.block, 3, 43, 0), false)
  assert.equal(dryColumn(sim.block, 4, 43, 0), true)
  const moved = await sidestep({ ports: sim.ports })
  assert.equal(moved.ok, true)
  assert.equal(Math.abs(moved.column.x) + Math.abs(moved.column.z), 4)
  // Leaves in the drift's way end that drift.
  const shut = world({ pool: -1, extra: { ...crown, '1,43,0': leaf, '-1,43,0': leaf, '0,43,1': leaf, '0,43,-1': leaf } })
  const out = await sidestep({ ports: shut.ports })
  assert.equal(out.ok, false)
  assert.ok(!shut.calls.some(call => /^mine (?:1|-1),43,0$|^mine 0,43,-?1$/.test(call)))
})
