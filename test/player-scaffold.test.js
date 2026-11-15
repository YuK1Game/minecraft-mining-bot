'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerScaffold, runScaffold, scaffoldPlan, dirtSpots, MAX_STEPS } = require('../src/modes/player-scaffold')
const { withPlayerTree } = require('../src/modes/player-tree')

// A grass field at y=0 (dirt below), a trunk at (0, 1..height, 0) whose lowest
// `cut` logs are already gone, and ports that answer like the server would.
function field ({ height = 9, cut = 6, dirt = 0, reach = 4.5, pillarFails = false } = {}) {
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block' })
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = -3; y <= 16; y++) put(x, y, z, y === 0 ? 'grass_block' : y < 0 ? 'dirt' : 'air')
  const tree = { logs: [], left: height - cut, misses: 0, progressAt: 0 }
  for (let y = 1; y <= height; y++) { tree.logs.push({ x: 0, y, z: 0 }); if (y > cut) put(0, y, 0, 'oak_log') }
  put(0, height + 1, 0, 'oak_leaves')
  const block = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false }
  const feet = { x: 2.5, y: 1, z: 0.5 }, calls = []
  const state = { dirt, logs: 0 }
  const eye = () => ({ x: feet.x, y: feet.y + 1.62, z: feet.z })
  const ports = {
    feet: () => ({ ...feet }), block, dirt: () => state.dirt, sleep: async () => {},
    walk: async target => { calls.push(['walk', target.x, target.y, target.z]); Object.assign(feet, target); if (block(Math.floor(feet.x), feet.y, Math.floor(feet.z)).name === 'minecraft:air' && state.drop === `${Math.floor(feet.x)},${feet.y},${Math.floor(feet.z)}`) { state.dirt++; state.drop = null } return true },
    canMine: cell => { const at = eye(); return Math.hypot(cell.x + 0.5 - at.x, cell.y + 0.5 - at.y, cell.z + 0.5 - at.z) <= reach },
    mine: async cell => { const name = block(cell.x, cell.y, cell.z).name; calls.push(['mine', cell.x, cell.y, cell.z]); put(cell.x, cell.y, cell.z, 'air'); if (/log/.test(name)) state.logs++; else state.drop = `${cell.x},${cell.y},${cell.z}`; return true },
    descend: async cell => { calls.push(['descend', cell.y]); put(cell.x, cell.y, cell.z, 'air'); feet.y = cell.y; state.dirt++; return true },
    pillar: async (column, feetY) => { calls.push(['pillar', feetY]); if (pillarFails) return { ok: false, reason: 'ASCENT_INPUT_BUSY' }; put(column.x, feetY, column.z, 'dirt'); feet.y = feetY + 1; state.dirt--; return { ok: true } },
    place: async cell => { calls.push(['place', cell.x, cell.y, cell.z]); put(cell.x, cell.y, cell.z, 'dirt'); state.dirt--; return true }
  }
  return { tree, ports, block, put, feet, calls, state }
}
const ground = f => { const names = []; for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) names.push(f.block(x, 0, z).name); return names }

test('plan: the pillar stands where the trunk stood and is as high as the top log needs', () => {
  const f = field({ height: 9 })
  assert.deepEqual(scaffoldPlan({ tree: f.tree, block: f.block }), { ready: true, column: { x: 0, z: 0 }, ground: 1, top: 9, left: 3, steps: 3 })
  assert.equal(scaffoldPlan({ tree: field({ height: 30, cut: 6 }).tree, block: field({ height: 30, cut: 6 }).block }).steps, MAX_STEPS)
  f.put(0, 0, 0, 'air')
  assert.equal(scaffoldPlan({ tree: f.tree, block: f.block }).reason, 'TRUNK_FLOOR_UNCONFIRMED')
})

