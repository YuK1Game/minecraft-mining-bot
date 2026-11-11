'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const { createInventoryInspection } = require('../src/inventory-inspection')
const { createRuntimeLoadoutReset } = require('../src/loadout-runtime-adapter')
const { matches, knownInventory } = require('../src/loadout-reset')
const { manifest } = require('../src/loadout-manifest')
const { discoverSupplyBindings } = require('../src/quarry-supplies')
const mc = require('minecraft-data')('bedrock_1.26.60')
const t = (type, value) => ({ type, value })
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const enchantIds = Object.fromEntries(Object.values(mc.enchantments).map(e => [e.name, e.id]))
function nbt (spec) {
  const value = {}
  if (Object.keys(spec.enchants ?? {}).length) {
    value.Damage = t('int', 0)
    value.ench = t('list', { type: 'compound', value: Object.entries(spec.enchants).map(([name, level]) => ({ id: t('short', enchantIds[name]), lvl: t('short', level) })) })
  }
  if (spec.contents) value.Items = t('list', { type: spec.contents.length ? 'compound' : 'end', value: spec.contents.map((item, slot) => ({ Slot: t('byte', slot), Name: t('string', item.name), Count: t('byte', item.count), Damage: t('short', 0), tag: t('compound', nbt(item)) })) })
  return value
}
function raw (spec, stack = 10) {
  const value = nbt(spec), has = Object.keys(value).length > 0
  return { ...empty(), network_id: mc.itemsByName[spec.name.replace('minecraft:', '')].id, count: spec.count, has_stack_id: true, stack_id: stack,
    extra: { has_nbt: has, can_place_on: [], can_destroy: [], ...(has ? { nbt: { version: 1, nbt: t('compound', value) } } : {}) } }
}
function scene () {
  const state = { profile: 'bot', playerName: 'OfflineBot', realm: { id: '42', name: 'Offline' }, connectionId: 'connection', startedAt: '2026-11-09T00:00:00Z', dimension: 'overworld', runtimeEntityId: '7', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20, gameMode: 'survival', inventory: { known: true }, position: { x: .5, y: 65.62, z: .5 } }
  const main = Array.from({ length: 36 }, empty), armorStore = { known: true, worn: new Map(Array.from({ length: 4 }, (_, i) => [i, empty()])) }
  let authority = true, open = null
  const crafting = { rawItem: i => main[i], itemNameOf: id => mc.items[id]?.name ? 'minecraft:' + mc.items[id].name : null,
    status: () => ({ authority, inventoryKnown: true, pendingRequestId: null, openContainer: open }), snapshot: () => crafting.status(), closeContainer: () => { open = null } }
  const inspection = createInventoryInspection({ crafting, armorStore, getState: () => state, registry: mc })
  inspection.applyPacket('inventory_content', { window_id: 'offhand', input: [empty()] })
  return { state, main, armorStore, crafting, inspection, setAuthority: v => { authority = v }, setOpen: v => { open = v } }
}
test('loadout-runtime: the real NBT inspection decodes every kit slot, armor and all 108 supply entries', () => {
  const f = scene(), m = manifest()
  m.hotbar.forEach((spec, i) => { f.main[i] = raw(spec, i + 100) })
  m.armor.forEach((spec, i) => f.armorStore.worn.set(i, raw(spec, i + 200)))
  for (const spec of [...m.cargo, ...m.supplies]) f.main[spec.slot] = raw(spec, spec.slot + 100)
  const view = f.inspection.snapshot()
  assert.equal(knownInventory(view), true)
  for (const [i, spec] of m.hotbar.entries()) assert.ok(matches(view.slots[i], spec), spec.name)
  for (const [i, spec] of m.armor.entries()) assert.ok(matches(view.armor.slots[i], spec), spec.name)
  for (const spec of [...m.cargo, ...m.supplies]) assert.ok(matches(view.slots[spec.slot], spec), spec.name)
  const discovered = discoverSupplyBindings([...m.cargo, ...m.supplies].map(spec => ({ ...spec, stackId: spec.slot + 100, raw: f.main[spec.slot] })), { resolveName: f.crafting.itemNameOf })
  assert.equal(discovered.ok, true)
  assert.deepEqual(discovered.bindings.map(b => b.role), ['pickaxe', 'shovel', 'food', 'dirt'])
  // An enchant receipt cannot hide a malformed, missing or different nested tool.
  f.main[29].extra.nbt.nbt.value.Items.value.value[3].tag.value.ench.value.value[0].lvl.value = 1
  assert.equal(matches(f.inspection.snapshot().slots[29], m.supplies[0]), false)
})
async function bridge (t) {
  const f = scene(), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-loadout-runtime-')), sent = []
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let actors = [], unknown = 0, held = null, reset
  const host = { shared: { loadingScreenEnded: true }, entities: { snapshot: () => actors, stats: () => ({ unknownPositions: unknown }) }, world: { getBlock: (_x, y) => ({ known: true, name: y < 64 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 64 ? 'block' : 'empty', extra: [] }) }, client: { queue: (name, packet) => {
    sent.push({ name, packet })
    if (name === 'command_request') queueMicrotask(() => reset.applyPacket('command_output', { origin: packet.origin, output_type: 'all', success_count: 0, output: [{ success: false, message_id: 'commands.generic.permission', parameters: [] }], has_data: false }))
  } } }
  reset = createRuntimeLoadoutReset({ host, getState: () => f.state, inspection: f.inspection, crafting: f.crafting, armor: {}, inventory: {}, chest: {},
    assertIdle: () => { if (held) throw Error('busy') }, acquire: id => { held = id }, release: id => { assert.equal(held, id); held = null }, getJob: () => null, generation: () => 1, cancelTransfers: async () => {}, journalDirectory: directory })
  return { ...f, reset, host, sent, directory, actors: a => { actors = a }, unknown: v => { unknown = v }, held: () => held }
}
test('loadout-runtime: real adapter privilege denial persists scoped failure without ever clearing inventory', async t => {
  const f = await bridge(t), p = await f.reset.prepare()
  f.reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' }); await f.reset.drain()
  assert.deepEqual(f.sent.map(p => p.packet.command), ['/testfor @s'])
  assert.equal(f.reset.status().phase, 'failed'); assert.equal(f.reset.status().serverConfirmed, false); assert.equal(f.held(), null)
  const files = await fs.readdir(f.directory); assert.equal(files.length, 1)
  const data = JSON.parse(await fs.readFile(path.join(f.directory, files[0]), 'utf8'))
  assert.equal(data.world, crypto.createHash('sha256').update(JSON.stringify(['bot', '42', 'overworld'])).digest('hex'))
  assert.equal(data.error.code, 'RESET_COMMAND_REJECTED')
})
test('loadout-runtime: missing authority and active container refuse before a command; actor proximity does not', async t => {
  const f = await bridge(t)
  f.setAuthority(false); await assert.rejects(f.reset.prepare(), { code: 'RESET_AUTHORITY_UNKNOWN' }); f.setAuthority(true)
  f.unknown(1); await f.reset.prepare(); f.unknown(0)
  f.actors([{ kind: 'player', runtimeId: '8', position: { x: 1, y: 64, z: 0 } }]); await f.reset.prepare(); f.actors([])
  f.setOpen({ id: 1 }); await assert.rejects(f.reset.prepare(), { code: 'RESET_JOB_PENDING' }); f.setOpen(null)
  await f.reset.prepare(); assert.equal(f.sent.length, 0)
})

