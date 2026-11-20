'use strict'

// The expedition cuts a tree it has begun down to its last log (src/modes/dragon-tree.js; `collect` in
// dragon-supply-gather.js records the tree, the runtime's step in dragon-runtime.js finishes it before other work).
// The user's rule, 2026-11-15: 「木は１本ずつ採取してください（上の方の原木もすべて）、じゃないと中途半端に木がなく
// なって見栄えが悪いです」. The expedition took single logs (fuel, the sticks of a stone pickaxe: the test of that in
// dragon-dig-tool.test.js ends with one log of four mined) and left the rest of the trunk standing.
// The ground is the forest floor received on the real Realm 2026-11-20 14:42 JST (test/fixtures/tree-top-stuck.json).
// Real here: the expedition's runtime (dragon-runtime.js: the step's order, the goal's ledger, the saved record),
// the gathering (`collect`), dragon-tree.js, player-scaffold.js, the scaffold's hands, the navigation's planner and
// physics. Stand-ins: the early step (it asks for one log, then says it does its next work), the server
// (helpers/dig-world.js: no pillar step is answered, so the scaffold stacks nothing). Its success is not the game's.
// Before (main 493f401, the first scene): the next work begins at the second look with three of the oak's four logs
// standing.
const test = require('node:test')
const assert = require('node:assert/strict')
const { collect } = require('../src/modes/dragon-supply-gather')
const { treeAt, finishTree, MAX } = require('../src/modes/dragon-tree')
const { createDigWorld } = require('./helpers/dig-world')
const { createWorld } = require('./helpers/dragon-goal-world')
const forest = require('./fixtures/tree-top-stuck.json')

const full = name => 'minecraft:' + name
const within = (x, z) => x >= forest.x0 && x <= forest.x0 + 14 && z >= forest.z0 && z <= forest.z0 + 14
const OAK = [66, 67, 68, 69].map(y => ({ x: 9884, y, z: 10158 }))
const BEGUN = /この木を最後まで伐ります（原木 (\d+) 個）/, DOWN = /木を1本伐り終えました（原木 (\d+) 個）/, LEFT = /届かない原木が (\d+) 個残りました/

// The expedition over the forest: its step asks for `want` logs, then does "its next work".
async function expedition (t, { scene = forest, feet = { x: 9887.5, y: 65, z: 10158.5 }, want = 1 } = {}) {
  const items = [{ slot: 0, name: full('stone_sword'), count: 1, durabilityKnown: true, durabilityRemaining: 89 }, { slot: 1, name: full('stone_pickaxe'), count: 1, durabilityKnown: true, durabilityRemaining: 100 }]
  const dig = createDigWorld({ ...scene, feet }, { items, logs: true, outside: (x, y, z) => within(x, z) ? (y < 63 ? 'stone' : 'air') : null })
  const standing = cells => cells.filter(cell => /_log$/.test(dig.getBlock(cell.x, cell.y, cell.z).name ?? '')).length
  const w = await createWorld(t, {
    getBlock: dig.getBlock,
    live: () => ({ position: dig.ctx.getFeet(), inventory: dig.ctx.runtime.inventory(), heldItem: dig.ctx.runtime.raw().heldItem }),
    ports: (signal, shared) => ({ ...dig.ctx, shared, cancelled: () => signal.aborted, log: line => w.lines.push(line), goal: undefined }),
    step: async ctx => {
      if (dig.count('oak_log') + dig.count('birch_log') < want) { await collect(ctx, 'log'); return { done: false, reason: '原木を集めています。' } }
      w.next ??= { looks: 0, standing: w.tree ? standing(w.tree) : null }
      w.next.looks++
      return { done: false, reason: '次の作業をしています。' }
    }
  })
  Object.assign(w, { dig, standing })
  return w
}

test('a log taken for the expedition is the first of its tree: the tree is down before the next work begins', async t => {
  const w = await expedition(t)
  w.tree = OAK
  assert.equal(w.standing(OAK), 4)
  await w.pass(60000, { tickMs: 2000 })
  const log = w.lines.join('\n')
  assert.ok(w.next, `the next work was reached\n${log}`)
  assert.equal(w.next.standing, 0, `logs of the oak standing when the next work began\n${log}`)
  assert.deepEqual(w.dig.minedNames.filter(name => /_log$/.test(name)), ['oak_log', 'oak_log', 'oak_log', 'oak_log'], log)
  assert.ok(w.dig.minedNames.every(name => !/leaves|leaf_litter/.test(name)), w.dig.minedNames.join(' '))
  assert.equal(w.dig.count('oak_log'), 4)
  assert.equal(w.said(BEGUN).length, 1, log)
  assert.equal(BEGUN.exec(w.said(BEGUN)[0])[1], '4')
  assert.equal(w.said(DOWN).length, 1, log)
  assert.equal(w.shared.playerTree, undefined)
  // No other tree was touched.
  assert.equal(w.said(LEFT).length, 0)
  // This oak has leaves from its second log up: the upper two logs were cut from the trunk's own column, entered one
  // block lower through the ground, and that ground is back.
  const ground = w.dig.minedNames.filter(name => !/_log$/.test(name))
  assert.ok(ground.length >= 1 && ground.length <= 4 && ground.every(name => /^(?:dirt|grass_block)$/.test(name)), ground.join(' '))
  assert.equal(w.dig.placed.length, ground.length, log)
  assert.equal(w.said(/掘った地面 \d+ か所を埋め戻しました/).length, 1, log)
  for (const at of w.dig.placed) assert.equal(w.dig.getBlock(at.x, at.y, at.z).boundingBox, 'block')
  assert.equal(w.dig.getBlock(9884, 65, 10158).boundingBox, 'block', 'the ground under the trunk')
  assert.ok(w.dig.cell().y <= 66, `not on the leaves: ${JSON.stringify(w.dig.cell())}`)
})

