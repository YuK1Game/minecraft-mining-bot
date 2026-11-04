'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGuardedRoute } = require('../src/guarded-route')
const { createNavigator } = require('../src/navigation')

const copy = value => structuredClone(value)
const separation = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function actualPhysicsEscape ({ targetZ = 14.5, earlyTerminal = false, unarmed = false, terrace = false, descend = false, onFrame = () => {} } = {}) {
  let now = 1000
  let motion = { phase: 'idle' }
  let stepper = null
  let starts = 0
  let stops = 0
  let fights = 0
  const frames = []
  const events = []
  const high = z => terrace && z <= 10 && (!descend || z >= 8)
  const world = { getBlock: (x, y, z) => ({ known: true, name: y < (high(z) ? 73 : 72) ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) }
  const navigator = createNavigator({ world })
  const sword = { slot: 0, name: 'minecraft:stone_sword', count: 1 }
  // Same player/Creeper geometry as the received field record. Terrain is an
  // explicit known flat fixture; no live server or saved actor cache is used.
  const creeper = { runtimeId: '6', uniqueId: '6', kind: 'mob', entityType: 'minecraft:creeper', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: -25.499740600585938, y: 72, z: 17.967775344848633 } }
  const state = { phase: 'spawned', profile: 'route', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', runtimeEntityId: '1', gameMode: 'survival', health: 20, position: { x: -24.500436782836914, y: 73.62, z: 15.118175506591797 }, positionUpdatedAt: now, positionSource: 'start_game', rawSelectedSlot: 0, selectedSlot: 0, equipmentServerConfirmed: true, heldItem: copy(sword), inventory: { known: true, items: [sword] }, entities: [creeper] }
  state.vitals = { hunger: 20 }
  if (unarmed) { state.inventory.items = []; state.heldItem = null }
  state.rawServerPosition = copy(state.position); state.rawServerPositionUpdatedAt = now
  const origin = copy(state.position)
  const target = { x: -24.5, y: high(Math.floor(targetZ)) ? 73 : 72, z: targetZ }
  const initialRange = separation(origin, creeper.position)
  const getState = () => copy(state)
  const physicsState = () => navigator.physics.fromServer(state)
  const movement = {
    preview: (target, options) => navigator.plan(physicsState(), target, { maxDistance: options.maxDistance, avoidance: options.avoidance }),
    start: (target, options) => {
      starts++
      events.push({ type: 'start', frame: frames.length })
      const initial = physicsState()
      const plan = navigator.plan(initial, target, { maxDistance: options.maxDistance, avoidance: options.avoidance })
      stepper = navigator.createStepper(plan, initial, { sprint: options.sprint === true })
      motion = { phase: 'moving' }
      return copy(motion)
    },
    stop: reason => { stops++; events.push({ type: 'stop', frame: frames.length, reason }); stepper = null; motion = { phase: 'stopped' }; return copy(motion) }
  }
  const getMovement = () => {
    if (!stepper || motion.phase !== 'moving') return copy(motion)
    const frame = stepper.next()
    now += 50
    state.position = navigator.physics.toServerPosition(frame.predictedState)
    state.positionUpdatedAt = now
    state.positionSource = 'client_prediction'
    state.predicted = { position: copy(state.position), physicsState: copy(frame.predictedState) }
    onFrame({ state, creeper, frame, index: frames.length })
    const gain = creeper.positionKnown === true && creeper.position ? separation(state.position, creeper.position) - initialRange : NaN
    const near = Math.hypot(state.position.x - target.x, state.position.z - target.z) <= 0.4
    motion = { phase: earlyTerminal && near && gain > 0.15 && gain < 0.25 ? 'awaiting_server_confirmation' : frame.phase }
    frames.push({ ...copy(frame), position: copy(state.position), motionPhase: motion.phase, near, gain, visitedPrefix: guard.snapshot().visitedPrefix })
    return copy(motion)
  }
  const guard = createGuardedRoute({
    getState, movement, getMovement,
    inventory: { equip: () => { throw new Error('Already confirmed sword must remain selected') }, cancel: () => {} },
    combat: { previewEngage: () => ({ ready: false }), engage: () => { fights++; throw new Error('Creepers must never be fought') }, cancel: () => {}, drain: () => {} },
    verifyStanding: observed => observed.predicted?.physicsState?.onGround !== false && navigator.physics.hasSupport({ ...observed.position, y: observed.position.y - 1.62 }),
    pollMs: 50, operationTimeoutMs: 5000, clock: () => now,
    // Each getMovement() already advances exactly one real 50ms physics tick.
    delay: async (ms, signal) => { if (signal.aborted) throw signal.reason }
  })
  return { guard, target, frames, events, state, origin, creeper, get counts () { return { starts, stops, fights } } }
}

test('real physics escape keeps moving through the near-target window before its total separation gain reaches a quarter block', async () => {
  const f = actualPhysicsEscape()
  const result = await f.guard.escape([f.target])
  assert.ok(f.frames.some(frame => frame.near && frame.gain < 0.25 && frame.motionPhase === 'moving'), 'the real one-tick sequence must exercise the early near window')
  assert.ok(f.frames.filter(frame => frame.motionPhase === 'moving').every(frame => !frame.visitedPrefix.some(point => point.z === f.target.z)), 'a planned waypoint is not visited while movement is still active')
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(result.interruptions, 0)
  assert.equal(f.counts.starts, 1)
  assert.equal(f.counts.fights, 0)
  assert.ok(f.frames.at(-1).gain >= 0.25)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.returned, false)
  assert.equal(result.safe, false)
  assert.deepEqual(f.state.rawServerPosition, f.origin)
})

