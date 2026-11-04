'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createAutonomy } = require('../src/autonomy')
function scene ({ policy = 'online_learning', life = 25, onDecision = () => {} } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'same', startedAt: 'start', runtimeEntityId: '1', dimension: 'overworld', health: 20, gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, entities: [], lifecycle: { deathId: life, phase: 'alive' }, threatPolicy: policy }
  let explored = 0, respawned = 0
  const create = () => createAutonomy({ getState: () => structuredClone(state), observe: () => ({}), planAction: () => ({ type: 'explore', resource: 'logs', reason: 'known local logs', target: { x: state.position.x + 1, y: 65, z: 0.5 } }), actions: { explore: async () => { explored++; state.position.x += 1; return { phase: 'completed' } }, respawn: async () => { respawned++; return { phase: 'completed' } } }, onDecision: d => onDecision(d, state), intervalMs: 60000 })
  const scope = JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, String(state.runtimeEntityId)])
  return { state, create, scope, explored: () => explored, respawned: () => respawned }
}
const config = progress => ({ objective: 'diamond', minHealth: 0, maxExplorations: 24, maxNoProgressActions: 100, progress })
async function start (engine, progress) { engine.start(config(progress)); return engine.tick() }
test('new known life permits exploration despite23or24historical attempts and preserves the total metric', async t => {
  for (const history of [23, 24]) {
    const f = scene(), engine = f.create(); t.after(() => engine.stop())
    await start(engine, { explorationAttempts: history, explorations: 5 })
    const p = engine.snapshot().progress
    assert.equal(f.explored(), 1); assert.equal(p.explorationAttempts, history + 1); assert.equal(p.learningExplorationBudget.deathId, 25); assert.equal(p.learningExplorationBudget.attempts, 1)
  }
})
test('24same-life attempts are enforced across stop/start and persisted hot reload', async t => {
  const f = scene(), engine = f.create(); t.after(() => engine.stop())
  await start(engine, { explorationAttempts: 23 })
  for (let n = 1; n < 24; n++) await engine.tick()
  assert.equal(f.explored(), 24); assert.equal(engine.snapshot().progress.learningExplorationBudget.attempts, 24)
  engine.stop(); await start(engine)
  assert.equal(engine.snapshot().phase, 'blocked'); assert.equal(f.explored(), 24, 'same-controller restart without a seed cannot mint more life allowance')
  const saved = structuredClone(engine.snapshot().progress), replacement = f.create(); t.after(() => replacement.stop())
  await start(replacement, saved); assert.equal(replacement.snapshot().phase, 'blocked'); assert.equal(f.explored(), 24)
})
test('bobbing, timestamps and target refresh do not reset allowance; confirmed new alive life does', async t => {
  const f = scene(), engine = f.create(); t.after(() => engine.stop())
  const progress = { explorationAttempts: 24, learningExplorationBudget: { scope: f.scope, deathId: 25, attempts: 24 } }
  f.state.position.z += 0.01; f.state.positionUpdatedAt = 'later'; f.state.observationVersion = 999; f.state.targetRuntimeId = 'new-target'
  await start(engine, progress); assert.equal(engine.snapshot().phase, 'blocked'); assert.equal(f.explored(), 0)
  f.state.lifecycle = { deathId: 26, phase: 'alive' }; await start(engine, engine.snapshot().progress)
  assert.equal(f.explored(), 1); assert.equal(engine.snapshot().progress.explorationAttempts, 25); assert.equal(engine.snapshot().progress.learningExplorationBudget.attempts, 1)
})
test('dead, unknown or older lifecycle observations cannot mint budget resets', async t => {
  const f = scene(), engine = f.create(); t.after(() => engine.stop())
  const progress = { explorationAttempts: 24, learningExplorationBudget: { scope: f.scope, deathId: 25, attempts: 24 } }
  f.state.health = 0; f.state.lifecycle = { deathId: 26, phase: 'dead' }; await start(engine, progress)
  assert.equal(f.respawned(), 1); assert.equal(engine.snapshot().progress.learningExplorationBudget.deathId, 25); engine.stop()
  f.state.health = 20; f.state.lifecycle = { deathId: 26, phase: 'unknown' }; await start(engine, progress)
  assert.equal(engine.snapshot().phase, 'blocked'); assert.equal(f.explored(), 0)
  f.state.lifecycle = { deathId: 24, phase: 'alive' }; await start(engine, progress)
  assert.equal(engine.snapshot().phase, 'blocked'); assert.equal(f.explored(), 0)
})
test('balanced mode retains the historical24attempt limit and unknown learning life cannot bypass it', async t => {
  for (const policy of ['balanced_mining', 'online_learning']) {
    const f = scene({ policy }), engine = f.create(); t.after(() => engine.stop())
    if (policy === 'online_learning') delete f.state.lifecycle
    await start(engine, { explorationAttempts: 24 })
    assert.equal(engine.snapshot().phase, 'blocked'); assert.equal(f.explored(), 0)
  }
})
test('life change after a decision requires a fresh exploration plan instead of dispatching an old-life tree target', async t => {
  let changed = false
  const f = scene({ onDecision: (_, state) => { if (!changed) { changed = true; state.lifecycle.deathId++ } } }), engine = f.create(); t.after(() => engine.stop())
  await start(engine, { explorationAttempts: 24 }); assert.equal(f.explored(), 0); assert.equal(engine.snapshot().phase, 'waiting')
  await engine.tick(); assert.equal(f.explored(), 1)
})
test('Runtime autonomy reads the real Host lifecycle and marks a missing lifecycle as unknown', t => {
  const filename = path.resolve(__dirname, 'runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { scene };', filename)
  const f = loaded.exports.scene(t); f.shared.deathRespawn.deathId = 26
  assert.equal(f.autonomyOptions.getState().lifecycle.deathId, 26); assert.equal(f.autonomyOptions.getState().lifecycle.phase, 'alive')
  f.raw.dead = true; assert.equal(f.autonomyOptions.getState().lifecycle.phase, 'dead'); f.raw.dead = false
  f.shared.deathRespawn = {}; assert.equal(f.autonomyOptions.getState().lifecycle.deathId, null)
})
