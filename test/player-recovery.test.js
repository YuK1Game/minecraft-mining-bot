'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerRecovery, nearestKnownLog, aheadPoint, farTarget } = require('../src/modes/player-recovery')
const { createAutonomy } = require('../src/survival/autonomy')
const { playerActivity, modeState } = require('../scripts/lib/player-activity')

function fixture ({ blocks = {}, mode = 'player', walks = false, climb = null, prey = null } = {}) {
  const calls = [], shared = { autoWanted: true, autoOptions: {} }, logs = [], position = { x: 0.5, y: 65.62, z: 0.5 }
  let busy = false, clock = 0
  const recovery = createPlayerRecovery({
    getMode: () => mode, shared, log: line => logs.push(line), prey, climb: climb && (async () => { calls.push('climb'); return climb }),
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

test('the same stop is not answered the same way twice: at once, then from another place, then from far away', async () => {
  const f = fixture({ walks: true })
  const stop = { running: false, phase: 'failed', reason: '同じ状態で同じ操作を繰り返しても進展がないため停止しました。', lastDecision: { type: 'scan_blocks', stage: 'body' }, progress: {} }
  f.recovery.onProgress(stop); await settle(f.recovery)
  assert.deepEqual(f.calls, [{ start: { objective: 'diamond', diamondCount: 1 } }])
  assert.ok(f.clock() < 1000, 'no pause before the first restart')
  assert.match(f.logs.join('\n'), /すぐにやり直します/)
  // The same stop again, at the same place: about 16 m away, then on with fresh lists.
  f.calls.length = 0
  f.recovery.onProgress(stop); await settle(f.recovery)
  assert.deepEqual(f.calls, [{ travel: { x: 16, z: 0 } }, { start: { objective: 'diamond', diamondCount: 1, freshExclusions: true, freshExploration: true } }])
  assert.match(f.logs.join('\n'), /別の場所へ移ってから続けます/)
  // From the new place the stop counts as new.
  f.calls.length = 0
  f.recovery.onProgress(stop); await settle(f.recovery)
  assert.deepEqual(f.calls, [{ start: { objective: 'diamond', diamondCount: 1 } }])
})

test('a stop that comes back where the Bot could not move away: the third time it walks far', async () => {
  const f = fixture()
  const stop = { running: false, phase: 'failed', reason: '再試行の上限に達しました: No known safe retreat route exists', lastDecision: { type: 'avoid_threat' }, progress: {} }
  for (let i = 0; i < 3; i++) { f.recovery.onProgress(stop); await settle(f.recovery) }
  const walks = f.calls.filter(call => call.travel).map(call => call.travel)
  assert.deepEqual(walks, [{ x: 16, z: 0 }, aheadPoint({ x: 0.5, z: 0.5 }, Math.PI / 3)])
  assert.match(f.logs.join('\n'), /遠くへ移動してから続けます/)
  assert.ok(f.clock() < 30000, 'no rest before the sixth time')
})

test('underground the second answer is straight up; a stop cancels a recovery', async () => {
  const roof = { '0,66,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,67,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,68,0': { known: true, name: 'minecraft:stone', boundingBox: 'block' } }
  const f = fixture({ blocks: roof, climb: { ok: true } })
  const stop = { running: false, phase: 'failed', reason: 'Navigation made no progress', lastDecision: { type: 'collect_drops', stage: 'diamond' }, progress: {} }
  f.recovery.onProgress(stop); await settle(f.recovery)
  f.recovery.onProgress(stop); await settle(f.recovery)
  assert.deepEqual(f.calls, [{ start: { objective: 'diamond', diamondCount: 1 } }, 'climb', { start: { objective: 'diamond', diamondCount: 1, freshExclusions: true, freshExploration: true } }])
  const g = fixture({ blocks: { '40,70,0': { known: true, name: 'minecraft:oak_log' } } })
  g.recovery.onProgress(blocked())
  assert.equal(g.recovery.cancel(), true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(g.calls.filter(call => call.start).length, 0)
  assert.equal(g.shared.autoWanted, false)
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

test('a respawn far from the destination ends the walk and the search starts over from there', async () => {
  const calls = [], logs = [], shared = { autoWanted: true, autoOptions: {} }, position = { x: 0.5, y: 65.62, z: 0.5 }
  let busy = false, clock = 0
  const recovery = createPlayerRecovery({
    getMode: () => 'player', shared, log: line => logs.push(line),
    agent: { objective: {}, stop: () => {}, start: async () => { calls.push('start') } },
    travel: { to: async input => { calls.push({ travel: input.destination }); busy = true; Object.assign(position, { x: -5000, z: -5000 }) }, status: () => ({ busy }), cancel: async () => { busy = false; calls.push('cancel') } },
    getBlock: () => ({ known: false }), getPosition: () => ({ ...position }),
    sleep: async ms => { clock += ms; await new Promise(resolve => setTimeout(resolve, 1)) }, now: () => clock
  })
  recovery.onProgress(blocked()); await settle(recovery)
  assert.deepEqual(calls, [{ travel: { x: 97, z: 1 } }, 'cancel', 'start'])
  assert.match(logs.join('\n'), /目的地から大きく離れた/)
  assert.ok(clock < 5000, 'did not wait out the trip')
})

test('mode runtime reads the working position for the search and the retreat, not the last received one', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/modes/mode-runtime.js'), 'utf8')
  assert.match(source, /getPosition: where\b/)
  assert.match(source, /position: where\(\)/)
  assert.doesNotMatch(source, /getPosition: \(\) => runtime\.raw\(\)\.position/)
})

test('a full list of unreachable candidates: restart at once with an empty list, not every ten minutes with the same one', async () => {
  const f = fixture()
  f.recovery.onProgress(blocked({ stopCode: 'exclusion_limit', reason: '到達できない候補の除外数が上限に達したため、自律作業を停止しました。', lastDecision: { type: 'collect_drops', stage: 'stone' } }))
  await settle(f.recovery)
  assert.deepEqual(f.calls, [{ start: { objective: 'diamond', diamondCount: 1, freshExclusions: true } }])
  assert.ok(f.clock() < 1000, `waited ${f.clock()}`)
  assert.match(f.logs.join('\n'), /すぐにやり直します/)
  assert.equal(f.shared.autoOptions.freshExclusions, undefined)
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/survival/autonomy.js'), 'utf8')
  assert.match(source, /'exclusion_limit'\)/)
  assert.match(source, /freshExclusions === true\) \{ seed\.excludedResources = \[\]; seed\.excludedDropIds = \[\] \}/)
})

test('a stop whose work lies far away walks there first, then goes on; a near one starts again at once', async () => {
  const far = fixture({ walks: true })
  far.recovery.onProgress(blocked({ stopCode: null, reason: '再試行の上限に達しました: The ore lies outside the bounded tunneling area', lastDecision: { type: 'tunnel', resource: 'iron', target: { x: 85, y: 68, z: 75 } } }))
  await settle(far.recovery)
  assert.deepEqual(far.calls, [{ travel: { x: 85, z: 75 } }, { start: { objective: 'diamond', diamondCount: 1 } }])
  assert.match(far.logs.join('\n'), /次の作業の場所 \(85, 75\) が遠いため/)
  const near = fixture()
  near.recovery.onProgress(blocked({ stopCode: null, lastDecision: { type: 'tunnel', resource: 'iron', target: { x: 10, y: 68, z: 5 } } }))
  await settle(near.recovery)
  assert.deepEqual(near.calls, [{ start: { objective: 'diamond', diamondCount: 1 } }])
  assert.ok(near.clock() < 1000)
})

test('underground, a table that cannot be walked to: straight up, then on at once', async () => {
  const roof = { '0,66,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,67,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,68,0': { known: true, name: 'minecraft:stone', boundingBox: 'block' } }
  const stuck = { running: false, phase: 'failed', reason: '再試行の上限に達しました: No known safe standing position has a valid route', lastDecision: { type: 'move_to', stage: 'crafting_table', resource: 'crafting_table', target: { x: 2, y: 63, z: 2 } }, progress: {} }
  const f = fixture({ blocks: roof, climb: { ok: true } })
  f.recovery.onProgress(stuck); await settle(f.recovery)
  assert.deepEqual(f.calls, ['climb', { start: { objective: 'diamond', diamondCount: 1 } }])
  assert.equal(f.clock() < 5000, true, 'no pause before playing on')
  const open = fixture({ climb: { ok: true } })
  open.recovery.onProgress(stuck); await settle(open.recovery)
  assert.equal(open.calls.includes('climb'), false, 'not under the open sky')
})

test('a food source the forage cannot step to: the long trip walks next to it, then play goes on', async () => {
  const f = fixture({ walks: true, prey: () => ({ x: -20.5, y: 72, z: 3.2 }) })
  f.recovery.onProgress(blocked({ stopCode: null, reason: '同じ状態で同じ操作を繰り返しても進展がないため停止しました。', lastDecision: { type: 'forage', stage: 'safety' } }))
  await settle(f.recovery)
  assert.deepEqual(f.calls, [{ travel: { x: -21, z: 3 } }, { start: { objective: 'diamond', diamondCount: 1 } }])
  assert.match(f.logs.join('\n'), /食料源 \(-21, 3\) へ歩いて近づきます/)
  const close = fixture({ prey: () => ({ x: 3, y: 65, z: 1 }) })
  close.recovery.onProgress(blocked({ stopCode: null, lastDecision: { type: 'forage', stage: 'safety' } }))
  await settle(close.recovery)
  assert.deepEqual(close.calls, [{ start: { objective: 'diamond', diamondCount: 1 } }])
})

test('underground, the next work lies far overhead: straight up, then on with a fresh exclusion list', async () => {
  const roof = { '0,66,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,67,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,68,0': { known: true, name: 'minecraft:stone', boundingBox: 'block' } }
  const stop = y => blocked({ stopCode: 'exclusion_limit', reason: '到達できない候補の除外数が上限に達したため、自律作業を停止しました。', lastDecision: { type: 'tunnel', resource: 'coal', target: { x: -5, y, z: 1 } } })
  const f = fixture({ blocks: roof, climb: { ok: true } })
  f.recovery.onProgress(stop(122)); await settle(f.recovery)
  assert.deepEqual(f.calls, ['climb', { start: { objective: 'diamond', diamondCount: 1, freshExclusions: true } }])
  assert.match(f.logs.join('\n'), /58 段上/)
  const level = fixture({ blocks: roof, climb: { ok: true } })
  level.recovery.onProgress(stop(60)); await settle(level.recovery)
  assert.equal(level.calls.includes('climb'), false, 'work below or level is tunnelled to')
})

test('a deep ore within tunnel reach is left to the tunnel, not surface travel', () => {
  const eye = { x: -5060.6, y: 65.6, z: -5058.5 }
  const deep = { lastDecision: { type: 'tunnel', target: { x: -5069, y: -4, z: -5014 } } }
  assert.equal(farTarget(deep, eye), null)
  const level = { lastDecision: { type: 'tunnel', target: { x: -5069, y: 62, z: -5014 } } }
  assert.deepEqual(farTarget(level, eye), { x: -5069, z: -5014 })
  const remote = { lastDecision: { type: 'tunnel', target: { x: -5069, y: -4, z: -5214 } } }
  assert.deepEqual(farTarget(remote, eye), { x: -5069, z: -5214 })
})

test('an exploration limit under a roof climbs first even when no wood is sought', async () => {
  // 2026-11-17 01:00-01:04 JST live: at y -50 the long walk found no waypoint every 5 s for four minutes.
  const roof = { '0,66,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,67,0': { known: true, name: 'minecraft:air', boundingBox: 'empty' }, '0,68,0': { known: true, name: 'minecraft:deepslate', boundingBox: 'block' } }
  const f = fixture({ blocks: roof, climb: { ok: true } })
  f.recovery.onProgress(blocked({ lastDecision: { type: 'explore', resource: 'crafting_table' } })); await settle(f.recovery)
  assert.deepEqual(f.calls, ['climb', { start: { objective: 'diamond', diamondCount: 1, freshExploration: true } }])
})
