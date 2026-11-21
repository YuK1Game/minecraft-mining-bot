'use strict'

// Player mode: open the way to a wanted item that lies one dig away.
// An ore mined from above or from the side leaves its item in a space the
// body cannot enter (real Realm 2026-11-16 05:12 JST: three coal lay one step
// below the Bot's stair, 3 m away; the cell above the step was stone, so the
// items were "not reachable on foot", were never picked up, and the plan went
// on without coal). When such an item is in pickup range of a cell next to
// one the Bot can walk to, and at most two blocks of plain stone stand in
// the body's way, the next action is to mine the first of them (ordinary
// mining, live preview). The walk and the pickup follow from the usual plan.
const { normalizeMode } = require('./bot-mode')
const { walkableCells, collectable } = require('./player-drops')

const WANTED = /^minecraft:(?:coal|raw_iron|diamond)$/
const STONE = /^minecraft:(?:stone|cobblestone|deepslate|cobbled_deepslate)$/
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|sweet_berry/
const KEEP = new Set(['stop', 'complete', 'wait', 'respawn', 'collect_drops', 'eat', 'avoid_threat', 'defend', 'capability_required'])
const REACH = 6
const TRIES = 3
const { cellKey: key } = require('../movement/plan-cache')
const idOf = drop => String(drop?.entityId ?? drop?.runtimeEntityId ?? drop?.runtimeId ?? drop?.id ?? '')

function openWayToDrop ({ mode, shared, state, decision, drops, getBlock, preview, log = () => {} }) {
  if (normalizeMode(mode) !== 'player' || !decision || KEEP.has(decision.type) || !Array.isArray(drops) || !drops.length || typeof preview !== 'function' || typeof getBlock !== 'function') return null
  const eye = state?.position
  if (!eye || ![eye.x, eye.y, eye.z].every(Number.isFinite)) return null
  const far = drop => Math.hypot(drop.position.x - eye.x, drop.position.y - eye.y, drop.position.z - eye.z)
  const wanted = drops.filter(drop => WANTED.test(drop?.name ?? '') && drop.position && [drop.position.x, drop.position.y, drop.position.z].every(Number.isFinite) && far(drop) <= REACH).sort((a, b) => far(a) - far(b))
  if (!wanted.length) return null
  const cells = walkableCells(eye, getBlock)
  if (!cells.size) return null
  const read = (x, y, z) => getBlock(x, y, z) ?? null
  const open = block => block?.known === true && !block.extra?.length && !HAZARD.test(block.name ?? '') && (AIR.test(block.name ?? '') || block.boundingBox === 'empty')
  const ground = block => block?.known === true && block.boundingBox === 'block' && !AIR.test(block.name ?? '') && !HAZARD.test(block.name ?? '')
  const plain = block => block?.known === true && STONE.test(block.name ?? '') && !block.protected && !block.protectionSource && block.natural !== false && !block.extra?.length
  const tried = shared.playerDropDig ??= {}
  for (const drop of wanted) {
    if (collectable(drop, cells)) continue
    const id = idOf(drop)
    if (id && (tried[id] ?? 0) >= TRIES) continue
    const cx = Math.floor(drop.position.x), cy = Math.floor(drop.position.y), cz = Math.floor(drop.position.z)
    let best = null
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const y of [cy, cy - 1]) {
      const x = cx + dx, z = cz + dz
      if (cells.has(key(x, y, z)) || !ground(read(x, y - 1, z)) || !collectable(drop, new Map([[key(x, y, z), { x, y, z }]]))) continue
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
        const from = cells.get(key(x + ax, y - dy, z + az))
        if (!from) continue
        // The body's cells: standing there, passing over the edge on a step down, the head room here on a step up.
        const body = [[x, y, z], [x, y + 1, z]]
        if (dy === -1) body.push([x, y + 2, z])
        if (dy === 1) body.push([from.x, from.y + 2, from.z])
        const blocks = body.map(point => ({ point, block: read(...point) })).filter(entry => !open(entry.block))
        if (!blocks.length || blocks.length > 2 || !blocks.every(entry => plain(entry.block))) continue
        if (!best || blocks.length < best.length) best = blocks
      }
    }
    if (!best) continue
    for (const entry of [...best].sort((a, b) => b.point[1] - a.point[1])) {
      const target = { x: entry.point[0], y: entry.point[1], z: entry.point[2] }
      let ready = false
      try { const result = preview([{ ...target }]); ready = result?.ready === true && result.targets?.length === 1 && STONE.test(result.targets[0].name ?? '') } catch {}
      if (!ready) continue
      if (id) tried[id] = (tried[id] ?? 0) + 1
      log(`プレイヤーモード: 落ちている${String(drop.name).replace(/^minecraft:/, '')}へ行くため、通り道の石を掘ります（(${target.x}, ${target.y}, ${target.z})）`)
      return { type: 'mine_stone', stage: 'drop_access', resource: 'stone', reason: '落ちている資材を拾いに行くため、通り道をふさぐ石を掘ります。', target, block: entry.block.name, count: 1, requiresLivePreview: true, requiresKnownDurability: true }
    }
  }
  return null
}

module.exports = { openWayToDrop }
