'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { sanitizeStatus, sanitizeCachedStatus } = require('../scripts/lib/dashboard-state')
const at = '2026-11-01T15:01:57.000Z'
const live = () => ({
  phase: 'spawned', health: 20, playerName: 'HouchiChan', realm: { name: 'YuK1Game' },
  position: { x: 1, y: 43.62, z: 2 }, positionSource: 'client_prediction',
  inventory: { known: true, items: [{ name: 'minecraft:diamond', count: 1 }] },
  quarry: {
    state: 'MINE', jobId: 'quarry-test', chunks: [{ x: -4, z: 2 }], yTop: 63, yBottom: -59, currentY: 42,
    counts: { remaining: 120, unknown: 5, reserved: 4, deferred: 3 },
    ledger: { minedBlocks: 5234, picked: 5100, deposited: 4096 }, pendingDrops: 8, freeSlots: 7, deferredCount: 3
  },
  depotMission: { enabled: true, phase: 'deposit_diamond', policy: { deposited: 1, depositConfirmedForCurrentLife: true } }
})
const oldMission = { version: 1, work: { title: '古いダイヤ目標完了', state: 'complete' }, milestones: [{ id: 'diamond', label: '旧目標', status: 'done' }] }

test('quarry observation replaces the former diamond/depot presentation and preserves real work counters', () => {
  const status = sanitizeStatus(live(), { observedAt: at, mission: oldMission })
  assert.equal(status.goal, 'quarry')
  assert.deepEqual(status.milestones, [])
  assert.equal(status.work.state, 'running')
  assert.doesNotMatch(status.work.title, /ダイヤ|保管確認/)
  assert.equal(status.quarry.state, 'MINE')
  assert.equal(status.quarry.currentY, 42)
  assert.deepEqual(status.quarry.chunks, [{ x: -4, z: 2 }])
  assert.equal(status.quarry.ledger.minedBlocks, 5234)
  assert.equal(status.quarry.ledger.picked, 5100)
  assert.equal(status.quarry.ledger.deposited, 4096)
  assert.equal(status.quarry.counts.unknown, 5)
  assert.equal(status.quarry.freeSlots, 7)
  assert.equal(status.position.y, 42)
  assert.equal(status.position.confirmed, false)
})

test('missing counters and unavailable scans remain unknown, while observed zero remains zero', () => {
  const raw = live()
  raw.quarry.counts = null
  raw.quarry.ledger = { minedBlocks: 0, picked: -1, deposited: '123' }
  delete raw.quarry.freeSlots
  const status = sanitizeStatus(raw, { observedAt: at })
  assert.equal(status.quarry.counts, null)
  assert.equal(status.quarry.ledger.minedBlocks, 0)
  assert.equal(status.quarry.ledger.picked, null)
  assert.equal(status.quarry.ledger.deposited, null)
  assert.equal(status.quarry.freeSlots, null)
  assert.notEqual(status.work.state, 'complete')
})

test('paused, dead and offline views preserve last observations without claiming active work', () => {
  const raw = live()
  raw.quarry.state = 'PAUSED'
  raw.quarry.pauseReason = 'WAITING_FOR_TOOL'
  const paused = sanitizeStatus(raw, { observedAt: at })
  assert.equal(paused.quarry.pauseReason, 'WAITING_FOR_TOOL')
  assert.notEqual(paused.work.state, 'running')
  assert.notEqual(paused.work.state, 'complete')
  raw.quarry.state = 'MINE'
  const observed = sanitizeStatus(raw, { observedAt: at })
  const cached = sanitizeCachedStatus(observed, { checkedAt: '2026-11-01T15:05:00Z' })
  assert.equal(cached.online, false)
  assert.equal(cached.stale, true)
  assert.equal(cached.observedAt, at)
  assert.equal(cached.quarry.ledger.minedBlocks, 5234)
  assert.notEqual(cached.work.state, 'running')
  raw.health = 0
  const dead = sanitizeStatus(raw, { observedAt: at })
  assert.equal(dead.online, false)
  assert.notEqual(dead.work.state, 'running')
})

test('old cached diamond prose and arbitrary quarry fields cannot become published current progress', () => {
  const raw = live()
  raw.quarry.auth = 'do-not-publish'
  raw.quarry.ledger.extra = 'private-ledger-extra'
  raw.quarry.pauseDetails = { token: 'private-pause-token' }
  const status = sanitizeStatus(raw, { observedAt: at, mission: oldMission })
  assert.doesNotMatch(JSON.stringify(status), /do-not-publish|private-ledger-extra|private-pause-token|古いダイヤ目標完了/)
  const oldCache = { ...status, quarry: null, work: oldMission.work, milestones: oldMission.milestones, depotMission: raw.depotMission }
  const cached = sanitizeCachedStatus(oldCache)
  assert.equal(cached.goal, 'quarry')
  assert.deepEqual(cached.milestones, [])
  assert.notEqual(cached.work.state, 'complete')
  assert.doesNotMatch(cached.work.title, /ダイヤ/)
})

test('completion requires an observed completed result and ordinary finish/stop cannot complete the goal', () => {
  const raw = live()
  raw.quarry.state = 'FINISHED'
  assert.notEqual(sanitizeStatus(raw, { observedAt: at }).work.state, 'complete')
  raw.quarry.result = { type: 'STOPPED', at }
  assert.notEqual(sanitizeStatus(raw, { observedAt: at }).work.state, 'complete')
  raw.quarry.result = { type: 'COMPLETED', at }
  assert.equal(sanitizeStatus(raw, { observedAt: at }).work.state, 'complete')
  raw.quarry.result = { type: 'COMPLETED_WITH_EXCEPTIONS', at }
  assert.equal(sanitizeStatus(raw, { observedAt: at }).work.state, 'complete')
  const cached = sanitizeCachedStatus(sanitizeStatus(raw, { observedAt: at }))
  assert.equal(cached.quarry.result.type, 'COMPLETED_WITH_EXCEPTIONS')
  assert.notEqual(cached.work.state, 'complete')
})

