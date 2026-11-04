'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { evaluateThreats } = require('../src/threats')
const Item = require('prismarine-item')('bedrock_1.26.60')
const copy = value => structuredClone(value)
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const swordRaw = (used = 0) => ({ network_id: 314, count: 1, metadata: 0, has_stack_id: true, stack_id: 501, block_runtime_id: 0, extra: used === null ? { has_nbt: 'false', can_place_on: [], can_destroy: [] } : { has_nbt: 'true', nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: used } } } }, can_place_on: [], can_destroy: [] } })

// Keep the established Runtime/real crafting/raw-item scene and transport
// assertions. The healthy case changes only its target and protection phase.
const fixtureFile = path.resolve(__dirname, 'runtime-stuck-combat.test.js')
const loaded = new Module(fixtureFile, module)
loaded.filename = fixtureFile; loaded.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
const source = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
loaded._compile(source + '\nmodule.exports = { setup };', fixtureFile)
function setup (t) {
  const f = loaded.exports.setup(t, { nativeStanding: true })
  let wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  f.raw.threatPolicy = 'online_learning'; f.raw.health = 12
  f.safetyStatus.phase = 'observing'
  f.target.entityType = 'minecraft:zombie'; f.target.position.x = 5
  f.runtime.applyPacket('item_registry', { itemstates: [{ runtime_id: 314, name: 'minecraft:stone_sword' }, { runtime_id: 330, name: 'minecraft:bow' }, { runtime_id: 332, name: 'minecraft:arrow' }] })
  const install = rawItem => {
    const slots = Array.from({ length: 36 }, empty); slots[0] = copy(rawItem)
    f.runtime.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
    f.raw.inventory = { known: true, items: copy(f.facadeOptions.crafting.snapshot().inventory) }
    f.raw.selectedSlot = f.raw.rawSelectedSlot = f.raw.rawServerSelectedSlot = 0
    f.raw.heldItem = copy(f.raw.inventory.items.find(item => item.slot === 0))
  }
  install(swordRaw(127))
  return { ...f, install, age: milliseconds => { wall += milliseconds }, now: () => wall }
}
const frame = (x = 0.8) => ({ predictedState: { position: { x, y: 65, z: 0.5 } } })
async function approachCallback (f) {
  f.observe()
  assert.equal(f.allowed(), true, 'The actual recent canonical observation must authorize this lease')
  const context = { kind: 'combat', claimId: 'combat:healthy', scope: f.scope(), target: copy(f.target) }
  context.token = await f.facadeOptions.acquireControl(context)
  assert.deepEqual(f.runtime.snapshot().userBehaviors.approachAdmission, { reason: 'healthy_armed_melee', targetRuntimeId: '70', engagementReached: false })
  let callback = null
  f.mockMovement.start = (target, options) => { callback = options.beforeInput; f.setMovement({ phase: 'awaiting_server_confirmation', running: false, sent: 0 }); return f.mockMovement.snapshot() }
  const result = await f.facadeOptions.approach(copy(f.target), context)
  assert.equal(typeof callback, 'function', JSON.stringify(result))
  assert.notEqual(result.serverConfirmed, true)
  return { callback, context, result }
}

test('healthy armed melee admission works during observing using actual raw sword wear and no new terrain rays', t => {
  const f = setup(t), queue = f.host.client.queue
  assert.equal(f.allowed(), false, 'No recent canonical safety observation exists yet')
  f.observe(); const reads = f.worldReads()
  assert.equal(f.safetyStatus.phase, 'observing', 'The old stuck-only admission denied this phase')
  assert.equal(f.allowed(), true)
  assert.equal(f.worldReads(), reads)
  const raw = f.facadeOptions.crafting.rawItem(0), parsed = Item.fromNotch(copy(raw))
  assert.equal(raw.stack_id, f.raw.heldItem.stackId)
  assert.equal(parsed.name, 'stone_sword')
  assert.equal(parsed.maxDurability - parsed.durabilityUsed, 4)
  assert.equal(f.host.client.queue, queue)
  assert.equal(f.wire.length, 0, 'Admission sends no attack or movement packets')
})

