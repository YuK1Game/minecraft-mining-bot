'use strict'

// Logs too high to reach from the ground (user 2026-11-15 22:04 JST:
// 「届かない場合は土か何かのブロックを積んで原木を採取してください、
// 最後に足場にしたブロックを回収してください」).
// The Bot stands where the trunk stood, stacks dirt under itself one block at a
// time (the quarry's pillar step: one jump, one ordinary placement, confirmed
// by the received block, one dirt fewer and the landing), cuts every log it
// can reach from each height, then mines the pillar back down from under its
// feet and takes the dirt with it.
// Dirt it does not hold is dug from the ground beside the tree, one block deep
// per spot, and those spots are filled again at the end, so no hole and no
// pillar stays behind. What could not be undone is kept in
// shared.playerScaffoldDebt and tried again.
const { normalizeMode } = require('./bot-mode')
const { logsLeft } = require('./player-tree')

const MAX_STEPS = 8
const REACH_UP = 5 // feet this far below a log's layer reach it straight up
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const SOIL = /^minecraft:(?:dirt|grass_block)$/
const key = point => `${point.x},${point.y},${point.z}`
const isAir = block => block?.known === true && AIR.test(block.name ?? '')
const isSolid = block => block?.known === true && block.boundingBox === 'block' && !AIR.test(block.name ?? '')
const isLog = block => block?.known === true && /_(?:log|stem)$/.test(block.name ?? '')
const isFloor = block => isSolid(block) && !isLog(block)
const MAX_DROP = 6 // how far below the lowest recorded log the real ground may be

// Where the pillar goes and how high. Pure; `block(x, y, z)` reads received terrain.
function scaffoldPlan ({ tree, block }) {
  if (!Array.isArray(tree?.logs) || !tree.logs.length) return { ready: false, reason: 'NO_TREE' }
  const base = tree.logs.reduce((low, point) => point.y < low.y ? point : low)
  const column = { x: base.x, z: base.z }
  const left = logsLeft(tree, point => block(point.x, point.y, point.z))
  if (!left.length) return { ready: false, reason: 'NO_LOGS_LEFT' }
  // The ground is the first received floor under the trunk, not the lowest
  // recorded log: a tree first seen after its root was cut hangs in the air
  // (real Realm 2026-11-15: the Bot was sent to stand in mid-air).
  let ground = base.y
  for (let i = 0; i < MAX_DROP && !isFloor(block(column.x, ground - 1, column.z)); i++) {
    const under = block(column.x, ground - 1, column.z)
    if (under?.known !== true || (!isAir(under) && !isLog(under))) return { ready: false, reason: 'TRUNK_FLOOR_UNCONFIRMED' }
    ground--
  }
  if (!isFloor(block(column.x, ground - 1, column.z))) return { ready: false, reason: 'TRUNK_FLOOR_UNCONFIRMED' }
  const top = Math.max(...left.map(point => point.y))
  return { ready: true, column, ground, top, left: left.length, steps: Math.max(1, Math.min(MAX_STEPS, top - REACH_UP - ground)) }
}

// Ground spots to take dirt from: soil at the trunk's ground level, two to
// four blocks from the trunk, open above, solid below and around.
function dirtSpots ({ column, ground, block, from = null }) {
  const y = ground - 1, spots = []
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) < 2) continue
    const x = column.x + dx, z = column.z + dz
    const soil = block(x, y, z)
    if (soil?.known !== true || !SOIL.test(soil.name ?? '')) continue
    if (!isAir(block(x, y + 1, z)) || !isAir(block(x, y + 2, z)) || !isSolid(block(x, y - 1, z))) continue
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].every(([ax, az]) => isSolid(block(x + ax, y, z + az)) && isAir(block(x + ax, y + 1, z + az)))) continue
    spots.push({ x, y, z })
  }
  const origin = from ?? { x: column.x + 0.5, z: column.z + 0.5 }
  return spots.sort((a, b) => Math.hypot(a.x + 0.5 - origin.x, a.z + 0.5 - origin.z) - Math.hypot(b.x + 0.5 - origin.x, b.z + 0.5 - origin.z))
}

