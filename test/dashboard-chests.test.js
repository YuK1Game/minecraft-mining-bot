'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readChestIndex } = require('../scripts/lib/dashboard-chests')
const { createDashboard } = require('../scripts/dashboard')

function makeTempWorkspace (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmb-dash-chests-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function invoke (handler, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let status = 0
    let resHeaders = {}
    const chunks = []
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:3001', ...headers },
      resume () {}
    }
    const res = {
      headersSent: false,
      writeHead (code, hdrs = {}) { status = code; resHeaders = hdrs; this.headersSent = true },
      end (data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); resolve({ status, headers: resHeaders, body: Buffer.concat(chunks).toString('utf8') }) },
      destroy (err) { reject(err || new Error('destroyed')) }
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

test('readChestIndex reads latest realm file, tags base chests first, and fills slot grid cleanly', async t => {
  const root = makeTempWorkspace(t)
  fs.mkdirSync(path.join(root, '.local', 'chest-index'), { recursive: true })
  fs.writeFileSync(path.join(root, '.local', 'player-house.json'), JSON.stringify({ origin: { x: 9880, y: 65, z: 10140 } }))
  fs.writeFileSync(path.join(root, '.local', 'chest-index', 'realm-21225335.json'), JSON.stringify({
    version: 1,
    realmId: '21225335',
    updatedAt: '2026-11-27 14:00:00 JST',
    chests: {
      'overworld:9950,48,10234': {
        dimension: 'overworld',
        position: { x: 9950, y: 48, z: 10234 },
        slotCount: 27,
        large: false,
        empty: 25,
        receivedAt: 2000,
        receivedAtJST: '2026-11-27 13:55:00 JST',
        items: { 'minecraft:raw_iron': 33, 'minecraft:coal': 12 },
        slots: [
          { slot: 0, known: true, name: 'minecraft:raw_iron', count: 33 },
          { slot: 1, known: true, name: 'minecraft:coal', count: 12 }
        ]
      },
      'overworld:9880,65,10139': {
        dimension: 'overworld',
        position: { x: 9880, y: 65, z: 10139 },
        slotCount: 54,
        large: true,
        empty: 10,
        receivedAt: 1000,
        receivedAtJST: '2026-11-27 13:50:00 JST',
        items: { 'minecraft:iron_pickaxe': 1, 'minecraft:cooked_mutton': 8 },
        slots: [
          { slot: 0, known: true, name: 'minecraft:iron_pickaxe', count: 1 },
          { slot: 1, known: true, name: 'minecraft:cooked_mutton', count: 8 }
        ]
      }
    }
  }))

  const result = await readChestIndex({ workspaceRoot: root })
  assert.equal(result.realmId, '21225335')
  assert.equal(result.chests.length, 2)
  assert.equal(result.chests[0].role, 'base', 'base chest sorted first')
  assert.equal(result.chests[0].slotCount, 54)
  assert.equal(result.chests[0].used, 44)
  assert.equal(result.chests[0].slots.length, 54)
  assert.equal(result.chests[1].role, 'field')
  assert.equal(result.chests[1].items[0].name, 'minecraft:raw_iron')
  assert.equal(result.chests[1].items[0].count, 33)
})

test('dashboard serves GET /api/chests and /chests.{js,css} read-only with origin/site guards', async t => {
  const root = makeTempWorkspace(t)
  fs.mkdirSync(path.join(root, '.local', 'chest-index'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dashboard', 'chests.js'), '/* ok */')
  fs.writeFileSync(path.join(root, 'dashboard', 'chests.css'), '/* ok */')
  fs.writeFileSync(path.join(root, '.local', 'chest-index', 'realm-1.json'), JSON.stringify({
    version: 1,
    realmId: '1',
    updatedAt: '2026-11-27 14:00:00 JST',
    chests: {
      'overworld:10,64,20': {
        dimension: 'overworld',
        position: { x: 10, y: 64, z: 20 },
        slotCount: 27,
        large: false,
        empty: 26,
        receivedAt: 100,
        items: { 'minecraft:diamond': 5 },
        slots: [{ slot: 0, known: true, name: 'minecraft:diamond', count: 5 }]
      }
    }
  }))

  const dash = createDashboard({ workspaceRoot: root })
  const res = await invoke(dash.handler, { method: 'GET', url: '/api/chests' })
  assert.equal(res.status, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.chests.length, 1)
  assert.equal(parsed.chests[0].items[0].name, 'minecraft:diamond')

  assert.equal((await invoke(dash.handler, { method: 'POST', url: '/api/chests' })).status, 405)
  assert.equal((await invoke(dash.handler, { method: 'GET', url: '/api/chests', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await invoke(dash.handler, { method: 'GET', url: '/chests.js' })).status, 200)
  assert.equal((await invoke(dash.handler, { method: 'GET', url: '/chests.css' })).status, 200)
})
