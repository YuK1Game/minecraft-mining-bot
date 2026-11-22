'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { observationWorld } = require('./helpers/branch-mine-observation-world')
const { nextMine, originAt } = require('../src/modes/mining/mine-sites')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { mineWorldScope } = require('../src/modes/mining/mine-state')
const { observeCandidate, observationStand, MAX_MOVES } = require('../src/modes/mining/mine-observation')
const { observeMineRuntime } = require('../src/modes/mining/mine-runtime-observe')
const target = { x: 48, y: 64, z: 0 }
const tick = async f => { f.advance(2000); return nextMine(f.ctx, 'raw_iron', 1) }

test('actual World distinguishes known cells, desired requests, suppression, and unrequestable target despite neighbour traffic', async () => {
  const f = observationWorld()
  let out = await f.ctx.minePorts.observe({ cells: [target] })
  assert.equal(out.code, 'MINE_TERRAIN_UNREQUESTABLE'); assert.equal(out.evidence.requested, 0); assert.equal(out.evidence.packets, 0)
  f.announce(2, 0)
  out = await f.ctx.minePorts.observe({ cells: [target] })
  assert.equal(out.code, 'MINE_TERRAIN_UNREQUESTABLE'); assert.equal(out.evidence.requested, 0); assert.ok(out.evidence.packets > 0)
  assert.equal(out.evidence.reason, 'unannounced_or_pending'); assert.equal(out.evidence.unannounced, null)
  f.announce(3, 0)
  out = await f.ctx.minePorts.observe({ cells: [target] })
  assert.equal(out.code, 'MINE_TERRAIN_REQUESTED'); assert.equal(out.evidence.requested, 1); assert.equal(out.serverConfirmed, false)
  out = await f.ctx.minePorts.observe({ cells: [target] })
  assert.equal(out.code, 'MINE_TERRAIN_WAITING'); assert.equal(out.evidence.requested, 0); assert.equal(out.evidence.waiting, 1)
  f.section(3, 4, 0, 'air')
  out = await f.ctx.minePorts.observe({ cells: [target] })
  assert.equal(out.code, 'MINE_TERRAIN_RECEIVED'); assert.equal(out.serverConfirmed, true)
})

test('actual nextMine makes two confirmed safe walks, then announced requests and received terrain produce a real plan at the fixed candidate', async () => {
  const f = observationWorld()
  f.onWalk(n => { if (n === 2) f.announce(3, 0) })
  let supplied = false
  f.onRequest(packet => {
    if (!supplied && f.walks.length === 2 && packet.origin.x === 3 && packet.requests.some(p => p.x === 0 && p.z === 0)) { supplied = true; f.receiveSite(3, 0) }
  })
  let out
  for (let i = 0; i < 12; i++) { out = await tick(f); if (out.branch) break }
  assert.ok(out.branch, JSON.stringify(out)); assert.equal(f.walks.length, 2); assert.equal(f.proofs.length, 2)
  assert.equal(f.positionPackets.length, 2)
  assert.ok(f.pendingBeforeReply.every(s => s.pending && s.lastResult?.requestId !== s.requestId), 'a sent command is pending until its matching reply')
  assert.equal(f.verifier.snapshot().lastResult.kind, 'server_position_volume')
  for (const walk of f.walks) {
    assert.ok(Math.hypot(walk.actual.x - walk.target.x, walk.actual.z - walk.target.z) <= 0.2)
    assert.equal(walk.actual.y, 64)
  }
  assert.ok(f.packets.length > 0); assert.ok(out.branch.plan.evaluation.availableTargetOre >= 1)
  assert.ok(out.branch.plan.site.anchor.x > 20, 'observation travel does not slide the original 48m candidate centre')
  assert.equal(f.ctx.memory.early.mine.search, undefined)
})

test('server correction prevents an observation movement from confirming arrival or moving on to another walk', async () => {
  const f = observationWorld(); f.correct({ x: 0.5, y: 64, z: 0.5 })
  await tick(f); await tick(f)
  const out = await tick(f), search = f.ctx.memory.early.mine.search
  assert.equal(out.result.code, 'MINE_POSITION_UNCONFIRMED'); assert.equal(f.proofs.length, 1)
  assert.equal(search.index, 2); assert.equal(search.deferred[1].observation.confirmed, undefined)
  assert.equal(f.walks.length, 1)
})

