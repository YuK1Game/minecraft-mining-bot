'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createAutonomy } = require('../src/autonomy')

function fixture (overrides = {}) {
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, world: { initialized: true, loadedSections: 1 }, capabilities: { mining: true, movement: true } }
  const observations = { blocks: [], drops: [], threats: [], capabilities: { scan_blocks: true, craft: true }, crafting: { previews: {} } }
  const calls = []
  const actions = { scan_blocks: async decision => { calls.push(decision.type); return { ok: true, phase: 'completed' } } }
  const autonomy = createAutonomy({ getState: () => state, observe: () => observations, actions, intervalMs: 60000, ...overrides })
  return { state, observations, calls, actions, autonomy }
}

function movementResourceScene (f) {
  const blocks = []
  for (let x = -1; x <= 8; x++) for (let y = 64; y <= 70; y++) for (let z = -1; z <= 2; z++) {
    const name = x === 6 && z === 0 && y >= 65 && y <= 68 ? 'oak_log' : x === 6 && z === 0 && y === 69 ? 'oak_leaves' : x === 7 && z === 1 && y >= 65 && y <= 68 ? 'birch_log' : x === 7 && z === 1 && y === 69 ? 'birch_leaves' : y === 64 ? 'grass_block' : 'air'
    blocks.push({ known: true, name: `minecraft:${name}`, position: { x, y, z }, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  }
  f.observations.blocks = blocks
}

function safetyError (code) { const error = new Error(`Latest raw guard: ${code}`); error.code = code; return error }

test('ticks coalesce, duplicate start is rejected, and stop forwards an abort signal', async () => {
  let signal
  let release
  const f = fixture({ actions: { scan_blocks: (decision, context) => { signal = context.signal; return new Promise(resolve => { release = resolve }) } } })
  f.autonomy.start()
  const first = f.autonomy.tick()
  assert.strictEqual(f.autonomy.tick(), first)
  assert.throws(() => f.autonomy.start(), /すでに実行中/)
  while (!signal) await delay(1)
  f.autonomy.stop('ユーザーの停止指示')
  assert.equal(signal.aborted, true)
  release({ ok: true, phase: 'completed' })
  await first
  assert.equal(f.autonomy.snapshot().phase, 'stopped')
  assert.equal(f.autonomy.snapshot().progress.actionsReturned, 0)
})

test('a bounded sheltered night wait outlives the missing-observation budget and resumes the original goal at daylight', async t => {
  let night = true
  const deadline = Date.now() + 10000
  const f = fixture({ planSafety: () => night ? { type: 'wait', stage: 'safety', code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: deadline, reason: '受信済みの夜を閉鎖拠点で待ちます。' } : null })
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ objective: 'diamond', diamondCount: 1, maxWaitTicks: 2 })
  for (let tick = 0; tick < 5; tick++) await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().running, true)
  assert.deepEqual(f.calls, [])
  assert.equal(f.autonomy.snapshot().progress.failures, 0)
  night = false
  await f.autonomy.tick()
  assert.deepEqual(f.calls, ['scan_blocks'])
  assert.equal(f.autonomy.snapshot().running, true)
  assert.equal(f.autonomy.snapshot().goal.diamond, 1)
})

test('renewed night deadlines cannot extend the first finite wait indefinitely', async t => {
  let deadline = Date.now() + 30
  const f = fixture({ planSafety: () => ({ type: 'wait', stage: 'safety', code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: deadline, reason: '夜を待ちます。' }) })
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxWaitTicks: 2 }); await f.autonomy.tick()
  await delay(40)
  deadline = Date.now() + 10000
  await f.autonomy.tick(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
})

test('ordinary, unknown, expired or unbounded waits retain the normal finite observation budget', async t => {
  for (const decision of [
    { code: 'shelter_cover', waitBudget: 'shelter_night', waitUntil: Date.now() + 10000 },
    { code: 'shelter_night', waitUntil: Date.now() + 10000 },
    { code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: Infinity },
    { code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: Date.now() - 1 },
    { code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: Date.now() + 1000000 }
  ]) {
    const f = fixture({ planSafety: () => ({ type: 'wait', stage: 'safety', reason: '確認待ち', ...decision }) })
    t.after(() => f.autonomy.stop())
    f.autonomy.start({ maxWaitTicks: 2 }); await f.autonomy.tick(); await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().phase, 'blocked')
    assert.equal(f.autonomy.snapshot().progress.actionsReturned, 0)
  }
})

test('nearby enemies take priority over gathering; low health stops and dead players request respawn', async t => {
  const chosen = []
  const f = fixture({ actions: { avoid_threat: async decision => { chosen.push(decision.type); return { ok: true, phase: 'completed' } }, respawn: async decision => { chosen.push(decision.type); return { ok: true, phase: 'completed' } } } })
  t.after(() => f.autonomy.stop())
  f.observations.threats = [{ entityId: 'z', name: 'minecraft:zombie', distance: 8, position: { x: 4, y: 65, z: 1 } }]
  f.autonomy.start(); await f.autonomy.tick()
  assert.deepEqual(chosen, ['avoid_threat'])
  f.state.health = 4
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'stopped')
  f.state.health = 0; f.state.dead = true
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(chosen.at(-1), 'respawn')
})

