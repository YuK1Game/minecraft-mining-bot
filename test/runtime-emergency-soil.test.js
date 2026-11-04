'use strict'

// Exercise production Runtime, Mining, navigation, physics and Guard using only
// captured blocks and a received-block fixture. No Realm or API is contacted.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { evaluateThreats } = require('../src/threats')
const observed = require('./fixtures/queued-tail-soil.json')
const fixtureFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
let prefix = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
// Read fixture declarations only, never register the large escape suite.
prefix = prefix.replace('const moduleTarget = { exports: {} }', `
fixtureSource = fixtureSource.replace('sendAction () {}, sendTransaction () {}', 'sendAction: (...args) => calls.push({ type: "mining_input_action", args: copy(args) }), sendTransaction () {}')
fixtureSource = fixtureSource.replace('stop: () => { running = false }', 'stop: () => { running = false; calls.push({ type: "mining_input_stop" }) }')
fixtureSource = fixtureSource.replace('release () {}', 'release: () => calls.push({ type: "mining_input_stop" })')
const moduleTarget = { exports: {} }`)
const fixtureModule = new Module(fixtureFile, module)
fixtureModule.filename = fixtureFile
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
fixtureModule._compile(prefix + '\nmodule.exports = { prepare, context }\n', fixtureFile)
const { prepare, context } = fixtureModule.exports
const obstacle = { x: -16, y: 68, z: 30 }
const key = p => `${p.x},${p.y},${p.z}`
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('captured hand soil clearance uses received AIR and fresh guarded movement', { timeout: 30000 }, async t => {
  // Reuse one physics fixture through sequential cases to keep the offline
  // capture regression bounded in memory.
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true })
  const blocks = new Map()
  let sequence = 100
  function reset (hand = 'minecraft:rotten_flesh') {
    delete f.shared.physicsWorking
    f.raw.health = observed.health
    f.raw.dead = false
    f.raw.phase = 'spawned'
    f.raw.dimension = observed.dimension ?? 'overworld'
    f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'
    f.raw.predicted = structuredClone(observed.predicted)
    f.raw.rawSelectedSlot = 0
    f.raw.rawServerSelectedSlot = 0
    f.raw.selectedSlot = 0
    f.raw.equipmentServerConfirmed = true
    f.raw.inventory = { known: true, uncertain: false, items: hand ? [{ slot: 0, name: hand, count: 2 }] : [] }
    f.raw.heldItem = hand ? structuredClone(f.raw.inventory.items[0]) : null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    blocks.clear()
    for (const block of observed.blocks) blocks.set(key(block.position), structuredClone(block))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    f.calls.length = 0
    for (const actor of f.movements) { actor.previews.length = 0; actor.starts.length = 0; actor.frames.length = 0 }
  }
  async function beginClear () {
    const action = Promise.resolve(f.safeties[0].options.clearEscape(context(f, ++sequence)))
    // Attach a handler immediately; the packet can abort it synchronously.
    action.catch(() => {})
    for (let n = 0; n < 200 && f.runtime.snapshot().mining.phase !== 'mining'; n++) await delay(5)
    assert.equal(f.runtime.snapshot().mining.phase, 'mining')
    assert.deepEqual(f.runtime.snapshot().mining.activeTarget, obstacle)
    assert.deepEqual(f.calls.find(call => call.type === 'mining_input_action')?.args.slice(0, 2), ['start_break', obstacle])
    return { action }
  }
  function receiveAir () {
    blocks.set(key(obstacle), { known: true, position: { ...obstacle }, name: 'minecraft:air', properties: {}, extra: [], boundingBox: 'empty', runtimeId: 3690217760 })
    f.runtime.applyPacket('update_block', {})
  }
  const movementStarts = () => f.movements.flatMap(actor => actor.starts)

  await t.test('baseline has no sampled route and performs no mining or movement', async () => {
    reset()
    const result = await f.safeties[0].options.escape(context(f, ++sequence))
    assert.equal(result.reason, 'no_known_away_route')
    assert.equal(result.diagnostics.previews, 0)
    assert.equal(movementStarts().length, 0)
    assert.equal(f.calls.some(call => call.type === 'mining_input_action'), false)
  })

  for (const hand of ['minecraft:rotten_flesh', null, 'minecraft:porkchop']) {
    await t.test(`${hand ?? 'empty hand'} waits for received AIR before the native guarded jump`, async () => {
      reset(hand)
      const { action } = await beginClear()
      // Hold the received block unchanged through the local hand-mining model's
      // 900 ms grass duration; no prediction may substitute for the AIR update.
      await delay(hand === 'minecraft:rotten_flesh' ? 925 : 110)
      assert.equal(f.runtime.snapshot().mining.phase, 'mining')
      assert.equal(blocks.get(key(obstacle)).name, 'minecraft:grass_block')
      assert.equal(movementStarts().length, 0)
      receiveAir()
      const cleared = await action
      assert.equal(cleared.cleared, true)
      assert.equal(cleared.serverConfirmed, true)
      assert.equal(cleared.arrived, undefined)
      assert.equal(cleared.escaped, undefined)
      assert.equal(movementStarts().length, 0)
      assert.equal(blocks.get('-16,67,30').name, 'minecraft:dirt')
      const result = await f.safeties[0].options.escape({ ...context(f, ++sequence), preferredTarget: cleared.target, reason: 'confirmed_soil_clearance' })
      assert.equal(result.arrived, true, JSON.stringify(result))
      assert.equal(result.escaped, true, JSON.stringify(result))
      assert.equal(result.serverConfirmed, false)
      assert.equal(result.movementStarts, 1)
      assert.equal(f.raw.health, observed.health)
      assert.ok(movementStarts().some(start => start.target.y === 68 && start.target.z > 30))
    })
  }

  await t.test('a pursuer moved after mining is included in every fresh movement preview', async () => {
    reset()
    const { action } = await beginClear()
    receiveAir()
    const cleared = await action
    const creeper = f.actors.find(actor => actor.runtimeId === '24')
    creeper.position.z += 1.5
    const currentPosition = structuredClone(creeper.position)
    f.runtime.applyPacket('move_entity', { runtime_entity_id: creeper.runtimeId, position: currentPosition })
    const current = f.safeties[0].options.getState()
    const measured = evaluateThreats(current, current.entities, { observationRadius: 32 }).threats.find(actor => actor.runtimeId === creeper.runtimeId).distance
    const result = await f.safeties[0].options.escape({ ...context(f, ++sequence), preferredTarget: cleared.target, reason: 'confirmed_soil_clearance' })
    const previews = f.movements.flatMap(actor => actor.previews).filter(preview => preview.options?.avoidance)
    assert.ok(previews.length > 0)
    for (const preview of previews) {
      const actor = preview.options.avoidance.find(actor => actor.id === creeper.runtimeId)
      assert.deepEqual(actor.position, currentPosition)
      assert.ok(Math.abs(actor.minDistance - measured) < 1e-6)
    }
    const final = f.safeties[0].options.getState()
    const live = evaluateThreats(final, final.entities, { observationRadius: 32 })
    assert.equal(result.escaped, result.arrived === true && live.threats.length === 0)
    assert.ok(distance(creeper.position, final.position) < 8.5430102, JSON.stringify({ result, final: final.position }))
    assert.equal(cleared.escaped, undefined)
  })

  for (const mode of ['damage', 'primed', 'approaching', 'hand_changed', 'inventory_uncertain', 'equipment_unconfirmed', 'scope_changed', 'support_changed', 'target_layer', 'target_protected', 'neighbour_liquid', 'air_layer']) {
    await t.test(`${mode} cancels active real Mining before movement`, async () => {
      reset()
      const { action } = await beginClear()
      const creeper = f.actors.find(actor => actor.runtimeId === '24')
      if (mode === 'damage') await delay(450)
      if (mode === 'damage') f.raw.health--
      if (mode === 'primed') creeper.primed = true
      if (mode === 'approaching') creeper.position = { ...f.raw.position }
      if (mode === 'hand_changed') { f.raw.heldItem.count = 3; f.raw.inventory.items[0].count = 3 }
      if (mode === 'inventory_uncertain') f.raw.inventory.uncertain = true
      if (mode === 'equipment_unconfirmed') f.raw.equipmentServerConfirmed = false
      if (mode === 'scope_changed') f.raw.dimension = 'nether'
      if (mode === 'support_changed') blocks.set('-16,67,30', { ...blocks.get('-16,67,30'), name: 'minecraft:stone', runtimeId: 2150698529 })
      if (mode === 'target_layer') blocks.get(key(obstacle)).extra = [{ known: true, name: 'minecraft:water', properties: { liquid_depth: 0 } }]
      if (mode === 'target_protected') blocks.get(key(obstacle)).protected = true
      if (mode === 'neighbour_liquid') blocks.set('-16,69,30', { known: true, name: 'minecraft:water', properties: { liquid_depth: 0 }, extra: [], boundingBox: 'empty' })
      if (mode === 'air_layer') blocks.set(key(obstacle), { known: true, position: { ...obstacle }, name: 'minecraft:air', properties: {}, extra: [{ known: true, name: 'minecraft:water', properties: { liquid_depth: 0 } }], boundingBox: 'empty' })
      const rejected = assert.rejects(action, /clearance|scope|aborted|cancel|safe/i)
      f.runtime.applyPacket('move_entity', {})
      assert.notEqual(f.runtime.snapshot().mining.phase, 'mining')
      await rejected
      assert.equal(movementStarts().length, 0)
      assert.equal(blocks.get(key(obstacle)).name, mode === 'air_layer' ? 'minecraft:air' : 'minecraft:grass_block')
      assert.ok(f.calls.some(call => call.type === 'mining_input_stop'))
      f.raw.dimension = observed.dimension ?? 'overworld'
    })
  }

  await t.test('a changed target fails Mining without accepting a nonexistent AIR receipt', async () => {
    reset()
    const { action } = await beginClear()
    blocks.set(key(obstacle), { ...blocks.get(key(obstacle)), name: 'minecraft:stone', runtimeId: 2150698529 })
    f.runtime.applyPacket('update_block', {})
    const result = await action.catch(error => ({ cleared: false, error: error.message }))
    assert.equal(result.cleared, false)
    assert.notEqual(f.runtime.snapshot().mining.phase, 'mining')
    assert.equal(movementStarts().length, 0)
  })

  await t.test('missing received AIR hits the existing two-second clearance deadline', async () => {
    reset()
    const { action } = await beginClear()
    await assert.rejects(action, error => /timed out|timeout|deadline/i.test(`${error.message} ${error.cause?.message ?? ''}`))
    assert.notEqual(f.runtime.snapshot().mining.phase, 'mining')
    assert.equal(movementStarts().length, 0)
    assert.equal(blocks.get(key(obstacle)).name, 'minecraft:grass_block')
  })

  await t.test('the real idle supervisor permits one hand soil clear and then replans', async () => {
    reset()
    const supervisor = f.safeties[0].native
    f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 })
    const operation = supervisor.tick()
    for (let n = 0; n < 300 && f.runtime.snapshot().mining.phase !== 'mining'; n++) await delay(5)
    assert.equal(f.runtime.snapshot().mining.phase, 'mining')
    assert.equal(movementStarts().length, 0)
    receiveAir()
    await operation
    assert.equal(supervisor.snapshot().lastClear?.cleared, true, JSON.stringify(supervisor.snapshot()))
    assert.equal(f.calls.filter(call => call.type === 'mining_input_action' && call.args[0] === 'start_break').length, 1)
    assert.ok(movementStarts().length >= 1)
    assert.equal(f.raw.health, observed.health)
    await f.runtime.operations.safety.stop()
  })
})
