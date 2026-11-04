'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { nextDiamondAction } = require('../src/diamond-planner')
const { createTunneling } = require('../src/tunneling')
const captured = require('./fixtures/diamond390-route-alternatives.json')
const copy = value => structuredClone(value)
const key = point => `${point.x},${point.y},${point.z}`

const fixtureFile = path.join(__dirname, 'runtime-survival.test.js')
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
fixtureSource = 'let hooks;\n' + fixtureSource
fixtureSource = fixtureSource.replace('  const overrides = {', `  const overrides = {
    './diamond-planner': { nextDiamondAction: (...args) => { hooks.plannerCalls.push(structuredClone(args)); return hooks.diamond(...args) } },
    './survival-planner': { nextSurvivalAction: (...args) => hooks.survival(...args) },
    './tunneling': { createTunneling: () => ({ preview: (decision, options) => { hooks.routeCalls.push({ decision: structuredClone(decision), options: structuredClone(options) }); return hooks.routePreview(decision, options) }, execute: () => { throw new Error('No tunneling action in passive planning tests') }, stop: async () => ({}), snapshot: () => ({ phase: 'idle', busy: false }) }) },`)
const miningNeedle = 'const mining = { preview: () => ({ ready: true, targets: [] }),'
assert.ok(fixtureSource.includes(miningNeedle))
fixtureSource = fixtureSource.replace(miningNeedle, 'const mining = { preview: targets => { hooks.miningCalls.push(structuredClone(targets)); return hooks.miningPreview(targets) },')
fixtureSource = fixtureSource.replace('  const create = () => {', '  Object.assign(raw, structuredClone(hooks.initialState)); shared.deathRespawn = { deathId: hooks.initialState.lifecycle.deathId };\n  const create = () => {')
fixtureSource += '\nmodule.exports = { fixture, setHooks: value => { hooks = value } }'
const loaded = { exports: {} }
new vm.Script(Module.wrap(fixtureSource), { filename: fixtureFile }).runInThisContext()(loaded.exports, Module.createRequire(fixtureFile), loaded, fixtureFile, path.dirname(fixtureFile))

function fixture (t) {
  const saved = captured.state ?? captured.status
  const hooks = { initialState: copy(saved), plannerCalls: [], routeCalls: [], miningCalls: [], diamond: nextDiamondAction, survival: () => null, routePreview: () => ({ ready: false, code: 'NO_SAFE_ROUTE', reason: 'Controlled bounded route rejection' }), miningPreview: () => ({ ready: false, targets: [] }) }
  loaded.exports.setHooks(hooks)
  const f = loaded.exports.fixture(t)
  Object.assign(f.raw, copy(saved))
  f.host.shared.deathRespawn = { deathId: saved.lifecycle.deathId }
  f.host.shared.autoWanted = false
  const ores = copy(captured.observations.ores), progress = copy(captured.observations.progress)
  const oreRows = new Map(Object.values(ores).flat().map(block => [key(block.position), { ...copy(block), properties: {}, boundingBox: 'block', diggable: true, hardness: 3, extra: [] }]))
  for (const block of captured.observations.blocks) if (block.known === true && /(?:diamond|iron|coal)_ore$/.test(block.name)) oreRows.set(key(block.position), copy(block))
  const received = new Map(captured.observations.blocks.map(block => [key(block.position), copy(block)]))
  for (const proof of [captured.verifiedBelow, captured.otherVerifiedBelow]) {
    const point = proof.decision.target
    assert.equal(proof.preview.ready, true)
    received.set(key(point), { ...copy(oreRows.get(key(point))), known: true, source: 'FIXED_SCENE_TARGET_IDENTIFIED_BY_SAVED_REAL_TUNNELING_PREVIEW' })
  }
  const changes = new Map(), packets = []
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? received.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } } }
  f.host.world.getBlock = world.getBlock
  f.host.client.queue = (...args) => { packets.push(args); assert.fail('Planning must not queue any protocol packet') }
  const config = f.autonomous[0]
  const observations = { ...copy(captured.observations), ores, progress }
  const incoming = () => ({ ...config.getState(), inventory: copy(saved.inventory), heldItem: copy(saved.heldItem), selectedSlot: saved.selectedSlot, rawSelectedSlot: saved.rawSelectedSlot ?? saved.selectedSlot, rawServerSelectedSlot: saved.rawServerSelectedSlot ?? saved.rawSelectedSlot ?? saved.selectedSlot, lifecycle: { phase: 'alive', dead: false, deathId: f.host.shared.deathRespawn.deathId } })
  const plan = (state = incoming(), view = observations) => config.planAction(state, view, { objective: 'diamond' })
  const first = nextDiamondAction(incoming(), observations, { objective: 'diamond' })
  return { ...f, hooks, config, incoming, observations, changes, world, packets, first, plan, saved, oreRows }
}