// The birch at (9880, 66..72, 10164): seven logs, its leaves from the fifth up. Nothing is dug for it.
test('a tree with room under its crown is cut from where its trunk stood, and no ground is touched', async t => {
  const birch = Array.from({ length: 7 }, (_, i) => ({ x: 9880, y: 66 + i, z: 10164 }))
  const w = await expedition(t, { feet: { x: 9880.5, y: 66, z: 10162.5 } })
  w.tree = birch
  assert.equal(w.standing(birch), 7)
  await w.pass(90000, { tickMs: 2000 })
  const log = w.lines.join('\n')
  assert.ok(w.next, `the next work was reached\n${log}`)
  assert.equal(w.next.standing, 0, log)
  assert.deepEqual(w.dig.minedNames, Array(7).fill('birch_log'), log)
  assert.deepEqual(w.dig.placed, [])
  assert.equal(BEGUN.exec(w.said(BEGUN)[0])[1], '7')
  assert.equal(w.said(DOWN).length, 1, log)
})

test('while an enemy is near the tree waits; it is finished afterwards', async t => {
  const w = await expedition(t)
  w.tree = OAK
  let cut = null
  await w.pass(60000, { tickMs: 2000, each: () => {
    const n = 4 - w.standing(OAK)
    if (n >= 1 && cut === null) { cut = n; w.threatened = true }
  } })
  assert.equal(4 - w.standing(OAK), cut, 'nothing more of it is cut with an enemy near')
  assert.ok(w.shared.playerTree, 'the tree is still recorded')
  w.threatened = false
  await w.pass(60000, { tickMs: 2000 })
  assert.equal(w.standing(OAK), 0, w.lines.join('\n'))
  assert.equal(w.said(DOWN).length, 1)
})

// A trunk taller than the hand reaches from the ground, with no way to stack under it here (the stand-in answers
// no pillar step): what is in reach is cut, the scaffold is tried once, and the rest is left with one line.
test('logs out of reach end the tree after one try of the scaffold, and the next work goes on', async t => {
  const tall = { ...forest, rows: { ...forest.rows } }
  for (let y = 70; y <= 78; y++) {
    const rows = [...(tall.rows[y] ?? Array(15).fill('.'.repeat(15)))]
    rows[7] = rows[7].slice(0, 7) + 'O' + rows[7].slice(8)
    tall.rows[y] = rows
  }
  const trunk = Array.from({ length: 13 }, (_, i) => ({ x: 9884, y: 66 + i, z: 10158 }))
  const w = await expedition(t, { scene: tall })
  w.tree = trunk
  await w.pass(240000, { tickMs: 2000 })
  const log = w.lines.join('\n')
  assert.ok(w.next, `the next work was reached\n${log}`)
  assert.equal(BEGUN.exec(w.said(BEGUN)[0])?.[1], '13', log)
  assert.equal(w.said(/地面から届かない原木のために足場を積みます/).length, 1, log)
  assert.equal(w.said(LEFT).length, 1, log)
  const left = w.standing(trunk)
  assert.ok(left >= 1 && left <= 8, `${left} logs left\n${log}`)
  assert.equal(Number(LEFT.exec(w.said(LEFT)[0])[1]), left)
  assert.equal(w.shared.playerTree, undefined)
  assert.ok(w.next.looks >= 10, 'the next work has the looks after it')
})

test('a tree the ordinary work began is finished by the expedition from the same record', async t => {
  const w = await expedition(t, { want: 0 })
  w.shared.playerTree = { logs: OAK.map(cell => ({ ...cell })), left: 4, misses: 0, progressAt: 0 }
  await w.pass(40000, { tickMs: 2000 })
  assert.equal(w.standing(OAK), 0, w.lines.join('\n'))
  assert.equal(w.said(DOWN).length, 1)
  assert.equal(w.said(BEGUN).length, 0)
})

test('the tree of a log: the logs joined to it, not protected ones, and nothing for a mass of logs', () => {
  const dig = createDigWorld({ ...forest, feet: { x: 9887.5, y: 65, z: 10158.5 } }, { logs: true, outside: () => 'air' })
  assert.deepEqual(treeAt(dig.getBlock, OAK[2]), OAK)
  assert.equal(treeAt(dig.getBlock, { x: 9887, y: 65, z: 10158 }), null, 'not a log')
  assert.deepEqual(treeAt(dig.getBlock, OAK[0], (block, cell) => cell.y === 68), OAK.slice(0, 2), 'a protected log is not part of it, nor what hangs on it')
  const mass = (x, y, z) => ({ known: true, name: full('oak_log'), boundingBox: 'block' })
  assert.equal(treeAt(mass, { x: 0, y: 0, z: 0 }), null)
  assert.ok(MAX >= 64)
})

test('with no tree recorded the step is nothing', async () => {
  const dig = createDigWorld({ ...forest, feet: { x: 9887.5, y: 65, z: 10158.5 } }, { logs: true, outside: () => 'air' })
  assert.equal(await finishTree(dig.ctx), null)
  assert.deepEqual(dig.minedNames, [])
})
