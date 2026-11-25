'use strict'

// Survey travel only follows received, connected dry ground. The ordinary
// movement port still plans the route and confirms the server pose.
const { STANDING_GROUND } = require('../../common/standing-ground')
const { at, air, point, key, scope, live, received, save, blocked, stopped, feetAt, results } = require('./mine-common')
const GROUND = new Set(STANDING_GROUND.map(name => `minecraft:${name}`))
const MAX_MOVES = 6, MAX_WAITS = 3, MAX_VISITS = 512, WALK_DISTANCE = 8
const ground = b => b?.known === true && b.boundingBox === 'block' && GROUND.has(b.name) && !b.extra?.length
const signature = (ctx, cells) => JSON.stringify(cells.map(p => { const b = at(ctx, p); return [key(p), b?.known === true ? [b.name, b.properties ?? null, b.extra ?? []] : null] }))

function observationStand (ctx, cells, tried = [], frontier = []) {
  const feet = point(ctx.getFeet()), targets = cells.filter(p => at(ctx, p)?.known !== true)
  if (!feet || !targets.length || Math.abs(feet.y - Math.round(feet.y)) > 0.12) return null
  const start = { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) }
  const rejected = new Map()
  const safe = p => {
    const checks = [[{ ...p, y: p.y - 1 }, ground], [p, air], [{ ...p, y: p.y + 1 }, air]]
    let valid = true
    for (const [position, predicate] of checks) if (!predicate(at(ctx, position))) { rejected.set(key(position), position); valid = false }
    return valid
  }
  if (!safe(start)) { frontier.push(...rejected.values()); return null }
  const distance = p => Math.min(...targets.map(t => Math.hypot(p.x - t.x, p.z - t.z)))
  const baseline = distance(start), excluded = new Set(tried), seen = new Set([key(start)]), queue = [{ ...start, steps: 0 }]
  let best = null
  for (let index = 0; index < queue.length && index < MAX_VISITS; index++) {
    const p = queue[index], gain = baseline - distance(p)
    if (gain >= 1 && !excluded.has(key(p)) && (!best || gain > best.gain || gain === best.gain && p.steps < best.steps)) best = { ...p, gain }
    if (p.steps >= WALK_DISTANCE) continue
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // Same-level travel keeps observation conservative: no unknown floor,
      // cliff, ladder or low-block movement is introduced by this planner.
      const next = { x: p.x + dx, y: p.y, z: p.z + dz }, id = key(next)
      if (seen.has(id)) continue
      seen.add(id)
      if (safe(next)) queue.push({ ...next, steps: p.steps + 1 })
    }
  }
  frontier.push(...[...rejected.values()].sort((a, b) => distance(a) - distance(b)).slice(0, 64))
  return best ? { x: best.x + 0.5, y: best.y, z: best.z + 0.5 } : null
}

