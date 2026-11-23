'use strict'

// The mine's supply trip is continued from where the Bot stands, not from the mine's entrance.
// Real Realm 2026-11-23 21:46-22:00 JST, third mine (anchor (9853,10114), entrance about (9851,10099)), upper lobby
// ready and its stored ore read, torches 31 of a refill to 32 → 「採掘場の資材を準備しています（log 0/1）」. The nearest
// logs stood 21-28 m from the entrance: (9835,71-76,10113), (9832,70-73,10119), (9836,67,10122), (9833,70-73,10124).
//   21:47:57 受信済みの原木へ向かいます（目的地 (9835, 10113)）
//   21:48:07 遠征: 探していたものが見つかったため、長距離移動を取り消します（残り 21m）
//   21:48:10 採掘場の確認を続けます（MINE_POSITION_UNCONFIRMED）。
//   21:48:21 採掘場の資材を準備しています（log 0/1）。
// seven times in 14 minutes; no log was tried (no 「…を掘れなかったため」, no 「この木を最後まで伐ります」). The third line is
// requestMine's entry before the stock check: with the lobby ready it walked to the entrance on every tick, so each
// tick's search for wood began there again, 16 cells from the nearest log (the search sees 12).
// Real: requestMine (mine-controller.js), enterMine/leaveMine (mine-route.js), the mine's ports, supplies and chests,
// createDragonSupplies → collect/explore (dragon-supply-gather.js), dragon-tree.js, the scaffold hands and the
// navigator. The peer of helpers/branch-mine-world.js answers blocks, positions and the inventory; the ground is its
// flat stone at y70, not the received ground of that place.
const test = require('node:test'), assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { requestMine } = require('../src/modes/mining/mine-controller')
const { leaveMine } = require('../src/modes/mining/mine-route')
const { createDragonSupplies } = require('../src/modes/dragon-supplies')

const held = (w, name) => w.items.filter(item => item.name === 'minecraft:' + name).reduce((n, item) => n + item.count, 0)
const REQUEST = { resource: 'raw_iron', targetHeld: 1 }

// The mine as it stood at 21:46: lobby built, stored ore read, the Bot outside at the entrance, torches short of a
// refill, and the supply box read for that need. `treeOffset`: a four-log oak on the entrance's row, that many
// cells east of it.
async function mineWithLobby (t, treeOffset) {
  const w = createMineWorld(t)
  let out
  for (let i = 0; i < 80 && !(w.branch.lobbyReady?.upper && !w.branch.segmentTask && w.branch.stockChecked); i++) out = await requestMine(w.ctx, REQUEST)
  assert.ok(w.branch.lobbyReady?.upper && w.branch.stockChecked, JSON.stringify(out))
  assert.equal((await leaveMine(w.ctx, w.branch)).status, 'completed')
  const entrance = w.plan.shaft.approach, z = Math.floor(entrance.z), treeX = Math.floor(entrance.x) + treeOffset
  const tree = [70, 71, 72, 73].map(y => ({ x: treeX, y, z }))
  for (const p of tree) w.put(p, 'oak_log')
  w.onMine(p => { if (tree.some(q => q.x === p.x && q.y === p.y && q.z === p.z)) w.give('oak_log') })
  for (const item of w.items) if (item.name === 'minecraft:torch') item.count = item.slot === 3 ? 5 : 0
  w.ctx.supplies = createDragonSupplies(w.ctx)
  w.ctx.walk = to => w.ctx.hands.walk(to)
  for (let i = 0; i < 4; i++) {
    out = await requestMine(w.ctx, REQUEST)
    if (out.result?.code === 'MINE_SUPPLIES_IN_PROGRESS') break
  }
  assert.match(out.reason, /log 0\/\d+/, JSON.stringify(out))
  const fromEntrance = () => Math.hypot(w.feet().x - entrance.x, w.feet().z - entrance.z)
  return { w, z, treeX, fromEntrance }
}

test('21:48 JST: beside the tree its supply trip reached, the next tick takes the log and does not walk to the entrance', async t => {
  const { w, z, treeX, fromEntrance } = await mineWithLobby(t, -24)
  w.setFeet({ x: treeX + 2.5, y: 70, z: z + 0.5 })
  const far = fromEntrance(), opened = w.opened.length
  const out = await requestMine(w.ctx, REQUEST)
  assert.equal(held(w, 'oak_log'), 1, JSON.stringify({ out, feet: w.feet() }))
  assert.match(out.reason, /log 1\/\d+/)
  assert.ok(fromEntrance() >= far - 3, `the Bot stays at the tree (${JSON.stringify(w.feet())})`)
  assert.equal(w.opened.length, opened, 'no chest of the mine is opened again')
  assert.ok(w.lines.some(line => /この木を最後まで伐ります/.test(line)), w.lines.join('\n'))
})

test('from the entrance the search for wood goes on from where the last tick ended, until a log 30 cells away is taken', async t => {
  const { w, fromEntrance } = await mineWithLobby(t, 30)
  const trace = []
  for (let i = 0; i < 12 && held(w, 'oak_log') < 1; i++) {
    await requestMine(w.ctx, REQUEST)
    trace.push(Math.round(fromEntrance()))
  }
  assert.equal(held(w, 'oak_log'), 1, `distance from the entrance after each tick: ${trace.join(', ')}`)
  assert.ok(trace.every((d, i) => i === 0 || d >= trace[i - 1] - 3), `no tick began at the entrance again: ${trace.join(', ')}`)
})

test('stored ore that has not been read is still read first: the Bot enters the mine from the tree', async t => {
  const { w, z, treeX } = await mineWithLobby(t, -24)
  w.setFeet({ x: treeX + 2.5, y: 70, z: z + 0.5 })
  // Another target is another stock key (mine-stock.js): the chest's answer for the old one says nothing about it.
  const opened = w.opened.length
  let out
  for (let i = 0; i < 6 && w.opened.length === opened; i++) out = await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: 2 })
  assert.ok(w.opened.length > opened, JSON.stringify({ out, feet: w.feet() }))
  assert.equal(held(w, 'oak_log'), 0, 'the log waits until the chest has answered')
})
