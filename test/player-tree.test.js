'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextBootstrapAction } = require('../src/survival/planner')
const { withPlayerTree, treePlanInput, logsLeft, MISS_LIMIT } = require('../src/modes/player-tree')

// A flat field with one oak of `height` logs at (4, 1..height, 0) and, further
// away, a second oak. The Bot starts empty-handed at (0, 1, 0).
function field ({ height = 5, second = true, litter = false } = {}) {
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, position: { x, y, z }, boundingBox: name === 'air' ? 'empty' : 'block', extra: [], properties: {} })
  for (let x = -3; x <= 14; x++) for (let y = -1; y <= 14; y++) for (let z = -4; z <= 4; z++) put(x, y, z, y <= 0 ? 'dirt' : 'air')
  const tree = (x, logs) => { for (let y = 1; y <= logs; y++) put(x, y, 0, 'oak_log'); put(x, logs + 1, 0, 'oak_leaves'); put(x + 1, logs, 0, 'oak_leaves') }
  tree(4, height)
  if (litter) for (let x = 2; x <= 6; x++) for (let z = -2; z <= 2; z++) if (x !== 4 || z) blocks.set(`${x},1,${z}`, { known: true, name: 'minecraft:leaf_litter', position: { x, y: 1, z }, boundingBox: 'empty', extra: [], properties: {} })
  if (second) tree(11, 4)
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, position: { x: 0.5, y: 2.62, z: 0.5 }, inventory: { known: true, items: [] }, capabilities: { mining: true, movement: true, scan_blocks: true, collect_drops: true, craft: true }, world: { initialized: true, loadedSections: 1 } }
  const shared = { botMode: 'player' }, lines = [], cut = []
  const observations = () => ({ blocks: [...blocks.values()], radius: 14, worldLoaded: true, crafting: { previews: {} } })
  const readBlock = point => blocks.get(`${point.x},${point.y},${point.z}`) ?? { known: false }
  let clock = 0
  const next = () => {
    const base = nextBootstrapAction(state, observations(), { allowLogs: true, logCount: 3 })
    return withPlayerTree({ mode: shared.botMode, shared, decision: base, position: state.position, readBlock, now: () => clock, log: line => lines.push(line), planTree: left => { const input = treePlanInput(state, {}, left); return nextBootstrapAction(input.state, observations(), input.options) } })
  }
  // Applies a decision the way the server would answer it.
  const apply = decision => {
    if (decision.type === 'gather_logs') {
      put(decision.target.x, decision.target.y, decision.target.z, 'air'); cut.push({ ...decision.target })
      const held = state.inventory.items.find(item => item.name === 'minecraft:oak_log')
      if (held) held.count++; else state.inventory.items.push({ name: 'minecraft:oak_log', count: 1, slot: 0 })
    } else if (decision.type === 'move_to') state.position = { x: decision.target.x, y: decision.target.y + 1.62, z: decision.target.z }
    else return false
    return true
  }
  return { blocks, put, state, shared, lines, cut, next, apply, readBlock, tick: ms => { clock += ms } }
}

test('a tree that was started is cut to its last log before anything else', () => {
  const f = field({ height: 6 })
  for (let step = 0; step < 40; step++) { const decision = f.next(); if (!f.shared.playerTree && f.cut.length) break; if (!f.apply(decision)) break }
  assert.deepEqual(f.cut.map(point => point.x), Array(6).fill(4), 'only the first tree was touched')
  assert.deepEqual(f.cut.map(point => point.y), [1, 2, 3, 4, 5, 6], 'from the bottom up to the top log')
  assert.equal(f.shared.playerTree, undefined)
  assert.ok(f.lines.some(line => line.includes('最後まで伐ります（原木 6 個）')))
  assert.ok(f.lines.some(line => line.includes('木を1本伐り終えました（原木 6 個）')))
})

test('with a log in hand the base plan would craft, the tree plan keeps cutting', () => {
  const f = field({ height: 4, second: false })
  for (let step = 0; step < 6 && !f.cut.length; step++) f.apply(f.next())
  assert.equal(f.cut.length, 1)
  const base = nextBootstrapAction(f.state, { blocks: [...f.blocks.values()], radius: 14, worldLoaded: true, crafting: { previews: {} } }, { allowLogs: true, logCount: 3 })
  assert.notEqual(base.type, 'gather_logs', 'the base plan stops cutting once a log is held')
  const decision = f.next()
  assert.ok(['gather_logs', 'move_to'].includes(decision.type), decision.type)
  assert.equal(decision.treeEvidence.detection, 'tree_in_progress')
})

test('the last single log of a tree is still a candidate', () => {
  const f = field({ height: 3, second: false })
  for (let step = 0; step < 20 && f.cut.length < 3; step++) if (!f.apply(f.next())) break
  assert.equal(f.cut.length, 3)
})

test('logs out of reach from the ground are given up, with a log line, not waited for', () => {
  const f = field({ height: 9, second: false })
  let decision
  for (let step = 0; step < 60; step++) { decision = f.next(); if (!f.apply(decision)) { if (!f.shared.playerTree) break } }
  assert.ok(f.cut.length >= 6, `cut ${f.cut.length}`)
  assert.ok(f.cut.length < 9)
  assert.equal(f.shared.playerTree, undefined)
  assert.ok(f.lines.some(line => line.includes(`届かない原木が ${9 - f.cut.length} 個残りました`)), f.lines.join('\n'))
})

test('an unreceived block still counts as a standing log; stops and other modes are left alone', () => {
  const tree = { logs: [{ x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }] }
  assert.equal(logsLeft(tree, point => point.y === 1 ? { known: true, name: 'minecraft:air' } : { known: false }).length, 1)
  const shared = { playerTree: { logs: tree.logs, left: 2, misses: 0, progressAt: 0 } }
  const stop = { type: 'stop', code: 'low_health' }
  let planned = 0
  const args = { shared, readBlock: () => ({ known: true, name: 'minecraft:oak_log' }), planTree: () => { planned++; return { type: 'gather_logs' } } }
  assert.equal(withPlayerTree({ ...args, mode: 'player', decision: stop }), stop)
  assert.equal(withPlayerTree({ ...args, mode: 'quarry', decision: { type: 'craft' } }).type, 'craft')
  assert.equal(planned, 0)
  assert.equal(withPlayerTree({ ...args, mode: 'player', decision: { type: 'craft' } }).type, 'gather_logs')
})

test('a tree left far behind is dropped', () => {
  const shared = { playerTree: { logs: [{ x: 0, y: 1, z: 0 }], left: 1, misses: 0, progressAt: 0 } }
  const lines = []
  const decision = withPlayerTree({ mode: 'player', shared, decision: { type: 'craft' }, position: { x: 80, y: 2, z: 0 }, readBlock: () => ({ known: false }), planTree: () => ({ type: 'gather_logs' }), log: line => lines.push(line) })
  assert.equal(decision.type, 'craft')
  assert.equal(shared.playerTree, undefined)
  assert.equal(MISS_LIMIT, 6)
})

test('a trunk ringed by leaf litter is cut from its root log up, not from the second log', () => {
  const f = field({ height: 5, second: false, litter: true })
  for (let step = 0; step < 40; step++) { const decision = f.next(); if (!f.shared.playerTree && f.cut.length) break; if (!f.apply(decision)) break }
  assert.deepEqual(f.cut.map(point => point.y), [1, 2, 3, 4, 5])
  assert.ok(f.lines.some(line => line.includes('木を1本伐り終えました（原木 5 個）')))
})
