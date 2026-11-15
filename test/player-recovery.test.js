'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerRecovery, nearestKnownLog, ringPoint } = require('../src/modes/player-recovery')
const { createAutonomy } = require('../src/survival/autonomy')
const { playerActivity, modeState } = require('../scripts/lib/player-activity')

function fixture ({ blocks = {}, mode = 'player' } = {}) {
  const calls = [], shared = { autoWanted: true, autoOptions: {} }, logs = []
  let busy = false, clock = 0
  const recovery = createPlayerRecovery({
    getMode: () => mode, shared, log: line => logs.push(line),
    agent: { objective: { objective: 'diamond', diamondCount: 1 }, stop: reason => { calls.push('stop'); shared.autoWanted = false }, start: async options => { calls.push({ start: options }); shared.autoWanted = true; shared.autoOptions = { ...options } } },
    travel: { to: async input => { calls.push({ travel: input.destination }); busy = true; setTimeout(() => { busy = false }, 5) }, status: () => ({ busy }), cancel: async () => { busy = false; calls.push('cancel') } },
    getBlock: (x, y, z) => blocks[`${x},${y},${z}`] ?? { known: false },
    getPosition: () => ({ x: 0.5, y: 65.62, z: 0.5 }),
    sleep: async ms => { clock += ms; await new Promise(resolve => setTimeout(resolve, 1)) }, now: () => clock
  })
  return { recovery, shared, calls, logs, clock: () => clock }
}
const settle = async recovery => { for (let i = 0; i < 2000 && recovery.status().active; i++) await new Promise(resolve => setTimeout(resolve, 2)) }
const blocked = (extra = {}) => ({ running: false, phase: 'blocked', reason: '探索回数の上限に達したため、自律作業を停止しました。', stopCode: 'exploration_limit', lastDecision: { type: 'explore', resource: 'logs' }, progress: { logsCollected: 0 }, ...extra })

test('exploration limit: no instant restart; walks to a received log and starts with a fresh budget', async () => {
  const f = fixture({ blocks: { '40,70,0': { known: true, name: 'minecraft:oak_log' }, '80,70,0': { known: true, name: 'minecraft:oak_log' } } })
  assert.equal(f.recovery.onProgress(blocked()), true)
  assert.equal(f.shared.autoWanted, false, 'the runtime must not restart the run at once')
  assert.equal(f.recovery.onProgress(blocked()), false, 'one recovery at a time')
  assert.equal(f.recovery.status().active, true)
  await settle(f.recovery)
  assert.deepEqual(f.calls, [{ travel: { x: 40, z: 0 } }, { start: { objective: 'diamond', diamondCount: 1, freshExploration: true } }])
  assert.equal(f.shared.autoOptions.freshExploration, undefined, 'later automatic restarts keep their exploration count')
  assert.match(f.logs.join('\n'), /探索回数の上限/)
})

test('no tree in the received terrain: goes to the next ring point, a different one each time', async () => {
  const f = fixture()
  f.recovery.onProgress(blocked()); await settle(f.recovery)
  f.recovery.onProgress(blocked()); await settle(f.recovery)
  const trips = f.calls.filter(call => call.travel).map(call => call.travel)
  assert.deepEqual(trips, [ringPoint({ x: 0.5, z: 0.5 }, 1), ringPoint({ x: 0.5, z: 0.5 }, 2)])
  assert.notDeepEqual(trips[0], trips[1])
})

test('other stops restart after a pause, not at once; stop cancels the wait', async () => {
  const f = fixture()
  f.recovery.onProgress({ running: false, phase: 'failed', reason: '同じ状態で同じ操作を繰り返しても進展がないため停止しました。', progress: {} })
  await settle(f.recovery)
  assert.deepEqual(f.calls, [{ start: { objective: 'diamond', diamondCount: 1 } }])
  assert.ok(f.clock() >= 30000)
  f.recovery.onProgress({ running: false, phase: 'failed', reason: 'x', progress: {} })
  assert.equal(f.recovery.cancel(), true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.calls.length, 1)
  assert.equal(f.shared.autoWanted, false)
})