test('an explicit safety planner can escape water at low health before resource observation or low-health stopping', async t => {
  const chosen = []
  let safetyCalls = 0
  const f = fixture({
    observe: () => { throw new Error('low-health recovery must not depend on resource scanning') },
    planSafety: (state, observations) => { safetyCalls++; assert.equal(state.health, 3.43); assert.deepEqual(observations, {}); return { type: 'recover', stage: 'safety', reason: '既知の岸へ戻ります。' } },
    planAction: () => { throw new Error('resource work must stay paused') },
    actions: { recover: async decision => { chosen.push(decision.type); return { ok: true, phase: 'completed', serverConfirmed: false } } }
  })
  t.after(() => f.autonomy.stop())
  f.state.health = 3.43
  f.autonomy.start(); await f.autonomy.tick()
  assert.deepEqual(chosen, ['recover'])
  assert.equal(safetyCalls, 1)
  assert.equal(f.autonomy.snapshot().running, true)
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'recover')
})

test('death always precedes an injected safety plan while the plan may precede an ordinary threat retreat', async t => {
  const chosen = []
  let safetyCalls = 0
  const f = fixture({
    planSafety: () => { safetyCalls++; return { type: 'recover', stage: 'safety', reason: '水から岸への復帰を優先します。' } },
    actions: { recover: async () => { chosen.push('recover'); return { phase: 'completed' } }, respawn: async () => { chosen.push('respawn'); return { phase: 'completed' } } }
  })
  t.after(() => f.autonomy.stop())
  f.observations.threats = [{ name: 'minecraft:skeleton', position: { x: 10, y: 65, z: 0 } }]
  f.autonomy.start(); await f.autonomy.tick()
  assert.deepEqual(chosen, ['recover'])
  f.state.dead = true; f.state.health = 0
  await f.autonomy.tick()
  assert.deepEqual(chosen, ['recover', 'respawn'])
  assert.equal(safetyCalls, 1)
})

test('a low-health land wait keeps safety observation running and returns to normal planning only after observed health improves', async t => {
  const f = fixture({ planSafety: state => state.health <= 6 ? { type: 'wait', stage: 'safety', code: 'recovery_wait', reason: '岸で体力の回復を待ちます。' } : null })
  t.after(() => f.autonomy.stop())
  f.state.health = 3
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'wait')
  assert.equal(f.autonomy.snapshot().running, true)
  assert.deepEqual(f.calls, [])
  f.state.health = 20
  await f.autonomy.tick()
  assert.deepEqual(f.calls, ['scan_blocks'])
})

test('a known raw hostile uses lightweight safety terrain before any resource scan', async t => {
  let heavy = 0
  let light = 0
  let received
  const blocks = [{ known: true, position: { x: 0, y: 64, z: 0 }, name: 'minecraft:grass_block' }]
  const f = fixture({
    observe: () => { heavy++; throw new Error('resource scanning must not delay a known threat') },
    observeSafety: ({ state, signal, goal }) => { light++; assert.equal(state.hostiles.length, 1); assert.equal(signal.aborted, false); assert.equal(goal.logs, 3); return { blocks, entities: state.hostiles } },
    planAction: () => { throw new Error('resource planning must not run') },
    actions: { avoid_threat: async (decision, context) => { received = context; return { ok: true, phase: 'completed' } } }
  })
  t.after(() => f.autonomy.stop())
  f.state.hostiles = [observedMob('zombie', 4)]
  f.autonomy.start(); await f.autonomy.tick()
  assert.deepEqual([heavy, light], [0, 1])
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'avoid_threat')
  assert.deepEqual(received.observations.blocks, blocks)
  assert.equal(received.state.hostiles[0].runtimeId, '55')
})

test('low health may use safety observation but confirmed death invokes neither observer', async t => {
  let heavy = 0
  let light = 0
  const chosen = []
  const f = fixture({
    observe: () => { heavy++; return {} },
    observeSafety: ({ state }) => { light++; return { healthAtObservation: state.health } },
    planSafety: (state, observations) => { assert.equal(observations.healthAtObservation, 3); return { type: 'recover', reason: '岸へ戻ります。' } },
    actions: { recover: async () => { chosen.push('recover'); return { phase: 'completed' } }, respawn: async () => { chosen.push('respawn'); return { phase: 'completed' } } }
  })
  t.after(() => f.autonomy.stop())
  f.state.health = 3
  f.autonomy.start(); await f.autonomy.tick()
  f.state.dead = true; f.state.health = 0
  await f.autonomy.tick()
  assert.deepEqual(chosen, ['recover', 'respawn'])
  assert.deepEqual([heavy, light], [0, 1])
})