test('a short final exact-target segment uses the whole real leg gain rather than requiring another quarter block', async () => {
  const f = actualPhysicsEscape({ targetZ: 14.3 })
  const result = await f.guard.escape([f.target])
  const final = f.frames.at(-1)
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.escaped, true)
  assert.equal(result.interruptions, 0)
  assert.equal(f.counts.starts, 1)
  assert.ok(final.gain >= 0.25)
  const lastCentre = { x: -24.5, y: 73.62, z: 14.5 }
  assert.ok(separation(final.position, f.creeper.position) - separation(lastCentre, f.creeper.position) < 0.25, 'the exact final segment is deliberately too short to supply the full-leg gain')
})

test('an executor that actually ends with insufficient real separation cannot certify escape', async () => {
  const f = actualPhysicsEscape({ earlyTerminal: true })
  const result = await f.guard.escape([f.target])
  assert.ok(f.frames.some(frame => frame.motionPhase === 'awaiting_server_confirmation' && frame.gain > 0.15 && frame.gain < 0.25))
  assert.equal(result.ok, false)
  assert.equal(result.escaped, false)
  assert.equal(result.arrived, false)
  assert.equal(result.safe, false)
  assert.ok(!result.visitedPrefix.some(point => point.z === f.target.z), 'a rejected terminal pose cannot become a visited waypoint in the following near-target retry')
  assert.ok(f.counts.stops > 0)
  assert.equal(f.counts.fights, 0)
  assert.ok(f.counts.starts <= 3)
})

test('explicit unarmed escape crosses one known continuous sprint-and-jump leg without rearming or stopping between grid nodes', async () => {
  const f = actualPhysicsEscape({ targetZ: 6.5, terrace: true, descend: true, unarmed: true })
  const result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 12, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.escaped, true)
  assert.equal(result.interruptions, 0)
  assert.equal(f.counts.starts, 1)
  assert.ok(f.frames.some(frame => frame.controls.sprint === true), 'the long known level part must use real sprint physics')
  assert.ok(f.frames.some(frame => frame.controls.jump === true), 'the route includes an ordinary one-block jump')
  assert.ok(f.frames.some((frame, index) => index && !frame.predictedState.onGround && frame.position.y < f.frames[index - 1].position.y), 'a real descending jump phase is exercised')
  assert.equal(f.frames.at(-1).predictedState.onGround, true)
  assert.ok(f.frames.at(-1).gain >= 0.25)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.returned, false)
  assert.equal(result.safe, false)
})

test('a long real-physics escape still stops its current leg on damage, changed danger, unknown actors or water', async () => {
  for (const kind of ['damage', 'primed', 'new_actor', 'unknown', 'water']) {
    const f = actualPhysicsEscape({ targetZ: 6.5, terrace: true, descend: true, unarmed: true, onFrame: ({ state, creeper, index }) => {
      if (index !== 5) return
      if (kind === 'damage') state.health--
      if (kind === 'primed') creeper.primed = true
      if (kind === 'new_actor') state.entities.push({ ...copy(creeper), runtimeId: '7', uniqueId: '7', position: { x: -24.5, y: 72, z: 9.5 } })
      if (kind === 'unknown') { creeper.positionKnown = false; creeper.position = null }
      if (kind === 'water') state.predicted.physicsState.isInWater = true
    } })
    const result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 12, maxBootstrapNodes: 16, maxBootstrapDistance: 16 })
    const firstStop = f.events.find(event => event.type === 'stop')
    assert.equal(firstStop?.frame, 6, `${kind}: the first unsafe physics observation stops the active movement`)
    assert.equal(f.frames[5].visitedPrefix.some(point => point.z === f.target.z), false, kind)
    if (kind === 'damage') assert.equal(result.routeInterruption?.code, 'TOOK_DAMAGE')
    if (kind === 'unknown') assert.equal(result.code, 'THREAT_OBSERVATION_UNKNOWN')
    if (['primed', 'new_actor', 'water'].includes(kind)) assert.equal(result.routeInterruption?.code, 'NEARBY_THREAT', kind)
    assert.ok(f.counts.starts <= 4, kind)
    assert.equal(f.counts.fights, 0, kind)
    assert.equal(result.outwardCompleted, false, kind)
  }
})

test('a continuous escape cannot extend the caller fixed deadline to finish a distant target', async () => {
  const f = actualPhysicsEscape({ targetZ: 6.5, unarmed: true })
  const result = await f.guard.escape([f.target], { allowUnarmedBootstrap: true, maxLegDistance: 12, maxBootstrapNodes: 16, maxBootstrapDistance: 16, timeoutMs: 100 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TIMEOUT')
  assert.equal(result.escaped, false)
  assert.ok(f.frames.length <= 2)
  assert.equal(f.counts.starts, 1)
  assert.ok(f.counts.stops >= 1)
})