test('quarry mode, a user stop and a running autonomy are left alone', () => {
  assert.equal(fixture({ mode: 'quarry' }).recovery.onProgress(blocked()), false)
  const f = fixture(); f.shared.autoWanted = false
  assert.equal(f.recovery.onProgress(blocked()), false)
  assert.equal(fixture().recovery.onProgress({ running: true, phase: 'running', lastDecision: { type: 'gather_logs', resource: 'logs' } }), false)
  assert.equal(fixture().recovery.onProgress({ running: false, phase: 'stopped' }), false)
})

test('wood needed and none near: the search is taken over at once; a tree that did not help is not chosen again', async () => {
  const f = fixture({ blocks: { '10,70,0': { known: true, name: 'minecraft:oak_log' }, '0,70,60': { known: true, name: 'minecraft:birch_log' } } })
  const seeking = { running: true, phase: 'running', reason: '探索', lastDecision: { type: 'explore', resource: 'logs' }, progress: { logsCollected: 0 } }
  assert.equal(f.recovery.onProgress(seeking), true)
  await settle(f.recovery)
  f.recovery.onProgress(seeking); await settle(f.recovery)
  f.recovery.onProgress(seeking); await settle(f.recovery)
  assert.deepEqual(f.calls.filter(call => call.travel).map(call => call.travel), [{ x: 10, z: 0 }, { x: 0, z: 60 }, ringPoint({ x: 0.5, z: 0.5 }, 3)])
  assert.equal(f.calls[0], 'stop')
  assert.deepEqual(f.calls[2], { start: { objective: 'diamond', diamondCount: 1, freshExploration: true } })
})

test('nearestKnownLog ignores unreceived terrain and logs closer than the minimum', async () => {
  const getBlock = (x, y, z) => x === 4 && z === 0 ? { known: true, name: 'minecraft:oak_log' } : x === 30 && z === 30 && y === 70 ? { known: true, name: 'minecraft:birch_log' } : x === 20 ? { known: false, name: 'minecraft:oak_log' } : { known: true, name: 'minecraft:air' }
  const found = await nearestKnownLog({ getBlock, position: { x: 0.5, y: 65.62, z: 0.5 }, pause: async () => {} })
  assert.deepEqual({ x: found.x, z: found.z }, { x: 30, z: 30 })
})

test('autonomy: the exploration stop carries a code and freshExploration clears the same-life count', async t => {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'same', startedAt: 'start', runtimeEntityId: '1', dimension: 'overworld', health: 20, gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, entities: [], lifecycle: { deathId: 3, phase: 'alive' }, threatPolicy: 'online_learning' }
  let explored = 0
  const autonomy = createAutonomy({ getState: () => structuredClone(state), observe: () => ({}), planAction: () => ({ type: 'explore', resource: 'logs', reason: 'r', target: { x: state.position.x + 1, y: 65, z: 0.5 } }), actions: { explore: async () => { explored++; state.position.x += 1; return { phase: 'completed' } } }, intervalMs: 60000 })
  t.after(() => autonomy.stop())
  const config = extra => ({ objective: 'diamond', minHealth: 0, maxExplorations: 1, maxNoProgressActions: 100, ...extra })
  autonomy.start(config()); await autonomy.tick(); await autonomy.tick()
  const stopped = autonomy.snapshot()
  assert.equal(explored, 1); assert.equal(stopped.phase, 'blocked'); assert.equal(stopped.stopCode, 'exploration_limit')
  autonomy.start(config({ progress: stopped.progress })); await autonomy.tick()
  assert.equal(explored, 1, 'a plain restart keeps the count')
  autonomy.start(config({ freshExploration: true, progress: autonomy.snapshot().progress })); await autonomy.tick()
  assert.equal(explored, 2)
})

test('activity band: a blocked player shows the reason; recovery shows as its own state', () => {
  const stages = []
  assert.deepEqual(playerActivity(modeState({ mode: 'player', player: { running: false, phase: 'blocked', reason: '理由', stages } })), { kind: 'error', label: 'プレイヤーモード: 停止', detail: '理由', code: null })
  assert.equal(playerActivity(modeState({ mode: 'player', player: { running: true, phase: 'recovering', reason: '移動', stages } })).label, 'プレイヤーモード: 立て直し中')
})
