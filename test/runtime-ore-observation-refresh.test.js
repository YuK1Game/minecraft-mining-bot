'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const copy = value => structuredClone(value)
const key = point => `${point.x},${point.y},${point.z}`
const target = { x: 3, y: 49, z: 3 }
const standardScan = { minY: -64, maxY: 80, chunkRadius: 1, maxResults: 64 }
const tool = { name: 'minecraft:iron_pickaxe', slot: 0, count: 1, networkId: 999, stackId: 42, durabilityKnown: true, durabilityUsed: 0, maxDurability: 250, durabilityRemaining: 250, durabilitySource: 'CONTROLLED_SERVER_ITEM_FIXTURE' }
const decision = (resource = 'iron') => ({ type: 'tunnel', stage: resource, resource, target: copy(target), resourceTarget: copy(target), block: `minecraft:${resource}_ore`, targetOre: { name: `minecraft:${resource}_ore`, position: copy(target) }, requiredToolTier: { coal: 1, iron: 2, diamond: 3 }[resource], requiresKnownDurability: true, requiresLivePreview: true, goal: { diamond: 1 }, counts: { ironIngots: 0 }, preparation: 'controlled_existing_choice' })

const runtimeFile = path.resolve(__dirname, '../src/runtime.js')
const runtimeSource = fs.readFileSync(runtimeFile, 'utf8').replace(/\r\n/g, '\n')
const helperStart = runtimeSource.indexOf('function normalizeUnobservedTunnel (')
const helperEnd = runtimeSource.indexOf('\nfunction ', helperStart + 1)
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'The private ore-observation normalizer must exist')
const normalize = new Function(runtimeSource.slice(helperStart, helperEnd) + '\nreturn normalizeUnobservedTunnel')()

// Load the real Runtime factory with the repository's service DI fixture.
// Planner choices and server observations are controlled; the actual Runtime,
// DiamondActions and Prospecting implementations run unchanged.
const fixtureFile = path.join(__dirname, 'runtime-survival.test.js')
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
fixtureSource = 'let hooks;\n' + fixtureSource
fixtureSource = fixtureSource.replace('  const overrides = {', `  const overrides = {
    './diamond-planner': { nextDiamondAction: (...args) => hooks.diamond(...args) },
    './survival-planner': { nextSurvivalAction: (...args) => hooks.survival(...args) },`)
const miningNeedle = 'const mining = { preview: () => ({ ready: true, targets: [] }),'
assert.ok(fixtureSource.includes(miningNeedle))
fixtureSource = fixtureSource.replace(miningNeedle, 'const mining = { preview: targets => { hooks.miningPreviews.push(structuredClone(targets)); return hooks.miningPreview(targets) },')
const runnerNeedle = "request: () => { throw new Error('Unexpected HTTP request') }, refreshState: async () => host.getState(), getState: host.getState,"
assert.ok(fixtureSource.includes(runnerNeedle))
fixtureSource = fixtureSource.replace(runnerNeedle, 'request: (...args) => hooks.request(...args), refreshState: async options => hooks.refreshState ? hooks.refreshState(options) : host.getState(), getState: host.getState,')
fixtureSource += '\nmodule.exports = { fixture, setHooks: value => { hooks = value } }'
const fixtureModule = { exports: {} }
new vm.Script(Module.wrap(fixtureSource), { filename: fixtureFile }).runInThisContext()(fixtureModule.exports, Module.createRequire(fixtureFile), fixtureModule, fixtureFile, path.dirname(fixtureFile))