test('pillar progress distinguishes estimated dirt, confirmed mining, and a confirmed surface return across offline cache', () => {
  const raw = live()
  raw.quarry.state = 'EGRESS_PREPARE'
  raw.quarry.egress = { mode: 'adjacent_pillar', phase: 'planned', miningCompleted: true, surfaceReturned: false, reservedDirt: 192, dirtAvailable: 40, estimatedDirtMissing: 152, privateCheckpoint: 'do-not-publish' }
  const planned = sanitizeStatus(raw, { observedAt: at })
  assert.equal(planned.quarry.state, 'EGRESS_PREPARE')
  assert.equal(planned.quarry.egress.estimatedDirtMissing, 152)
  for (const field of ['column', 'requiredDirt', 'totalDirt', 'dirtMissing']) assert.equal(planned.quarry.egress[field], null)
  assert.equal(planned.quarry.egress.miningCompleted, true)
  assert.equal(planned.quarry.egress.surfaceReturned, false)
  assert.doesNotMatch(JSON.stringify(planned), /do-not-publish|privateCheckpoint/)
  raw.quarry.state = 'PAUSED'; raw.quarry.pauseReason = 'EXIT_MATERIAL_MISSING'
  Object.assign(raw.quarry.egress, { phase: 'blocked', column: { x: 16, z: -2, secret: 'do-not-publish' }, landing: { x: 17, y: 68, z: -2 }, startFeet: { x: 16, y: -59, z: -2 }, requiredDirt: 127, reserveDirt: 8, totalDirt: 135, dirtMissing: 95, estimatedDirtMissing: null, reason: 'EXIT_MATERIAL_MISSING' })
  const blocked = sanitizeStatus(raw, { observedAt: at })
  assert.equal(blocked.quarry.egress.dirtMissing, 95); assert.equal(blocked.quarry.egress.estimatedDirtMissing, null)
  assert.deepEqual(blocked.quarry.egress.column, { x: 16, z: -2 })
  const cached = sanitizeCachedStatus(blocked)
  assert.deepEqual(cached.quarry.egress, blocked.quarry.egress); assert.equal(cached.work.state, 'waiting')
  raw.quarry.state = 'FINISHED'; raw.quarry.pauseReason = null; raw.quarry.result = { type: 'COMPLETED', at }
  assert.notEqual(sanitizeStatus(raw, { observedAt: at }).work.state, 'complete', 'the mining milestone alone cannot claim a completed pillar job')
  Object.assign(raw.quarry.egress, { phase: 'completed', surfaceReturned: true, reason: null, dirtMissing: 0 })
  const finished = sanitizeStatus(raw, { observedAt: at })
  assert.equal(finished.work.state, 'complete'); assert.equal(finished.quarry.egress.dirtMissing, 0)
})

test('dashboard renders the estimate separately from the selected column material requirement', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8')
  const source = html.slice(html.indexOf('function finishedQuarryLabel('), html.indexOf('function renderQuarry('))
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {} }); return nodes.get(id) }
  const context = { $: node, set: (id, value) => { node(id).textContent = value }, fmt: String, num: value => Number.isFinite(value) ? value : null, live: () => true, reasons: { EXIT_MATERIAL_MISSING: '脱出用の土が不足' } }
  vm.runInNewContext(source, context)
  context.renderEgress(null); assert.equal(node('egress-panel').hidden, true)
  const egress = { mode: 'adjacent_pillar', phase: 'planned', miningCompleted: false, surfaceReturned: false, reservedDirt: 192, dirtAvailable: 40, estimatedDirtMissing: 152 }
  context.renderEgress(egress)
  assert.equal(node('egress-panel').hidden, false); assert.match(node('egress-dirt').textContent, /確保目安 192個 · 見積不足 152個/)
  assert.doesNotMatch(node('egress-dirt').textContent, /必要 192/)
  Object.assign(egress, { phase: 'blocked', miningCompleted: true, column: { x: 16, z: 4 }, totalDirt: 108, requiredDirt: 100, reserveDirt: 8, dirtMissing: 68, reason: 'EXIT_MATERIAL_MISSING' })
  context.renderEgress(egress)
  assert.equal(node('egress-panel').open, true); assert.match(node('egress-dirt').textContent, /必要 108個.*不足 68個/)
  assert.match(node('egress-milestones').textContent, /採掘 完了 · 地上復帰 未確認/); assert.match(node('egress-reason').textContent, /土が不足/)
  assert.equal(context.finishedQuarryLabel({ result: { type: 'COMPLETED' }, egress }), '地上復帰の確認待ち')
})

test('the unified dashboard keeps valid inline JavaScript and remains an observation-only page', () => {
  const filename = process.env.DEPOT_DASHBOARD_HTML ?? path.resolve(__dirname, '../dashboard/index.html')
  const html = fs.readFileSync(filename, 'utf8')
  for (const [index, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries()) new vm.Script(match[1], { filename: 'dashboard-inline-' + index })
  assert.match(html, /露天掘り/)
  assert.match(html, /シュルカー/)
  assert.match(html, /エンチャント/)
  assert.match(html, /耐久/)
  assert.match(html, /id="logs"/)
  assert.match(html, /\/api\/logs\/stream/)
  assert.doesNotMatch(html, /\/action|\/respawn|\/agent\/start|ダイヤを1個採取/)
})
