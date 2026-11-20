'use strict'

// The expedition cuts a tree it has begun down to its last log.
//
// The user's rule (2026-11-15 21:44 JST): 「木は１本ずつ採取してください（上の方の原木もすべて）、じゃないと中途半端に
// 木がなくなって見栄えが悪いです」. The ordinary work keeps it (player-tree.js, player-scaffold.js). The expedition
// took single logs (`collect(ctx, 'log')` in dragon-supply-gather.js: the fuel of a furnace, the sticks of a stone
// pickaxe) and went on with one in the bag, so every tree it touched was left with a hole in its trunk.
//
// One record for both: shared.playerTree, the record of player-tree.js ({ logs, left, misses, progressAt }).
// - The gathering records the tree of a log it has mined (`treeAt` before the cut, `beginTree` after it).
// - While the record has logs standing, the expedition's step works on that tree before anything else of the
//   overworld (`finishTree`, called from dragon-runtime.js): the lowest log first, from where the mining check takes
//   it: here, under it in the trunk's place, or beside it.
// - The walk toward a log goes to the trunk's foot, not to the log's height: the nearest stand at the height of a
//   log in the crown is the top of the leaves (the same forest floor, the same planner: from the grass the walk
//   ended on the leaves at y 69).
// - An oak of four logs has leaves from its second log up. Beside its trunk there is no place to stand, and from
//   outside only the lowest two logs show a face. Leaves are never cut. The way to the upper logs is the trunk's
//   own column, entered one block lower by the dig-and-stack walk (`burrow`: two or three blocks of ground); what
//   that dug is put back when the tree is done (`refill`), from inside outward.
// - A log that was tried and not taken rests (supply-cell-rest.js). With every log left at rest the scaffold takes
//   the tree once (player-scaffold.js: dirt under the feet, the pillar taken down again); what still stands after
//   that is left with a log line. So a tree costs a bounded number of tries.
// - A log counts as gone only by the received block. A record begun by the ordinary work is finished the same way,
//   and the ordinary work finishes one begun here (it reads the same record).
// Not a tree here: more than MAX logs joined, or wider than a tree (the planner's bounds). Those are cut log by log,
// as before.
const { logsLeft } = require('./player-tree')
const { scaffoldTree, settleDebt, debtDue } = require('./player-scaffold')
const { cellRest } = require('./supply-cell-rest')
const { standable } = require('./house/house-steps')
const { createBuildWalk } = require('./player-build-walk')

const MAX = 128, TALL = 24, WIDE = 12, FAR_M = 48, REACH_UP = 6, TRIES_A_STEP = 3
const LOG = /^(?:minecraft:)?(?!stripped_)[a-z_]+_(?:log|stem)$/
const WORKING = { phase: 'working', reason: '伐り始めた木を最後まで伐っています。' }
const key = p => `${p.x},${p.y},${p.z}`

// The logs joined to this one (the 26 cells around each, the same kind). `skip(block, cell)`: logs that are not to
// be cut (protected ones). null: not a log, or not one tree.
function treeAt (getBlock, cell, skip = () => false) {
  const first = getBlock(cell.x, cell.y, cell.z)
  if (first?.known !== true || !LOG.test(first.name ?? '')) return null
  const seen = new Set([key(cell)]), logs = [{ x: cell.x, y: cell.y, z: cell.z }]
  for (let i = 0; i < logs.length; i++) {
    const at = logs[i]
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const next = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
      if (seen.has(key(next))) continue
      seen.add(key(next))
      const block = getBlock(next.x, next.y, next.z)
      if (block?.known !== true || block.name !== first.name || skip(block, next)) continue
      if (logs.push(next) > MAX) return null
    }
  }
  const span = axis => Math.max(...logs.map(p => p[axis])) - Math.min(...logs.map(p => p[axis]))
  if (span('y') > TALL || span('x') > WIDE || span('z') > WIDE) return null
  return logs.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
}