test('actual64-target catalog and scoped history use a private below-level preference after a blocked above target', t => {
  const f = fixture(t), before = copy(f.observations), sharedBefore = copy(f.host.shared.autonomyProgress)
  assert.equal(f.observations.ores.diamond.length, 64)
  assert.equal(f.first.type, 'tunnel')
  assert.ok(f.first.target.y > f.incoming().position.y - 1.62)
  f.hooks.routePreview = decision => key(decision.target) === key(f.first.target) ? { ready: false, code: 'NO_SAFE_ROUTE' } : { ready: true, withinDurability: true, resource: decision.resource, target: copy(decision.target), block: decision.block ?? decision.targetOre.name }
  const result = f.plan()
  assert.equal(result.type, 'tunnel')
  assert.equal(result.resource, 'diamond')
  assert.deepEqual(result.target, captured.verifiedBelow.decision.target, 'Full saved catalog ranks the verified -42 lower cluster first')
  assert.ok(result.target.y <= f.incoming().position.y - 1.62)
  assert.notDeepEqual(result.target, f.first.target)
  assert.ok(f.hooks.routeCalls.length <= 4)
  assert.ok(f.hooks.routeCalls.every(call => call.options.maxExpanded === 3000))
  assert.ok(f.hooks.plannerCalls.length >= 2)
  assert.ok(f.hooks.plannerCalls.slice(1).some(call => call[1].progress.excludedResources.length > before.progress.excludedResources.length))
  assert.deepEqual(f.observations, before)
  assert.deepEqual(f.host.shared.autonomyProgress, sharedBefore)
  assert.equal(f.packets.length, 0)
})

test('an empty below-level preference falls back to a ready upper alternative within the same bounded attempt', t => {
  const f = fixture(t), state = f.incoming(), feetY = state.position.y - 1.62
  // Keep the saved fixture unchanged. This isolated view has only its actually
  // observed upper ores; route readiness remains a controlled matching preview.
  f.observations.ores.diamond = f.observations.ores.diamond.filter(block => block.position.y > feetY)
  f.observations.blocks = f.observations.blocks.filter(block => !/(?:deepslate_)?diamond_ore$/.test(block.name) || block.position.y > feetY)
  const before = copy(f.observations), scope = JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, String(state.runtimeEntityId)])
  const ordinaryView = { ...f.observations, progress: { ...f.observations.progress, excludedResources: [...f.observations.progress.excludedResources, { resource: 'diamond', position: copy(f.first.target), scope }] } }
  const secondAbove = nextDiamondAction(state, ordinaryView, { objective: 'diamond' })
  assert.equal(secondAbove.type, 'tunnel')
  assert.ok(secondAbove.target.y > feetY)
  assert.notDeepEqual(secondAbove.target, f.first.target)
  const choices = [], planner = f.hooks.diamond
  f.hooks.diamond = (...args) => { const choice = planner(...args); choices.push(choice.type); return choice }
  f.hooks.routePreview = candidate => key(candidate.target) === key(f.first.target) ? { ready: false, code: 'NO_SAFE_ROUTE' } : { ready: true, withinDurability: true, resource: candidate.resource, target: copy(candidate.target), block: candidate.block ?? candidate.targetOre.name }
  const result = f.plan(state)
  assert.ok(['prospect', 'explore'].includes(choices[1]), 'Without the fallback this first private choice would retain the original')
  assert.deepEqual(result.target, secondAbove.target)
  assert.equal(result.resource, 'diamond')
  assert.equal(f.hooks.routeCalls.length, 2, 'Only the original and one real alternative receive tunneling previews')
  assert.deepEqual(f.hooks.routeCalls.map(call => call.decision.target), [f.first.target, secondAbove.target])
  assert.equal(choices.length, 3, 'The empty preference and ordinary view are evaluated within one retry slot')
  assert.deepEqual(f.observations, before)
  assert.equal(f.packets.length, 0)
})

test('a real bounded synthetic world at the captured pose rejects the floating upper vein and proves a lower catalog route', t => {
  const f = fixture(t), noAction = () => { throw new Error('No action in route proof') }
  f.world.getBlock = (x, y, z) => f.oreRows.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y < 4 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 4 ? 'block' : 'empty', diggable: y < 4, hardness: 1.5, extra: [] }
  f.host.world.getBlock = f.world.getBlock
  const physical = createTunneling({ getState: f.incoming, world: f.world, excavation: { preview: noAction, execute: noAction, stop: () => {} }, movement: { preview: noAction, start: noAction, stop: () => {} }, getMovement: () => ({ phase: 'idle' }), mining: { preview: () => ({ ready: false }) } })
  const outcomes = []
  f.hooks.routePreview = (decision, options) => { const result = physical.preview(decision, options); outcomes.push({ target: copy(decision.target), result }); return result }
  const result = f.plan()
  assert.equal(outcomes[0].result.ready, false)
  assert.equal(outcomes[0].result.code, 'NO_SAFE_ROUTE')
  assert.equal(result.type, 'tunnel')
  assert.equal(result.resource, 'diamond')
  assert.ok(result.target.y < f.incoming().position.y - 1.62)
  const accepted = outcomes.find(outcome => outcome.result.ready)
  assert.ok(accepted)
  assert.equal(accepted.result.withinDurability, true)
  assert.deepEqual(result.target, accepted.target)
  assert.ok(accepted.result.steps.length > 0)
  assert.equal(accepted.result.serverConfirmed, false)
  assert.equal(accepted.result.collected, false)
  assert.equal(f.packets.length, 0)
})

