'use strict'

// Player mode cuts one tree at a time, down to its last log (user 2026-11-15
// 21:44 JST: 「木は１本ずつ採取してください（上の方の原木もすべて）、じゃないと
// 中途半端に木がなくなって見栄えが悪いです」). The base plan stops cutting as
// soon as it holds one log, which left trunks hanging in the air.
// - The first log decision of a tree records every log of that tree.
// - While any of those logs is left, the next action is that tree again
//   (dropped logs first, then the lowest remaining layer), ahead of crafting
//   and other work. Stops, respawn and shelter decisions are never replaced.
// - A log counts as gone only when the received block there is no longer a
//   log; an unreceived block still counts as left.
// - Logs that cannot be reached from the ground (the planner asks to look
//   around six times in a row, or four minutes pass without one fewer log)
//   are given up with a log line, so the Bot never stands under a tree forever.
const { normalizeMode } = require('./bot-mode')

const LOG = /^(?:minecraft:)?[a-z_]+_(?:log|stem)$/
const MISS_LIMIT = 6
const STALL_MS = 240000
const FAR_M = 48
const KEEP = new Set(['stop', 'complete', 'respawn', 'build_shelter', 'leave_shelter'])
const key = point => `${point.x},${point.y},${point.z}`
const isLogItem = name => /_(?:log|stem)$/.test(String(name ?? ''))

const startsTree = decision => (decision?.type === 'gather_logs' || decision?.type === 'move_to' && decision.resource === 'logs') && Array.isArray(decision.treeEvidence?.componentLogPositions) && decision.treeEvidence.componentLogPositions.length > 0
const worksOnTree = plan => plan?.type === 'gather_logs' || plan?.type === 'move_to' && plan.resource === 'logs' || plan?.type === 'collect_drops' && plan.stage === 'logs'

// The logs of the tree that are still standing, by the received terrain.
function logsLeft (tree, readBlock) {
  return tree.logs.filter(point => {
    const block = readBlock(point)
    return block?.known !== true || LOG.test(block.name ?? '')
  })
}

// Planner input for "cut this tree": as if no pickaxe, log or plank were held
// (with them the base plan crafts or mines stone instead), and the tree's own
// logs as the only candidates: the lowest layer first, then any that is left.
function treePlanInput (state, options = {}, left = []) {
  const inventory = state?.inventory
  const items = Array.isArray(inventory?.items) ? inventory.items.filter(item => !/_pickaxe$|_planks$/.test(String(item?.name ?? '')) && !isLogItem(item?.name)) : inventory?.items
  const wanted = new Set(left.map(key))
  const logCandidates = known => {
    const standing = known.filter(block => wanted.has(key(block.position)))
    if (!standing.length) return [[]]
    const evidence = { detection: 'tree_in_progress', harvestOrder: 'bottom_up', componentLogPositions: standing.map(block => ({ ...block.position })) }
    const bottom = Math.min(...standing.map(block => block.position.y))
    const tagged = standing.map(block => ({ ...block, evidence }))
    return [tagged.filter(block => block.position.y === bottom), tagged]
  }
  return { state: { ...state, inventory: inventory ? { ...inventory, items } : inventory }, options: { ...options, allowLogs: true, logCount: 64, stoneCount: 2304, logCandidates } }
}

function withPlayerTree ({ mode, shared, decision, position = null, readBlock, planTree, log = () => {}, now = Date.now }) {
  if (normalizeMode(mode) !== 'player' || !shared) return decision
  const begin = () => {
    if (startsTree(decision)) {
      const logs = decision.treeEvidence.componentLogPositions.map(point => ({ x: point.x, y: point.y, z: point.z }))
      shared.playerTree = { logs, left: logs.length, misses: 0, progressAt: now() }
      log(`プレイヤーモード: この木を最後まで伐ります（原木 ${logs.length} 個）`)
    }
    return decision
  }
  const tree = shared.playerTree
  if (!tree || !Array.isArray(tree.logs)) return begin()
  if (KEEP.has(decision?.type)) return decision
  const drop = text => { log(`プレイヤーモード: ${text}`); delete shared.playerTree }
  const left = logsLeft(tree, readBlock)
  if (!left.length) { drop(`木を1本伐り終えました（原木 ${tree.logs.length} 個）`); return begin() }
  const base = tree.logs[0]
  if (position && Math.hypot(position.x - base.x, position.z - base.z) > FAR_M) { drop(`伐っていた木から離れたため、残りの原木 ${left.length} 個はそのままにします`); return begin() }
  if (left.length < tree.left) { tree.left = left.length; tree.misses = 0; tree.progressAt = now() }
  let plan = null
  try { plan = planTree(left) } catch (error) { log(`プレイヤーモード: 木の計画に失敗 ${String(error?.message ?? error).slice(0, 120)}`) }
  if (worksOnTree(plan)) return plan
  // Waits and stops of the tree plan are the base plan's too; only "nothing
  // reachable" (look around, explore) counts against the tree.
  if (plan && ['scan_blocks', 'explore'].includes(plan.type)) tree.misses++
  if (tree.misses >= MISS_LIMIT || now() - tree.progressAt > STALL_MS) { drop(`地面から届かない原木が ${left.length} 個残りました。この木はここまでにします`); return begin() }
  return decision
}

module.exports = { withPlayerTree, treePlanInput, logsLeft, MISS_LIMIT }
