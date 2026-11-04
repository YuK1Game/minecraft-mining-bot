'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), vm = require('node:vm')
const { setImmediate: turn } = require('node:timers/promises')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { createInput } = require('../src/input')
const { createMeleeCombat } = require('../src/melee-combat')
const { createCombatCoordinator } = require('../src/combat-coordinator')
const capture = require('./fixtures/runtime-surface-combat246.json')
const copy = value => structuredClone(value)
const eye = p => ({ ...p, y: p.y + 1.62 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const aim = actor => ({ ...actor.position, y: actor.position.y + (['minecraft:spider', 'minecraft:cave_spider'].includes(actor.entityType) ? 0.2 : 0.9) })
function segmentDistance (p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, length = dx * dx + dy * dy + dz * dz
  const ratio = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / length)) : 0
  return distance(p, { x: a.x + dx * ratio, y: a.y + dy * ratio, z: a.z + dz * ratio })
}
const blocks = new Map(capture.blocks.map(block => [Object.values(block.position).join(','), block]))
const read = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false }
const prepared = createPhysics({ world: { getBlock: read }, allowWater: true })

function loadModule (filename, source, overrides) {
  const loaded = { exports: {} }, nativeRequire = Module.createRequire(filename)
  new vm.Script(Module.wrap(source), { filename }).runInThisContext()(loaded.exports, name => overrides[name] ?? nativeRequire(name), loaded, filename, path.dirname(filename))
  return loaded.exports
}
function facadeFactory (hooks) {
  const filename = path.resolve(__dirname, '../src/user-behaviors.js')
  return loadModule(filename, fs.readFileSync(filename, 'utf8'), {
    './melee-combat': { createMeleeCombat: options => {
      const melee = createMeleeCombat(options); hooks.melee = melee
      return { ...melee, engage: async (id, options) => {
        hooks.meleeCalls.push({ id, preview: melee.preview(id) })
        // Request one ordinary hit through the REAL controller. The controlled
        // queue supplies no target health/death response and earns no hit credit.
        const result = await melee.engage(id, { ...options, critical: false, maxHits: 1 })
        hooks.meleeResults.push(result)
        hooks.coordinator.cancel('Controlled in-memory ordinary request observed', 'CONTROLLED_REQUEST_ONLY')
        return result
      } }
    } },
    './combat-coordinator': { createCombatCoordinator: options => { hooks.coordinator = createCombatCoordinator(options); return hooks.coordinator } }
  }).createUserBehaviors
}