test('an original ready route or a different preview rejection never retargets the chosen ore', t => {
  const f = fixture(t)
  for (const preview of [{ ready: true, withinDurability: true }, { ready: false, code: 'SETTLE_REQUIRED' }, { ready: false, code: 'DURABILITY_UNKNOWN' }, { ready: false, code: 'NEARBY_THREAT' }]) {
    f.hooks.routeCalls.length = 0; f.hooks.plannerCalls.length = 0
    f.hooks.routePreview = () => preview
    assert.deepEqual(f.plan().target, f.first.target)
    assert.equal(f.hooks.routeCalls.length, 1)
    assert.equal(f.hooks.plannerCalls.length, 1)
  }
})

test('a real Mining-ready alternative uses the existing mine_ore handoff ahead of another tunnel preview', t => {
  const f = fixture(t)
  f.hooks.miningPreview = targets => key(targets[0]) === key(f.first.target) ? { ready: false, targets: [] } : { ready: true, targets: [{ position: copy(targets[0]), name: f.world.getBlock(targets[0].x, targets[0].y, targets[0].z).name }] }
  const result = f.plan()
  assert.equal(result.type, 'mine_ore')
  assert.equal(result.resource, 'diamond')
  assert.equal(f.hooks.routeCalls.length, 1)
  assert.equal(result.requiresKnownDurability, true)
  assert.equal(f.packets.length, 0)
})

test('bounded failures retain the original without mutating catalog/history or leaking another resource', t => {
  const f = fixture(t), before = copy(f.observations)
  const result = f.plan()
  assert.deepEqual(result.target, f.first.target)
  assert.ok(f.hooks.routeCalls.length <= 4)
  assert.deepEqual(f.observations, before)
  const originalPlanner = f.hooks.diamond
  f.hooks.diamond = (state, observations, options) => observations.progress.excludedResources.length > before.progress.excludedResources.length ? { ...copy(f.first), resource: 'coal', stage: 'coal', block: 'minecraft:coal_ore' } : originalPlanner(state, observations, options)
  const otherResource = f.plan()
  assert.deepEqual(otherResource.target, f.first.target)
  assert.equal(otherResource.resource, 'diamond')
  assert.equal(f.packets.length, 0)
})

test('Survival priority, unknown current targets, tool, full scope and disposed generation retain their existing paths', async t => {
  const f = fixture(t)
  const priority = { type: 'eat', stage: 'survival' }
  f.hooks.survival = () => priority
  assert.equal(f.plan(), priority)
  assert.equal(f.hooks.routeCalls.length, 0)
  f.hooks.survival = () => null
  f.changes.set(key(f.first.target), { known: false, position: copy(f.first.target) })
  assert.equal(f.plan().type, 'prospect')
  assert.equal(f.hooks.routeCalls.length, 0)
  f.changes.delete(key(f.first.target))
  for (const property of ['protected', 'natural']) {
    f.changes.set(key(f.first.target), { ...f.world.getBlock(f.first.target.x, f.first.target.y, f.first.target.z), [property]: property === 'protected' })
    f.hooks.routeCalls.length = 0
    assert.deepEqual(f.plan().target, f.first.target)
    assert.equal(f.hooks.routeCalls.length, 0)
    f.changes.delete(key(f.first.target))
  }
  for (const mutate of [state => { state.inventory.items.find(item => item.slot === state.rawServerSelectedSlot).durabilityKnown = false }, state => { state.connectionId = 'stale' }, state => { state.lifecycle.deathId++ }]) {
    const state = f.incoming(); mutate(state)
    f.hooks.routeCalls.length = 0
    const ordinary = nextDiamondAction(state, f.observations, { objective: 'diamond' })
    assert.deepEqual(f.plan(state), ordinary)
    assert.equal(f.hooks.routeCalls.length, 0)
  }
  const state = f.incoming()
  await f.runtime.dispose('Controlled generation ended')
  assert.deepEqual(f.plan(state).target, f.first.target)
  assert.equal(f.packets.length, 0)
})