test('fresh raw actors take priority when a threat arrives during a resource scan or leaves during safety observation', async t => {
  const enemy = observedMob('zombie', 30)
  let heavy = 0
  const arrived = fixture({
    observe: () => { heavy++; arrived.state.hostiles = [{ ...enemy, position: { x: 2.5, y: 66.62, z: 0.5 } }]; return { entities: [enemy], blocks: [] } },
    actions: { avoid_threat: async () => ({ phase: 'completed' }) }
  })
  t.after(() => arrived.autonomy.stop())
  arrived.state.hostiles = [enemy]
  arrived.autonomy.start(); await arrived.autonomy.tick()
  assert.equal(heavy, 1)
  assert.equal(arrived.autonomy.snapshot().lastDecision.type, 'avoid_threat')
  assert.equal(arrived.autonomy.snapshot().lastDecision.threat.distance, 2)
  let light = 0
  const near = observedMob('zombie', 2)
  const left = fixture({
    observe: () => { throw new Error('initial known threat should bypass resource scanning') },
    observeSafety: () => { light++; left.state.hostiles = [{ ...near, position: { x: 30.5, y: 66.62, z: 0.5 } }]; return { entities: [near] } },
    planAction: () => ({ type: 'scan_blocks', reason: '最新状態で資源観測へ戻ります。' })
  })
  t.after(() => left.autonomy.stop())
  left.state.hostiles = [near]
  left.autonomy.start(); await left.autonomy.tick()
  assert.equal(light, 1)
  assert.equal(left.autonomy.snapshot().lastDecision.type, 'scan_blocks')
})

test('unknown raw actor positions cannot become safe or zero-distance threats through a safety observer', async t => {
  for (const entity of [observedMob('skeleton', 0, { position: null, positionKnown: false, distance: 0 }), observedMob('zombie', 0, { position: { x: NaN, y: 65, z: 0 }, distance: 0 })]) {
    let light = 0
    const f = fixture({ observe: () => { throw new Error('unknown actor safety must precede resource scanning') }, observeSafety: () => { light++; return { entities: [] } } })
    t.after(() => f.autonomy.stop())
    f.state.hostiles = [entity]
    f.autonomy.start(); await f.autonomy.tick()
    const decision = f.autonomy.snapshot().lastDecision
    assert.equal(light, 1)
    assert.equal(decision.type, 'wait')
    assert.equal(decision.code, 'threat_observation_required')
    assert.equal(decision.unknownPositions[0].distance, null)
    assert.equal(decision.unknownPositions[0].dangerous, null)
    assert.deepEqual(f.calls, [])
  }
  const opaque = fixture({ observe: () => { throw new Error('opaque actor positions are not safe') }, observeSafety: () => ({ entities: [] }) })
  t.after(() => opaque.autonomy.stop())
  opaque.state.hostiles = []
  opaque.state.entityStats = { unknownPositions: 1 }
  opaque.autonomy.start(); await opaque.autonomy.tick()
  assert.equal(opaque.autonomy.snapshot().lastDecision.hostUnknownPositionCount, 1)
})

test('a healthy actor list without nearby enemies retains ordinary resource observation despite a safety callback', async t => {
  let heavy = 0
  let light = 0
  const f = fixture({ observe: () => { heavy++; return { ...f.observations, entities: [] } }, observeSafety: () => { light++; return {} } })
  t.after(() => f.autonomy.stop())
  f.state.hostiles = [observedMob('zombie', 30, { distance: 0 })]
  f.autonomy.start(); await f.autonomy.tick()
  assert.deepEqual([heavy, light], [1, 0], 'actual position overrides the supplied zero distance')
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'scan_blocks')
})

test('stale resource observation uses the safety interruption budget then reevaluates a newly observed raw threat', async t => {
  let heavy = 0
  let light = 0
  const f = fixture({
    observe: () => { heavy++; f.state.hostiles = [observedMob('zombie', 3)]; throw safetyError('STALE_OBSERVATION') },
    observeSafety: () => { light++; return { entities: f.state.hostiles, blocks: [] } },
    actions: { avoid_threat: async () => ({ phase: 'completed' }) }
  })
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxRetries: 0, maxSafetyInterruptions: 3 }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().running, true)
  assert.equal(f.autonomy.snapshot().progress.failures, 0)
  assert.equal(f.autonomy.snapshot().lastSafetyInterrupt.code, 'STALE_OBSERVATION')
  await f.autonomy.tick()
  assert.deepEqual([heavy, light], [1, 1])
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'avoid_threat')
  assert.equal(f.autonomy.snapshot().progress.failures, 0)
})

test('stale resource or safety scans remain bounded without consuming resource failure retries', async t => {
  for (const urgent of [false, true]) {
    const f = fixture({ observe: () => { throw safetyError('STALE_OBSERVATION') }, observeSafety: () => { throw safetyError('STALE_OBSERVATION') } })
    t.after(() => f.autonomy.stop())
    if (urgent) f.state.hostiles = [observedMob('zombie', 3)]
    f.autonomy.start({ maxRetries: 0, maxSafetyInterruptions: 2 }); await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().running, true)
    await f.autonomy.tick()
    const state = f.autonomy.snapshot()
    assert.equal(state.phase, 'blocked')
    assert.equal(state.progress.failures, 0)
    assert.equal(state.progress.safetyInterruptions, 2)
  }
})

