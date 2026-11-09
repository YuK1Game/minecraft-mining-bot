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
