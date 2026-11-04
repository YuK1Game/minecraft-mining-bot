'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { evaluateThreats } = require('../src/threats')
const { continuationScope } = require('../src/base-continuation')
const captured = require('./fixtures/recent-damage-retreat.json')
const copy = value => structuredClone(value)
const filename = path.resolve(__dirname, '../src/recent-damage-retreat.js')
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(process.env.RECENT_DAMAGE_RETREAT_TEST_SOURCE ?? filename, 'utf8'), filename)
const { planRecentDamageRetreat, retreatFrameAllowed } = loaded.exports
const cells = new Map(captured.blocks.map(block => [Object.values(block.position).join(','), block]))
const world = { getBlock: (x, y, z) => cells.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? { known: false } }
const prepared = createPhysics({ world, version: '1.26.60' })
const epoch = Date.parse(captured.provenance.capturedAt)

function fixture () {
  const state = copy(captured.state)
  // CONTROLLED Host-semantic damage record, not a recovered historical event.
  const damage = { source: 'host_received_health_drop', scope: continuationScope(state), at: epoch, previousHealth: 20, health: 17 }
  return { state, world, physics: prepared, damage, status: null, now: () => epoch, check: () => {}, yieldControl: turn }
}

function margin (point, from, to, radius) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }, length = d.x ** 2 + d.y ** 2 + d.z ** 2
  const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * d.x + (point.y - from.y) * d.y + (point.z - from.z) * d.z) / length)) : 0
  return Math.hypot(point.x - from.x - t * d.x, point.y - from.y - t * d.y, point.z - from.z - t * d.z) - radius
}

test('the actual old no-primary branch rejects the fully supported captured origin before producing any route', () => {
  const f = fixture(), nav = createNavigator({ world, physics: prepared }), initial = nav.physics.fromServer(f.state)
  const evaluated = evaluateThreats(f.state, f.state.entities, { now: f.now, observationRadius: 32 })
  assert.equal(evaluated.requiresObservation, false)
  assert.equal(evaluated.threats.length, 0)
  assert.equal(evaluated.outsideDanger.length, 14)
  assert.equal(nav.verifyOrigin(initial), true)
  const source = fs.readFileSync(path.resolve(__dirname, '../src/runtime.js'), 'utf8')
  const marker = '            if (!primary || !alreadyShallow && !fullOrigin && !partialOrigin) {'
  const start = source.indexOf(marker), end = source.indexOf('            const urgentCreeper', start)
  assert.ok(start >= 0 && end > start, 'Execute the preserved real Runtime gate, not a restated predicate')
  const gate = new Function('primary', 'alreadyShallow', 'fullOrigin', 'partialOrigin', 'initial', 'signal', 'context', 'produceRoute', source.slice(start, end) + '\nreturn produceRoute()')
  let routes = 0
  const result = gate(undefined, false, nav.verifyOrigin(initial), false, f.state, null, {}, () => { routes++; return nav.plan(initial, { ...initial.position, x: initial.position.x - 1 }, { maxDistance: 2, maxExpanded: 300 }) })
  assert.deepEqual(result, { supported: false, reason: 'no_known_escape_origin' })
  assert.equal(routes, 0)
})

test('historical received terrain supports a bounded ordinary Native retreat with every current canonical circle intact', async () => {
  const f = fixture(), before = copy(f.state), result = await planRecentDamageRetreat(f)
  assert.equal(result.ready, true, result.reason ?? result.code)
  assert.equal(result.kind, 'recent_damage_no_primary')
  assert.deepEqual(result.initial, prepared.fromServer(before), 'Actual captured velocity and feet must be retained')
  assert.deepEqual(f.state, before)
  assert.ok([14, 15].includes(result.trace.length), `Native ticks: ${result.trace.length}`)
  assert.ok(result.executionTicks <= 20)
  assert.ok(Math.hypot(result.target.x - result.initial.position.x, result.target.z - result.initial.position.z) <= 1.0001)
  assert.ok(Math.abs(result.target.y - result.initial.position.y) <= 1)
  assert.notEqual(result.riskAccepted, true)
  assert.equal(result.primary, undefined)
  assert.deepEqual(result.scope, continuationScope(before))
  const canonical = evaluateThreats(before, before.entities, { now: f.now, observationRadius: 32 })
  assert.equal(result.avoidance.length, canonical.outsideDanger.length)
  for (const circle of result.avoidance) {
    const actor = canonical.outsideDanger.find(actor => actor.runtimeId === circle.id)
    assert.ok(actor)
    assert.equal(circle.minDistance, actor.dangerRadius)
    assert.equal(circle.padding ?? 0, 0)
  }
  let previous = before.position
  for (const frame of result.trace) {
    assert.equal(frame.predictedState.isInWater, false)
    assert.equal(frame.predictedState.isInLava, false)
    assert.notEqual(frame.controls.sprint, true)
    for (const circle of result.avoidance) assert.ok(margin(circle.position, previous, frame.packetPosition, circle.minDistance) >= -1e-4, circle.id)
    previous = frame.packetPosition
  }
  const last = result.trace.at(-1), nav = createNavigator({ world, physics: prepared })
  assert.equal(last.phase, 'awaiting_server_confirmation')
  assert.equal(last.serverConfirmed, false)
  assert.equal(nav.verifyOrigin(last.predictedState), true)
})

