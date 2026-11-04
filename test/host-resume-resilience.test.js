'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resumeRuntimeSafely, createOnlineEmergencyHandler } = require('../src/host')

test('reload resume synchronously throwing or asynchronously rejecting records bounded error and preserves transport', async () => {
  for (const asynchronous of [false, true]) {
    const shared = { safetyWanted: true, autoWanted: true }, reports = []
    let closed = 0
    const runtime = { resumeRequested: () => { const error = new ReferenceError('WORK_MARGIN missing ' + 'x'.repeat(500)); if (asynchronous) return Promise.reject(error); throw error }, close: () => { closed++ } }
    const scheduled = () => resumeRuntimeSafely(runtime, { shared, source: 'reload', onError: receipt => reports.push(receipt) })
    const result = await new Promise(resolve => setImmediate(() => resolve(scheduled())))
    assert.equal(result, false)
    assert.equal(reports.length, 1)
    assert.ok(shared.runtimeResumeError.message.length > 0 && shared.runtimeResumeError.message.length <= 300)
    assert.equal(shared.runtimeResumeError.source, 'reload')
    assert.equal(shared.safetyWanted, true)
    assert.equal(shared.autoWanted, true)
    assert.equal(closed, 0)
  }
})

test('online emergency contains both resume failure forms without unhandled rejection or local disconnect', async () => {
  for (const asynchronous of [false, true]) {
    const state = { phase: 'spawned', connectionId: 'same-socket', health: 6 }, shared = { safetyWanted: true, autoWanted: true }, reports = []
    let closed = 0
    const runtime = { resumeRequested: () => { if (asynchronous) return Promise.reject(new Error('resume rejected')); throw new Error('resume threw') }, close: () => { closed++ } }
    const emergency = createOnlineEmergencyHandler({ getState: () => state, getShared: () => shared, getCurrent: () => runtime, report: receipt => reports.push({ ...receipt }) })
    assert.equal(emergency({ reasonCode: 'DEFENSE_UNAVAILABLE' }).accepted, true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(shared.onlineEmergency.status, 'remaining_online')
    assert.equal(shared.runtimeResumeError.source, 'online_emergency')
    assert.match(shared.onlineEmergency.resumeError, /resume (rejected|threw)/)
    assert.equal(reports.length, 2)
    assert.equal(state.phase, 'spawned')
    assert.equal(shared.safetyWanted, true)
    assert.equal(shared.autoWanted, true)
    assert.equal(closed, 0)
  }
})
