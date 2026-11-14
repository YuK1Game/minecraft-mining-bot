'use strict'

// A long trip is started outside the page. The control snapshot carries its
// received status and the "what it is doing now" band names the trip instead
// of "waiting, no quarry job". Runs the page's own controlActivity code.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createDashboardControl } = require('../src/dashboard-control')
const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8')
const line = start => { const found = html.split(/\r?\n/).find(text => text.startsWith(start)); assert.ok(found, 'page code exists: ' + start); return found }
const body = (() => { const first = html.indexOf('function controlActivity(){'), last = html.indexOf('function noteActivity()', first); assert.ok(first >= 0 && last > first); return html.slice(first, last) })()

function band (live, activity = { kind: 'idle', label: '待機中: 露天掘りのジョブなし' }) {
  const context = vm.createContext({ document: { getElementById: () => ({}), createElement: () => ({}) }, Intl, controlLive: live, snapshot: { activity } })
  vm.runInContext(line('const $=id=>') + '\n' + line('const fmt=') + '\n' + line('const clean=') + '\n' + body + '\nresult=controlActivity()', context)
  return context.result ? JSON.parse(JSON.stringify(context.result)) : null
}
function snapshotWith (travelStatus) {
  const state = { phase: 'spawned', health: 20, profile: 'bot', realm: { id: 1, name: 'Realm' }, dimension: 'overworld', connectionId: 'c', startedAt: '2026-11-14T00:00:00.000Z', position: { x: 0.5, y: 65.62, z: 0.5 }, lifecycle: { deathId: 0 }, inventory: { known: true } }
  const quarry = { status: () => ({}), ...(travelStatus === undefined ? {} : { travelStatus }) }
  return createDashboardControl({ getState: () => state, getQuarry: () => quarry, disconnect () {} }).snapshot()
}

test('the control snapshot carries only the trip fields the page shows', () => {
  const travel = snapshotWith(() => ({ busy: true, phase: 'moving', remaining: 1902.6, legs: 14, failures: 2, destination: { x: 1975.4, y: null, z: -2040.2 }, reason: null, message: 'x'.repeat(500), timing: { a: 1 } })).travel
  assert.deepEqual(travel, { busy: true, phase: 'moving', remaining: 1903, legs: 14, destination: { x: 1975, z: -2040 }, reason: null })
  assert.deepEqual(snapshotWith(undefined).travel, { busy: false, phase: 'idle', remaining: null, legs: null, destination: null, reason: null })
  assert.deepEqual(snapshotWith(() => { throw new Error('reloading') }).travel, { busy: false, phase: 'idle', remaining: null, legs: null, destination: null, reason: null })
  assert.equal(snapshotWith(() => ({ busy: 'yes', destination: { x: NaN, z: 1 }, remaining: Infinity })).travel.busy, false)
})

test('the band names a running trip with the received distance left and the destination', () => {
  const live = snapshotWith(() => ({ busy: true, phase: 'moving', remaining: 1903, legs: 14, destination: { x: 1975, z: -2040 } }))
  assert.deepEqual(band(live), { kind: 'busy', label: '長距離移動中', detail: '残り 1,903m · 目的地 X 1975 Z -2040', code: null })
  live.travel.phase = 'waiting'; live.travel.remaining = null
  assert.deepEqual(band(live), { kind: 'busy', label: '長距離移動: 一時待機中', detail: '目的地 X 1975 Z -2040', code: null })
})

test('combat keeps the band during a trip, and a finished trip or an older Bot shows nothing extra', () => {
  const live = snapshotWith(() => ({ busy: true, phase: 'moving', remaining: 50, destination: { x: 1, z: 2 } }))
  assert.equal(band(live, { kind: 'busy', label: '戦闘中' }), null)
  assert.equal(band(snapshotWith(() => ({ busy: false, phase: 'arrived', remaining: 3, destination: { x: 1, z: 2 } }))), null)
  const old = snapshotWith(undefined); delete old.travel
  assert.equal(band(old), null)
})