test('explicit lifecycle death also skips both observers even before the health attribute reaches zero', async t => {
  for (const flag of [{ lifecycle: { dead: true } }, { isDead: true }, { phase: 'dead' }]) {
    let observed = 0
    const f = fixture({ observe: () => { observed++; throw new Error('dead resource observation') }, observeSafety: () => { observed++; throw new Error('dead safety observation') }, actions: { respawn: async () => ({ phase: 'completed' }) } })
    t.after(() => f.autonomy.stop())
    Object.assign(f.state, flag)
    f.autonomy.start(); await f.autonomy.tick()
    assert.equal(observed, 0)
    assert.equal(f.autonomy.snapshot().lastDecision.type, 'respawn')
  }
})

function observedMob (type, blocksAway, metadata = {}) {
  return { runtimeId: '55', kind: 'mob', entityType: `minecraft:${type}`, dimension: 'overworld', alive: true, positionKnown: true, position: { x: 0.5 + blocksAway, y: 66.62, z: 0.5 }, ...metadata }
}

test('autonomy follows species danger radii beyond the removed eight-block cutoff', async t => {
  for (const [type, distance, metadata, radius, avoids] of [
    ['skeleton', 20, {}, 24, true], ['stray', 20, {}, 24, true], ['bogged', 20, {}, 24, true],
    ['zombie', 10, {}, 12, true], ['creeper', 10, {}, 8, false],
    ['creeper', 10, { primed: true }, 12, true], ['creeper', 14, { charged: true }, 16, true]
  ]) {
    const f = fixture()
    t.after(() => f.autonomy.stop())
    f.observations.entities = [observedMob(type, distance, metadata)]
    const avoided = []
    f.actions.avoid_threat = async decision => { avoided.push(decision.threat); return { ok: true, phase: 'completed' } }
    f.autonomy.start(); await f.autonomy.tick()
    assert.equal(avoided.length, Number(avoids), `${type} at ${distance} blocks`)
    if (avoids) {
      assert.equal(avoided[0].dangerRadius, radius)
      assert.equal(avoided[0].distance, distance)
      assert.match(f.autonomy.snapshot().lastDecision.reason, new RegExp(`${radius}ブロック`))
    } else assert.equal(f.autonomy.snapshot().lastDecision.type, 'scan_blocks')
  }
})

test('raw actor metadata preserves primed policy and the shared score chooses the top danger, not nearest', async t => {
  const f = fixture()
  t.after(() => f.autonomy.stop())
  f.observations.entities = [observedMob('skeleton', 20, { runtimeId: '51' }), observedMob('zombie', 2, { runtimeId: '52' }), observedMob('creeper', 10, { runtimeId: '53', primed: true })]
  // An older reduced evaluation must not overwrite the raw fuse observation.
  f.observations.threats = [{ runtimeId: '53', name: 'minecraft:creeper', position: { x: 10.5, y: 66.62, z: 0.5 }, distance: 1, dangerRadius: 8 }]
  let selected
  f.actions.avoid_threat = async decision => { selected = decision.threat; return { ok: true, phase: 'completed' } }
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(selected.name, 'minecraft:creeper')
  assert.equal(selected.entityId, '53')
  assert.equal(selected.dangerRadius, 12)
  assert.equal(selected.distance, 10)
})

test('unknown hostile distance waits for observation and never invents zero-distance avoidance', async t => {
  const f = fixture()
  t.after(() => f.autonomy.stop())
  f.observations.entities = [observedMob('skeleton', 0, { position: null, positionKnown: false, distance: 0 })]
  let avoided = 0
  f.actions.avoid_threat = async () => { avoided++; return { ok: true, phase: 'completed' } }
  f.autonomy.start(); await f.autonomy.tick()
  const decision = f.autonomy.snapshot().lastDecision
  assert.equal(decision.type, 'wait')
  assert.equal(decision.code, 'threat_observation_required')
  assert.equal(decision.unknownPositions[0].distance, null)
  assert.equal(decision.unknownPositions[0].dangerous, null)
  assert.equal(avoided, 0)
  assert.equal(f.calls.length, 0)
})

test('players, NPCs and unclassified actors are not promoted into confirmed enemies', async t => {
  const f = fixture()
  t.after(() => f.autonomy.stop())
  f.observations.entities = [observedMob('player', 1, { runtimeId: '51', kind: 'player', hostile: true }), observedMob('npc', 1, { runtimeId: '52', kind: 'npc', hostile: true }), observedMob('custom_mob', 1, { runtimeId: '53', hostile: true })]
  let avoided = 0
  f.actions.avoid_threat = async () => { avoided++; return { ok: true, phase: 'completed' } }
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(avoided, 0)
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'scan_blocks')
  f.observations.entities[0].position = null
  f.observations.entities[0].positionKnown = false
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().lastDecision.code, 'threat_observation_required')
  assert.equal(f.autonomy.snapshot().lastDecision.unknownPositions[0].classification, 'player')
  assert.equal(avoided, 0)
})

