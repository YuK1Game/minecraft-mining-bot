'use strict'

const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { createUserControlRuntime } = require('../../src/runtime/user-control-runtime')
const { createMovement } = require('../../src/movement/movement')
const { createNavigator } = require('../../src/movement/navigation')
const { evaluateThreats } = require('../../src/combat/threats')

// The actual owner handoff, native movement, navigator, physics and frame
// guards. Only unrelated work controllers and the network sink are inert.
function combatRetreatRuntime (t, { state: received, world, target }) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const seed = { ...structuredClone(received), health: 20, phase: 'spawned', inventory: { known: true, items: [] } }
  let state = structuredClone(seed), facade, clock = 0
  const actor = structuredClone(target), events = [], packets = [], previews = [], starts = [], errors = []
  const navigator = createNavigator({ world, allowWater: true })
  const idle = () => ({ busy: false, pendingRequestId: null })
  const inert = name => ({ snapshot: idle, cancel: () => events.push(`${name}.cancel`), stop: () => events.push(`${name}.stop`), drain: async () => {} })
  const client = { queue(name, packet) { packets.push({ name, packet: structuredClone(packet) }); return { tick: packet.tick } } }
  const movement = createMovement({ client, getState: () => seed, world, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => clock,
    waterPhysics: navigator.physics, onPrediction: prediction => { state = { ...state, position: { ...prediction.position }, positionSource: 'client_prediction', predicted: structuredClone(prediction) } }, onError: error => errors.push(error) })
  const nativePreview = movement.preview, nativeStart = movement.start
  movement.preview = (point, options) => { previews.push(options); return nativePreview(point, options) }
  let beforeStart = null
  movement.start = (point, options) => { starts.push({ point, options }); events.push('movement.start'); beforeStart?.(); return nativeStart(point, options) }
  const current = () => ({ ...state, entities: [actor] })
  const rt = {
    require: createRequire(require.resolve('../../src/runtime.js')),
    host: { shared: { autoWanted: true, userBehaviorsEnabled: true, deathRespawn: { deathId: 0 } }, client, world, entities: { snapshot: () => [actor] }, meta: { version: '1.26.60' }, log() {} },
    requireGeneration() {}, currentGeneration: () => true, lightweightUserState: current, working: current, raw: current, rawScope: current,
    userScope: value => `${value.connectionId}:${value.dimension}:${value.runtimeEntityId}`, actualLifeId: () => 0, evaluateThreats, resourceMinHealth: () => 0,
    userBehaviorTimer: 1, userBehaviorLease: null, userBehaviorSnapshot: () => ({ sleeping: false }), generationStream: {},
    createUserBehaviors: options => { facade = options; return {} }, createSightStanceSearch: () => () => null,
    generationSafety: { snapshot: () => ({ running: true, busy: true, active: 'escape', phase: 'escaping' }), stop: () => events.push('safety.stop'), drain: async () => {} },
    idleSafetyRuntime: { owners: { escape: { operationId: 'old-escape' } }, generationGuardRoute: inert('guard') },
    generationPhysics: navigator.physics, createNavigator, generationMovement: movement, movement,
    generationCombat: inert('combat'), generationShelter: inert('shelter'), generationHut: inert('hut'),
    mining: inert('mining'), food: inert('food'), armor: {}, interactions: inert('interactions'), prospecting: inert('prospecting'), inventory: inert('inventory'), chest: inert('chest'), furnace: inert('furnace'), autonomy: inert('autonomy'),
    craftStatus: idle, chestStatus: idle, crafting: { cancel() {}, closeContainer() {} },
    cancelChunkMovement: () => events.push('chunk.cancel'), stopOrdinaryUserStream: () => events.push('stream.stop'), startIdle() {},
    KITE_LANDING_POLLS: 12, KITE_RADII: [3.4, 3.2, 3.6], KITE_ANGLES: [0, 35, -35, 70, -70].map(x => x * Math.PI / 180), quarryRetreatDepth: 0,
    portableMovementSerial: 0, yieldPortableMovement: () => events.push('portable.yield'),
    delay: async ms => { clock += ms; t.mock.timers.tick(ms); await Promise.resolve() },
    threatReachability: { ENGAGE_RADIUS: 32 }, userBehaviorError: error => { throw error }
  }
  createUserControlRuntime(rt)
  t.after(() => movement.stop('test_cleanup'))
  async function acquire () {
    const context = { kind: 'combat', claimId: 'combat:1', signal: new AbortController().signal, target: actor }
    context.token = await facade.acquireControl(context)
    assert.equal(rt.userBehaviorLease.ready, true)
    assert.ok(events.includes('safety.stop'))
    assert.equal(previews.length, 0, 'combat takes priority before planning')
    return context
  }
  return { acquire, retreat: context => facade.retreat(actor, { ...context, radii: [9, 10, 8.5], maxStep: 6 }), rt, actor, movement, navigator, events, packets, previews, starts, errors, state: current,
    beforeStart: hook => { beforeStart = hook }, changeState: change => { Object.assign(state, change); Object.assign(seed, change) } }
}

module.exports = { combatRetreatRuntime }
