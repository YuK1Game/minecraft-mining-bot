'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { setImmediate: turn } = require('node:timers/promises')
const { createMovement } = require('../src/movement')
const { createPhysics } = require('../src/physics')
const { supplyScope } = require('../src/supply-return')
const portable = require('../src/portable-worksite')
const { evaluateThreats } = require('../src/threats')
const { resourceMinHealth } = require('../src/learning-health')
const copy = v => structuredClone(v)
function deferred () { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function harness (t) {
  let clock = 0, claimed = false, latestOptions = null, lastFrame = null, queued = 0, drained = 0, motionSeed = null
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'portable-policy', startedAt: '2026-11-01T00:00:00Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 1 }, threatPolicy: 'online_learning', health: 20, gameMode: 'survival', inventory: { known: true, items: [] }, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 'seed', rotation: { yaw: -90, pitch: 0 } }
  state.rawServerPosition = copy(state.position); state.rawServerPositionUpdatedAt = 'raw-seed'
  const actors = [{ runtimeId: '8', uniqueId: '-8', kind: 'mob', entityType: 'minecraft:zombie', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: 8, y: 65, z: 0.5 } }]
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', properties: {}, extra: [] }) }
  const physics = createPhysics({ world }), floors = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }], host = { shared: { deathRespawn: { deathId: 1 }, portableWorksiteMemo: { site: { id: 'site' } } }, entities: { snapshot: () => copy(actors), stats: () => ({ unknownPositions: 0 }) } }
  const real = createMovement({ client: { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); queued++; return { tick: packet.tick } } }, world, physics, getState: () => motionSeed ? { ...copy(state), position: copy(motionSeed.position), positionSource: motionSeed.positionSource, positionUpdatedAt: motionSeed.positionUpdatedAt, predicted: copy(motionSeed.predicted) } : copy(state), version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => clock, onPrediction: prediction => { state.position = copy(prediction.position); state.positionSource = 'client_prediction'; state.predicted = copy(prediction); state.positionUpdatedAt = 'queued-' + queued } })
  let drainGate = null
  const movement = { ...real, start: (target, options) => {
    latestOptions = options; motionSeed = copy(state)
    return real.start(target, { ...options, ...(options.beforeInput ? { beforeInput: frame => { lastFrame = copy(frame); return options.beforeInput(frame) } } : {}) })
  }, drain: async () => { drained++; if (drainGate) await drainGate.promise } }
  t.after(() => real.stop('fixture cleanup'))
  const source = fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js'), 'utf8'), begin = source.indexOf('  function portablePolicyError ('), end = source.indexOf('  function portableState ()', begin)
  const motionStart = source.indexOf('  function startMotion ('), motionEnd = source.indexOf('\n  const operations = {', motionStart)
  const previewLine = source.split('\n').find(line => line.includes('preview: (target, options) => {') && line.includes('portableMovementOptions') && line.includes('movement?.preview'))
  const ownedLine = source.split('\n').find(line => line.includes('const ownedMovement = {') && line.includes('tagPortableOwnedMove'))
  const requestStart = source.indexOf('      const lease = portableMovementLease\n      if (lease && method'), requestEnd = source.indexOf("      return pathname === '/equipment/select'", requestStart)
  assert.ok(begin >= 0 && end > begin && previewLine && ownedLine && requestStart >= 0)
  const bindings = { host, working: () => copy(state), userBehaviorOwns: () => claimed, resourceMinHealth, supplyScope, evaluateThreats, nextPortableStep: () => ({ type: 'move_to', target: { x: 1.5, y: 65, z: 0.5 } }), portableFallbackStop: portable.portableFallbackStop, readCurrentTunnelFloors: () => floors, idlePhysics: physics, planningWorld: world, portableGuard: () => copy(state), movement, generationMovement: movement, excavation: { stop: async () => {} }, interactions: { cancel: () => {} }, requireIdle: () => {}, crafting: { closeContainer: () => {} }, stopIdleStream: () => {}, rememberNavigationDestination: () => {} }
  const init = `let portableMovementLease=null,portableMovementOwner=null,portableMovementSerial=0,portableFallbackProposal=null;const disposed=false,disposing=false,recoveryMotionDepth=0,userBehaviorLease=null,ownedCall=0,inputOwner='none',inputStream=null,inputHistory=null,walker=null;let idlePhysicsState=null,motionOrigin=null;const own=f=>f;`
  const api = Function(...Object.keys(bindings), init + source.slice(begin, end) + source.slice(motionStart, motionEnd) + `\nconst operations={movement:{${previewLine.trim()}}};${ownedLine}\nfunction request(method,pathname,body){${source.slice(requestStart, requestEnd)};return {method,pathname,body}};return {run:withPortableMovementLease,preview:operations.movement.preview,startMotion,ownedMovement,request,options:portableMovementOptions,setFallback:t=>portableFallbackProposal={scope:supplyScope(working()),target:t},lease:()=>portableMovementLease}`)(...Object.values(bindings))
  return { api, state, actors, host, floors, real, movement, queue: () => queued, drained: () => drained, tick: ms => { clock += ms; t.mock.timers.tick(ms) }, options: () => latestOptions, frame: () => lastFrame, claim: value => { claimed = value }, delayDrain: gate => { drainGate = gate } }
}
test('actual owned Excavation hook applies fresh full circles at preview/start and real Movement packetPosition frames queue successfully', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = harness(t), gate = deferred()
  const decision = { portableSiteId: 'site', target: { x: 1, y: 65, z: 0 } }, goal = { x: 1.5, y: 65, z: 0.5 }
  const run = f.api.run(decision, {}, 'excavate', async () => {
    const preview = f.api.ownedMovement.preview(goal, { avoidance: [{ id: '8', position: { x: 999, y: 0, z: 0 }, minDistance: 6, padding: 0.5 }] })
    assert.equal(preview.ready, true); assert.equal(preview.avoidance[0].minDistance, 6); assert.equal(preview.avoidance[0].position.x, 8)
    f.api.ownedMovement.start(goal, {}); await gate.promise
  })
  assert.equal(f.queue(), 1); assert.ok(f.frame().packetPosition); assert.equal(f.frame().position, undefined)
  f.tick(50); assert.ok(f.queue() >= 2, JSON.stringify(f.real.snapshot()))
  const oldGuard = f.options().beforeInput, frame = f.frame(); gate.resolve(); await run
  assert.equal(f.drained(), 1); assert.equal(f.api.lease(), null)
  assert.throws(() => oldGuard(frame), /PORTABLE_REOBSERVE/)
  assert.equal(f.real.snapshot().running, false)
})
test('fresh actor movement, unknown identity and changed life block the next actual input before queue', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const mode of ['crossing', 'uid', 'life']) {
    const f = harness(t), gate = deferred(), decision = { portableSiteId: 'site', target: { x: 1, y: 65, z: 0 } }
    const run = f.api.run(decision, {}, 'excavate', async () => { f.api.ownedMovement.start({ x: 1.5, y: 65, z: 0.5 }, {}); await gate.promise })
    const sent = f.queue()
    if (mode === 'crossing') f.actors[0].position.x = 2
    if (mode === 'uid') f.actors[0].uniqueId = null
    if (mode === 'life') f.host.shared.deathRespawn.deathId++
    f.tick(50); assert.equal(f.queue(), sent, mode); assert.equal(f.real.snapshot().phase, 'failed', mode); assert.match(f.real.snapshot().reason, /PORTABLE_REOBSERVE/, mode)
    gate.resolve(); await run
  }
})
test('explicit portable RPC carries only scalar lease ID; stale target/ID and settle reject without changing Runner budgets', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = harness(t), target = { x: 1.5, y: 65, z: 0.5 }; let tagged
  await f.api.run({ portableSiteId: 'site', target }, {}, 'move', async () => {
    tagged = f.api.request('POST', '/move/preview', { target, options: {} }).body.options
    assert.equal(typeof tagged._portableMovementLease, 'string'); assert.ok(!JSON.stringify(tagged).includes('beforeInput'))
    assert.equal(f.api.preview(target, tagged).ready, true)
    assert.throws(() => f.api.startMotion('navigation', { ...target, x: 2.5 }, tagged), /unexpected/)
    assert.throws(() => f.api.request('POST', '/action', { group: 'movement', method: 'settle', args: [{}] }), /PORTABLE_REOBSERVE/)
  })
  assert.throws(() => f.api.preview(target, tagged), /stale lease/); assert.equal(f.queue(), 0)
  delete f.host.shared.portableWorksiteMemo
  f.api.setFallback(target); f.floors[1] = { x: 2, y: 64, z: 0 }
  await assert.rejects(f.api.run({ target }, {}, 'move', async () => assert.fail('changed fallback must not run')), /preserved fallback/)
})
test('token is held through matching drain and old cleanup cannot stop a later safety/user movement owner', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = harness(t), gate = deferred(), drain = deferred()
  f.delayDrain(drain)
  const run = f.api.run({ portableSiteId: 'site', target: { x: 1, y: 65, z: 0 } }, {}, 'excavate', async () => { f.api.ownedMovement.start({ x: 1.5, y: 65, z: 0.5 }, {}); await gate.promise })
  gate.resolve(); await turn(); assert.ok(f.api.lease()); assert.equal(f.drained(), 1)
  f.claim(true); f.api.startMotion('navigation', { x: -1.5, y: 65, z: 0.5 }, {})
  const before = f.queue(); drain.resolve(); await run; f.tick(100)
  assert.ok(f.queue() > before, JSON.stringify(f.real.snapshot())); assert.equal(f.real.snapshot().running, true)
})