test('cancellation and failed durable intent prevent survey movement; an old-life result cannot commit a position', async () => {
  const cancelled = observationWorld(); cancelled.abort()
  assert.equal((await tick(cancelled)).result.status, 'interrupted'); assert.equal(cancelled.walks.length, 0)
  const failedSave = observationWorld(); await tick(failedSave); await tick(failedSave); failedSave.saveOK(false)
  assert.equal((await tick(failedSave)).result.code, 'MINE_CHECKPOINT'); assert.equal(failedSave.walks.length, 0)
  const oldLife = observationWorld(); oldLife.onWalk(() => { oldLife.current.lifecycle.deathId++ })
  await tick(oldLife); await tick(oldLife)
  assert.equal((await tick(oldLife)).result.status, 'interrupted'); assert.equal(oldLife.proofs.length, 0)
  assert.equal(oldLife.ctx.memory.early.mine.search.index, 1)
})

test('no safe route defers an unknown candidate and the next received candidate can be planned', async () => {
  const f = observationWorld()
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { if (x === -1) { f.announce(-1, 0); f.section(-1, 4, 0, 'air') }; f.put({ x, y: 64, z }, 'stone') }
  await tick(f); await tick(f)
  assert.equal((await tick(f)).result.code, 'MINE_OBSERVATION_NO_SAFE_ROUTE')
  assert.equal(f.ctx.memory.early.mine.search.index, 2); assert.equal(f.walks.length, 0)
  f.receiveSite(0, 3)
  const out = await tick(f)
  assert.ok(out.branch, JSON.stringify(out)); assert.ok(out.branch.plan.site.anchor.z > 20)
})

test('all nine inaccessible candidates exhaust once and unrelated revisions do not restart zero-request or walk loops', async () => {
  const f = observationWorld({ index: 0 })
  for (const [x, z] of [[1, 0], [0, 1], [0, -1]]) f.put({ x, y: 64, z }, 'stone')
  let out
  for (let i = 0; i < 35; i++) { f.advance(10000); out = await tick(f); if (out.result?.code === 'MINE_OBSERVATION_EXHAUSTED') break }
  assert.equal(out.result.code, 'MINE_OBSERVATION_EXHAUSTED'); assert.equal(f.ctx.memory.early.mine.search.index, 9); assert.equal(f.walks.length, 0)
  const packets = f.packets.length
  for (let i = 0; i < 4; i++) { f.put({ x: 10, y: 63, z: 10 }, i % 2 ? 'stone' : 'iron_ore'); assert.equal((await tick(f)).result.code, 'MINE_OBSERVATION_EXHAUSTED') }
  assert.equal(f.packets.length, packets)
})

test('positive target sends keep their cooldown and observation movement budgets survive unrelated terrain packets', async () => {
  const f = observationWorld(), record = {}, options = { cells: [target], reason: 'test' }
  f.announce(3, 0)
  for (let i = 0; i < 4; i++) { await observeCandidate(f.ctx, record, options); f.advance(100) }
  assert.equal(f.walks.length, 0)
  assert.ok(record.observation.requestedAt != null)
  f.advance(6000)
  for (let i = 0; i < 30; i++) {
    f.put({ x: 10, y: 63, z: 10 }, i % 2 ? 'stone' : 'iron_ore')
    const out = await observeCandidate(f.ctx, record, options)
    if (out.defer) break
    f.advance(2000)
  }
  assert.ok(record.observation.moves <= MAX_MOVES)
  assert.ok(f.walks.length <= MAX_MOVES)
})

test('frontier rejects an unsafe floor, unknown body, and unfinished construction; empty and changed runtime scope never imply received terrain', async () => {
  const f = observationWorld()
  f.put({ x: 0, y: 63, z: 0 }, 'water')
  assert.equal(observationStand(f.ctx, [target]), null)
  const out = await observeCandidate(f.ctx, {}, { cells: [target], branch: { segmentTask: { stepId: 'pending' } } })
  assert.equal(out.result.code, 'MINE_OBSERVATION_PENDING_WORK'); assert.equal(f.packets.length, 0)
  assert.equal((await observeMineRuntime(f.rt, {})).code, 'MINE_OBSERVATION_EMPTY')
  f.current.connectionId = null
  assert.equal((await observeMineRuntime(f.rt, { cells: [target] })).status, 'interrupted')
})