function fixture (t) {
  const hooks = { diamond: decision, survival: () => null, miningPreviews: [], miningPreview: () => ({ ready: false, targets: [], errors: ['Controlled not-yet-accessible face'] }), request: () => assert.fail('No dispatch during planAction') }
  // The planner receives options as its third argument, not a resource string.
  hooks.diamond = () => decision()
  fixtureModule.exports.setHooks(hooks)
  const f = fixtureModule.exports.fixture(t), changes = new Map(), packets = [], dispatches = []
  f.host.shared.deathRespawn = { deathId: 390 }
  Object.assign(f.raw, { lifecycle: { phase: 'alive', dead: false, deathId: 390 }, inventory: { known: true, items: [copy(tool)] }, heldItem: copy(tool), rawSelectedSlot: 0, rawServerSelectedSlot: 0 })
  f.host.world.getBlock = (x, y, z) => changes.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', runtimeId: 1, properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }
  changes.set(key(target), { known: false, position: copy(target), reason: 'subchunk_not_received' })
  const config = f.autonomous[0]
  const incoming = () => ({ ...config.getState(), inventory: { known: true, items: [copy(tool)] }, heldItem: copy(tool), selectedSlot: 0, rawSelectedSlot: 0, rawServerSelectedSlot: 0, lifecycle: { phase: 'alive', dead: false, deathId: f.host.shared.deathRespawn.deathId } })
  hooks.refreshState = async () => ({ ...f.host.getState(), entities: copy(f.actors), hostiles: copy(f.actors.filter(actor => actor.hostile)), entityStats: { unknownPositions: 0 }, prospecting: f.runtime.operations.prospecting.snapshot() })
  hooks.request = async (method, endpoint, body) => {
    assert.equal(method, 'POST'); assert.equal(endpoint, '/action')
    assert.equal(body.group, 'prospecting', 'The refresh must reuse the existing prospect action')
    assert.ok(['start', 'stop'].includes(body.method))
    dispatches.push(copy(body))
    return f.runtime.operations.prospecting[body.method](...body.args)
  }
  f.host.client.queue = (name, params) => { packets.push({ name, params: copy(params) }); assert.equal(name, 'subchunk_request', 'No movement, mining or inventory action is permitted') }
  return { ...f, hooks, config, incoming, changes, packets, dispatches }
}

test('only an already chosen matching ore tunnel can become a standard unfocused prospect decision', () => {
  for (const resource of ['coal', 'iron', 'diamond']) {
    for (const observed of [{ known: false }, { known: true, name: 'minecraft:air' }, { known: true, name: 'minecraft:coal_ore' }]) {
      const chosen = decision(resource), result = normalize(chosen, () => observed)
      if (observed.known && observed.name === chosen.block) { assert.equal(result, chosen); continue }
      assert.equal(result.type, 'prospect')
      assert.equal(result.resource, resource)
      assert.deepEqual(result.scanOptions, standardScan)
      assert.equal(result.rejectUnknown, true)
      assert.equal(result.target, undefined)
      assert.equal(result.resourceTarget, undefined)
      assert.equal(result.targetOre, undefined)
      assert.equal(result.scanOptions.center, undefined)
      assert.deepEqual(result.goal, chosen.goal)
      assert.equal(result.requiredToolTier, chosen.requiredToolTier)
    }
  }
})

test('known, protected, unnatural, stone, survival and inconsistent identities keep their existing decisions', () => {
  const unchanged = [
    [decision(), { known: true, name: 'minecraft:iron_ore' }],
    [decision(), { known: true, name: 'minecraft:iron_ore', protected: true }],
    [decision(), { known: true, name: 'minecraft:iron_ore', natural: false }],
    [decision(), { known: true, name: 'minecraft:air', protected: true }],
    [decision(), { known: true, name: 'minecraft:air', natural: false }],
    [{ ...decision(), type: 'eat' }, { known: false }],
    [{ ...decision(), resource: 'stone', block: 'minecraft:stone' }, { known: false }],
    [{ ...decision(), resourceTarget: { ...target, x: target.x + 1 } }, { known: false }],
    [{ ...decision(), targetOre: { name: 'minecraft:iron_ore', position: { ...target, z: target.z + 1 } } }, { known: false }]
  ]
  for (const [chosen, block] of unchanged) assert.equal(normalize(chosen, () => block), chosen)
})