const sceneFile = path.resolve(__dirname, 'runtime-user-behaviors.test.js')
let sceneSource = fs.readFileSync(sceneFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
sceneSource = 'let testHooks;\n' + sceneSource
sceneSource = sceneSource.replace('  const actors = []', '  Object.assign(raw, structuredClone(testHooks.initialRaw));\n  const actors = structuredClone(testHooks.actors)')
sceneSource = sceneSource.replace('  const facadeState =', '  shared.deathRespawn = { deathId: 246 }; shared.prediction = structuredClone(testHooks.initialPrediction);\n  const facadeState =')
sceneSource = sceneSource.replace('  const overrides = {', "  const overrides = {\n    'node:timers/promises': { ...require('node:timers/promises'), setTimeout: (ms, value, options) => testHooks.wait(ms, options?.signal) },")
sceneSource = sceneSource.replace(/^    '\.\/physics': .+$/m, "    './physics': { createPhysics: options => testHooks.physics(options) }, './navigation': { createNavigator: options => testHooks.navigator(options) }, './movement': { createMovement: options => { wireMovementOptions.push(options); Object.assign(mockMovement, testHooks.movement(options)); return mockMovement } },")
sceneSource = sceneSource.replace(/^    '\.\/input': .+$/m, "    './input': { createInput: options => { wireInputOptions.push(options); return testHooks.input(options) } },")
sceneSource = sceneSource.replace(/^    '\.\/user-behaviors': .+$/m, "    './user-behaviors': { createUserBehaviors: options => { facadeOptions = options; const actual = testHooks.facade(options); return { ...actual, tick: () => Promise.resolve(actual.snapshot()) } } }")
sceneSource += '\nmodule.exports = { scene, setHooks: value => { testHooks = value } }'
const scenes = loadModule(sceneFile, sceneSource, {})

function fixture (t, { mutateFrame = null, mutatePreview = null, onWait = null, bob = false } = {}) {
  let elapsed = 0, f, movement, input, currentFacade
  const epoch = Date.parse(capture.capturedAt)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const overrides = new Map(), queuedFrames = [], starts = [], previews = [], movementStops = []
  const initialRaw = { ...copy(capture.state), position: copy(capture.state.rawServerPosition), positionSource: 'server_post_move', positionServerConfirmed: true, positionUpdatedAt: 'unknown_historical_raw_anchor', rawServerPositionUpdatedAt: undefined, selectedSlot: 2, rawSelectedSlot: 2, rawServerSelectedSlot: 2 }
  delete initialRaw.predicted
  const initialPrediction = copy(capture.state.predicted)
  if (bob) { initialPrediction.physicsState.isInWater = false; initialPrediction.isInWater = false }
  const hooks = { initialRaw, initialPrediction, actors: copy(capture.actors), meleeCalls: [], meleeResults: [], coordinator: null, melee: null, queuedFrames, movementStops,
    physics: options => prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }),
    navigator: options => createNavigator({ ...options, physics: options.physics ?? prepared.withWorld(options.world, { allowWater: options.allowWater ?? false }) }),
    wait: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error('cancelled')
      const before = elapsed
      await turn()
      if (onWait) await onWait({ f, hooks, ms, movement, input })
      if (elapsed === before && ms > 0 && (movement?.snapshot().running || input?.stats().running)) { elapsed += ms; t.mock.timers.tick(ms) }
      await turn()
      if (signal?.aborted) throw signal.reason ?? new Error('cancelled')
    },
    movement: options => {
      const beforeInput = options.beforeInput
      movement = createMovement({ ...options, clock: () => elapsed, startGameReceivedAt: 0,
        onQueuedFrame: frame => { queuedFrames.push(copy(frame)); options.onQueuedFrame?.(frame) },
        beforeInput,
        onPrediction: value => options.onPrediction(value)
      })
      return { ...movement,
        preview: (target, options) => { const result = movement.preview(target, options); previews.push({ target: copy(target), options, result }); mutatePreview?.({ f, hooks, target, options, result }); return result },
        start: (target, options) => {
          starts.push({ target: copy(target), options })
          const guard = options?.beforeInput
          return movement.start(target, { ...options, beforeInput: frame => { mutateFrame?.({ f, hooks, frame, queuedFrames }); return guard?.(frame) } })
        },
        stop: reason => { movementStops.push(reason); return movement.stop(reason) }
      }
    },
    input: options => { input = createInput({ ...options, clock: () => elapsed, startGameReceivedAt: 0 }); return input },
    facade: options => {
      currentFacade = facadeFactory(hooks)({ ...options, now: () => elapsed, wallNow: Date.now, sleep: (ms, signal) => hooks.wait(ms, signal) })
      return currentFacade
    }
  }
  scenes.setHooks(hooks)
  f = scenes.scene(t)
  f.host.world.getBlock = (x, y, z) => overrides.get(`${x},${y},${z}`) ?? read(x, y, z)
  f.host.setPrediction = prediction => { f.shared.prediction = { ...copy(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date(Date.now()).toISOString() } }
  f.host.getState = () => ({ ...copy(f.raw), rawServerPosition: copy(f.raw.position), rawServerPositionUpdatedAt: f.raw.rawServerPositionUpdatedAt, rawSelectedSlot: f.raw.selectedSlot, ...(f.shared.prediction ? { position: copy(f.shared.prediction.position), predicted: copy(f.shared.prediction), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: f.shared.prediction.updatedAt } : {}) })
  // CONTROLLED in-memory server packets restore observed inventory names/counts.
  // Their stack IDs are test scaffolding; capture246 omitted actual raw stacks.
  f.runtime.applyPacket('item_registry', { itemstates: [{ runtime_id: 379, name: 'minecraft:rotten_flesh' }] })
  const slots = Array.from({ length: 36 }, () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }))
  slots[0] = { ...slots[0], network_id: 379, count: 1, has_stack_id: true, stack_id: 500 }
  f.runtime.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  f.raw.inventory = { known: true, items: copy(f.facadeOptions.crafting.snapshot().inventory) }; f.raw.heldItem = null
  f.shared.autoWanted = true; f.shared.userBehaviorsEnabled = true
  t.after(async () => { hooks.coordinator?.cancel('test_cleanup', 'CANCELLED'); await currentFacade?.drain(); movement?.stop(); input?.stop(false) })
  const target = f.actors.find(actor => actor.runtimeId === '8398')
  const context = () => ({ kind: 'combat', claimId: 'combat:surface', scope: f.scope(), target: copy(target) })
  const approach = async () => { const ctx = context(); hooks.approachContext = ctx; ctx.token = await f.facadeOptions.acquireControl(ctx); assert.notEqual(ctx.token?.acquired, false); return { ctx, result: await f.facadeOptions.approach(copy(target), ctx) } }
  return { ...f, hooks, actualFacade: currentFacade, target, movement, input, overrides, queuedFrames, starts, previews, movementStops, approach, context, working: () => f.facadeOptions.getState(), elapsed: () => elapsed }
}