test('host-reported opaque unknown positions remain an observation requirement', async t => {
  const f = fixture()
  t.after(() => f.autonomy.stop())
  f.observations.threatEvaluation = { requiresObservation: true, unknownPositions: [], hostUnknownPositionCount: 2 }
  f.autonomy.start(); await f.autonomy.tick()
  const decision = f.autonomy.snapshot().lastDecision
  assert.equal(decision.code, 'threat_observation_required')
  assert.equal(decision.hostUnknownPositionCount, 2)
  assert.equal(f.calls.length, 0)
})

test('only fresh inventory evidence can mark the goal complete', async t => {
  const f = fixture()
  t.after(() => f.autonomy.stop())
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.equal(f.autonomy.snapshot().progress.stoneCollected, 0)
  f.state.inventory.items = [{ name: 'minecraft:cobblestone', count: 16, slot: 0 }]
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'complete')
  assert.equal(f.autonomy.snapshot().progress.inventory.stone, 16)
})

test('an injected planner stays passive until start and receives the original observation and lower budgets', async t => {
  let stateReads = 0
  let observations = 0
  let decisions = 0
  let actions = 0
  const state = { phase: 'spawned', health: 20, dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] } }
  const agent = createAutonomy({
    getState: () => { stateReads++; return state },
    observe: () => { observations++; return { entities: [], marker: 'fresh' } },
    planAction: (received, observation, options) => {
      decisions++
      assert.strictEqual(received, state)
      assert.equal(observation.marker, 'fresh')
      assert.equal(observation.progress.observations, 1)
      assert.deepEqual(options, { logCount: 4, stoneCount: 20, minHealth: 6 })
      return { type: 'scan_blocks', stage: 'logs', reason: '追加の観測を行います。' }
    },
    actions: { scan_blocks: async () => { actions++; return { ok: true, phase: 'completed' } } },
    intervalMs: 60000
  })
  t.after(() => agent.stop())
  assert.deepEqual([stateReads, observations, decisions, actions], [0, 0, 0, 0])
  assert.equal(agent.snapshot().phase, 'idle')
  agent.start({ logCount: 4, stoneCount: 20 }); await agent.tick()
  assert.deepEqual([observations, decisions, actions], [1, 1, 1])
})

test('diamond objective retains its goal and cannot complete from an injected stone subgoal', async t => {
  for (const configuration of [{ objective: 'diamond' }, { diamondCount: 2 }]) {
    const planned = []
    const observedGoals = []
    const f = fixture({
      observe: request => { observedGoals.push(request.goal); return { entities: [] } },
      planAction: (state, observations, options) => {
        planned.push(options)
        assert.equal(state.inventory.items[0].count, 16)
        return { type: 'complete', stage: 'stone', goal: { stone: 16 }, reason: '石材の下位工程を完了しました。' }
      }
    })
    t.after(() => f.autonomy.stop())
    f.state.inventory.items = [{ name: 'minecraft:cobblestone', count: 16, slot: 0 }]
    f.autonomy.start(configuration); await f.autonomy.tick()
    const goalCount = configuration.diamondCount ?? 1
    let status = f.autonomy.snapshot()
    assert.equal(status.phase, 'running')
    assert.equal(status.goal.diamond, goalCount)
    assert.equal(status.lastDecision.goal.diamond, goalCount)
    assert.equal(status.lastDecision.type, 'wait')
    assert.equal(status.lastDecision.code, 'goal_inventory_unconfirmed')
    assert.equal(status.progress.inventory.diamond, 0)
    assert.equal(observedGoals[0].diamond, goalCount)
    assert.deepEqual(planned[0], { logCount: 3, stoneCount: 16, minHealth: 6, objective: 'diamond', diamondCount: goalCount })
    f.state.inventory.items.push({ name: 'minecraft:diamond', count: goalCount, slot: 1 })
    f.state.inventory.known = false
    await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().phase, 'running', 'cached items are insufficient while inventory is unknown')
    f.state.inventory.known = true
    f.state.inventory.uncertain = true
    await f.autonomy.tick()
    assert.equal(f.autonomy.snapshot().phase, 'running', 'uncertain inventory cannot finish the final goal')
    f.state.inventory.uncertain = false
    await f.autonomy.tick()
    status = f.autonomy.snapshot()
    assert.equal(status.phase, 'complete')
    assert.equal(status.goal.diamond, goalCount)
    assert.equal(status.progress.inventory.diamond, goalCount)
    assert.equal(status.progress.milestones.diamond, true)
    assert.equal(status.lastDecision.confirmedBy, 'server_inventory')
    assert.equal(status.lastDecision.stage, 'diamond')
  }
})

test('injected diamond planning still yields to threats, respawn and low-health protection', async t => {
  let planned = 0
  const f = fixture({ planAction: () => { planned++; return { type: 'complete', stage: 'stone', reason: '下位工程だけの完了です。' } } })
  t.after(() => f.autonomy.stop())
  f.observations.entities = [observedMob('skeleton', 20)]
  f.actions.avoid_threat = async () => ({ ok: true, phase: 'completed' })
  f.actions.respawn = async () => ({ ok: true, phase: 'completed' })
  f.autonomy.start({ objective: 'diamond' }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'avoid_threat')
  assert.equal(f.autonomy.snapshot().lastDecision.goal.diamond, 1)
  f.state.health = 0; f.state.dead = true
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'respawn')
  f.state.health = 3; f.state.dead = false
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'stopped')
  assert.equal(f.autonomy.snapshot().lastDecision.code, 'low_health')
  assert.equal(planned, 0)
})