test('actual Runtime converts only the selected stale tunnel after Survival priority without sending packets', t => {
  const f = fixture(t), state = f.incoming()
  const priority = { type: 'craft', stage: 'survival', reason: 'Existing prerequisite' }
  f.hooks.survival = () => priority
  assert.equal(f.config.planAction(state, {}, { objective: 'diamond' }), priority)
  assert.equal(f.hooks.miningPreviews.length, 0)
  f.hooks.survival = () => null
  const result = f.config.planAction(state, {}, { objective: 'diamond' })
  assert.equal(result.type, 'prospect')
  assert.deepEqual(result.scanOptions, standardScan)
  assert.equal(f.packets.length, 0)
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.events.includes('mine'), false)
  assert.equal(f.events.includes('move'), false)
})

test('Runtime prospect dispatch runs real DiamondActions and Prospecting requests, then reuses received ore normally', async t => {
  const f = fixture(t), chosen = f.config.planAction(f.incoming(), {}, { objective: 'diamond' })
  assert.equal(chosen.type, 'prospect')
  let receipt = false
  f.host.client.queue = (name, params) => {
    assert.equal(name, 'subchunk_request')
    f.packets.push({ name, params: copy(params) })
    assert.equal(params.dimension, 0)
    assert.deepEqual(params.origin, { x: 0, y: 0, z: 0 }, 'Existing scan remains centered on the actual player chunk')
    assert.ok(params.requests.length <= 18)
    if (params.requests.some(section => section.x === 0 && section.z === 0 && section.y === Math.floor(target.y / 16))) {
      receipt = true
      // Explicit controlled received server block data, never a planning-air
      // projection or a claimed Realm receipt.
      f.changes.set(key(target), { known: true, position: copy(target), name: 'minecraft:iron_ore', runtimeId: 2, properties: {}, boundingBox: 'block', extra: [], source: 'CONTROLLED_RECEIVED_SUBCHUNK' })
    }
  }
  const result = await f.config.actions.prospect(chosen, { signal: new AbortController().signal })
  assert.equal(receipt, true)
  assert.equal(f.packets.length, 5)
  assert.ok(f.packets.every(packet => packet.name === 'subchunk_request'))
  assert.equal(f.packets.reduce((sum, packet) => sum + packet.params.requests.length, 0), 90)
  assert.ok(f.packets.every(packet => packet.params.requests.every(section => Math.abs(section.x) <= 1 && Math.abs(section.z) <= 1 && section.y >= -4 && section.y <= 5)))
  assert.equal(result.collected, false)
  assert.equal(result.ores.iron.some(ore => key(ore.position) === key(target)), true)
  assert.deepEqual(f.dispatches[0].args, [standardScan])
  const stillNeedsTunnel = f.config.planAction(f.incoming(), {}, { objective: 'diamond' })
  assert.equal(stillNeedsTunnel.type, 'tunnel')
  f.hooks.miningPreview = targets => ({ ready: true, targets: [{ position: copy(targets[0]), name: 'minecraft:iron_ore' }], errors: [] })
  const direct = f.config.planAction(f.incoming(), {}, { objective: 'diamond' })
  assert.equal(direct.type, 'mine_ore')
  assert.equal(direct.block, 'minecraft:iron_ore')
  assert.equal(f.events.includes('mine'), false, 'Observation and normal planning earn no mining or item credit')
})

test('mismatched incoming scope or life cannot normalize into or dispatch a new prospect action', t => {
  const f = fixture(t), selected = decision()
  f.hooks.diamond = () => selected
  for (const mutate of [state => { state.connectionId = 'other-cid' }, state => { state.lifecycle.deathId++ }, state => { state.runtimeEntityId = 'other-self' }, state => { state.dimension = 'nether' }]) {
    const state = f.incoming(); mutate(state)
    assert.equal(f.config.planAction(state, {}, { objective: 'diamond' }), selected)
  }
  assert.equal(f.packets.length, 0)
  assert.equal(f.dispatches.length, 0)
})

test('a disposed generation cannot convert its cached tunnel or dispatch terrain requests', async t => {
  const f = fixture(t), state = f.incoming(), selected = decision()
  f.hooks.diamond = () => selected
  await f.runtime.dispose('Controlled generation ended')
  assert.equal(f.config.planAction(state, {}, { objective: 'diamond' }), selected)
  assert.equal(f.packets.length, 0)
  assert.equal(f.dispatches.length, 0)
})