test('captured246 Native water arc reaches the actual low Spider body aim while bobbing and keeping the other canonical circles', () => {
  const world = { getBlock: read }, physics = prepared.withWorld(world), navigator = createNavigator({ world, physics, allowWater: true })
  const initial = physics.fromServer(capture.state), target = capture.target, actualAim = aim(target)
  assert.ok(distance(capture.state.position, actualAim) > 2.8 && distance(capture.state.position, actualAim) < 4)
  const d = Math.hypot(initial.position.x - target.position.x, initial.position.z - target.position.z)
  const goal = { x: target.position.x + (initial.position.x - target.position.x) / d * 2.2, y: 63, z: target.position.z + (initial.position.z - target.position.z) / d * 2.2 }
  const circles = capture.proof.otherCanonicalCircles ?? capture.proof.circles
  const route = navigator.plan(initial, goal, { directSurface: true, exactGoal: true, maxDistance: 6, maxExpanded: 300, avoidance: circles })
  assert.equal(route.ready, true, route.reason)
  const stepper = navigator.createStepper(route, initial, { maxTicks: 80, sprint: false }); let firstReach = null, frame, count = 0, sawAirBob = false
  let previous = copy(capture.state.position)
  do { frame = stepper.next(); count++; if (distance(frame.packetPosition, actualAim) <= 2.8 && firstReach === null) firstReach = count; sawAirBob ||= frame.predictedState.isInWater === false; for (const circle of circles) assert.ok(segmentDistance(circle.position, previous, frame.packetPosition) >= circle.minDistance - 1e-4, circle.id); previous = frame.packetPosition } while (frame.phase === 'moving' && count < 80)
  assert.equal(count, 28); assert.equal(firstReach, 11); assert.equal(sawAirBob, true)
  assert.equal(frame.phase, 'awaiting_server_confirmation', frame.reason); assert.ok(distance(frame.packetPosition, actualAim) <= 2.8); assert.equal(frame.serverConfirmed, false)
})

test('actual Runtime owns the same-surface approach and hands back only when a real queued eye reaches Spider+.2', async t => {
  const f = fixture(t), raw = copy(f.raw), { result } = await f.approach()
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.notEqual(result.serverConfirmed, true)
  const water = f.starts.filter(start => start.options.allowWater)
  assert.equal(water.length, 1)
  assert.equal(water[0].options.directSurface, true); assert.equal(water[0].options.exactGoal, true); assert.equal(water[0].options.sprint, false)
  assert.equal(water[0].options.maxDistance, 6); assert.equal(water[0].options.maxExpanded, 300); assert.equal(water[0].options.maxTicks, 80)
  assert.ok(f.queuedFrames.filter(frame => frame.modeled).length >= 11)
  const last = f.queuedFrames.filter(frame => frame.modeled).at(-1)
  assert.ok(distance(last.packetPosition, aim(f.target)) <= 2.8, 'Actual queued native eye, not nominal surface goal, establishes current reach')
  assert.equal(f.hooks.melee.preview('8398').code, 'BUSY', 'A direct Root fixture lease does not forge the separate Facade combat lease; the next test verifies the fully coupled handoff')
  assert.equal(f.wire.filter(packet => packet.name === 'inventory_transaction').length, 0)
  assert.deepEqual(f.raw, raw)
})