test('false results and thrown errors retry finitely and cannot become successful actions', async () => {
  let count = 0
  const f = fixture({ actions: { scan_blocks: async () => { count++; return { ok: false, reason: 'まだ読み取れません。' } } } })
  f.autonomy.start({ maxRetries: 1 })
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'running')
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'failed')
  assert.equal(count, 2)
  assert.equal(f.autonomy.snapshot().progress.actionsReturned, 0)
})

test('item bobbing and observation timestamps cannot reset retries for the same drop entity', async () => {
  let observed = 0
  let attempts = 0
  const f = fixture()
  f.observations.capabilities.collect_drops = true
  f.observations.drops = [{ known: true, entityId: 'drop-7', name: 'minecraft:oak_log', count: 3, position: { x: 1.01, y: 65.12, z: 0.52 } }]
  const agent = createAutonomy({ getState: () => f.state, intervalMs: 60000, observe: () => {
    observed++
    f.observations.observedAt = `refresh-${observed}`
    f.state.positionUpdatedAt = `server-${observed}`
    f.observations.drops[0].position.x += 0.0001
    f.observations.drops[0].position.y += 0.0002
    return f.observations
  }, actions: { collect_drops: async () => { attempts++; throw new Error('No safe route to this item') } } })
  agent.start({ maxRetries: 1 })
  await agent.tick(); await agent.tick()
  assert.equal(attempts, 2)
  assert.equal(agent.snapshot().phase, 'failed')
  assert.deepEqual(agent.snapshot().trace.filter(entry => entry.event === 'action_error').map(entry => entry.attempt), [1, 2])
})

test('changing nearby observations does not reset failed scan action identity', async () => {
  const f = fixture()
  let attempts = 0
  const agent = createAutonomy({ getState: () => f.state, intervalMs: 60000, observe: () => {
    f.state.position.x += 0.0001
    f.observations.blocks = [{ known: true, name: 'minecraft:air', position: { x: attempts, y: 65, z: 2 } }]
    return f.observations
  }, actions: { scan_blocks: async () => { attempts++; return false } } })
  agent.start({ maxRetries: 1 }); await agent.tick(); await agent.tick()
  assert.equal(attempts, 2)
  assert.equal(agent.snapshot().phase, 'failed')
})

test('a final raw guard detecting a new enemy interrupts movement without spending its retry budget', async t => {
  const f = fixture()
  movementResourceScene(f)
  const calls = []
  f.actions.move_to = async (decision, context) => {
    calls.push(decision.type)
    assert.equal(context.observations.threats.length, 0, 'the scan was safe before the latest raw guard')
    await Promise.resolve()
    f.observations.threats = [{ entityId: '9', hostile: true, name: 'minecraft:zombie', distance: 4, positionKnown: true, position: { x: 4.5, y: 66.62, z: 0.5 } }]
    throw safetyError('NEARBY_THREAT')
  }
  f.actions.avoid_threat = async decision => { calls.push(decision.type); return { ok: true, phase: 'completed' } }
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxRetries: 0 })
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.equal(f.autonomy.snapshot().progress.failures, 0)
  assert.equal(f.autonomy.snapshot().progress.safetyInterruptions, 1)
  await f.autonomy.tick()
  assert.deepEqual(calls, ['move_to', 'avoid_threat'])
  assert.equal(f.autonomy.snapshot().progress.consecutiveSafetyInterruptions, 0)
  assert.equal(f.autonomy.snapshot().trace.find(entry => entry.event === 'action_interrupted').code, 'NEARBY_THREAT')
})

test('death during movement reaches respawn even when resource observation itself rejects dead players', async t => {
  const f = fixture()
  movementResourceScene(f)
  const calls = []
  let scans = 0
  const agent = createAutonomy({ getState: () => f.state, intervalMs: 60000, observe: () => {
    scans++
    if (f.state.dead) throw safetyError('DEAD')
    return f.observations
  }, actions: {
    move_to: async () => { calls.push('move_to'); f.state.health = 0; f.state.dead = true; throw safetyError('DEAD') },
    respawn: async () => { calls.push('respawn'); f.state.health = 20; f.state.dead = false; return { ok: true, phase: 'completed', serverConfirmed: true } }
  } })
  t.after(() => agent.stop())
  agent.start({ maxRetries: 0 }); await agent.tick()
  assert.equal(agent.snapshot().phase, 'running')
  await agent.tick()
  assert.deepEqual(calls, ['move_to', 'respawn'])
  assert.equal(scans, 1, 'respawn is not blocked behind a resource observer that requires life')
  assert.equal(agent.snapshot().progress.failures, 0)
})

test('damage interruption redirects to low-health stopping rather than resource failure', async () => {
  const f = fixture()
  movementResourceScene(f)
  f.actions.move_to = async () => { f.state.health = 4; throw safetyError('TOOK_DAMAGE') }
  f.autonomy.start({ maxRetries: 0 }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'running')
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'stopped')
  assert.equal(f.autonomy.snapshot().lastDecision.code, 'low_health')
  assert.equal(f.autonomy.snapshot().progress.failures, 0)
})