test('only the typed canonical melee allowlist is admitted without modifying any danger radius', t => {
  const f = setup(t)
  for (const type of ['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider', 'cave_spider']) {
    f.target.entityType = `minecraft:${type}`; f.observe()
    const observed = f.facadeOptions.getState(), canonical = evaluateThreats(observed, observed.entities)
    assert.ok(canonical.threats.some(actor => actor.runtimeId === '70'), type)
    assert.equal(canonical.threats.find(actor => actor.runtimeId === '70').dangerRadius, type === 'cave_spider' ? 12 : 5)
    assert.equal(f.allowed(), true, type)
  }
  for (const type of ['skeleton', 'drowned', 'creeper', 'witch', 'wither_skeleton', 'pig']) {
    f.target.entityType = `minecraft:${type}`; f.observe()
    assert.equal(f.allowed(), false, type)
  }
})

test('HP twelve and four known remaining uses are strict admission thresholds; explicit no-NBT means pristine', t => {
  const f = setup(t)
  f.observe(); assert.equal(f.allowed(), true)
  f.raw.health = 11.999; f.observe(); assert.equal(f.allowed(), false)
  f.raw.health = 12; f.install(swordRaw(128)); f.observe(); assert.equal(f.allowed(), false)
  f.install(swordRaw(null)); f.observe(); assert.equal(f.allowed(), true, 'Explicit has_nbt:false is an ordinary pristine vanilla sword')
  for (const raw of [
    { ...swordRaw(0), stack_id: 0 },
    { ...swordRaw(0), count: 2 },
    { ...swordRaw(0), extra: { has_nbt: 'true', nbt: null } },
    { ...swordRaw(0), extra: { has_nbt: 'true', nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'string', value: 'unknown' } } } } } },
    { ...swordRaw(0), extra: { has_nbt: 'true', nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Unrecognized: { type: 'string', value: 'unknown' } } } } } }
  ]) {
    f.install(raw); f.observe(); assert.equal(f.allowed(), false, JSON.stringify(raw))
  }
})

test('cache age, exact pose and UID, inventory, bow/ammo and life changes cannot borrow healthy admission', t => {
  const f = setup(t)
  f.observe(); f.age(500); assert.equal(f.allowed(), true)
  f.age(1); assert.equal(f.allowed(), false)
  f.observe(); f.target.uniqueId = '-different'; assert.equal(f.allowed(), false); f.target.uniqueId = '-700'
  f.observe(); f.target.position.x += 0.01; assert.equal(f.allowed(), false); f.target.position.x -= 0.01
  f.observe(); f.raw.position.x += 0.01; assert.equal(f.allowed(), false); f.raw.position.x -= 0.01
  f.observe(); f.raw.inventory.items.push({ name: 'minecraft:bow', count: 1 }, { name: 'minecraft:arrow', count: 1 }); assert.equal(f.allowed(), false); f.raw.inventory.items.splice(1)
  f.observe(); f.raw.inventory.uncertain = true; assert.equal(f.allowed(), false); delete f.raw.inventory.uncertain
  f.observe(); f.actors.push({ ...copy(f.target), runtimeId: '71', uniqueId: '-701', positionKnown: false, position: null }); assert.equal(f.allowed(), false); f.actors.pop()
  f.observe(); f.target.position.x = 6; f.observe(); assert.equal(f.allowed(), false, 'A target outside its unchanged canonical five-block circle is not admitted'); f.target.position.x = 5
  f.observe(); f.shared.deathRespawn.deathId++; assert.equal(f.allowed(), false)
})

