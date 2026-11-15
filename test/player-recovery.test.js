'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerRecovery, nearestKnownLog, aheadPoint } = require('../src/modes/player-recovery')
const { createAutonomy } = require('../src/survival/autonomy')
const { playerActivity, modeState } = require('../scripts/lib/player-activity')

function fixture ({ blocks = {}, mode = 'player', walks = false } = {}) {
  const calls = [], shared = { autoWanted: true, autoOptions: {} }, logs = [], position = { x: 0.5, y: 65.62, z: 0.5 }
  let busy = false, clock = 0
  const recovery = createPlayerRecovery({
    getMode: () => mode, shared, log: line => logs.push(line),
    agent: { objective: { objective: 'diamond', diamondCount: 1 }, stop: reason => { calls.push('stop'); shared.autoWanted = false }, start: async options => { calls.push({ start: options }); shared.autoWanted = true; shared.autoOptions = { ...options } } },
    travel: { to: async input => { calls.push({ travel: input.destination }); if (walks) Object.assign(position, { x: input.destination.x + 0.5, z: input.destination.z + 0.5 }); busy = true; setTimeout(() => { busy = false }, 5) }, status: () => ({ busy }), cancel: async () => { busy = false; calls.push('cancel') } },
    getBlock: (x, y, z) => blocks[`${x},${y},${z}`] ?? { known: false },
    getPosition: () => ({ ...position }),
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

test('no tree in the received terrain: keeps walking 96 m the same way, away from the start', async () => {
  const f = fixture({ walks: true })
  for (let i = 0; i < 3; i++) { f.recovery.onProgress(blocked()); await settle(f.recovery) }
  assert.deepEqual(f.calls.filter(call => call.travel).map(call => call.travel), [{ x: 97, z: 1 }, { x: 194, z: 2 }, { x: 291, z: 3 }])
})

test('a walk that got nowhere turns the search 60 degrees', async () => {
  const f = fixture()
  f.recovery.onProgress(blocked()); await settle(f.recovery)
  f.recovery.onProgress(blocked()); await settle(f.recovery)
  const here = { x: 0.5, z: 0.5 }
  assert.deepEqual(f.calls.filter(call => call.travel).map(call => call.travel), [aheadPoint(here, 0), aheadPoint(here, Math.PI / 3)])
})

test('the search starts toward the nearest received grass', async () => {
  const f = fixture({ walks: true, blocks: { '0,60,-40': { known: true, name: 'minecraft:grass_block' } } })
  f.recovery.onProgress(blocked()); await settle(f.recovery)
  assert.deepEqual(f.calls[0], { travel: { x: 1, z: -95 } })
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
  assert.deepEqual(f.calls.filter(call => call.travel).map(call => call.travel), [{ x: 10, z: 0 }, { x: 0, z: 60 }, aheadPoint({ x: 0.5, z: 0.5 }, 0)])
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

test('a restart that is refused keeps trying; it does not leave the player stopped', async () => {
  const f = fixture()
  let refusals = 3
  const calls = []
  const recovery = createPlayerRecovery({
    getMode: () => 'player', shared: f.shared, log () {},
    agent: { objective: { objective: 'diamond' }, start: async () => { if (refusals-- > 0) throw new Error('Botの移動が終わるまで待ってください。'); calls.push('start') }, stop () {} },
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} },
    getBlock: () => ({ known: false }), getPosition: () => ({ x: 0, y: 65, z: 0 }), sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000) })()
  })
  recovery.onProgress(blocked()); await settle(recovery)
  assert.deepEqual(calls, ['start'])
})

test('keepPlaying: wanted but idle for ten seconds starts again; a user stop, a rest or a running player does not', async () => {
  const f = fixture()
  let clock = 0
  const calls = [], shared = { playerWanted: true, autoWanted: false }
  const recovery = createPlayerRecovery({
    getMode: () => 'player', shared, log () {}, now: () => clock,
    agent: { objective: { objective: 'diamond' }, start: async options => calls.push(options.objective), stop () {} },
    travel: { to: async () => {}, status: () => ({ busy: false }), cancel: async () => {} }, getBlock: () => ({ known: false }), getPosition: () => null
  })
  assert.equal(recovery.keepPlaying({ running: false }), false)
  clock = 9000; assert.equal(recovery.keepPlaying({ running: false }), false)
  clock = 9500; assert.equal(recovery.keepPlaying({ running: true }), false, 'running resets the count')
  clock = 12000; assert.equal(recovery.keepPlaying({ running: false }), false)
  clock = 21000; assert.equal(recovery.keepPlaying({ running: false, resting: true }), false)
  clock = 22000; assert.equal(recovery.keepPlaying({ running: false }), false)
  clock = 33000; assert.equal(recovery.keepPlaying({ running: false }), true)
  await settle(recovery)
  assert.deepEqual(calls, ['diamond'])
  shared.playerWanted = false; clock = 60000
  assert.equal(recovery.keepPlaying({ running: false }), false); clock = 80000
  assert.equal(recovery.keepPlaying({ running: false }), false)
  assert.equal(f.calls.length, 0)
})