test('repeated safety interruptions have their own finite bound', async () => {
  const f = fixture()
  movementResourceScene(f)
  f.actions.move_to = async () => { throw safetyError('NEARBY_THREAT') }
  f.autonomy.start({ maxRetries: 0, maxSafetyInterruptions: 2 })
  await f.autonomy.tick(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
  assert.equal(f.autonomy.snapshot().progress.safetyInterruptions, 2)
  assert.equal(f.autonomy.snapshot().progress.failures, 0)
})

test('exhausted route retries exclude that resource while unconfirmed timeouts still fail normally', async t => {
  const f = fixture()
  movementResourceScene(f)
  f.actions.move_to = async () => { throw safetyError('NO_SAFE_ROUTE') }
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxRetries: 0 }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.equal(f.autonomy.snapshot().progress.excludedResources.length, 1)
  assert.equal(f.autonomy.snapshot().progress.failures, 1)
  assert.equal(f.autonomy.snapshot().progress.safetyInterruptions, 0)
  const other = fixture()
  movementResourceScene(other)
  other.actions.move_to = async () => { throw safetyError('UNCONFIRMED_TIMEOUT') }
  other.autonomy.start({ maxRetries: 0 }); await other.autonomy.tick()
  assert.equal(other.autonomy.snapshot().phase, 'failed')
  assert.equal(other.autonomy.snapshot().progress.failures, 1)
})

function completeEmptyCoverage (f) {
  f.observations.blocks = [{ known: true, name: 'minecraft:air', position: { x: 0, y: 65, z: 0 } }]
  f.observations.coverage = { unknown: 0, known: 1, expected: 1 }
  f.observations.capabilities.explore = true
}

test('fully observed resource-free terrain produces an explicit bounded explore action', async () => {
  const f = fixture()
  completeEmptyCoverage(f)
  const attempts = []
  f.actions.explore = async (decision, context) => {
    attempts.push(decision.attempt)
    assert.equal(decision.type, 'explore')
    assert.equal(context.progress.explorationAttempts, decision.attempt)
    f.state.position.x += 2
    return { ok: true, phase: 'predicted', verificationPending: true, serverConfirmed: false, explored: true }
  }
  f.autonomy.start({ maxExplorations: 2 })
  await f.autonomy.tick(); await f.autonomy.tick(); await f.autonomy.tick()
  assert.deepEqual(attempts, [1, 2])
  assert.equal(f.calls.length, 0, 'a read-only scan is not used to hide a movement action')
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
  assert.equal(f.autonomy.snapshot().progress.explorations, 2)
  assert.equal(f.autonomy.snapshot().progress.explorationAttempts, 2)
  assert.equal(f.autonomy.snapshot().progress.stoneCollected, 0)
})

test('partial coverage or an unavailable exploration capability keeps scanning read-only', async t => {
  const f = fixture()
  completeEmptyCoverage(f)
  f.observations.coverage.unknown = 1
  let moved = 0
  f.actions.explore = async () => { moved++; return { ok: true, phase: 'completed' } }
  t.after(() => f.autonomy.stop())
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'scan_blocks')
  f.observations.coverage.unknown = 0
  f.observations.capabilities.explore = false
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().lastDecision.type, 'scan_blocks')
  assert.equal(moved, 0)
  assert.equal(f.autonomy.snapshot().progress.explorationAttempts, 0)
})

test('exploration attempt limits survive a saved progress restart', async () => {
  const f = fixture()
  completeEmptyCoverage(f)
  let moves = 0
  f.actions.explore = async () => { moves++; return { ok: true, phase: 'completed' } }
  f.autonomy.start({ maxExplorations: 2, progress: { explorations: 2, explorationAttempts: 2 } })
  await f.autonomy.tick()
  assert.equal(moves, 0)
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
  assert.equal(f.autonomy.snapshot().progress.explorationAttempts, 2)
})

test('a failed resource is excluded without removing other logs from its natural-tree evidence', async t => {
  const f = fixture()
  movementResourceScene(f)
  const selected = []
  f.actions.move_to = async decision => { selected.push(decision.resourceTarget); throw safetyError('NO_SAFE_ROUTE') }
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxRetries: 0 }); await f.autonomy.tick(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.equal(selected.length, 2)
  assert.notDeepEqual(selected[0], selected[1])
  assert.equal(f.autonomy.snapshot().progress.excludedResources.length, 2)
  assert.equal(f.autonomy.snapshot().trace.filter(entry => entry.event === 'target_excluded').length, 2)
})

test('a resource is excluded only after its normal retry budget has actually been spent', async t => {
  const f = fixture()
  movementResourceScene(f)
  f.actions.move_to = async () => { throw safetyError('NO_SAFE_ROUTE') }
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxRetries: 1 }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().progress.excludedResources.length, 0)
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().progress.excludedResources.length, 1)
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.deepEqual(f.autonomy.snapshot().trace.filter(entry => entry.event === 'action_error').map(entry => entry.attempt), [1, 2])
})