for (const kind of ['player', 'hostile', 'unknown']) test(`loadout-runtime: ${kind} does not block the actual adapter's command path`, async t => {
  const f = await bridge(t)
  f.actors([{ kind: kind === 'player' ? 'player' : 'mob', hostile: kind !== 'player', runtimeId: '8', position: kind === 'unknown' ? null : { x: .5, y: 64, z: .5 } }])
  f.unknown(kind === 'unknown' ? 1 : 0)
  const p = await f.reset.prepare()
  f.reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' }); await f.reset.drain()
  // The mock server denies operator permission. Reaching the read-only probe
  // proves actors were not an admission gate; denial still never clears items.
  assert.deepEqual(f.sent.map(p => p.packet.command), ['/testfor @s'])
  assert.equal(f.reset.status().error.code, 'RESET_COMMAND_REJECTED')
})
test('loadout-runtime: actor cache is not required by debug reset', async t => {
  const f = await bridge(t)
  f.host.entities.snapshot = () => { throw Error('actor cache is not a reset dependency') }
  f.host.entities.stats = () => { throw Error('actor statistics are not a reset dependency') }
  await f.reset.prepare()
  assert.equal(f.sent.length, 0)
})

test('loadout-runtime: decoded Bedrock slot updates recover unobserved armor/offhand before normal reset work', async t => {
  const f = await bridge(t)
  const { createArmor } = require('../src/armor')
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const serializer = createSerializer('1.26.60'), deserializer = createDeserializer('1.26.60')
  const armor = createArmor({ client: f.host.client, crafting: f.crafting, getState: () => f.state, store: f.armorStore })
  const received = []
  function receive (name, params) {
    const packet = deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data
    received.push(packet)
    // Runtime's order: inspection -> crafting -> armor -> command receiver.
    f.inspection.applyPacket(packet.name, packet.params)
    if (packet.name === 'inventory_content' && packet.params.window_id === 'inventory') f.main.splice(0, 36, ...packet.params.input)
    if (packet.name === 'inventory_slot' && packet.params.window_id === 'inventory') f.main[packet.params.slot] = packet.params.item
    armor.applyPacket(packet.name, packet.params)
    f.reset.applyPacket(packet.name, packet.params)
  }
  f.inspection.applyPacket('start_game', {})
  armor.applyPacket('start_game', {})
  receive('inventory_content', { window_id: 'inventory', input: f.main, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: empty() })
  const before = f.inspection.snapshot()
  assert.equal(before.known, true)
  assert.equal(before.armor.known, false)
  assert.equal(before.offhand.known, false)
  let stack = 900, beforeTemplate = null
  f.host.client.queue = (name, packet) => {
    assert.equal(name, 'command_request')
    f.sent.push({ name, packet })
    queueMicrotask(() => {
      const args = packet.command.split(' '), denied = packet.command.startsWith('/setblock')
      if (denied) beforeTemplate = f.inspection.snapshot()
      else if (packet.command === '/clear @s') {
        receive('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, empty), container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: empty() })
      } else if (packet.command.startsWith('/replaceitem entity')) {
        const where = args[3]
        const window = where.startsWith('slot.armor.') ? 'armor' : where === 'slot.weapon.offhand' ? 'offhand' : 'inventory'
        const slot = window === 'armor' ? ['head', 'chest', 'legs', 'feet'].indexOf(where.split('.').at(-1)) : Number(args[4]) + (where === 'slot.inventory' ? 9 : 0)
        const item = args[5] === 'minecraft:air' ? empty() : raw({ name: args[5], count: Number(args[6]) }, stack++)
        receive('inventory_slot', { window_id: window, slot, item, container: { container_id: window, dynamic_container_id: null }, storage_item: empty() })
      } else assert.equal(packet.command, '/testfor @s')
      f.reset.applyPacket('command_output', { origin: packet.origin, output_type: 'all', success_count: denied ? 0 : 1,
        output: [{ success: !denied, message_id: denied ? 'fixture.stop.before.template' : 'commands.generic.success', parameters: [] }], has_data: false })
    })
  }
  const p = await f.reset.prepare()
  assert.equal(f.sent.length, 0)
  assert.equal(p.replaces.armor, null, 'unobserved equipment is not reported as zero worn pieces')
  assert.equal(f.inspection.snapshot().offhand.known, false)
  f.reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' }); await f.reset.drain()
  assert.equal(f.reset.status().error.code, 'RESET_COMMAND_REJECTED', JSON.stringify(f.reset.status()))
  assert.match(f.reset.status().error.message, /fixture.stop.before.template/)
  assert.equal(knownInventory(beforeTemplate), true)
  assert.ok(beforeTemplate.armor.slots.every(s => s.known && s.empty))
  assert.equal(beforeTemplate.offhand.slots[0].empty, true)
  assert.equal(received.filter(p => p.name === 'inventory_slot' && p.params.window_id === 'armor').length, 8)
  assert.equal(received.filter(p => p.name === 'inventory_slot' && p.params.window_id === 'offhand').length, 2)
  assert.equal(f.sent[0].packet.command, '/testfor @s')
  assert.equal(f.reset.status().serverConfirmed, false, 'the deliberate later rejection is never reported as a complete kit')
  assert.equal(f.held(), null)
})

test('loadout-runtime: a cancelled job no longer blocks the v2.2 reset; a paused or running one with unfinished work still does', () => {
  const { jobPending } = require('../src/loadout-runtime-adapter')
  const job = (state, doc = {}) => ({ status: () => ({ state }), document: () => ({ state, ...doc }), holdsWork: () => false })
  const restock = { supplyRestock: { operationId: 'op' } }
  assert.equal(jobPending(job('FINISHED', restock)), false, 'a cancelled job keeps its records but never resumes')
  assert.equal(jobPending(job('PAUSED', restock)), true)
  assert.equal(jobPending(job('PAUSED', { portableStorage: {} })), true)
  assert.equal(jobPending(job('PAUSED', { egress: { operationId: 'e' } })), true)
  assert.equal(jobPending(job('MINE')), true)
  assert.equal(jobPending({ ...job('FINISHED', restock), status: () => ({ state: 'FINISHED', persistence: { status: 'failed' } }) }), true)
  assert.equal(jobPending(null), false)
})
