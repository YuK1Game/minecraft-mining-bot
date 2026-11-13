'use strict'
// Live 2026-11-14 02:50: after a server-side disconnect the dashboard's automatic
// reconnect restored nothing, because the job the user left running was already
// paused (SUPPLY_RESTOCK_BLOCKED). Such a job is now selected for loading; a job
// the user paused, stopped or finished is not.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { selectPausedRunningCandidate, selectRecoveryCandidate } = require('../src/quarry-recovery')

const state = { profile: 'bot', realm: { id: '21225335' }, dimension: 'overworld' }
const now = Date.parse('2026-11-14T03:00:00Z')
const doc = (extra = {}) => ({ config: { jobId: 'q1' }, world: { profile: 'bot', realmId: '21225335', dimension: 'overworld' }, savedAt: '2026-11-14T02:40:00Z', state: 'PAUSED', userRunIntent: 'running', pauseReason: 'SUPPLY_RESTOCK_BLOCKED', pauseDetails: { reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED' }, ...extra })

test('a job left running but paused for another reason is selected for loading after a reconnect', () => {
  assert.equal(selectRecoveryCandidate([doc()], state, now), null, 'the ordinary restore still skips it')
  assert.equal(selectPausedRunningCandidate([doc()], state, now)?.config.jobId, 'q1')
})

test('paused by the user, stopped, finished, failed persistence, another world or too old is not selected', () => {
  for (const extra of [{ userRunIntent: 'paused' }, { userRunIntent: 'stopped' }, { userRunIntent: 'cancelled' }, { requestedStop: { reason: 'x' } }, { state: 'FINISHED' }, { result: { type: 'COMPLETED' } }, { persistence: { status: 'failed' } }, { world: { profile: 'bot', realmId: '1', dimension: 'overworld' } }, { savedAt: '2026-11-12T00:00:00Z' }]) {
    assert.equal(selectPausedRunningCandidate([doc(extra)], state, now), null, JSON.stringify(extra))
  }
})

test('a job the ordinary restore resumes is left to it', () => {
  assert.equal(selectPausedRunningCandidate([doc({ state: 'MINE', pauseReason: null })], state, now), null)
  assert.equal(selectPausedRunningCandidate([doc({ pauseReason: 'DISCONNECTED' })], state, now), null)
})

test('only the latest job of the world counts', () => {
  const older = doc({ config: { jobId: 'old' }, savedAt: '2026-11-14T01:00:00Z' })
  const newerStopped = doc({ config: { jobId: 'new' }, savedAt: '2026-11-14T02:50:00Z', userRunIntent: 'stopped' })
  assert.equal(selectPausedRunningCandidate([older, newerStopped], state, now), null)
})