test('known representative samples do not repeatedly release a planner whose other section cells are still unknown', async () => {
  const f = observationWorld(), record = {}, options = { cells: [{ x: 8, y: 64, z: 8 }], reason: 'a different cell in this section is unresolved' }
  for (let i = 0; i < 2; i++) {
    const out = await observeCandidate(f.ctx, record, options)
    assert.equal(out.result.code, 'MINE_OBSERVATION_SAMPLE_INCOMPLETE'); assert.equal(out.changed, undefined)
  }
  const out = await observeCandidate(f.ctx, record, options)
  assert.equal(out.defer, true); assert.equal(f.packets.length, 0); assert.equal(f.walks.length, 0)
})

test('actual position verifier keeps the walk pending for a sent command and ignores another request UUID', async () => {
  const f = observationWorld(); f.autoPosition(false)
  let settled = false
  const pending = f.ctx.minePorts.walk({ x: 8.5, y: 64, z: 0.5 }).then(out => { settled = true; return out })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.positionPackets.length, 1); assert.equal(f.verifier.snapshot().pending, true); assert.equal(settled, false)
  const origin = { ...f.positionPackets[0].packet.origin, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
  assert.equal(f.replyPosition({ origin }), false)
  await Promise.resolve(); assert.equal(settled, false)
  assert.equal(f.replyPosition(), true)
  assert.equal((await pending).serverConfirmed, true)
})

test('a newly received safe frontier resumes the same candidate without resetting its confirmed movement budget', async () => {
  const f = observationWorld()
  await tick(f); await tick(f); await tick(f)
  assert.equal(f.walks.length, 1)
  const x = Math.floor(f.feet().x), z = Math.floor(f.feet().z)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.put({ x: x + dx, y: 64, z: z + dz }, 'stone')
  await tick(f); await tick(f); const deferred = await tick(f)
  assert.equal(deferred.result.code, 'MINE_OBSERVATION_NO_SAFE_ROUTE')
  const search = f.ctx.memory.early.mine.search, moves = search.deferred[1].observation.moves
  search.index = 9 // The other candidate slots have been exhausted by the scheduler.
  assert.equal((await tick(f)).result.code, 'MINE_OBSERVATION_EXHAUSTED')
  f.put({ x: x + 1, y: 64, z }, 'air')
  await tick(f)
  assert.equal(search.index, 1); assert.equal(search.wait.observation.moves, moves + 1)
  assert.equal(f.walks.length, 2)
})

test('surface observation records the actually unknown head cell even when its body and floor are already known', () => {
  const f = observationWorld()
  for (let y = 1; y <= 5; y++) f.section(3, y, 0, 'stone')
  f.put({ x: 48, y: 88, z: 0 }, 'air')
  f.world.applyPacket('update_block', { position: { x: 48, y: 89, z: 0 }, block_runtime_id: 999999, layer: 0 })
  const before = originAt(f.ctx, 1, [], { x: 0.5, y: 64, z: 0.5 })
  assert.deepEqual(before.unknown, [{ x: 48, y: 89, z: 0 }])
  f.put({ x: 48, y: 89, z: 0 }, 'air')
  assert.deepEqual(originAt(f.ctx, 1, [], { x: 0.5, y: 64, z: 0.5 }).origin, { x: 48.5, y: 88, z: 0.5 })
})

test('a retired mine continues from an exhausted nearby search to a received outer candidate', async () => {
  const f = observationWorld({ index: 9 })
  const mine = f.ctx.memory.early.mine
  const previous = createMineGeometry({
    scope: mineWorldScope(f.current), anchor: { x: 0, z: 0 }, direction: 'east',
    surfaceY: 64, upperY: 48, width: 16, length: 16
  })
  mine.sites = [{ plan: previous }]
  mine.search.origin = { x: 0.5, y: 64, z: 0.5 }
  mine.search.exhaustedRevision = 1
  mine.search.entranceSurveyed = true
  f.receiveSite(6, 0)

  const out = await tick(f)
  assert.ok(out.branch, JSON.stringify(out))
  assert.ok(out.branch.plan.site.anchor.x > 65, 'the new site is outside the first ring')
  assert.deepEqual(mine.sites.map(site => site.plan.id), [previous.id])
  assert.equal(mine.search, undefined)
  assert.equal(f.walks.length, 0, 'received terrain can be planned from a distance')
})
