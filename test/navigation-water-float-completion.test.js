'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const activeNavigation = require('../src/navigation')
const { createPhysics } = require('../src/physics')
const capture = require('./fixtures/navigation-water-float254.json')
const copy = value => structuredClone(value)
const rows = new Map(capture.blocks.map(block => [Object.values(block.position).join(','), block]))
const read = (x, y, z) => rows.get(`${x},${y},${z}`) ?? { known: false }
const prepared = createPhysics({ world: { getBlock: read }, allowWater: true })
function compiled (filename, source, overrides = {}) {
  const target = { exports: {} }, nativeRequire = Module.createRequire(filename)
  new vm.Script(Module.wrap(source), { filename }).runInThisContext()(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
  return target.exports
}
const navFile = path.resolve(__dirname, '../src/navigation.js'), navSource = fs.readFileSync(navFile, 'utf8')
const marker = 'else if (settled && !atTarget && !waterFloatCompletion)'
assert.equal(navSource.split(marker).length, 2, 'The old-branch control removes only the terminal float suppression')
const oldNavigation = compiled(navFile, navSource.replace(marker, 'else if (settled && !atTarget)'))
const movementFile = path.resolve(__dirname, '../src/movement.js'), movementSource = fs.readFileSync(movementFile, 'utf8')

function fixture (t, { legacy = false, maxTicks = 40, afterQueue = null } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0, activeRoute = null
  const changes = new Map(), packets = [], records = [], predictions = [], state = copy(capture.state)
  t.mock.method(Date, 'now', () => Date.parse(capture.capturedAt) + elapsed)
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? read(x, y, z) }, physics = prepared.withWorld(world)
  const source = legacy ? oldNavigation : activeNavigation
  const navigation = { createNavigator: options => {
    const navigator = source.createNavigator(options)
    return { ...navigator, plan: (...args) => { const route = navigator.plan(...args); activeRoute = route; return route } }
  } }
  const { createMovement } = compiled(movementFile, movementSource, { './navigation': navigation })
  const movement = createMovement({ world, waterPhysics: physics, getState: () => copy(state), version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed,
    client: { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } },
    onQueuedFrame: frame => records.push(copy(frame)), onPrediction: value => { predictions.push(copy(value)); afterQueue?.({ records, predictions, changes, route: activeRoute }) }
  })
  t.after(() => movement.stop('Test cleanup'))
  const options = { allowWater: true, emergency: true, exactGoal: true, maxDistance: 2, maxExpanded: 64, maxTicks, sprint: false, avoidance: copy(capture.circles) }
  const run = () => { movement.start(capture.target, options); for (let count = 0; count < 80 && movement.snapshot().phase === 'moving'; count++) { elapsed += 50; t.mock.timers.tick(50) }; return movement.snapshot() }
  return { state, physics, movement, records, packets, predictions, changes, run }
}

test('real Movement reproduces nineteen old queued frames and keeps the unchanged native float for twenty-three new frames', async t => {
  let old
  await t.test('old terminal branch', t => {
    const f = fixture(t, { legacy: true }), result = f.run()
    assert.equal(f.records.length, 19, JSON.stringify({ phase: result.phase, reason: result.reason })); assert.equal(result.phase, 'replan_required')
    assert.equal(result.settled, true); assert.ok(result.predictedFeet.y < capture.target.y - 0.8)
    old = f.records.map(frame => copy(frame.predictedState))
    assert.equal(result.serverConfirmed, false)
  })
  await t.test('new bounded completion', t => {
    const f = fixture(t), before = copy(f.state), result = f.run()
    assert.equal(f.records.length, 23, JSON.stringify({ phase: result.phase, reason: result.reason })); assert.equal(result.phase, 'awaiting_server_confirmation', result.reason)
    assert.equal(f.predictions[18].phase, 'moving'); assert.equal(f.predictions[18].settled, true)
    assert.ok(f.predictions[18].feetPosition.y < capture.target.y - 0.8)
    for (let index = 0; index < old.length; index++) assert.deepEqual(f.records[index].predictedState, old[index], 'The fix changes no physics through the old stopping point')
    assert.ok(Math.hypot(result.predictedFeet.x - capture.target.x, result.predictedFeet.z - capture.target.z) <= 0.35)
    assert.ok(Math.abs(result.predictedFeet.y - capture.target.y) <= 0.8)
    assert.equal(result.settled, true); assert.equal(result.serverConfirmed, false)
    assert.ok(f.records.slice(-2).every(frame => frame.predictedState.isInWater && Math.hypot(frame.predictedState.velocity.x, frame.predictedState.velocity.z) < 0.006 && Math.abs(frame.predictedState.velocity.y) < 0.08))
    assert.ok(f.records.slice(18).every(frame => frame.controls.jump === true && !frame.controls.sprint))
    for (let index = 1; index < f.records.length; index++) assert.equal(f.records[index].tick, f.records[index - 1].tick + 1n)
    assert.ok(f.records.every(frame => frame.modeled && frame.receiptConfirmed && frame.producer === 'navigation'))
    assert.deepEqual(f.state, before); assert.equal(result.collected, undefined); assert.equal(result.reachedDestination, undefined)
  })
})

