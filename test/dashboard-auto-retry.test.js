'use strict'

// 2026-11-13: a scheduled bounded automatic retry is shown as a wait, not an error.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sanitizeStatus } = require('../scripts/lib/dashboard-state')

test('the quarry auto retry is passed to the dashboard with bounded fields', () => {
  const raw = { phase: 'spawned', health: 20, quarry: { state: 'PAUSED', jobId: 'j', pauseReason: 'CARRIED_STORAGE_BLOCKED', autoRetry: { kind: 'capacity', reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED', attempt: 2, max: 8, inSeconds: 41, nextAt: 1 } } }
  const s = sanitizeStatus(raw, { observedAt: '2026-11-13T04:00:00.000Z' })
  assert.deepEqual(s.quarry.autoRetry, { kind: 'capacity', reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED', attempt: 2, max: 8, inSeconds: 41 })
  const none = sanitizeStatus({ ...raw, quarry: { ...raw.quarry, autoRetry: null } }, { observedAt: '2026-11-13T04:00:00.000Z' })
  assert.equal(none.quarry.autoRetry, null)
})
