'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createApi } = require('../src/host/api')
const { createStatusSnapshot } = require('../src/runtime/status-snapshot')
const { requestLocalStatus } = require('../scripts/dashboard')
const { sanitizeStatus } = require('../scripts/lib/dashboard-state')
const { createTerrainObservers } = require('../src/host/terrain-observer')
const { createQuarryPlanner } = require('../src/quarry/quarry-planner')
const { buildRegions } = require('../src/quarry/quarry-region')

test('review: dashboard transport reads the small projection; explicit diagnostics retain the full snapshot', async t => {
  const state = { phase: 'spawned', profile: 'bot', health: 20, realm: { id: '1', name: 'test' }, position: { x: 0.5, y: 65.62, z: 0.5 }, positionSource: 'server', inventory: { known: true, items: [] } }
  let fullCalls = 0, summaries = 0
  const status = createStatusSnapshot({
    host: { shared: { vitals: { hunger: { value: 18, source: 'server_attribute' } } } },
    inventoryInspection: { snapshot: () => ({}) }, userBehaviorSnapshot: () => ({ ready: true, busy: false }),
    quarrySnapshot: options => { assert.equal(options.detail, false); summaries++; return { jobId: 'job', state: 'MINE', counts: { remaining: 5, unknown: 0, reserved: 0, deferred: 0 } } },
    observedState: () => assert.fail('display must not trigger combat observation'),
    publishWalker: () => assert.fail('display must not publish movement predictions')
  })
  const full = { ...state, diagnosticHistory: 'x'.repeat(100000) }
  const api = createApi({ snapshot: () => { fullCalls++; return full }, dashboardSnapshot: () => ({ ...state, ...status.getDashboardSnapshot(state) }) })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => api.close(resolve)))
  const port = api.address().port
  const observation = await requestLocalStatus({ apiPort: port, timeoutMs: 800 })
  assert.equal(fullCalls, 0)
  assert.equal(summaries, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) < 2000)
  const publicState = sanitizeStatus(observation)
  assert.equal(publicState.quarry.counts.remaining, 5)
  assert.equal(publicState.health, 20)
  assert.equal(publicState.hunger, 18)
  const response = await new Promise((resolve, reject) => http.get({ hostname: '127.0.0.1', port, path: '/status', agent: false }, res => {
    let body = ''; res.on('data', data => { body += data }); res.on('end', () => resolve(JSON.parse(body)))
  }).on('error', reject))
  assert.equal(fullCalls, 1)
  assert.equal(response.diagnosticHistory.length, 100000)
})

function terrainFixture () {
  const versions = new Map(), changes = new Map()
  let reads = 0
  const observations = createTerrainObservers({ epoch: () => 'same-world', version: key => versions.get(key) ?? 0 })
  const section = (x, y, z) => [x, y, z].map(v => Math.floor(v / 16))
  const getBlock = (x, y, z) => {
    reads++; observations.read(...section(x, y, z))
    const changed = changes.get(`${x},${y},${z}`)
    if (changed === 'unknown') return { known: false }
    const name = changed ?? (y < 8 ? 'stone' : 'air')
    return { known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] }
  }
  const change = (x, y, z, name) => { changes.set(`${x},${y},${z}`, name); const key = section(x, y, z).join(','); versions.set(key, (versions.get(key) ?? 0) + 1) }
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }, { x: 1, z: 0 }] }, yTop: 31, yBottom: 0 })
  const planner = createQuarryPlanner({ regions, getBlock })
  const scan = current => planner.countsAsync(31, current, { observeTerrain: observations.observe })
  return { planner, scan, change, readCount: () => reads, resetReads: () => { reads = 0 } }
}

test('review: quarry display counts rescan only affected sections and completion still reads every cell', async () => {
  const f = terrainFixture(), first = await f.scan()
  assert.equal(f.readCount(), 16384)
  assert.equal(first.remaining, 4096)
  f.resetReads()
  f.change(1000, 10, 1000, 'stone')
  assert.deepEqual(await f.scan(), first)
  assert.equal(f.readCount(), 0, 'unrelated terrain packets do not rescan a deep quarry')
  f.change(1, 20, 1, 'stone')
  assert.equal((await f.scan()).remaining, 4097)
  assert.equal(f.readCount(), 4096, 'only the changed section is traversed')
  f.resetReads()
  f.change(2, 20, 2, 'unknown')
  assert.equal((await f.scan()).unknown, 1)
  f.change(2, 20, 2, 'air')
  assert.equal((await f.scan()).unknown, 0)
  f.resetReads()
  assert.equal(f.planner.counts(31).remaining, 4097)
  assert.equal(f.readCount(), 16384, 'completion is independent of the display cache')
})

test('review: a canceled display scan yields without publishing partial counts', async () => {
  const f = terrainFixture()
  let active = true, heartbeat = false
  setImmediate(() => { active = false; heartbeat = true })
  assert.equal(await f.scan(() => active), null)
  assert.equal(heartbeat, true)
  assert.ok(f.readCount() < 16384)
})