async function observeCandidate (ctx, record, { cells, reason, branch = null, travel = true } = {}) {
  const before = scope(ctx)
  if (!live(ctx, before)) return { result: stopped() }
  if (branch && (branch.segmentTask || branch.vein || branch.pendingAction)) return { result: blocked('MINE_OBSERVATION_PENDING_WORK', '施工中の区間と埋戻しを完了してから観測します。', 'inventory_update') }
  const evidenceKey = signature(ctx, cells)
  const changedEvidence = record.observation?.scope === before && record.observation.signature !== evidenceKey
  const unknownBefore = cells.some(p => at(ctx, p)?.known !== true)
  if (!record.observation || record.observation.scope !== before) record.observation = { scope: before, moves: 0, waits: 0, tried: [], signature: evidenceKey }
  const observation = record.observation
  if (observation.signature !== evidenceKey) { observation.waits = 0; observation.signature = evidenceKey; delete observation.requestedAt }
  let out
  try { out = await ctx.minePorts.observe({ cells, reason }) } catch (error) { return { result: results.failed('MINE_OBSERVATION_FAILED', { detail: error.message }) } }
  if (!live(ctx, before)) return { result: stopped() }
  if (received(out) && (unknownBefore || changedEvidence)) return { result: out, changed: true }
  // Survey samples can already be known while other cells in their section
  // have an unknown palette. Re-reading the same known sample must not
  // release an expensive planner loop without any new terrain evidence.
  if (received(out)) out = blocked('MINE_OBSERVATION_SAMPLE_INCOMPLETE', '観測点は受信済みですが、計画範囲の未確認部分が残っています。')
  if (out?.status === 'interrupted' || out?.status === 'cancelled' || out?.status === 'failed') return { result: out }
  if (out?.code === 'MINE_TERRAIN_REQUEST_REFUSED' || out?.code === 'MINE_OBSERVATION_UNAVAILABLE') return { result: out }
  const now = (ctx.now ?? Date.now)()
  if (out?.evidence?.requested > 0 && observation.requestedAt == null) observation.requestedAt = now
  observation.waits++
  // Give positive requests and unknown in-flight suppression a finite chance
  // to arrive before considering another observation position.
  if (observation.waits < MAX_WAITS || observation.requestedAt != null && now - observation.requestedAt < 5000) {
    if (!await save(ctx, branch, before)) return { result: blocked('MINE_CHECKPOINT', '観測待ちの記録を保存します。', 'owner_released') }
    // These are bounded network/observation attempts. Once their budget is
    // spent the next call chooses a safe walk or a different candidate; it
    // must not become an indefinite terrain wait in the expedition owner.
    return { result: out?.status ? { ...out, retry: { kind: observation.requestedAt != null ? 'time' : 'now', ms: 2000 } } : blocked('MINE_OBSERVATION_UNAVAILABLE', '地形の観測結果を確認できません。', 'owner_released') }
  }
  if (!travel || observation.moves >= MAX_MOVES) return { result: blocked('MINE_OBSERVATION_DEFERRED', '受信を確認できない候補を保留し、別の候補を調べます。'), defer: true }
  const frontier = [], target = observationStand(ctx, cells, observation.tried, frontier)
  observation.frontier = frontier
  if (!target) return { result: blocked('MINE_OBSERVATION_NO_SAFE_ROUTE', '受信済みの安全な観測経路がないため、この候補を保留します。', 'position_changed'), defer: true }
  observation.moves++; observation.waits = 0
  observation.tried.push(key({ x: Math.floor(target.x), y: target.y, z: Math.floor(target.z) }))
  observation.intent = { from: point(ctx.getFeet()), target, scope: before }
  if (!await save(ctx, branch, before)) return { result: blocked('MINE_CHECKPOINT', '安全な観測移動の予定を保存します。', 'owner_released') }
  let moved
  try { moved = await ctx.minePorts.walk(target) } catch (error) { moved = results.failed('MINE_OBSERVATION_WALK_FAILED', { detail: error.message }) }
  if (!live(ctx, before)) return { result: stopped() }
  if (moved?.status === 'interrupted' || moved?.status === 'cancelled') return { result: moved }
  if (!received(moved) || !feetAt(ctx, target)) {
    delete observation.intent
    if (!await save(ctx, branch, before)) return { result: blocked('MINE_CHECKPOINT', '観測移動の確認結果を保存します。', 'owner_released') }
    return { result: moved?.status ? moved : blocked('MINE_OBSERVATION_POSITION_UNCONFIRMED', '観測地点への到着をまだ受信できません。', 'position_changed'), defer: true }
  }
  delete observation.intent
  observation.confirmed = { target, scope: before }
  if (!await save(ctx, branch, before)) return { result: blocked('MINE_CHECKPOINT', '受信した観測地点を保存します。', 'owner_released') }
  out = await ctx.minePorts.observe({ cells, reason })
  if (!live(ctx, before)) return { result: stopped() }
  return { result: out?.status ? { ...out, retry: { kind: 'now' } } : blocked('MINE_OBSERVATION_UNAVAILABLE', '観測移動後の地形を確認します。'), changed: received(out) }
}

module.exports = { observationStand, observeCandidate, observationSignature: signature, MAX_MOVES, MAX_WAITS }
