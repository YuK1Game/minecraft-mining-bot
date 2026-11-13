'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sanitizeStatus, sanitizeCachedStatus } = require('../scripts/lib/dashboard-state')
const at = '2026-11-13T06:30:00.000Z'
const live = quarry => ({ phase: 'spawned', health: 20, quarry: { jobId: 'job-1', ...quarry } })
const activity = (quarry, extra = {}) => sanitizeStatus({ ...live(quarry), ...extra }, { observedAt: at }).activity

test('activity line names what the quarry is doing now', () => {
  assert.deepEqual(activity({ state: 'MINE', currentY: -12 }), { kind: 'busy', label: '採掘中', detail: 'Y -12', code: null })
  assert.equal(activity({ state: 'PORTABLE_STORAGE', portableStorage: { kind: 'shulker', stage: 'depositing' } }).label, 'シュルカーへ収納中')
  assert.equal(activity({ state: 'PORTABLE_STORAGE', portableStorage: { kind: 'shulker', stage: 'breaking' } }).label, 'シュルカーを回収中')
  assert.equal(activity({ state: 'RESTOCK', supplies: { active: { operationId: 'x', phase: 'transferring' } } }).label, '補給箱からアイテムを回収中')
  assert.equal(activity({ state: 'RESTOCK', supplies: { active: { phase: 'intent' } } }).label, '補給箱へ移動中')
  assert.equal(activity({ state: 'COLLECT', pendingDrops: 3 }).detail, '残り 3 個')
  assert.equal(activity({ state: 'MINE' }, { userBehaviors: { activeKind: 'combat' } }).label, '戦闘中')
})

test('errors, waits and pauses share the same slot', () => {
  assert.deepEqual(activity({ state: 'PAUSED', pauseReason: 'CARRIED_STORAGE_BLOCKED' }), { kind: 'error', label: '一時停止: シュルカーを置ける場所がありません', detail: null, code: 'CARRIED_STORAGE_BLOCKED' })
  assert.deepEqual(activity({ state: 'PAUSED', pauseReason: 'ACTION_FAILED', autoRetry: { kind: 'action', reason: 'ACTION_FAILED', attempt: 1, max: 3, inSeconds: 27 } }), { kind: 'waiting', label: '待機中: 操作が完了しませんでした', detail: '自動で再試行 · あと27秒 · 1/3回目', code: 'ACTION_FAILED' })
  assert.equal(activity({ state: 'PAUSED', pauseReason: 'MANUAL_PAUSE' }).kind, 'paused')
  assert.equal(activity({ state: 'PAUSED', pauseReason: 'SOMETHING_NEW' }).label, '一時停止: SOMETHING_NEW')
  assert.equal(activity({ state: 'MINE', persistence: { status: 'failed', error: 'EIO' } }).kind, 'error')
  assert.equal(activity({ state: 'FINISHED', result: { type: 'COMPLETED' } }).kind, 'done')
  assert.equal(sanitizeStatus({ phase: 'spawned', health: 0 }, { observedAt: at }).activity.kind, 'error')
  assert.equal(sanitizeStatus({ phase: 'spawned', health: 20 }, { observedAt: at }).activity.label, '待機中: 露天掘りのジョブなし')
})

// 2026-11-14 user question "なんの待機？": waiting and pauses always say what for,
// including the sub-reason in pauseDetails.
test('waiting and pauses always say what they wait for in Japanese', () => {
  assert.equal(activity({ state: 'IDLE' }).label, '待機中: 計画の確認と開始待ち')
  const paused = activity({ state: 'PAUSED', pauseReason: 'SUPPLY_RESTOCK_BLOCKED', pauseDetails: { reason: 'SUPPLY_SCOPE_CHANGED' } })
  assert.equal(paused.label, '一時停止: 補給箱から取り出せません')
  assert.equal(paused.detail, '接続が変わったため補給の続きを確認できません')
  assert.equal(activity({ state: 'PAUSED', pauseReason: 'EXIT_SUPPLY_UNCONFIRMED' }).label, '一時停止: 脱出用の補給品を確認できません')
  assert.equal(activity({ state: 'PAUSED', pauseReason: 'MANUAL_PAUSE' }).label, '一時停止: 手動で一時停止')
})

test('a cached snapshot never claims current activity', () => {
  const status = sanitizeStatus(live({ state: 'MINE', currentY: 4, supplies: { active: { phase: 'transferring' } } }), { observedAt: at })
  const cached = sanitizeCachedStatus(status)
  assert.equal(cached.activity.kind, 'offline')
  assert.deepEqual(cached.quarry.supplyRestock, { phase: 'transferring' })
})