test('the identified unreachable drop is excluded and a different drop remains eligible', async t => {
  const f = fixture()
  f.observations.capabilities.collect_drops = true
  f.observations.drops = ['a', 'b'].map((entityId, index) => ({ known: true, entityId, name: 'minecraft:oak_log', count: 1, position: { x: index + 1.5, y: 65.125, z: 0.5 } }))
  const selected = []
  f.actions.collect_drops = async decision => {
    selected.push(decision.targets.map(value => value.entityId))
    if (selected.length === 1) { const error = safetyError('NO_SAFE_ROUTE'); error.targetEntityId = 'a'; throw error }
    return { ok: true, phase: 'completed' }
  }
  t.after(() => f.autonomy.stop())
  f.autonomy.start({ maxRetries: 0 }); await f.autonomy.tick(); await f.autonomy.tick()
  assert.deepEqual(selected, [['a', 'b'], ['b']])
  assert.deepEqual(f.autonomy.snapshot().progress.excludedDropIds, ['a'])
  assert.equal(f.autonomy.snapshot().phase, 'running')
  assert.equal(f.autonomy.snapshot().progress.logsCollected, 0)
})

test('target exclusions have a separate finite maximum instead of growing forever', async () => {
  const f = fixture()
  movementResourceScene(f)
  f.actions.move_to = async () => { throw safetyError('NO_SAFE_ROUTE') }
  f.autonomy.start({ maxRetries: 0, maxExcludedTargets: 1 })
  await f.autonomy.tick(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
  assert.equal(f.autonomy.snapshot().progress.excludedTargetCount, 1)
})

test('unsupported and missing action handlers block explicitly without retrying or claiming completion', async () => {
  const f = fixture({ actions: {} })
  f.autonomy.start(); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'blocked')
  assert.equal(f.autonomy.snapshot().requiredCapability, 'scan_blocks')
  const other = fixture({ actions: { scan_blocks: async () => ({ supported: false, phase: 'unsupported' }) } })
  other.autonomy.start(); await other.autonomy.tick()
  assert.equal(other.autonomy.snapshot().phase, 'blocked')
  assert.equal(other.autonomy.snapshot().progress.actionsReturned, 0)
})

test('an uncompleted asynchronous action result is not counted as a successful return', async () => {
  const f = fixture({ actions: { scan_blocks: async () => ({ phase: 'awaiting_server_confirmation' }) } })
  f.autonomy.start({ maxRetries: 0 }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().phase, 'failed')
  assert.equal(f.autonomy.snapshot().progress.actionsReturned, 0)
})

test('a predicted movement return permits observation to continue without claiming material success', async t => {
  const f = fixture({ actions: { scan_blocks: async () => ({ ok: true, phase: 'predicted', verificationPending: true, serverConfirmed: false }) } })
  t.after(() => f.autonomy.stop())
  f.autonomy.start(); await f.autonomy.tick()
  const status = f.autonomy.snapshot()
  assert.equal(status.phase, 'running')
  assert.equal(status.lastActionResult.verificationPending, true)
  assert.equal(status.lastActionResult.serverConfirmed, false)
  assert.equal(status.progress.logsCollected, 0)
  assert.equal(status.progress.stoneCollected, 0)
})

test('unchanged observations cannot cause an endless loop of locally completed actions', async () => {
  const f = fixture()
  f.autonomy.start({ maxNoProgressActions: 2, traceLimit: 4 })
  await f.autonomy.tick(); await f.autonomy.tick(); await f.autonomy.tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.autonomy.snapshot().phase, 'failed')
  assert.ok(f.autonomy.snapshot().trace.length <= 4)
})

test('timeouts abort the child action and fail after the configured attempt limit', async () => {
  let signal
  const f = fixture({ actions: { scan_blocks: (decision, context) => { signal = context.signal; return new Promise(() => {}) } } })
  f.autonomy.start({ actionTimeoutMs: 30, maxRetries: 0 })
  await f.autonomy.tick()
  assert.equal(signal.aborted, true)
  assert.equal(f.autonomy.snapshot().phase, 'failed')
})

test('material progress follows inventory changes and survives serialization without doubling saved counts', async t => {
  const f = fixture()
  t.after(() => f.autonomy.stop())
  f.state.inventory.items = [{ name: 'minecraft:oak_log', count: 3, slot: 0 }]
  f.actions.preview_craft = async decision => ({ ok: true, phase: 'completed', output: decision.output })
  f.autonomy.start({ progress: { logsCollected: 3 } }); await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().progress.logsCollected, 3)
  assert.doesNotThrow(() => JSON.stringify(f.autonomy.snapshot()))
  f.state.inventory.items = [{ name: 'minecraft:oak_planks', count: 12, slot: 0 }]
  await f.autonomy.tick()
  assert.equal(f.autonomy.snapshot().progress.logsCollected, 3)
  assert.equal(f.autonomy.snapshot().progress.inventory.logs, 0)
  assert.equal(f.autonomy.snapshot().progress.milestones.planks, true)
})