test('missing or stale damage, changed life, unknown terrain, and known poison do not authorize a retreat', async () => {
  const cases = [
    f => { f.damage = null },
    f => { f.damage.source = 'inferred_damage' },
    f => { f.damage.at -= 60001 },
    f => { f.damage.scope.life++ },
    f => { f.state.lifecycle.deathId++ },
    f => { f.state.startedAt = null },
    f => { f.state.entities[0].positionKnown = false; f.state.entities[0].position = null },
    f => { f.world = { getBlock: () => ({ known: false }) }; f.physics = prepared.withWorld(f.world) },
    f => { f.status = { source: 'own_mob_effect', scope: continuationScope(f.state), active: [19], observedAt: epoch } },
    f => { f.status = { source: 'own_mob_effect', scope: continuationScope(f.state), active: [20], observedAt: epoch } },
    f => { f.state.onFire = true },
    f => { f.state.breath = { current: 0, maximum: 300 } }
  ]
  for (const change of cases) {
    const f = fixture(); change(f)
    const result = await planRecentDamageRetreat(f)
    assert.equal(result.ready, false, `Unexpected route for ${change}: ${JSON.stringify(result.target)}`)
  }
})

test('the fresh frame guard rejects changed actor identity, life, poison, and unknown body before queueing', async () => {
  const f = fixture(), plan = await planRecentDamageRetreat(f), frame = plan.trace[0]
  assert.equal(plan.ready, true)
  const allowed = extra => retreatFrameAllowed({ ...f, plan, frame, ...extra })
  assert.equal(allowed({}), true)
  const changedLife = copy(f.state); changedLife.lifecycle.deathId++
  assert.equal(allowed({ state: changedLife }), false)
  const changedActor = copy(f.state); changedActor.entities[0].uniqueId = '-123456789'
  assert.equal(allowed({ state: changedActor }), false)
  const crossed = copy(f.state)
  crossed.entities.find(actor => actor.runtimeId === '16204').position = { ...frame.packetPosition, y: frame.packetPosition.y - 0.9 }
  assert.equal(allowed({ state: crossed }), false)
  const unknown = { getBlock: () => ({ known: false }) }
  assert.equal(allowed({ world: unknown, physics: prepared.withWorld(unknown) }), false)
  assert.equal(allowed({ status: { source: 'own_mob_effect', scope: continuationScope(f.state), active: [19], observedAt: epoch } }), false)
})

test('real Movement queues the proven normal retreat with fresh guards and reports only model completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(), plan = await planRecentDamageRetreat(f), queued = [], packets = []
  let elapsed = 0, current = copy(f.state)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  // Runtime freezes motionOrigin for the Native producer; its fresh frame
  // callback independently reads the current published working prediction.
  const movement = createMovement({ world, physics: prepared, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, getState: () => f.state,
    client: { queue: (name, packet) => { packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } },
    onPrediction: prediction => { current = { ...current, position: copy(prediction.position), predicted: { ...copy(prediction), updatedAt: new Date(epoch + elapsed).toISOString() }, positionSource: 'client_prediction', positionUpdatedAt: new Date(epoch + elapsed).toISOString() } },
    onQueuedFrame: frame => queued.push(copy(frame)) })
  t.after(() => movement.stop('Test cleanup'))
  const options = { emergency: true, allowWater: false, sprint: false, maxDistance: 2, maxExpanded: 300, maxTicks: plan.executionTicks, avoidance: plan.avoidance, beforeInput: frame => retreatFrameAllowed({ ...f, state: current, plan, frame, now: () => epoch + elapsed }) }
  assert.equal(movement.preview(plan.target, options).ready, true)
  movement.start(plan.target, options)
  for (let ticks = 0; movement.snapshot().running && ticks < 20; ticks++) { elapsed += 50; t.mock.timers.tick(50); await turn() }
  const result = movement.snapshot(), modeled = queued.filter(frame => frame.modeled)
  assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
  assert.equal(result.serverConfirmed, false)
  assert.equal(modeled.length, plan.trace.length)
  assert.ok(modeled.every(frame => frame.receiptConfirmed === true))
  assert.ok(modeled.every(frame => !frame.controls.sprint))
  assert.ok(packets.every(packet => packet.name === 'player_auth_input'))
  assert.deepEqual(current.inventory, f.state.inventory, 'Model movement gives no inventory or collection credit')
})

test('a newly crossing actor stops real Movement before the next modeled queue', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(), plan = await planRecentDamageRetreat(f), queued = []
  let elapsed = 0, current = copy(f.state)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const movement = createMovement({ world, physics: prepared, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, getState: () => f.state,
    client: { queue: (name, packet) => ({ tick: packet.tick }) },
    onPrediction: prediction => { current = { ...current, position: copy(prediction.position), predicted: { ...copy(prediction), updatedAt: new Date(epoch + elapsed).toISOString() }, positionSource: 'client_prediction', positionUpdatedAt: new Date(epoch + elapsed).toISOString() } },
    onQueuedFrame: frame => queued.push(copy(frame)) })
  t.after(() => movement.stop('Test cleanup'))
  movement.start(plan.target, { emergency: true, allowWater: false, sprint: false, maxDistance: 2, maxExpanded: 300, maxTicks: plan.executionTicks, avoidance: plan.avoidance, beforeInput: frame => retreatFrameAllowed({ ...f, state: current, plan, frame, now: () => epoch + elapsed }) })
  const count = queued.filter(frame => frame.modeled).length
  assert.equal(count, 1)
  const witch = current.entities.find(actor => actor.runtimeId === '16204')
  witch.position = { ...current.position, y: current.position.y - 0.9 }
  elapsed += 50; t.mock.timers.tick(50); await turn()
  assert.equal(queued.filter(frame => frame.modeled).length, count)
  assert.equal(movement.snapshot().phase, 'failed')
  assert.match(movement.snapshot().reason, /frame guard rejected/)
  assert.equal(movement.snapshot().serverConfirmed, false)
})
