'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { resourceMinHealth } = require('../src/learning-health')
const copy = value => structuredClone(value)

// Compact verbatim state/preview fields from the preserved 2026-11-01 05:51
// audit (SHA256 a3f031f23c11fd0d68a971f248e9777acbd4228a42655a4b3ccb5119eb3e4661).
// These are historical evidence, never a current server or inventory receipt.
const savedTool = { slot: 2, name: 'minecraft:stone_pickaxe', networkId: 316, count: 1, metadata: 0, stackId: 368, durabilityKnown: true, durabilityUsed: 59, maxDurability: 131, durabilityRemaining: 72, durabilitySource: 'server_item_nbt' }
const savedState = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, dimension: 'overworld', connectionId: '85a7e65e-8372-4363-830f-d55a60bdafe0', startedAt: '2026-10-31T23:43:20.653Z', runtimeEntityId: '273', lifecycle: { phase: 'alive', dead: false, deathId: 176 }, health: 20, dead: false, spawnPending: false, gameMode: 'survival', threatPolicy: 'online_learning', position: { x: -20.581046769626646, y: 52.62, z: 12.558470969514579 }, selectedSlot: 2, rawSelectedSlot: 2, heldItem: savedTool, inventory: { known: true, items: [savedTool] }, entities: [] }
const savedTarget = { x: -19, y: 49, z: 13 }
const savedPreview = { ready: true, targets: [{ position: savedTarget, name: 'minecraft:iron_ore', runtimeId: 2032622302, distance: 3.32, aim: { point: { x: -18.999, y: 49.98, z: 13.8 }, hit: { x: -19, y: 49.98166872437066, z: 13.79921523873104 }, face: 4, distance: 3.3166168228036645 } }], errors: [], movement: false }
const tunnelDecision = () => ({ type: 'tunnel', stage: 'iron', resource: 'iron', target: copy(savedTarget), resourceTarget: copy(savedTarget), block: 'minecraft:iron_ore', targetOre: { position: copy(savedTarget), name: 'minecraft:iron_ore' }, requiredToolTier: 2, requiresKnownDurability: true, requiresLivePreview: true, preparation: 'iron_kit' })

const runtimeFile = path.resolve(__dirname, '../src/runtime.js')
const runtimeSource = fs.readFileSync(runtimeFile, 'utf8').replace(/\r\n/g, '\n')
const helperStart = runtimeSource.indexOf('function normalizeReachableTunnel (')
const helperEnd = runtimeSource.indexOf('\nfunction baseSafetyError (', helperStart)
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'The Runtime private normalizer must be present')
const normalize = new Function('resourceMinHealth', runtimeSource.slice(helperStart, helperEnd) + '\nreturn normalizeReachableTunnel')(resourceMinHealth)

// Actual Runtime factory and planAction; only planner/service dependencies are
// injected through the existing runtime-survival test fixture's module loader.
const fixtureFile = path.resolve(__dirname, 'runtime-survival.test.js')
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
fixtureSource = 'let testHooks;\n' + fixtureSource
fixtureSource = fixtureSource.replace('  const overrides = {', `  const overrides = {
    './diamond-planner': { nextDiamondAction: (...args) => testHooks.diamond(...args) },
    './survival-planner': { nextSurvivalAction: (...args) => testHooks.survival(...args) },`)
const miningNeedle = 'const mining = { preview: () => ({ ready: true, targets: [] }),'
assert.ok(fixtureSource.includes(miningNeedle))
fixtureSource = fixtureSource.replace(miningNeedle, 'const mining = { preview: targets => { testHooks.previewCalls.push(structuredClone(targets)); return testHooks.preview(targets) },')
fixtureSource += '\nmodule.exports = { fixture, setHooks: value => { testHooks = value } }'
const fixtureModule = { exports: {} }
new vm.Script(Module.wrap(fixtureSource), { filename: fixtureFile }).runInThisContext()(fixtureModule.exports, Module.createRequire(fixtureFile), fixtureModule, fixtureFile, path.dirname(fixtureFile))
function fixture (t) {
  const hooks = { diamond: tunnelDecision, survival: () => null, preview: () => copy(savedPreview), previewCalls: [] }
  fixtureModule.exports.setHooks(hooks)
  const f = fixtureModule.exports.fixture(t)
  Object.assign(f.raw, copy(savedState))
  f.host.shared.deathRespawn = { deathId: 176 }
  const getBlock = f.host.world.getBlock.bind(f.host.world)
  // A saved ready Mining preview does not make an unknown current cache cell
  // known. This handoff fixture separately supplies the matching received ore.
  f.host.world.getBlock = (x, y, z) => x === savedTarget.x && y === savedTarget.y && z === savedTarget.z
    ? { known: true, name: 'minecraft:iron_ore', runtimeId: 2032622302, position: { x, y, z }, boundingBox: 'block', properties: {}, extra: [], natural: true }
    : getBlock(x, y, z)
  const config = f.autonomous[0]
  const incoming = () => ({ ...config.getState(), inventory: copy(savedState.inventory), heldItem: copy(savedTool), lifecycle: { phase: 'alive', dead: false, deathId: 176 } })
  hooks.previewCalls.length = 0
  return { ...f, hooks, config, incoming }
}

