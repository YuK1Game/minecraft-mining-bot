'use strict'
// Actual reset adapter + inventory controller + command receipts, with an
// offline server. Decode real Bedrock packets; never connect to a Realm.
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { fixture } = require('./helpers/loadout-sim')
const { createInventory } = require('../src/inventory')
const { createRuntimeLoadoutReset } = require('../src/loadout-runtime-adapter')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const mc = require('minecraft-data')('bedrock_1.26.60')

test('loadout-hand: real adapter and encoded packets recover a stale cached hand and build all 24 boxes', async t => {
  const f = fixture({ serverSlot: 5 }); f.state.rawSelectedSlot = 0
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-loadout-hand-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const serializer = createSerializer('1.26.60'), deserializer = createDeserializer('1.26.60')
  const packets = [], receive = (name, params) => deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data
  let reset
  const client = { queue (name, params) {
    const p = receive(name, params); packets.push(p)
    if (name === 'mob_equipment') { f.setSelected(p.params.selected_slot); return }
    assert.equal(name, 'command_request')
    void Promise.resolve().then(async () => {
      let failure
      try { await f.commands.send(p.params.command) } catch (error) { failure = error }
      const reply = receive('command_output', { origin: p.params.origin, output_type: 'all', success_count: failure ? 0 : 1, has_data: false,
        output: [{ success: !failure, message_id: failure?.messageId ?? (p.params.command.startsWith('/testfor') ? 'commands.testfor.success' : 'commands.generic.success'), parameters: [f.state.playerName] }] })
      reset.applyPacket(reply.name, reply.params)
    }).catch(error => { t.diagnostic(String(error)); reset.cancel() })
  } }
  const rawItem = i => {
    const x = f.view.slots[i]
    return { network_id: x.empty ? 0 : mc.itemsByName[x.name.replace('minecraft:', '')].id, count: x.count, metadata: 0,
      has_stack_id: !x.empty, ...(x.empty ? {} : { stack_id: x.stackId }), block_runtime_id: 0,
      extra: { has_nbt: false, can_place_on: [], can_destroy: [] } }
  }
  const crafting = { rawItem, applyPacket () {}, itemNameOf: id => `minecraft:${mc.items[id]?.name}`,
    status: () => ({ authority: true, inventoryKnown: true, openContainer: f.adapter.container() }),
    snapshot: () => crafting.status(), closeContainer: () => { void f.adapter.close() } }
  const inventory = createInventory({ client, getState: () => f.state, crafting, allocateRequestId: () => -1,
    commitSelection: slot => { f.state.rawSelectedSlot = slot } })
  const originalSelect = inventory.selectHotbarForReset.bind(inventory)
  let selections = 0
  inventory.selectHotbarForReset = (...args) => { selections++; return originalSelect(...args) }
  inventory.equipForCombat = () => { throw Error('reset must not use the cached combat selection shortcut') }
  const host = { client, shared: { loadingScreenEnded: true }, world: { getBlock: f.adapter.getBlock } }
  reset = createRuntimeLoadoutReset({ host, getState: () => f.state,
    inspection: { snapshot: () => ({ ...f.adapter.getView(), openContainer: f.adapter.container() }) }, crafting,
    armor: { equipBest: f.adapter.equipArmor }, inventory, chest: { open: f.adapter.open, depositItem: f.adapter.deposit },
    assertIdle: f.adapter.assertIdle, acquire: f.adapter.acquire, release: f.adapter.release,
    getJob: () => null, generation: () => 1, cancelTransfers: f.adapter.cancelTransfers, journalDirectory: directory })
  const p = await reset.prepare()
  reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' }); await reset.drain()
  assert.equal(reset.status().serverConfirmed, true, JSON.stringify(reset.status()))
  assert.equal(selections, 63)
  assert.equal(f.blocks.size, 0)
  assert.equal(f.view.slots.filter(x => x.container).length, 12) // 8 cargo (v2) + 4 supply
  assert.equal(f.selected(), 1)
  assert.equal(f.lease(), null)
  // Every tool selection is followed by a scoped server hand query, before
  // any enchant is sent. This crosses the REAL runtime adapter boundary.
  for (let i = 0; i < packets.length; i++) {
    if (packets[i].name !== 'mob_equipment') continue
    assert.equal(packets[i + 1].name, 'command_request')
    assert.match(packets[i + 1].params.command, /^\/testfor @s\[hasitem=/)
  }
  const [journal] = await fs.readdir(directory)
  const saved = JSON.parse(await fs.readFile(path.join(directory, journal), 'utf8'))
  assert.equal(saved.phase, 'completed'); assert.equal(saved.serverConfirmed, true)
})
