'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { quarryConfig } = require('../src/dashboard-control')
const filename = require.resolve('./runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { scene }\n', filename)
const { scene } = loaded.exports
const copy = value => structuredClone(value)
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const item = (id, stack = 400) => ({ ...air(), network_id: id, count: 1, has_stack_id: true, stack_id: stack })
const home = { position: { x: 2042, y: 63, z: 2015 }, other: { x: 2041, y: 63, z: 2015 },
  stand: { x: 2043, y: 63, z: 2014 }, stage: { x: 2044, y: 63, z: 2014 }, chunk: { x: 127, z: 125 }, addressing: 'combined' }

function fixture (t, { registered = true, actualGear = true, registration = {} } = {}) {
  let record = null, adapter, document = null
  const plans = [], calls = [], reads = []
  const runtimeFs = { ...fs, readFileSync (file, options) {
    if (typeof file === 'string' && file.replace(/\\/g, '/').includes('/.local/loadout-reset-v22/')) {
      reads.push(file)
      if (!record) throw Object.assign(new Error('No registered fixture station'), { code: 'ENOENT' })
      const data = JSON.stringify(record), encoding = typeof options === 'string' ? options : options?.encoding
      return encoding ? data : Buffer.from(data)
    }
    return fs.readFileSync(file, options)
  } }
  const f = scene(t, { runtimeOverrides: {
    'node:fs': runtimeFs,
    './quarry-job': { createQuarryJob: options => {
      adapter = options.adapter
      return { holdsWork: () => false, status: () => document ? { state: 'IDLE', jobId: 'fixture-plan' } : null,
        document: () => document,
        plan: config => { plans.push(copy(config)); document = { config: copy(config), state: 'IDLE', instanceId: 'fixture-plan' }; return { ready: true, jobId: 'fixture-plan' } },
        start: () => { calls.push('start'); return {} }, resume: () => { calls.push('resume'); return {} }, pause: async () => {}, cancel: async () => { calls.push('cancel') }
      }
    } }
  } })
  f.raw.position = { x: 2043.5, y: 64.62, z: 2014.5 }
  f.host.world.getBlock = (x, y, z) => {
    const chest = [home.position, home.other].some(p => p.x === x && p.y === y && p.z === z)
    return { known: true, name: chest ? 'minecraft:chest' : y < 63 ? 'minecraft:stone' : 'minecraft:air',
      boundingBox: chest || y < 63 ? 'block' : 'empty', runtimeId: chest ? 54 : y < 63 ? 1 : 0, position: { x, y, z }, properties: {}, extra: [] }
  }
  if (registered) record = { phase: 'completed', serverConfirmed: true,
    world: JSON.stringify([f.raw.profile, String(f.raw.realm.id), f.raw.dimension]), home: copy(home), ...registration }
  f.runtime.applyPacket('item_registry', { itemstates: [
    { runtime_id: 401, name: 'minecraft:diamond_helmet' }, { runtime_id: 402, name: 'minecraft:totem_of_undying' }, { runtime_id: 403, name: 'minecraft:dirt' }
  ] })
  f.runtime.applyPacket('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, air) })
  const emptyGear = () => {
    f.runtime.applyPacket('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, air) })
    f.runtime.applyPacket('inventory_content', { window_id: 'offhand', input: [air()] })
  }
  if (actualGear) emptyGear()
  const config = () => quarryConfig({ x1: 127, z1: 126 }, f.raw)
  return { ...f, plans, calls, reads, emptyGear, config,
    plan: extra => f.runtime.operations.quarry.plan({ ...config(), ...extra }), adapter: () => adapter }
}
function passive (f) {
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.wire, [], 'planning cannot send commands, interactions or item transfers')
  assert.equal(f.counters.autonomyStarts, 0)
  assert.deepEqual(f.raw.inventory.items, [], 'planning cannot invent the 34 future loadout stacks')
}

test('dashboard passive/full planning attaches only the registered adjacent-chunk startup source to an actually empty Bot', t => {
  const f = fixture(t), input = f.config(), before = copy(input), result = f.runtime.operations.quarry.plan(input)
  assert.equal(result.ready, true); assert.equal(result?.then, undefined, 'dashboard planning remains synchronous')
  const planned = f.plans[0]
  assert.equal(planned.initialLoadout, 'v22'); assert.equal(planned.inventory.supplyLayout, 'v22')
  assert.equal(planned.inventory.pickupMode, 'passive'); assert.equal(planned.inventory.depositWhen, 'full')
  assert.deepEqual(planned.inventory.storage, [])
  assert.deepEqual(planned.target, { rect: { x1: 127, z1: 126, x2: 127, z2: 126 } })
  assert.deepEqual(planned.homeChest, home)
  assert.deepEqual(planned.homeChest.chunk, { x: 127, z: 125 })
  assert.deepEqual(input, before)
  assert.deepEqual(f.adapter().registeredHomeChest(), home)
  assert.equal(f.adapter().equipmentView().armor.slots.every(slot => slot.known && slot.empty), true)
  passive(f)
})

test('an empty Bot without a registered station gets no automatic initial loadout or chest fallback', t => {
  const f = fixture(t, { registered: false }); f.plan()
  assert.equal(f.plans[0].initialLoadout, undefined)
  assert.equal(f.plans[0].inventory.supplyLayout, undefined)
  assert.equal(f.plans[0].homeChest, undefined)
  assert.deepEqual(f.plans[0].inventory.storage, [])
  passive(f)
})

for (const [label, registration] of [['unconfirmed', { serverConfirmed: false }], ['unfinished', { phase: 'failed' }], ['another-world', { world: '["bot","other-realm","overworld"]' }]]) {
  test(`${label} reset metadata cannot authorize an automatic or explicit initial loadout`, t => {
    const f = fixture(t, { registration }); f.plan()
    assert.equal(f.plans[0].initialLoadout, undefined)
    assert.equal(f.plans[0].homeChest, undefined)
    assert.throws(() => f.plan({ initialLoadout: 'v22', homeChest: copy(home) }), { code: 'LOADOUT_SOURCE_NOT_REGISTERED' })
    assert.equal(f.plans.length, 1)
    passive(f)
  })
}

for (const kind of ['main', 'armor', 'offhand']) test(`a received nonempty ${kind} slot prevents automatic startup acquisition`, t => {
  const f = fixture(t)
  f.runtime.applyPacket('inventory_slot', { window_id: kind === 'main' ? 'inventory' : kind, slot: kind === 'main' ? 9 : 0, item: item(kind === 'main' ? 403 : kind === 'armor' ? 401 : 402) })
  f.plan()
  assert.equal(f.plans[0].initialLoadout, undefined)
  assert.equal(f.plans[0].inventory.supplyLayout, undefined)
  passive(f)
})

test('unreceived actual equipment cannot be promoted to an empty 41-slot startup inventory', t => {
  const f = fixture(t, { actualGear: false }); f.plan()
  assert.equal(f.plans[0].initialLoadout, undefined)
  const equipment = f.adapter().equipmentView()
  assert.equal(equipment.armor.known, false); assert.equal(equipment.offhand.known, false)
  passive(f)
})

test('ACK-synthesized gear emptiness is neither a startup source grant nor actual equipment proof', t => {
  const f = fixture(t)
  f.runtime.applyPacket('item_stack_response', { responses: [{ request_id: -91, status: 0, containers: [
    { slot_type: { container_id: 'armor' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
    { slot_type: { container_id: 'offhand' }, slots: [{ slot: 1, count: 0, item_stack_id: 0 }] }
  ] }] })
  for (const kind of ['armor', 'offhand']) f.runtime.applyPacket('inventory_slot', { window_id: kind, slot: 0, item: air(), source: 'server_item_stack_response' })
  f.plan()
  assert.equal(f.plans[0].initialLoadout, undefined)
  assert.equal(f.adapter().equipmentView().armor.known, false)
  assert.equal(f.adapter().equipmentView().offhand.known, false)
  f.runtime.applyPacket('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, air) })
  assert.equal(f.adapter().equipmentView().armor.known, false, 'a main-only refresh is not armor evidence')
  f.emptyGear(); f.plan()
  assert.equal(f.plans[1].initialLoadout, 'v22')
  passive(f)
})

test('explicit startup markers reject an absent or changed registered source before reaching the job planner', t => {
  const f = fixture(t, { registered: false })
  assert.throws(() => f.plan({ initialLoadout: 'v22', homeChest: copy(home) }), { code: 'LOADOUT_SOURCE_NOT_REGISTERED' })
  assert.equal(f.plans.length, 0)
  f.shared.quarryV22HomeChest = copy(home)
  const wrong = copy(home); wrong.position.x--
  assert.throws(() => f.plan({ initialLoadout: 'v22', homeChest: wrong }), { code: 'LOADOUT_SOURCE_NOT_REGISTERED' })
  f.plan({ initialLoadout: 'v22', homeChest: copy(home) })
  assert.equal(f.plans[0].initialLoadout, 'v22')
  const moved = copy(home); moved.stage.z--
  f.shared.quarryV22HomeChest = moved
  assert.deepEqual(f.adapter().registeredHomeChest(), moved, 'the job reads current registration rather than the planned source copy')
  assert.throws(() => f.plan({ initialLoadout: 'v22', homeChest: copy(home) }), { code: 'LOADOUT_SOURCE_NOT_REGISTERED' })
  assert.equal(f.plans.length, 1)
  passive(f)
})

test('the quarry equipment port fingerprints actual metadata/NBT and invalidates proof on a changed connection', t => {
  const f = fixture(t); f.plan()
  const received = { ...item(401), metadata: 3, extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 7 } } } } } }
  f.runtime.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: received })
  const first = f.adapter().equipmentView().armor.slots[0]
  assert.equal(first.known, true); assert.equal(first.empty, false); assert.equal(first.metadata, 3)
  assert.match(first.receiptIdentity, /^[a-f0-9]{64}$/)
  first.metadata = 999
  assert.equal(f.adapter().equipmentView().armor.slots[0].metadata, 3)
  received.extra.nbt.nbt.value.Damage.value = 8
  f.runtime.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: received })
  assert.notEqual(f.adapter().equipmentView().armor.slots[0].receiptIdentity, first.receiptIdentity)
  f.raw.connectionId = 'changed-connection'
  assert.equal(f.adapter().equipmentView().armor.known, false)
  assert.equal(f.adapter().equipmentView().offhand.known, false)
  passive(f)
})