test('real Facade and Coordinator approach the bound water Spider then use real Runtime float input for one ordinary melee request without hit credit', async t => {
  const f = fixture(t)
  assert.equal(f.hooks.melee.preview('8398').ready, false)
  await f.actualFacade.tick(); await f.actualFacade.drain()
  assert.equal(f.hooks.meleeCalls.length, 1)
  assert.equal(f.hooks.meleeCalls[0].id, '8398')
  assert.equal(f.hooks.meleeCalls[0].preview.ready, true)
  const melee = f.hooks.meleeResults[0]
  assert.equal(melee.hitsRequested, 1)
  assert.equal(melee.serverConfirmed, false); assert.equal(melee.targetDead, false)
  assert.equal(melee.attempts[0].criticalAttempt, false); assert.equal(melee.attempts[0].hitConfirmed, false)
  const attacks = f.wire.filter(packet => packet.name === 'inventory_transaction' && packet.p.transaction?.transaction_data?.action_type === 'attack')
  assert.equal(attacks.length, 1)
  assert.equal(String(attacks[0].p.transaction.transaction_data.entity_runtime_id), '8398')
  const float = f.wire.filter(packet => packet.name === 'player_auth_input' && packet.p.move_vector?.x === 0 && packet.p.move_vector?.z === 0 && packet.p.input_data.includes('want_up'))
  assert.ok(float.length, 'The actual generationInput→neutralFrame provider preserves Native float intent through ordinary melee handoff')
  assert.equal(f.hooks.coordinator.snapshot().lastResult.targetDead, false)
})

test('known same-surface geometry admits an air-bob seed without relying on isInWater=true', async t => {
  const f = fixture(t, { bob: true })
  assert.equal(f.working().predicted.physicsState.isInWater, false)
  const { result } = await f.approach()
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.ok(f.starts.some(start => start.options.directSurface === true))
})

async function assertDenied (f) {
  let value, error
  try { value = (await f.approach()).result } catch (caught) { error = caught }
  assert.ok(error || value?.accepted !== true, JSON.stringify(value))
  assert.equal(f.queuedFrames.filter(frame => frame.modeled).length, 0)
  assert.equal(f.wire.filter(packet => packet.name === 'inventory_transaction').length, 0)
}

test('scope, life, UID, entity and canonical policy changes after preview cannot queue the old surface route', async t => {
  for (const mode of ['scope', 'life', 'uid', 'entity', 'unknown_target', 'policy']) await t.test(mode, async t => {
    let changed = false
    const f = fixture(t, { mutatePreview: ({ f, options, result }) => {
      if (changed || options.allowWater !== true || !result.ready) return
      changed = true
      const target = f.actors.find(actor => actor.runtimeId === '8398')
      if (mode === 'scope') f.raw.connectionId = 'changed-session'
      if (mode === 'life') f.shared.deathRespawn.deathId++
      if (mode === 'uid') target.uniqueId = '-changed'
      if (mode === 'entity') target.entityType = 'minecraft:cave_spider'
      if (mode === 'unknown_target') target.positionKnown = false
      if (mode === 'policy') f.shared.autoWanted = false
    } })
    await assertDenied(f)
    assert.equal(changed, true, 'The initially valid actual Native preview must be exercised')
  })
})

test('unknown or solid headroom, lava and an untrusted current pose cannot gain surface movement permission', async t => {
  for (const mode of ['unknown_head', 'solid_head', 'lava', 'stale_pose', 'shadow_prediction', 'inventory_confidence']) await t.test(mode, async t => {
    const f = fixture(t, { mutatePreview: ({ f, options, result }) => {
      // Acquisition may now queue genuine neutral physics. Inject stale data
      // after that receipt, at the actual ready Native preview boundary.
      if (mode === 'stale_pose' && options.allowWater === true && result.ready) f.shared.prediction.updatedAt = new Date(Date.now() - 201).toISOString()
    } })
    const position = { x: 11, y: 64, z: 54 }
    if (mode === 'unknown_head') f.overrides.set('11,64,54', { known: false, position })
    if (mode === 'solid_head') f.overrides.set('11,64,54', { known: true, position, name: 'minecraft:stone', boundingBox: 'block', properties: {}, extra: [] })
    if (mode === 'lava') f.overrides.set('11,62,54', { known: true, position: { x: 11, y: 62, z: 54 }, name: 'minecraft:lava', boundingBox: 'empty', properties: { liquid_depth: 0 }, extra: [] })
    if (mode === 'shadow_prediction') {
      const current = f.host.getState
      f.host.getState = () => { const value = current(); value.predicted.position.x += 0.01; return value }
    }
    if (mode === 'inventory_confidence') f.raw.inventoryConfidence = { known: false }
    await assertDenied(f)
  })
})