test('saved reachable iron tunnel becomes ordinary mine_ore without fabricating tool, inventory or mining credit', () => {
  const state = copy(savedState), decision = tunnelDecision(), before = copy(state), requested = []
  const result = normalize(state, decision, targets => { requested.push(copy(targets)); return copy(savedPreview) })
  assert.equal(result.type, 'mine_ore')
  assert.equal(result.block, 'minecraft:iron_ore')
  assert.deepEqual(result.target, savedTarget)
  assert.deepEqual(result.resourceTarget, savedTarget)
  assert.equal(result.requiredToolTier, 2)
  assert.equal(result.requiresKnownDurability, true)
  assert.equal(result.requiresLivePreview, true)
  assert.equal(result.preparation, decision.preparation)
  assert.deepEqual(requested, [[savedTarget]])
  assert.deepEqual(state, before)
  assert.equal(result.serverConfirmed, undefined)
  assert.equal(result.collected, undefined)
})

test('unready, different, ambiguous or throwing mining previews retain the original tunnel', () => {
  const changes = [
    preview => { preview.ready = false },
    preview => { preview.targets[0].position.x++ },
    preview => { preview.targets[0].name = 'minecraft:coal_ore' },
    preview => { preview.targets = [] },
    preview => { preview.targets.push(copy(preview.targets[0])) }
  ]
  for (const change of changes) {
    const decision = tunnelDecision(), preview = copy(savedPreview); change(preview)
    assert.equal(normalize(copy(savedState), decision, () => preview), decision)
  }
  const decision = tunnelDecision()
  assert.equal(normalize(copy(savedState), decision, () => { throw new Error('Current mining proof unavailable') }), decision)
  for (const change of [decision => { decision.resource = 'coal' }, decision => { decision.block = 'minecraft:deepslate_iron_ore' }, decision => { delete decision.block; decision.targetOre.name = 'minecraft:coal_ore' }, decision => { decision.target.x += 0.1 }, decision => { decision.resourceTarget.z++ }, decision => { decision.targetOre.position.y++ }]) {
    const decision = tunnelDecision(); change(decision)
    assert.equal(normalize(copy(savedState), decision, () => copy(savedPreview)), decision)
  }
})

test('unknown NBT wear, wrong actual tool, inventory or living scope deny conversion before preview', () => {
  const changes = [
    state => { state.inventory.items[0].durabilityKnown = false },
    state => { delete state.inventory.items[0].durabilityUsed; state.inventory.items[0].metadata = 0 },
    state => { delete state.inventory.items[0].maxDurability },
    state => { state.inventory.items[0].durabilityUsed = 131 },
    state => { state.inventory.items[0].name = 'minecraft:wooden_pickaxe'; state.heldItem.name = 'minecraft:wooden_pickaxe' },
    state => { state.heldItem = null },
    state => { state.equipmentServerConfirmed = false },
    state => { state.inventory.uncertain = true },
    state => { state.inventory.known = false },
    state => { state.dead = true },
    state => { state.health = 0 },
    state => { state.spawnPending = true },
    state => { delete state.connectionId },
    state => { delete state.lifecycle.deathId }
  ]
  for (const change of changes) {
    const state = copy(savedState), decision = tunnelDecision(); change(state)
    assert.equal(normalize(state, decision, () => assert.fail('A denied tool/inventory/life must not request mining preview')), decision)
  }
})

test('ordinary survival decisions remain identical and never request the tunnel mining preview', () => {
  for (const type of ['craft', 'eat', 'wait', 'build_shelter', 'equip', 'forage']) {
    const decision = { type, stage: 'survival', reason: 'Existing prerequisite' }
    assert.equal(normalize(copy(savedState), decision, () => assert.fail('Survival decisions must not be previewed by tunnel normalization')), decision)
  }
})

test('actual Runtime planAction normalizes only the chosen decision after Survival priority and checks the incoming life', t => {
  const f = fixture(t), state = f.incoming()
  for (const type of ['craft', 'eat', 'wait']) {
    const priority = { type, stage: 'survival', reason: 'Survival has priority' }
    f.hooks.survival = () => priority
    f.hooks.previewCalls.length = 0
    assert.equal(f.config.planAction(state, {}, { objective: 'diamond' }), priority)
    assert.equal(f.hooks.previewCalls.length, 0, 'The unchosen Diamond tunnel must not be normalized before Survival selects a prerequisite')
  }
  f.hooks.survival = () => null
  f.hooks.previewCalls.length = 0
  const converted = f.config.planAction(state, {}, { objective: 'diamond' })
  assert.equal(converted.type, 'mine_ore')
  assert.equal(converted.resource, 'iron')
  assert.equal(converted.block, 'minecraft:iron_ore')
  assert.deepEqual(f.hooks.previewCalls, [[savedTarget]])
  const survivorTunnel = { ...tunnelDecision(), preparation: 'survival_iron_kit' }
  f.hooks.survival = () => survivorTunnel
  f.hooks.previewCalls.length = 0
  assert.equal(f.config.planAction(state, {}, {}).preparation, 'survival_iron_kit')
  assert.equal(f.hooks.previewCalls.length, 1, 'The selected Survival tunnel also reaches the same normalizer')
  for (const change of [value => { value.connectionId = 'different-session' }, value => { value.lifecycle.deathId++ }]) {
    const stale = copy(state); change(stale)
    f.hooks.previewCalls.length = 0
    assert.equal(f.config.planAction(stale, {}, {}), survivorTunnel)
    assert.equal(f.hooks.previewCalls.length, 0)
  }
  assert.equal(f.events.includes('mine'), false)
  assert.equal(f.events.includes('move'), false)
})