// One scaffold job. Ports (all confirmed by received data inside the port):
// feet() -> {x, y, z}; block(x, y, z); dirt() -> count; walk(target) -> bool;
// canMine(cell) -> bool; mine(cell) -> bool (received air); descend(cell) ->
// bool; pillar(column, feetY) -> {ok, reason}; place(cell) -> bool.
async function runScaffold ({ tree, record, ports, aborted = () => false, log = () => {} }) {
  const { feet, block, dirt, walk, canMine, mine, descend, pillar, place } = ports
  const plan = scaffoldPlan({ tree, block })
  if (!plan.ready) return { ok: false, reason: plan.reason, cut: 0 }
  const { column, ground } = plan
  Object.assign(record, { column, ground, holes: record.holes ?? [], placed: record.placed ?? 0 })
  const centre = { x: column.x + 0.5, y: ground, z: column.z + 0.5 }
  const level = () => { const at = feet(); return at ? Math.floor(at.y + 0.001) : null }
  const inColumn = () => { const at = feet(); return !!at && Math.floor(at.x) === column.x && Math.floor(at.z) === column.z }
  const standing = () => logsLeft(tree, point => block(point.x, point.y, point.z))
  let cut = 0, reason = null

  // The tree can be up to 48 m away when the plan hands it over: go there first.
  { const at = feet(); if (at && Math.hypot(at.x - centre.x, at.z - centre.z) > 12 && !(await ports.approach?.(centre))) return { ok: false, reason: 'TREE_TOO_FAR', cut: 0, left: plan.left, cleaned: null, detail: ports.why?.() ?? null } }

  // Dirt for the pillar: what is held, else from the ground beside the tree.
  if (!(inColumn() && level() > ground)) {
    const tried = new Set()
    for (let attempt = 0; attempt < plan.steps * 2 + 2 && dirt() < plan.steps && !aborted(); attempt++) {
      const at = feet(), spot = dirtSpots({ column, ground, block, from: at }).find(cell => !tried.has(key(cell)) && !(at && Math.floor(at.x) === cell.x && Math.floor(at.z) === cell.z))
      if (!spot) break
      tried.add(key(spot))
      if (!canMine(spot)) { await walk({ x: spot.x + 1.5, y: ground, z: spot.z + 0.5 }); if (!canMine(spot)) continue }
      const before = dirt()
      if (!await mine(spot)) continue
      record.holes.push(spot)
      // The drop lies in the spot: step in, take it, step out with the next walk.
      await walk({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 })
      for (let i = 0; i < 20 && dirt() <= before && !aborted(); i++) await ports.sleep(200)
    }
    // Logs still standing where the Bot has to stand (the root, cut around
    // but not through) are cut from beside the trunk first.
    const inWay = () => [ground, ground + 1].map(y => ({ x: column.x, y, z: column.z })).filter(cell => isLog(block(cell.x, cell.y, cell.z)))
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!inWay().length || aborted()) break
      if ((dx || dz) && !inWay().some(canMine)) await walk({ x: column.x + dx + 0.5, y: ground, z: column.z + dz + 0.5 })
      for (const cell of inWay()) if (canMine(cell) && await mine(cell)) cut++
    }
    if (dirt() < 1) reason = 'NO_DIRT'
    else if (inWay().length) reason = 'TRUNK_BLOCKED'
    else { await walk(centre); if (!inColumn()) reason = 'TRUNK_NOT_REACHED' }
  }

  // Up: cut what is in reach, then one block higher, until no log is left.
  for (let round = 0; !reason && round < 40 && !aborted(); round++) {
    let mined = true
    while (mined && !aborted()) {
      mined = false
      for (const point of standing().sort((a, b) => a.y - b.y)) {
        if (!canMine(point)) continue
        if (await mine(point)) { cut++; mined = true }
        break
      }
    }
    if (!standing().length) break
    const at = level()
    if (at === null || at - ground >= MAX_STEPS) { reason = 'TOO_HIGH'; break }
    if (dirt() < 1) { reason = 'NO_DIRT'; break }
    if (!isAir(block(column.x, at + 2, column.z)) || !isAir(block(column.x, at + 3, column.z))) { reason = 'NO_HEADROOM'; break }
    const step = await pillar(column, at)
    if (!step?.ok) { reason = `PILLAR_${String(step?.reason ?? 'BLOCKED').slice(0, 60)}`; break }
    record.placed = at + 1 - ground
  }
  if (aborted() && !reason) reason = 'INTERRUPTED'

  const cleaned = await cleanScaffold({ record, ports, log })
  const leftNow = standing().length
  return { ok: leftNow === 0, reason: leftNow === 0 ? null : reason ?? 'LOGS_OUT_OF_REACH', cut, left: leftNow, cleaned, detail: leftNow === 0 ? null : ports.why?.() ?? null }
}

