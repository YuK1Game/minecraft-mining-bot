'use strict'

// Real return runner/stages and durable file writes; only the world, clock and
// pending movement boundary are controlled here. No Bot or Realm is started.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createReturnRunner } = require('../src/modes/return/return-runner')
const { newGoal } = require('../src/modes/return/return-goal')
const { writeDurableJson } = require('../src/common/durable-json')

function deferred () {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture () {
  const state = { now: 0, scope: 'connection-1/overworld/life-1', disposed: false, inside: false, covered: false, inventory: { items: [{ name: 'minecraft:diamond', count: 64 }] } }
  const shared = { playerWanted: true, playerBase: { x: 100, y: 64, z: 0 } }
  const log = [], calls = [], starts = []
  const ports = {
    getPosition: () => ({ x: 0.5, y: 65.62, z: 0.5 }), getFeet: () => ({ x: 0.5, y: 64, z: 0.5 }), getInventory: () => state.inventory,
    getBlock: (x, y, z) => ({ known: true, name: y < 64 || (state.covered && y === 68) ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 64 || (state.covered && y === 68) ? 'block' : 'empty' }), dimension: () => 'overworld',
    moves: {
      climb: async () => null, water: { needed: () => false }, house: { inside: () => state.inside, leave: async () => { state.inside = false; return true } },
      travel: { to: async input => { calls.push({ input, scope: state.scope, wanted: shared.playerWanted }) }, status: () => ({ busy: false }), cancel: async () => {} }
    },
    chests: { hands: {}, spares: () => [], near: () => [] }
  }
  const policy = { due: () => true, reason: () => 'test cargo', supplies: () => 'same supplies', cargo: () => state.inventory?.items ?? [], restockWanted: () => false, canBuild: () => false }
  const config = {
    getMode: () => 'player', shared, ports, policy, scope: () => state.scope, disposed: () => state.disposed, settled: () => true,
    agent: { running: () => false, stop: () => {}, start: async () => { starts.push(state.now) }, objective: { objective: 'diamond' } },
    log: text => log.push(text), now: () => state.now, sleep: async ms => { state.now += ms }, newId: () => 'return-goal'
  }
  return { state, shared, ports, policy, config, log, calls, starts }
}

test('partial terrain does not immediately retry or exhaust the return; the missing cells release it', async () => {
  const f = fixture(), received = new Set([63])
  const get = f.ports.getBlock
  f.ports.getBlock = (x, y, z) => received.has(y) ? get(x, y, z) : { known: false }
  const runner = createReturnRunner(f.config)
  await runner.tick()
  assert.equal(runner.status().goal.attempts, 1, 'one blocked observation, not three in the same tick')
  assert.equal(runner.status().goal.state, 'active')
  for (let tick = 1; tick <= 4; tick++) { f.state.now = tick * 2000; await runner.tick() }
  assert.equal(runner.status().goal.attempts, 1, 'the known floor alone does not release the wait')
  received.add(64)
  await runner.tick()
  assert.equal(runner.status().goal.attempts, 1, 'the head cell is still missing')
  received.add(65)
  f.state.inventory.items = []
  assert.equal(await runner.tick(), true)
  assert.equal(runner.status().goal, null)
  assert.equal(f.starts.length, 1)
  assert.equal(f.log.some(text => /保留|あきらめ/.test(text)), false)
})

test('a restored terrain hold waits for its target, not the known ground at the Bot', async () => {
  const f = fixture(), get = f.ports.getBlock
  let received = false
  f.ports.getBlock = (x, y, z) => x === 2 && y === 64 && z === 0 && !received ? { known: false } : get(x, y, z)
  const goal = newGoal({ id: 'held-goal', reason: 'terrain', scope: f.state.scope, now: 0 })
  goal.state = 'held'
  goal.hold = { code: 'TERRAIN_UNKNOWN', at: 0, until: 600000, position: { x: 0, y: 65, z: 0 }, supplies: 'same supplies', kinds: ['terrain_received'], terrainCells: [{ x: 2, y: 64, z: 0 }] }
  f.shared.playerReturn = JSON.parse(JSON.stringify(goal))
  const runner = createReturnRunner(f.config)
  for (let tick = 0; tick < 7; tick++) { f.state.now = tick * 2000; await runner.tick() }
  assert.equal(runner.status().goal.state, 'held')
  assert.equal(runner.status().goal.wakes, 0)
  assert.equal(f.starts.length, 0)
  received = true; f.state.inventory.items = []
  assert.equal(await runner.tick(), true)
  assert.equal(runner.status().goal, null)
})

test('unknown target terrain is not released by the known cells at the Bot', async () => {
  const f = fixture(), get = f.ports.getBlock
  f.shared.playerBase = { x: 2, y: 64, z: 0 }
  f.ports.getBlock = (x, y, z) => x === 2 && y === 64 && z === 0 ? { known: false } : get(x, y, z)
  const runner = createReturnRunner(f.config)
  await runner.tick()
  assert.equal(runner.status().goal.stage, 'approach')
  assert.equal(runner.status().goal.attempts, 1)
  for (let tick = 1; tick <= 4; tick++) { f.state.now = tick * 2000; await runner.tick() }
  assert.equal(runner.status().goal.stage, 'approach')
  assert.equal(runner.status().goal.attempts, 1)
  assert.equal(f.shared.playerReturn.unopened.length, 0, 'unreceived terrain is still awaited, not rejected as an unopened chest')
})

for (const nextScope of ['connection-1/overworld/life-2', 'connection-2/overworld/life-1', 'connection-1/nether/life-1']) {
  test(`the pending step loses its authority when the scope changes to ${nextScope}`, async () => {
    const f = fixture(), entered = deferred(), release = deferred()
    let aborted
    f.state.covered = true
    f.ports.moves.climb = async check => { aborted = check; entered.resolve(); await release.promise; return { ok: true } }
    const runner = createReturnRunner(f.config), pending = runner.tick()
    await entered.promise
    f.state.scope = nextScope; f.state.inventory = null; f.state.covered = false
    const oldStepAborted = aborted()
    release.resolve(); await pending
    assert.equal(oldStepAborted, true, 'the old operation cannot become current in a new life, connection or dimension')
    assert.equal(f.calls.length, 0)
    assert.equal(runner.status().goal.id, 'return-goal', 'the purpose survives, its operation does not')
    assert.equal(runner.status().goal.scope, nextScope)
    assert.equal(runner.status().goal.stage, 'observe')
    assert.equal(runner.status().goal.last.code, 'INVENTORY_UNKNOWN')
  })
}

test('stop then play while house exit settles does not authorize the old step again', async () => {
  const f = fixture(), entered = deferred(), release = deferred()
  f.state.inside = true
  f.ports.moves.house.leave = async () => { entered.resolve(); await release.promise; f.state.inside = false; return true }
  const runner = createReturnRunner(f.config), pending = runner.tick()
  await entered.promise
  f.shared.playerWanted = false; runner.cancel('MANUAL_STOP'); f.shared.playerWanted = true
  release.resolve(); await pending
  assert.equal(f.calls.length, 0, 'the cancelled step issues no new travel even when playing is requested again')
  assert.equal(runner.status().goal, null)
  assert.equal(f.starts.length, 0)
})

test('writes from a reloaded runner finish before the newer cancellation on the real file', { timeout: 5000 }, async t => {
  const f = fixture(), gate = deferred(), oldStarted = deferred(), oldDrained = deferred(), newSaved = deferred()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'player-return-writes-'))
  const file = path.join(directory, 'player-return.json')
  t.after(async () => { gate.resolve(); await fs.rm(directory, { recursive: true, force: true }) })
  f.state.inventory = null
  let oldCount = 0, newStarted = false
  const old = createReturnRunner({ ...f.config, file, write: async (name, doc) => {
    if (++oldCount === 1) { oldStarted.resolve(); await gate.promise }
    await writeDurableJson(name, doc)
    if (oldCount === 2) oldDrained.resolve()
  } })
  await old.tick(); await oldStarted.promise
  f.state.disposed = true
  // Hot reload clears the module cache, but host.shared survives.
  const modules = path.resolve(__dirname, '../src/modes/return') + path.sep
  for (const name of Object.keys(require.cache)) if (name.startsWith(modules)) delete require.cache[name]
  const next = require('../src/modes/return/return-runner').createReturnRunner({ ...f.config, disposed: () => false, file, write: async (name, doc) => { newStarted = true; await writeDurableJson(name, doc); newSaved.resolve() } })
  f.shared.playerWanted = false; next.cancel('MANUAL_STOP')
  await turn()
  if (newStarted) await newSaved.promise
  gate.resolve()
  await Promise.all([oldDrained.promise, newSaved.promise])
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).goal, null, 'a completed cancellation cannot be overwritten by the old runtime')
  assert.equal(f.shared.playerReturn, null)
})