test('with no dirt in hand: digs it beside the tree, cuts every log from the pillar, takes the pillar down and fills the ground again', async () => {
  const f = field({ height: 9 })
  const before = ground(f)
  const record = { holes: [], placed: 0 }
  const result = await runScaffold({ tree: f.tree, record, ports: f.ports })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.cut, 3)
  assert.equal(result.cleaned, true)
  assert.equal(f.state.logs, 3)
  for (let y = 1; y <= 12; y++) assert.equal(f.block(0, y, 0).name, y === 10 ? 'minecraft:oak_leaves' : 'minecraft:air', `trunk column y=${y}`)
  assert.deepEqual(ground(f).map(name => name === 'minecraft:air'), before.map(() => false), 'no hole is left in the ground')
  assert.equal(f.feet.y, 1, 'back on the ground')
  assert.deepEqual(record.holes, [])
  assert.equal(record.placed, 0)
  assert.equal(f.state.dirt, 0, 'the dug dirt went back into the ground')
  const spots = f.calls.filter(call => call[0] === 'mine' && call[2] === 0)
  assert.ok(spots.length >= 1 && spots.every(call => Math.max(Math.abs(call[1]), Math.abs(call[3])) >= 2), 'dirt is not taken next to the trunk')
})

test('with dirt in hand the ground is left alone and the dirt comes back', async () => {
  const f = field({ height: 10, dirt: 8 })
  const result = await runScaffold({ tree: f.tree, record: { holes: [], placed: 0 }, ports: f.ports })
  assert.equal(result.ok, true)
  assert.equal(f.calls.some(call => call[0] === 'place'), false)
  assert.equal(f.state.dirt, 8)
  assert.equal(f.calls.filter(call => call[0] === 'pillar').length, f.calls.filter(call => call[0] === 'descend').length)
})

test('a pillar step that is refused ends the job honestly and still cleans up', async () => {
  const f = field({ height: 9, pillarFails: true })
  const record = { holes: [], placed: 0 }
  const result = await runScaffold({ tree: f.tree, record, ports: f.ports })
  assert.equal(result.ok, false)
  assert.equal(result.left, 3)
  assert.match(result.reason, /^PILLAR_ASCENT_INPUT_BUSY/)
  assert.equal(result.cleaned, true)
  assert.equal(ground(f).includes('minecraft:air'), false)
})

test('dirt spots keep two blocks from the trunk and need open, solid surroundings', () => {
  const f = field()
  const spots = dirtSpots({ column: { x: 0, z: 0 }, ground: 1, block: f.block })
  assert.ok(spots.length > 0)
  assert.ok(spots.every(cell => cell.y === 0 && Math.max(Math.abs(cell.x), Math.abs(cell.z)) >= 2))
  f.put(2, 1, 0, 'short_grass')
  assert.equal(dirtSpots({ column: { x: 0, z: 0 }, ground: 1, block: f.block }).some(cell => cell.x === 2 && cell.z === 0), false)
})

test('the tree plan hands unreachable logs to the scaffold once, then gives the tree up', async () => {
  const f = field({ height: 9, pillarFails: true })
  const shared = { botMode: 'player', playerWanted: true, playerTree: f.tree }, lines = [], agentCalls = []
  const scaffold = createPlayerScaffold({ getMode: () => 'player', shared, log: line => lines.push(line), ports: f.ports, sleep: async () => {}, agent: { objective: {}, stop: () => agentCalls.push('stop'), start: async () => agentCalls.push('start'), settled: () => true } })
  const args = { mode: 'player', shared, decision: { type: 'craft' }, readBlock: point => f.block(point.x, point.y, point.z), planTree: () => ({ type: 'scan_blocks' }), log: line => lines.push(line), now: () => 0 }
  for (let i = 0; i < 6; i++) withPlayerTree(args)
  assert.equal(shared.playerTree.needsScaffold, true)
  assert.equal(await scaffold.tick(), true)
  assert.deepEqual(agentCalls, ['stop', 'start'])
  assert.equal(shared.playerTree.scaffolded, true)
  assert.equal(shared.playerTree.needsScaffold, false)
  assert.match(lines.join('\n'), /足場から原木 0 個を伐りました。3 個は残ります/)
  for (let i = 0; i < 6; i++) withPlayerTree(args)
  assert.equal(shared.playerTree, undefined, 'given up after the scaffold was tried')
  assert.equal(await scaffold.tick(), null)
})