// After a log of `logs` was mined: the tree is the work until it is down.
function beginTree (ctx, logs, { now = Date.now } = {}) {
  if (!Array.isArray(logs) || logs.length < 2 || ctx.shared.playerTree) return false
  ctx.shared.playerTree = { logs, left: logs.length, misses: 0, progressAt: now(), by: 'expedition' }
  ctx.log?.(`プレイヤーモード: この木を最後まで伐ります（原木 ${logs.length} 個）`)
  return true
}

// Where the trunk stood under a log: the highest place to stand in its column from which the log is overhead.
function under (getBlock, cell) {
  for (let y = cell.y - 1; y >= cell.y - REACH_UP; y--) {
    if (standable(getBlock, cell.x, y, cell.z)) return { x: cell.x + 0.5, y, z: cell.z + 0.5 }
    const block = getBlock(cell.x, y, cell.z)
    if (block?.known !== true || block.boundingBox === 'block') return null
  }
  return null
}

// Into the trunk's column under a log no face of which is seen from outside: one or two cells lower than a stand
// right under it would be, by the dig-and-stack walk. Each height once a log. The ground it digs is recorded.
async function burrow (ctx, tree, cell) {
  const tried = tree.ways ??= {}, dug = tree.dug ??= []
  const solid = at => { const block = ctx.getBlock(at.x, at.y, at.z); return block?.known === true && block.boundingBox === 'block' }
  const here = () => { const at = ctx.getFeet(); return at ? { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } : null }
  const noting = take => async at => { const ground = solid(at), from = here(), taken = await take(at); if (taken && ground && from) dug.push({ x: at.x, y: at.y, z: at.z, from }); return taken }
  // Nothing is stacked or laid on this way (`fill`): only dug, and what is dug is put back.
  const hands = { ...ctx.hands, mine: noting(ctx.hands.mine), dig: noting(ctx.hands.dig), fill: () => 0 }
  for (const y of [cell.y - 2, cell.y - 3]) {
    if (ctx.cancelled() || ctx.hands.canMine(cell)) return
    const way = `${key(cell)}@${y}`, target = { x: cell.x, y, z: cell.z }
    // A stand there has ground under it and no log in it (a log higher up the trunk has neither: the scaffold's part).
    if (tried[way] || !solid({ x: cell.x, y: y - 1, z: cell.z }) || [y - 1, y, y + 1].some(level => LOG.test(ctx.getBlock(cell.x, level, cell.z)?.name ?? ''))) continue
    tried[way] = true
    await createBuildWalk({ hands, getHouse: () => ctx.shared.playerHouse, log: ctx.log })(target, { done: at => at.x === target.x && at.y === target.y && at.z === target.z, aborted: ctx.cancelled })
  }
}

// The ground the way under the trunk dug, put back: the innermost block first, from the cell it was dug from.
async function refill (ctx, tree) {
  const open = at => { const block = ctx.getBlock(at.x, at.y, at.z); return block?.known === true && block.boundingBox !== 'block' }
  const holes = (tree.dug ?? []).filter(open)
  let left = holes.length
  for (const hole of holes.reverse()) {
    if (ctx.cancelled()) break
    await ctx.hands.walk({ x: hole.from.x + 0.5, y: hole.from.y, z: hole.from.z + 0.5 })
    if (!ctx.cancelled() && await ctx.hands.place(hole, { any: true })) left--
  }
  tree.dug = (tree.dug ?? []).filter(open)
  if (holes.length) ctx.log?.(left ? `プレイヤーモード: 木の下へ入るために掘った地面 ${holes.length} か所のうち ${left} か所を埋め戻せませんでした（${holes.filter(open).slice(0, 3).map(at => `(${at.x}, ${at.y}, ${at.z})`).join(' ')}）` : `プレイヤーモード: 木の下へ入るために掘った地面 ${holes.length} か所を埋め戻しました`)
}

