'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), Module = require('node:module')
const root = process.cwd()
const { createAutonomy } = require(path.join(root, 'src/autonomy'))
const { continuationScope } = require(path.join(root, 'src/base-continuation'))
const copy = value => structuredClone(value)
function load (filename, source) { const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename)); m._compile(source, filename); return m.exports }

for(const stocked of [false,true])test('real Runtime: '+(stocked?'actual log stock admits bounded Native home prefix':'empty life keeps Legacy resource search and does not probe home'), async t => {
  const fixtures = path.join(root, 'test/runtime-depot-resource-scope.test.js')
  const { hostScene, seed } = load(fixtures, fs.readFileSync(fixtures, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports={hostScene,seed};')
  const helper = load(path.join(root, 'src/owned-camp-bootstrap.js'), fs.readFileSync(process.env.HOME_BOOTSTRAP_TEST_SOURCE??(fs.existsSync(path.join(root,'src/owned-camp-bootstrap.js'))?path.join(root,'src/owned-camp-bootstrap.js'):path.join(root,'.local/staged/owned-camp-bootstrap/src/owned-camp-bootstrap.js')), 'utf8'))
  const state = copy(seed.state)
  Object.assign(state, { position: { x: .5, y: 66.62, z: .5 }, positionSource: 'server_post_move', positionUpdatedAt: new Date().toISOString(), lifecycle: { phase: 'alive', deathId: 1 }, health: 20, gameMode: 'survival', inventory: { known: true, items: stocked ? [{slot:0,name:'minecraft:oak_log',count:1}] : [] }, heldItem: null, selectedSlot: 0, rawSelectedSlot: 0, entities: [], entityStats: { unknownPositions: 0 } })
  delete state.predicted
  state.vitals.hunger = { value: 20, source: 'server_attribute' }
  const scope = continuationScope(state), worldScope = JSON.stringify([scope.profile, scope.realmId, scope.dimension])
  const tableCell = { x: 20, y: 65, z: 0 }, storageCell = { x: 21, y: 65, z: 0 }
  const getBlock = (x, y, z) => { const name = x === 20 && y === 65 && z === 0 ? 'crafting_table' : x === 21 && y === 65 && z === 0 ? 'chest' : y < 65 ? 'stone' : 'air'; return { known: true, name: 'minecraft:' + name, position: { x, y, z }, runtimeId: name === 'air' ? 0 : name === 'stone' ? 1 : name === 'crafting_table' ? 2 : 3, boundingBox: name === 'air' ? 'empty' : 'block', properties: name === 'chest' ? { facing_direction: 2 } : {}, extra: [] } }
  const finger = p => { const b = getBlock(p.x, p.y, p.z); return { name: b.name, runtimeId: b.runtimeId, properties: b.properties } }
  const floorCells = [20, 21].map(x => ({ x, y: 64, z: 0 }))
  const historicalScope = { ...scope, life: 0 }
  const camp = { version: 1, kind: 'worksite_camp', id: 'CONTROLLED_empty_new_life_owned_camp', worldScope, tableCell, storageCell, floorFingerprints: floorCells.map(finger), pending: null, table: { operation: 'place', blockName: 'minecraft:crafting_table', position: tableCell, scope: historicalScope, serverConfirmed: true, inventoryConfirmed: true, confirmedBy: 'server_block_and_inventory', beforeCount: 1, afterCount: 0, fingerprint: finger(tableCell) } }
  const chest = { position: storageCell, placementScope: historicalScope, fingerprint: finger(storageCell) }
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'owned-camp-bootstrap-'))
  await fsp.mkdir(path.join(workspaceRoot, '.local'))
  await fsp.writeFile(path.join(workspaceRoot, '.local', `depot-${scope.profile}-${scope.realmId}-${scope.dimension}.json`), JSON.stringify({ version: 1, world: worldScope, enabled: false, policy: { version: 1, world: worldScope, deposited: 0, base: { id: camp.id, position: tableCell, storageCell, floorCells }, chest, depositReceipt: null }, extra: { campBuilder: camp } }))
  let f, actor
  t.after(async () => { await f?.runtime.dispose('controlled bootstrap test cleanup'); assert.ok(path.resolve(workspaceRoot).startsWith(path.join(os.tmpdir(), 'owned-camp-bootstrap-'))); await fsp.rm(workspaceRoot, { recursive: true, force: true }) })
  const starts = [], runnerActions = []
  const runner = { request: () => { throw Error('No network in controlled bootstrap test') }, getState: () => copy(state), refreshState: async () => copy(state), getLastObservation: () => null, getExplorationSnapshot: () => ({}), observe: async () => ({ blocks: [], entities: [], worldLoaded: true, coverage: { expected: 1, known: 1, unknown: 0 }, capabilities: {} }), actions: Object.fromEntries(['gather_logs', 'move_to', 'explore', 'scan_blocks', 'mine_stone', 'craft', 'equip', 'tree_access', 'collect_drops'].map(kind => [kind, async () => { runnerActions.push(kind); return { phase: 'predicted', serverConfirmed: false } }])) }
  const originalSource = process.env.RUNTIME_TEST_SOURCE
  process.env.RUNTIME_TEST_SOURCE = process.env.BOOTSTRAP_TEST_RUNTIME_SOURCE ?? path.join(root, 'src/runtime.js')
  try {
    f = hostScene(t, workspaceRoot, { state, getBlock, overrides: {
      './owned-camp-bootstrap': helper,
      './runner': { ...require(path.join(root, 'src/runner')), createRunner: () => runner },
      './autonomy': { createAutonomy: options => {
        actor = createAutonomy({ ...options, intervalMs: 60000 })
        return { ...actor, start: options => { starts.push(copy(options)); return actor.start(options) } }
      } }
    } })
  } finally { if (originalSource == null) delete process.env.RUNTIME_TEST_SOURCE; else process.env.RUNTIME_TEST_SOURCE = originalSource }
  await f.runtime.resumeRequested()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(f.sent.some(p => p.name === 'player_auth_input'), 'the real neutral Native producer queues current standing frames')
  const rawOrigin = copy(f.parsed.state.position), queuedBefore = f.sent.filter(p => p.name === 'player_auth_input').length
  const learnedBudget = { explorations: 12, explorationAttempts: 17, learningExplorationBudget: { scope: JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, String(state.runtimeEntityId)]), deathId: 1, attempts: 7 } }
  f.host.shared.autonomyProgress = copy(learnedBudget)
  const actorProgressBefore = copy(actor.snapshot().progress)
  await f.runtime.operations.depotMission.start()
  await f.runtime.operations.depotMission.tick()
  const result = f.runtime.operations.depotMission.snapshot()
  t.diagnostic(JSON.stringify({ gatePhase: result.lastResult?.phase, actualLegacyStarts: starts.length, currentLife: 1, actualKnownMainItems: f.parsed.state.inventory.items.length }))
  assert.equal(result.lastError, null, JSON.stringify(result))
  if(!stocked){
    assert.equal(result.lastResult.phase,'reacquiring_diamond',JSON.stringify(result.lastResult));assert.equal(starts.length,1);assert.equal(actor.snapshot().running,true)
    assert.deepEqual(f.host.shared.autonomyProgress,learnedBudget);assert.equal(actor.snapshot().progress.explorationAttempts,learnedBudget.explorationAttempts)
    assert.equal(f.host.shared.ownedCampBootstrap.attempts,0);assert.equal(f.host.shared.ownedCampBootstrap.prefixes,0)
    assert.deepEqual(f.parsed.state.inventory.items,[]);assert.deepEqual(f.host.getState().position,rawOrigin);assert.equal(result.policy.deposited,0)
    assert.equal(f.sent.some(p=>p.name==='player_auth_input'&&(Math.abs(p.packet.move_vector?.z??0)+Math.abs(p.packet.move_vector?.x??0)>0)),false)
    await f.runtime.operations.depotMission.stop();return
  }
  assert.equal(result.lastResult.phase, 'bootstrap_at_owned_camp', JSON.stringify(result.lastResult))
  assert.equal(starts.length, 0, 'fresh bootstrap primitive precedes the old Diamond1 restart')
  assert.equal(actor.snapshot().running, false)
  assert.deepEqual(actor.snapshot().progress, actorProgressBefore, 'bootstrap transport does not reset or advance the real Legacy actor progress')
  assert.deepEqual(f.host.shared.autonomyProgress, learnedBudget, 'current-life exploration budget remains intact instead of being replenished')
  const end = f.host.getState()
  assert.ok(end.position.x > rawOrigin.x + .4 && end.position.x <= rawOrigin.x + 6.4, 'actual Native frames advance one short model prefix')
  assert.equal(end.positionSource, 'client_prediction')
  assert.deepEqual(f.parsed.state.position, rawOrigin, 'the controlled client supplies no authoritative arrival packet')
  assert.deepEqual(end.inventory.items, [{slot:0,name:'minecraft:oak_log',count:1}])
  assert.equal(result.policy.deposited, 0)
  assert.equal(result.policy.depositConfirmedForCurrentLife, false)
  assert.equal(result.lastResult.serverConfirmed, false)
  assert.equal(result.lastResult.inventoryConfirmed, false)
  assert.equal(f.host.shared.ownedCampBootstrap.prefixes, 1)
  assert.ok(f.sent.filter(p => p.name === 'player_auth_input').length > queuedBefore + 2)
  assert.ok(f.sent.some(p => p.name === 'player_auth_input' && Math.abs(p.packet.move_vector?.z ?? 0) + Math.abs(p.packet.move_vector?.x ?? 0) > 0), 'real movement inputs, not only neutral snapshots')
  assert.deepEqual(runnerActions, [])
  t.diagnostic(JSON.stringify({ life: 1, emptyActualMain: false, starts: starts.length, queuedFrames: f.sent.filter(p => p.name === 'player_auth_input').length, predictedPosition: end.position, rawPositionUnchanged: true, reachedCamp: false, deposited: 0 }))
  await f.runtime.operations.depotMission.stop()
})
