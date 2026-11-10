'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { blockRule, selectTool } = require('../src/quarry-rules')
const { createMining } = require('../src/mining')
const { planQuarryExit } = require('../src/quarry-exit-plan')

function fixtureFrom (name) {
  const file = path.resolve(__dirname, name)
  const loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
  loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture }\n', file)
  return loaded.exports.fixture
}
const exitFixture = fixtureFrom('quarry-pillar-exit.test.js')
const runtimeFixture = fixtureFrom('quarry-egress-runtime.test.js')

test('every registered vanilla ore including lit variants and ancient debris is protected', () => {
  const names = require('minecraft-data')('bedrock_1.26.60').blocksArray.map(b => b.name).filter(name => /_ore$/.test(name) || name === 'ancient_debris')
  assert.ok(names.length >= 20)
  for (const name of names) assert.deepEqual(blockRule(`minecraft:${name}`), { kind: 'protected', reason: 'PROTECTED_ORE' }, name)
  for (const name of ['lit_redstone_ore', 'lit_deepslate_redstone_ore', 'unrecognized_ore', 'custom:future_ore']) assert.deepEqual(blockRule(name), { kind: 'protected', reason: 'PROTECTED_ORE' }, name)
  assert.equal(blockRule('minecraft:stone').kind, 'dig')
})

test('a better, fortune or silk tool and legacy ore policies cannot override ore protection', () => {
  const tools = [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 1561, enchantments: [{ name: 'fortune', level: 3 }, { name: 'silk_touch', level: 1 }] }]
  for (const orePolicy of ['maximize_yield', 'preserve_ore']) for (const name of ['gold_ore', 'deepslate_diamond_ore', 'future_ore']) assert.deepEqual(selectTool(blockRule(name), tools, { orePolicy }), { ok: false, reason: 'PROTECTED_ORE' })
})

test('reconciliation of saved tool or route deferrals reclassifies ores without putting them back into mine targets', async () => {
  for (const previous of ['TOOL_DURABILITY_RESERVE', 'WAITING_FOR_TOOL', 'UNREACHABLE', 'MINING_FAILED']) {
    const { sim, planner } = exitFixture()
    const p = { x: 8, y: 60, z: 8 }
    sim.world.set(p.x, p.y, p.z, 'deepslate_gold_ore')
    planner.defer(p, previous)
    planner.clearDeferred([previous])
    assert.equal(planner.cellStatus(p).reason, 'PROTECTED_ORE')
    const decision = await planner.next({ feet: sim.feet(), yTop: 60, tools: sim.state.inventory.items, inventoryItems: sim.state.inventory.items })
    assert.notEqual(decision.action, 'mine', previous)
    assert.equal(planner.deferredList().find(d => d.position === '8,60,8').reason, 'PROTECTED_ORE')
    assert.equal(sim.world.name(8, 60, 8), 'deepslate_gold_ore')
  }
})

test('shaft selection mines listed ores in the exit column with a pickaxe (2026-11-10 Y-59 request)', () => {
  for (const name of ['iron_ore', 'deepslate_gold_ore']) {
    const { sim, args } = exitFixture()
    for (let z = 0; z < 16; z++) sim.world.set(16, 61, z, name)
    const result = planQuarryExit(args())
    assert.equal(result.ok, true, name)
    assert.ok(result.plan.shaftCells.some(c => c.name === 'minecraft:' + name), JSON.stringify(result.plan.shaftCells))
  }
})

test('shaft selection still rejects unlisted and unknown ores instead of mining them or pretending a safe exit exists', () => {
  for (const name of ['ancient_debris', 'unrecognized_ore']) {
    const { sim, args } = exitFixture()
    for (let z = 0; z < 16; z++) sim.world.set(16, 61, z, name)
    const result = planQuarryExit(args())
    assert.equal(result.ok, false, name)
    assert.equal(result.reason, 'EXIT_COLUMN_UNAVAILABLE')
    assert.equal(result.details.attempts.length, 16)
    assert.ok(result.details.attempts.every(a => a.reason === 'PROTECTED'), JSON.stringify(result.details))
  }
})

test('even a matching saved shaft intent cannot dispatch ore mining after the policy changes', async () => {
  for (const name of ['minecraft:deepslate_gold_ore', 'minecraft:future_ore']) {
    const f = runtimeFixture()
    f.blocks.set('1,65,0', name)
    Object.assign(f.plan.shaftCells[0], { name, expectedRuntimeId: 0 })
    const result = await f.run()
    assert.equal(result.status, 'blocked', name)
    assert.equal(result.reason, 'EGRESS_SHAFT_CHANGED')
    assert.equal(result.serverConfirmed, false)
    assert.equal(f.mines.length, 0)
    assert.equal(f.steps.length, 0)
  }
})

test('ordinary quarry and fluid-access mining reject ore payloads before any input starts', () => {
  let starts = 0
  const mining = createMining({ getState: () => ({}), world: {}, getInput: () => { starts++; return null } })
  for (const accessPreparation of ['quarry', 'quarry_fluid_roof']) for (const expectedName of ['minecraft:gold_ore', 'minecraft:deepslate_diamond_ore', 'minecraft:future_ore']) {
    assert.throws(() => mining.start([{ x: 0, y: 60, z: 0, expectedName, accessPreparation, requiredTool: { kind: 'pickaxe', tier: 4, reserve: 1 } }]), /diggable/, expectedName)
  }
  assert.equal(starts, 0)
})
