'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildWalk, createMemo } = require('../src/modes/player-build-walk')
const { planBuildRouteAsync } = require('../src/movement/build-route')
const { createScaffoldPorts } = require('../src/modes/player-scaffold-ports')

// Real build-walk and build-route over a received two-high stone passage.
// The only server stand-ins are the hands and their inventory/block replies.
function scene () {
  const cells = new Map(), target = { x: 2, y: 1, z: 0 }, memo = createMemo(), plans = []
  const state = { feet: { x: 0.5, y: 1, z: 0.5 }, inventory: { known: true, items: [] }, scope: 'realm:overworld', hand: false, attempts: 0, mined: 0, refusal: 'NO_TOOL' }
  const block = (x, y, z) => {
    const name = cells.get(`${x},${y},${z}`) ?? ((y === 1 || y === 2) && z === 0 && x >= 0 && x <= 2 ? (x === 1 ? 'minecraft:stone' : 'minecraft:air') : 'minecraft:bedrock')
    return { known: true, name, boundingBox: name === 'minecraft:air' ? 'empty' : 'block' }
  }
  const ports = {
    feet: () => ({ ...state.feet }), block, fill: () => 0,
    buildConditions: () => ({ scope: state.scope, inventory: state.inventory }),
    walk: async at => { state.feet = { ...at }; return true },
    canMine: () => state.hand, canDig: () => false, reason: () => state.refusal,
    pick: async () => { state.attempts++; state.hand = state.inventory.items.some(i => i.name === 'minecraft:stone_pickaxe' && i.durabilityKnown && i.durabilityRemaining > 2); return state.hand },
    mine: async at => { state.mined++; cells.set(`${at.x},${at.y},${at.z}`, 'minecraft:air'); return true }
  }
  const run = () => buildWalk({ ports, target, done: n => n.x === 2 && n.y === 1 && n.z === 0, memo, limits: { pad: 2, rise: 0 }, plan: options => { plans.push(new Set(options.refused)); return planBuildRouteAsync(options) } })
  return { state, ports, memo, cells, plans, run }
}

test('the next walk retries a refused stone after receiving a usable pickaxe, including one not equipped yet', async () => {
  const f = scene()
  assert.equal((await f.run()).ok, false)
  assert.equal(f.state.attempts, 1)
  assert.equal((await f.run()).ok, false)
  assert.equal(f.state.attempts, 1, 'unchanged failures stay remembered')
  f.state.inventory.items.push({ name: 'minecraft:stone_pickaxe', count: 1, slot: 15, durabilityKnown: true, durabilityRemaining: 80 })
  assert.equal(f.state.hand, false)
  assert.equal((await f.run()).ok, true)
  assert.equal(f.state.mined, 2)
  assert.equal(f.state.attempts, 2, 'the new tool is actually equipped before the ordinary mine')
})

test('ordinary tool wear and unrelated terrain updates keep a structural failure remembered', async () => {
  const f = scene()
  f.state.inventory.items.push({ name: 'minecraft:iron_pickaxe', count: 1, slot: 0, durabilityKnown: true, durabilityRemaining: 100 })
  f.state.refusal = 'MINING_FACE_BLOCKED'
  assert.equal((await f.run()).ok, false)
  f.state.inventory.items[0].durabilityRemaining = 99
  f.cells.set('100,2,100', 'minecraft:air')
  assert.equal((await f.run()).ok, false)
  assert.equal(f.state.attempts, 1)
  assert.ok(f.plans.at(-1).size > 0)
})

test('a relevant neighbour change or a different world discards only the now-stale failure', async () => {
  for (const change of [f => f.cells.set('1,2,1', 'minecraft:air'), f => { f.state.scope = 'other-realm:overworld' }]) {
    const f = scene(); f.state.refusal = 'MINING_FACE_BLOCKED'
    assert.equal((await f.run()).ok, false)
    change(f)
    const before = f.plans.length
    assert.equal((await f.run()).ok, false, 'ordinary mining still refuses; changed conditions are not success evidence')
    assert.equal(f.plans[before].size, 0)
    assert.equal(f.state.attempts, 2)
  }
})

test('a transient owner refusal is not kept as an impassable block for the next walk', async () => {
  const f = scene(); f.state.refusal = 'CHUNK_MOVE_BUSY'
  assert.equal((await f.run()).ok, false)
  assert.deepEqual(f.memo.live('refused'), [])
  assert.equal((await f.run()).ok, false)
  assert.equal(f.state.attempts, 2)
})

test('the actual scaffold port exposes current received inventory and world scope without issuing inputs', () => {
  let inventory = { known: true, items: [] }, scope = 'realm:overworld'
  const ports = createScaffoldPorts({ getBlock: () => ({ known: false }), getFeet: () => null, getInventory: () => inventory, getScope: () => scope, getMotion: () => ({ phase: 'idle' }), operations: {}, pillarStep: async () => ({}) })
  assert.deepEqual(ports.buildConditions(), { scope, inventory })
  inventory = { known: true, items: [{ name: 'minecraft:stone_pickaxe', count: 1 }] }; scope = 'realm:nether'
  assert.deepEqual(ports.buildConditions(), { scope, inventory })
})