// One step on the recorded tree. null: no tree is the work (none recorded, it is down, or it was left).
async function finishTree (ctx, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const shared = ctx.shared, tree = shared.playerTree
  const ports = () => ({ ...ctx.hands, sleep })
  // A pillar or a hole a scaffold of this tree's (or an earlier one's) left behind.
  if (!tree?.logs?.length) {
    if (!debtDue(shared, now) || ctx.cancelled()) return null
    await settleDebt({ shared, ports: ports(), log: ctx.log, now })
    return WORKING
  }
  const feet = ctx.getFeet()
  if (!feet || ctx.cancelled()) return null
  // The tree is over: what was dug to get under it goes back first (one try), then the record goes.
  const leave = async text => {
    if (tree.dug?.length) { await refill(ctx, tree); if (ctx.cancelled()) return WORKING }
    ctx.log?.(`プレイヤーモード: ${text}`)
    delete shared.playerTree
    return null
  }
  const left = logsLeft(tree, p => ctx.getBlock(p.x, p.y, p.z))
  if (!left.length) return leave(`木を1本伐り終えました（原木 ${tree.logs.length} 個）`)
  const foot = tree.logs.reduce((low, p) => p.y < low.y ? p : low)
  if (Math.hypot(feet.x - foot.x, feet.z - foot.z) > FAR_M) { ctx.log?.(`プレイヤーモード: 伐っていた木から離れたため、残りの原木 ${left.length} 個はそのままにします`); delete shared.playerTree; return null }
  if (left.length < tree.left) Object.assign(tree, { left: left.length, misses: 0, progressAt: now() })
  const rested = cellRest(shared, ctx.runtime?.raw?.().dimension, { now: ctx.now })
  const far = cell => { const at = ctx.getFeet(); return at ? Math.hypot(cell.x + 0.5 - at.x, cell.y - at.y, cell.z + 0.5 - at.z) : Infinity }
  const open = left.filter(cell => !rested.resting(cell)).sort((a, b) => a.y - b.y || far(a) - far(b))
  const can = cell => !ctx.cancelled() && ctx.hands.canMine(cell)
  for (const cell of open.slice(0, TRIES_A_STEP)) {
    const before = far(cell)
    // From here; from under it where the trunk stood; from beside the trunk's foot; from the trunk's column entered lower.
    if (!can(cell)) { const stand = under(ctx.getBlock, cell); if (stand) await ctx.hands.walk(stand) }
    if (!can(cell) && !ctx.cancelled()) await ctx.hands.approach({ x: cell.x + 0.5, y: foot.y, z: cell.z + 0.5 }, 2.7)
    if (!can(cell) && !ctx.cancelled()) await burrow(ctx, tree, cell)
    if (ctx.cancelled()) return WORKING
    if (can(cell) && await ctx.hands.mine(cell)) {
      // The drop lies where the log stood, and the next log is overhead from there.
      if (!ctx.cancelled() && standable(ctx.getBlock, cell.x, cell.y, cell.z)) await ctx.hands.walk({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 })
      return WORKING
    }
    if (ctx.cancelled()) return WORKING
    rested.miss(cell, before, far(cell))
  }
  if (left.some(cell => !rested.resting(cell))) return WORKING
  // Nothing of it is taken from the ground: the scaffold once, then the tree is left as it stands.
  if (!tree.scaffolded) {
    try { await scaffoldTree({ tree, shared, ports: ports(), aborted: ctx.cancelled, log: ctx.log, now }) } catch (error) { ctx.log?.(`プレイヤーモード: 足場の処理に失敗 ${String(error?.message ?? error).slice(0, 120)}`) }
    return WORKING
  }
  const still = logsLeft(tree, p => ctx.getBlock(p.x, p.y, p.z))
  return still.length ? leave(`届かない原木が ${still.length} 個残りました。この木はここまでにします`) : leave(`木を1本伐り終えました（原木 ${tree.logs.length} 個）`)
}

module.exports = { treeAt, beginTree, finishTree, MAX }