// Down the pillar from under the feet, then the dirt back into the spots it
// came from. Returns true when nothing is owed any more.
async function cleanScaffold ({ record, ports }) {
  const { feet, block, dirt, walk, descend, place } = ports
  const { column, ground } = record
  const level = () => { const at = feet(); return at ? Math.floor(at.y + 0.001) : null }
  const onPillar = () => { const at = feet(); return !!at && Math.floor(at.x) === column.x && Math.floor(at.z) === column.z && level() > ground }
  for (let i = 0; i < MAX_STEPS + 2 && onPillar(); i++) {
    const cell = { x: column.x, y: level() - 1, z: column.z }
    if (!SOIL.test(block(cell.x, cell.y, cell.z)?.name ?? '')) break
    if (!await descend(cell)) break
  }
  // Pillar blocks still standing in the trunk's place (counted from received terrain).
  let standing = 0
  for (let y = ground; y < ground + MAX_STEPS + 1; y++) if (SOIL.test(block(column.x, y, column.z)?.name ?? '')) standing++; else break
  record.placed = standing
  for (const hole of [...record.holes]) {
    if (!isAir(block(hole.x, hole.y, hole.z))) { record.holes = record.holes.filter(cell => key(cell) !== key(hole)); continue }
    if (dirt() < 1 || onPillar()) break
    const at = feet()
    if (at && Math.floor(at.x) === hole.x && Math.floor(at.z) === hole.z) await walk({ x: hole.x + 1.5, y: ground, z: hole.z + 0.5 })
    let filled = await place(hole)
    if (!filled) { await walk({ x: hole.x + 1.5, y: ground, z: hole.z + 0.5 }); filled = await place(hole) }
    if (filled) record.holes = record.holes.filter(cell => key(cell) !== key(hole))
  }
  return record.placed === 0 && record.holes.length === 0
}

const REASONS = { NO_DIRT: '足場にする土を用意できません', TRUNK_NOT_REACHED: '幹のあった場所に立てません', TRUNK_BLOCKED: '幹の根元の原木を伐れません', TREE_TOO_FAR: '木のそばまで歩けません', TOO_HIGH: `足場は${MAX_STEPS}段までです`, NO_HEADROOM: '頭の上が空いていません', INTERRUPTED: '中断しました', LOGS_OUT_OF_REACH: '足場からも届きません', TRUNK_FLOOR_UNCONFIRMED: '幹の下の地面を確認できません' }

// Runs the job when the tree plan asks for it (tree.needsScaffold), with the
// autonomy stopped, and plays on afterwards.
function createPlayerScaffold ({ getMode, shared, agent, ports, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, reason = null
  shared.playerScaffold = true
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return true } catch { await sleep(2000) } } return false }
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }

  async function tick () {
    if (busy || !live() || blocked()) return null
    const tree = shared.playerTree, debt = shared.playerScaffoldDebt
    const owed = !!debt && (debt.tries ?? 0) < 3 && now() - (debt.triedAt ?? 0) > 30000
    if (!tree?.needsScaffold && !owed) return null
    busy = true
    try {
      agent.stop(reason = tree?.needsScaffold ? '足場を積んで上の原木を伐っています。' : '足場のブロックを回収しています。')
      await settle()
      const all = { ...ports, sleep }
      if (tree?.needsScaffold) {
        const record = tree.scaffold ??= { holes: [], placed: 0 }
        log(`プレイヤーモード: 地面から届かない原木のために足場を積みます`)
        const result = await runScaffold({ tree, record, ports: all, aborted: () => !live() || blocked(), log })
        Object.assign(tree, { needsScaffold: false, scaffolded: true, misses: 0, progressAt: now() })
        log(result.ok ? `プレイヤーモード: 足場から原木 ${result.cut} 個を伐り、木を伐り終えました` : `プレイヤーモード: 足場から原木 ${result.cut} 個を伐りました。${result.left ?? '?'} 個は残ります（${REASONS[result.reason] ?? String(result.reason).slice(0, 80)}${result.detail ? `: ${String(result.detail).slice(0, 80)}` : ''}）`)
        if (result.cleaned === false) { shared.playerScaffoldDebt = { column: record.column, ground: record.ground, holes: record.holes, placed: record.placed, tries: 0, triedAt: now() }; log(`プレイヤーモード: 足場の片付けが残りました（柱 ${record.placed} 段・穴 ${record.holes.length} か所）。あとでやり直します`) } else if (result.cleaned) log('プレイヤーモード: 足場のブロックを回収しました')
      } else {
        debt.tries = (debt.tries ?? 0) + 1; debt.triedAt = now()
        const cleaned = await cleanScaffold({ record: debt, ports: all })
        if (cleaned) { delete shared.playerScaffoldDebt; log('プレイヤーモード: 残っていた足場を片付けました') } else if (debt.tries >= 3) log(`プレイヤーモード: 足場を片付けられませんでした（柱 ${debt.placed} 段・穴 ${debt.holes.length} か所、(${debt.column.x}, ${debt.ground}, ${debt.column.z})）`)
      }
      return true
    } catch (error) {
      log(`プレイヤーモード: 足場の処理に失敗 ${String(error?.message ?? error).slice(0, 120)}`)
      if (shared.playerTree) Object.assign(shared.playerTree, { needsScaffold: false, scaffolded: true })
      return false
    } finally {
      reason = null; busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? reason : null }) }
}

module.exports = { createPlayerScaffold, runScaffold, cleanScaffold, scaffoldPlan, dirtSpots, MAX_STEPS }