test('mode wiring reads the Host life separately from raw state and never reuses failures across death or reconnect', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
  const { createRequire, wrap } = require('node:module')
  const { failureRecord, sameFailure } = require('../src/modes/build-walk-memo')
  const filename = require.resolve('../src/modes/mode-runtime'), load = createRequire(filename), mod = { exports: {} }, captured = []
  // Capture the real scaffold port while running the complete mode wiring.
  require('node:vm').runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(mod.exports, name => name === './player-scaffold-ports'
    ? { createScaffoldPorts: options => { const ports = createScaffoldPorts(options); captured.push(ports); return ports } }
    : load(name), mod, filename, path.dirname(filename))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-memo-life-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = { profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'one', startedAt: '2026-11-21T00:00:00Z', runtimeEntityId: '1', inventory: { known: true, items: [] } }
  let life = { connectionId: 'one', deathId: 0, dead: false }
  const host = { shared: {}, log () {}, getLife: () => life, world: { getBlock: () => ({ known: true, name: 'minecraft:stone', boundingBox: 'block' }) } }
  const operations = { quarry: { status: () => null, start () {}, resume () {} }, agent: { start () {}, stop () {} }, safety: { start () {} } }
  const runtime = { host: () => host, raw: () => state, inventory: () => state.inventory, autonomy: () => ({ running: false }), chunkMoveHeld: () => false, resetHeld: () => false, manualChestStorage: () => null }
  mod.exports.attachModeOperations(operations, runtime, { root })
  assert.equal(state.lifecycle, undefined, 'the production raw Host snapshot has no lifecycle')
  const ports = captured[0], points = [{ x: 1, y: 1, z: 0 }]
  const failure = failureRecord(ports, points, 'refused', 'NO_TOOL')
  assert.ok(failure, 'a received Host counter enables the persistent failure memo')
  assert.equal(sameFailure(ports, failure), true)
  life = { ...life, deathId: 1 }
  assert.equal(sameFailure(ports, failure), false)
  const afterDeath = failureRecord(ports, points, 'refused', 'NO_TOOL')
  state.connectionId = 'two'
  assert.equal(ports.buildConditions().scope, null, 'a prior connection counter is unavailable for this connection')
  life = { connectionId: 'two', deathId: 0, dead: false }
  assert.equal(sameFailure(ports, afterDeath), false)
  assert.ok(failureRecord(ports, points, 'refused', 'NO_TOOL'))
  life = null
  assert.equal(failureRecord(ports, points, 'refused', 'NO_TOOL'), null, 'an unavailable Host counter is not assumed to be life zero')
})

test('cancelling a pending build plan starts no action and adds no failure memory', async () => {
  const f = scene(); let cancelled = false, finish
  const pending = buildWalk({ ports: f.ports, target: { x: 2, y: 1, z: 0 }, done: () => false, memo: f.memo, aborted: () => cancelled,
    plan: () => new Promise(resolve => { finish = resolve }) })
  await new Promise(resolve => setImmediate(resolve)); cancelled = true
  finish({ ok: true, steps: [{ kind: 'walk', dig: [{ x: 1, y: 1, z: 0 }], to: { x: 1, y: 1, z: 0 } }] })
  assert.equal((await pending).code, 'INTERRUPTED')
  assert.equal(f.state.attempts, 0)
  assert.deepEqual(f.memo.live('refused'), [])
})

test('cancelling a bundled walk does not start its single-step fallback', async () => {
  const f = scene(); let cancelled = false, finish, starts = 0
  f.ports.walk = () => { starts++; return new Promise(resolve => { finish = resolve }) }
  const pending = buildWalk({ ports: f.ports, target: { x: 4, y: 1, z: 0 }, done: () => false, memo: f.memo, aborted: () => cancelled,
    plan: async () => ({ ok: true, steps: [1, 2, 3, 4].map(x => ({ kind: 'walk', dig: [], to: { x, y: 1, z: 0 } })) }) })
  await new Promise(resolve => setImmediate(resolve)); cancelled = true; finish(false)
  assert.equal((await pending).code, 'INTERRUPTED')
  assert.equal(starts, 1)
  assert.deepEqual(f.memo.live('barred'), [])
})

test('health recovery and protection changes invalidate their own local failure, and missing scope is not remembered', () => {
  const { failureRecord, sameFailure } = require('../src/modes/build-walk-memo')
  const f = scene(), points = [{ x: 0, y: 1, z: 0 }, { x: 1, y: -3, z: 0 }]
  let health = 10.2, protectedBlock = false
  f.ports.health = () => health
  const original = f.ports.block
  f.ports.block = (x, y, z) => ({ ...original(x, y, z), protected: protectedBlock })
  const healthFailure = failureRecord(f.ports, points, 'barred', 'DROP_TOO_DEEP_FOR_HEALTH')
  health = 10.9
  assert.equal(sameFailure(f.ports, healthFailure), true, 'fractional recovery has not increased the allowed fall')
  health = 12
  assert.equal(sameFailure(f.ports, healthFailure), false)
  const blocked = failureRecord(f.ports, points, 'barred', 'WALK_FAILED')
  protectedBlock = true
  assert.equal(sameFailure(f.ports, blocked), false)
  f.state.scope = null
  assert.equal(failureRecord(f.ports, points, 'barred', 'WALK_FAILED'), null)
})