test('a fresh known player crossing only the next swept segment is rejected before that input is queued', async t => {
  let injected = false, rejectedSegment = null
  const f = fixture(t, { mutateFrame: ({ f, frame, queuedFrames }) => {
    if (injected || queuedFrames.filter(value => value.modeled).length !== 6) return
    const from = f.facadeOptions.getState().position, to = frame.packetPosition, dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz)
    assert.ok(length > 0.07)
    const radius = 3, offset = radius - 0.0002
    const point = { x: (from.x + to.x) / 2 - dz / length * offset, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 + dx / length * offset }
    assert.ok(distance(point, from) > radius && distance(point, to) > radius)
    assert.ok(segmentDistance(point, from, to) < radius - 1e-4)
    f.actors.push({ runtimeId: '999999', uniqueId: '-999999', kind: 'player', entityType: 'minecraft:player', username: 'ControlledCoplayer', alive: true, positionKnown: true, dimension: 'overworld', position: point })
    injected = true; rejectedSegment = { from, to }
  } })
  await assert.rejects(f.approach())
  assert.equal(injected, true)
  assert.equal(f.queuedFrames.filter(frame => frame.modeled).length, 6)
  assert.ok(f.queuedFrames.every(frame => distance(frame.packetPosition, rejectedSegment.to) > 1e-5), 'Neither endpoint-only safety nor a stale actor list can authorize the swept segment')
  assert.equal(f.wire.filter(packet => packet.name === 'inventory_transaction').length, 0)
})

test('the water extension does not enable swimming for existing bed movement defaults', async t => {
  const f = fixture(t), context = { kind: 'bed', claimId: 'bed:controlled', scope: f.scope() }
  context.token = await f.facadeOptions.acquireControl(context)
  f.mockMovement.preview = (target, options) => { f.previews.push({ target, options, result: { ready: false } }); return { ready: false } }
  const result = await f.facadeOptions.moveBed({ target: { x: 11, y: 63, z: 54 } }, context)
  assert.equal(result.ready, false)
  assert.equal(f.previews.at(-1).options.allowWater, false)
  assert.equal(f.previews.at(-1).options.directSurface, undefined)
  assert.equal(f.queuedFrames.length, 0)
})

test('ordinary dry melee approach keeps its original dry movement options', async t => {
  const f = fixture(t)
  f.host.world.getBlock = (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', properties: {}, extra: [] })
  f.raw.position = { x: 0.5, y: 66.62, z: 0.5 }
  f.raw.positionSource = 'server_post_move'; f.raw.positionUpdatedAt = new Date(Date.now()).toISOString()
  f.raw.physicsState = { position: { x: 0.5, y: 65, z: 0.5 }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true, isInWater: false, isInLava: false }
  f.shared.prediction = null; f.target.position = { x: 3.8, y: 65, z: 0.5 }
  const { result } = await f.approach()
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].options.allowWater, false)
  assert.equal(f.starts[0].options.directSurface, undefined)
  assert.equal(f.starts[0].options.exactGoal, undefined)
  assert.equal(f.starts[0].options.maxTicks, undefined)
  assert.equal(f.wire.filter(packet => packet.name === 'inventory_transaction').length, 0)
})

test('old surface cleanup cannot stop or release a newer Root owner', async t => {
  let replacement = null, stopsAfterReplacement = null, exchanged = false
  const f = fixture(t, { onWait: async ({ f, hooks, ms }) => {
    if (exchanged || ms !== 50 || !hooks.approachContext) return
    exchanged = true
    assert.equal((await f.facadeOptions.resumeControl(hooks.approachContext)).resumed, true)
    replacement = { kind: 'bed', claimId: 'bed:new-owner', scope: f.scope() }
    replacement.token = await f.facadeOptions.acquireControl(replacement)
    assert.notEqual(replacement.token?.acquired, false)
    stopsAfterReplacement = hooks.movementStops.length
  } })
  await assert.rejects(f.approach())
  assert.equal(exchanged, true)
  assert.equal(f.movementStops.length, stopsAfterReplacement, 'The obsolete surface finally must not stop the replacement owner')
  assert.equal((await f.facadeOptions.resumeControl(replacement)).resumed, true)
  assert.equal(f.wire.filter(packet => packet.name === 'inventory_transaction').length, 0)
})