test('healthy approach lease revokes low HP or worn weapon before actual working pose reaches melee', async t => {
  const f = setup(t), { callback } = await approachCallback(f)
  assert.equal(callback(frame(2.6)), true, 'A proposed close frame alone does not prove current entry into melee')
  f.raw.health = 11
  assert.throws(() => callback(frame()), /health|healthy|armed|admission|approach/i)
  f.raw.health = 12; f.install(swordRaw(128))
  assert.throws(() => callback(frame()), /sword|wear|healthy|armed|admission|approach/i)
  f.install(swordRaw(127)); f.target.position.x = 6
  assert.throws(() => callback(frame()), /healthy|armed|admission|approach/i, 'Leaving the unchanged canonical radius revokes an unengaged approach')
  assert.equal(f.wire.length, 0)
})

test('actual entry into melee makes the healthy lease sticky across later positive-HP knockback', async t => {
  const f = setup(t), { callback, context } = await approachCallback(f)
  // A real current working pose, not the proposed next frame, enters reach.
  f.raw.position.x = 2.5; f.raw.positionUpdatedAt = new Date(Date.now()).toISOString()
  f.facadeOptions.getState()
  assert.equal(f.runtime.snapshot().userBehaviors.approachAdmission.engagementReached, true, 'Actual fresh facade state also marks entry when Melee can engage without Root approach')
  assert.equal(callback(frame(2.6)), true)
  f.raw.health = 1; f.install(swordRaw(129)); f.raw.position.x = 0.5; f.raw.positionUpdatedAt = new Date(Date.now()).toISOString()
  assert.equal(callback(frame()), true, 'A bound positive-HP fight survives later knockback and weapon wear')
  assert.equal(f.facadeOptions.getState().health, 1)
  assert.equal(f.wire.length, 0, 'Lease continuity is not hit, movement, inventory or server credit')
  f.shared.deathRespawn.deathId++
  assert.throws(() => callback(frame()), /scope|life|changed/i)
  assert.equal((await f.facadeOptions.resumeControl(context)).resumed, true)
})

test('stale current poses and proposed close frames cannot mark the direct-Melee engagement lease', async t => {
  const f = setup(t), { callback } = await approachCallback(f)
  assert.equal(callback(frame(2.6)), true)
  assert.equal(f.runtime.snapshot().userBehaviors.approachAdmission.engagementReached, false)
  f.raw.position.x = 2.5; f.raw.positionUpdatedAt = new Date(Date.now() - 201).toISOString()
  f.facadeOptions.getState()
  assert.equal(f.runtime.snapshot().userBehaviors.approachAdmission.engagementReached, false)
  f.raw.position.x = 0.5; f.raw.positionUpdatedAt = new Date(Date.now()).toISOString(); f.raw.health = 11
  assert.throws(() => callback(frame()), /healthy|armed|admission|approach/i)
  assert.equal(f.wire.length, 0)
})

test('legacy stuck fallback and positive-HP already-near combat remain available', async t => {
  const f = setup(t)
  f.raw.health = 1; f.target.entityType = 'minecraft:skeleton'; f.target.position.x = 10
  f.safetyStatus.phase = 'emergency_retry'; f.safetyStatus.lastResult = { action: 'escape', reason: 'no_known_away_route' }
  f.raw.inventory.items = []; f.raw.heldItem = null; f.observe()
  assert.equal(f.allowed(), true, 'The old stuck-combat admission remains intact')
  f.target.entityType = 'minecraft:zombie'; f.target.position.x = 2.5; f.safetyStatus.phase = 'observing'; f.observe()
  const state = f.facadeOptions.getState()
  assert.equal(state.health, 1)
  assert.ok(Math.hypot(state.position.x - f.target.position.x, state.position.y - f.target.position.y - 0.9, state.position.z - f.target.position.z) < 2.8)
  const context = { kind: 'combat', claimId: 'combat:already-near', scope: f.scope(), target: copy(f.target) }
  context.token = await f.facadeOptions.acquireControl(context)
  assert.notEqual(context.token?.acquired, false, 'Positive HP already inside melee keeps the existing lease path')
  assert.equal((await f.facadeOptions.resumeControl(context)).resumed, true)
  assert.equal(f.wire.length, 0)
})