test('the existing forty-tick limit is not renewed and a twenty-tick budget stops before a twenty-first queue', t => {
  const f = fixture(t, { maxTicks: 20 }), result = f.run()
  assert.equal(f.records.length, 20)
  assert.equal(result.phase, 'failed'); assert.match(result.reason, /tick limit/i)
  assert.equal(result.serverConfirmed, false)
})

test('unknown headroom, lava or a changed received surface during float completion deny the next queue', async t => {
  for (const mode of ['unknown_head', 'lava', 'surface_changed']) await t.test(mode, t => {
    let changed = false
    const f = fixture(t, { afterQueue: ({ records, changes }) => {
      if (records.length !== 19 || changed) return
      changed = true
      if (mode === 'unknown_head') changes.set('5,63,13', { known: false })
      else changes.set('5,62,13', { known: true, position: { x: 5, y: 62, z: 13 }, name: mode === 'lava' ? 'minecraft:lava' : 'minecraft:air', properties: mode === 'lava' ? { liquid_depth: 0 } : {}, boundingBox: 'empty', extra: [] })
    } }), result = f.run()
    assert.equal(changed, true); assert.equal(f.records.length, 19)
    assert.equal(result.phase, 'failed'); assert.equal(result.serverConfirmed, false)
  })
})

test('the same captured actor hard floor is rechecked before every additional native float queue', t => {
  let changed = false
  const f = fixture(t, { afterQueue: ({ records, route }) => {
    if (records.length !== 19 || changed) return
    changed = true
    const current = records.at(-1).packetPosition, actor = route.avoidance[0]
    // Controlled fresh policy observation: preserve its exact original floor,
    // with the actor ahead of the next vertical float segment. No real actor
    // movement or server receipt is asserted by this in-memory negative test.
    actor.position = { x: current.x, y: current.y + actor.minDistance + 0.03, z: current.z }
  } }), result = f.run()
  assert.equal(changed, true); assert.equal(f.records.length, 19)
  assert.equal(result.phase, 'failed'); assert.match(result.reason, /avoidance/i)
  assert.equal(result.serverConfirmed, false)
})

test('ordinary dry and horizontally overshot water endpoints retain their old replan result', () => {
  for (const mode of ['dry', 'water_wrong_xy']) {
    const world = mode === 'dry' ? { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) } : { getBlock: read }
    const physics = prepared.withWorld(world, { allowWater: mode !== 'dry' })
    const result = []
    for (const navigation of [oldNavigation, activeNavigation]) {
      const n = navigation.createNavigator({ world, physics, allowWater: mode !== 'dry' })
      let initial, route
      if (mode === 'dry') {
        initial = physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, gameMode: 'survival' })
        route = { ready: true, origin: initial.position, target: { x: 3.5, y: 65, z: 0.5 }, waypoints: [], avoidance: [] }
      } else {
        initial = physics.fromServer(capture.state); initial.position = { x: 5.7, y: 62.25, z: capture.target.z }; initial.velocity = { x: 0.3, y: 0, z: 0 }; initial.onGround = false; initial.isInWater = true
        route = copy(capture.route); route.avoidance = []
      }
      const stepper = n.createStepper(route, initial, { maxTicks: 80, sprint: false }); let frame, ticks = 0
      do { frame = stepper.next(); ticks++ } while (frame.phase === 'moving' && ticks < 80)
      result.push({ phase: frame.phase, reason: frame.reason, ticks })
    }
    assert.equal(result[0].phase, 'replan_required', mode); assert.deepEqual(result[1], result[0], mode)
  }
})
