'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryV22Equipment } = require('../src/quarry-v22-equipment')
const raw = (id = 0, stack_id = 0) => ({ network_id: id, count: id ? 1 : 0, has_stack_id: !!id, stack_id, metadata: 0, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const name = id => ({ 1: 'minecraft:totem_of_undying', 2: 'minecraft:diamond_helmet' })[id]
function fixture () {
  const bag = Array.from({ length: 36 }, () => raw()), armor = Array.from({ length: 4 }, () => raw()), offhand = [raw()], commands = [], uncertain = []
  const state = { phase: 'spawned', profile: 'p', realm: { id: 2 }, dimension: 'overworld', connectionId: 'c', startedAt: '2026-11-11T00:00:00Z', runtimeEntityId: '11', lifecycle: { deathId: 0 }, health: 20, gameMode: 'survival', inventory: { known: true } }
  bag[5] = raw(1, 10); bag[6] = raw(2, 11)
  const slot = (r, i) => ({ slot: i, known: true, empty: !r.count, name: r.count ? name(r.network_id) : null, count: r.count })
  const getView = () => ({ known: true, slots: bag.map(slot), armor: { known: true, slots: armor.map(slot) }, offhand: { known: true, slots: offhand.map(slot) } })
  const equipment = createQuarryV22Equipment({
    client: { queue: (type, data) => { assert.equal(type, 'item_stack_request'); commands.push(data.requests[0]) } },
    getState: () => state, getView, getRawMain: n => bag[n],
    getRawEquipment: (kind, n) => (kind === 'armor' ? armor : offhand)[n],
    allocateRequestId: () => -3 - commands.length * 2,
    commitMain: (i, next) => { bag[i] = next },
    commitEquipment: (kind, i, next) => { (kind === 'armor' ? armor : offhand)[i] = next },
    onUncertain: e => uncertain.push(e), timeoutMs: 1000
  })
  const acknowledge = ({ source, destination, status = 'ok', includeDestination = true } = {}) => {
    const p = commands.at(-1)
    const groups = [{
      slot_type: { container_id: source ?? 'hotbar_and_inventory' },
      slots: [{ slot: p.actions[0].source.slot, count: 0, item_stack_id: 0 }]
    }]
    if (includeDestination) groups.push({
      slot_type: { container_id: destination ?? 'offhand' },
      slots: [{ slot: p.actions[0].destination.slot, count: 1, item_stack_id: 111 }]
    })
    equipment.applyPacket('item_stack_response', { responses: [{ request_id: p.request_id, status, containers: groups }] })
  }
  return { equipment, bag, armor, offhand, commands, uncertain, state, acknowledge }
}
test('equip totem from main into offhand using matching server stack response', async () => {
  const f = fixture(), task = f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' })
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].actions[0].type_id, 'place')
  f.acknowledge()
  const proof = await task
  assert.equal(proof.serverConfirmed, true)
  assert.equal(f.bag[5].count, 0)
  assert.equal(f.offhand[0].network_id, 1)
  assert.equal(f.uncertain.length, 0)
})
test('offhand unloads to main only into an observed empty slot', async () => {
  const f = fixture()
  f.offhand[0] = raw(1, 10); f.bag[5] = raw()
  const task = f.equipment.transfer({ from: 'offhand', fromSlot: 0, to: 'main', toSlot: 5, expectedName: 'minecraft:totem_of_undying' })
  f.acknowledge({ source: 'offhand', destination: 'hotbar_and_inventory' })
  await task
  assert.equal(f.bag[5].network_id, 1)
  assert.equal(f.offhand[0].count, 0)
})
test('armor unloads to main with same confirmed take request', async () => {
  const f = fixture(); f.armor[0] = raw(2, 10); f.bag[5] = raw()
  const task = f.equipment.transfer({ from: 'armor', fromSlot: 0, to: 'main', toSlot: 5, expectedName: 'minecraft:diamond_helmet' })
  f.acknowledge({ source: 'armor', destination: 'hotbar_and_inventory' })
  await task
  assert.equal(f.bag[5].network_id, 2)
  assert.equal(f.armor[0].count, 0)
})
test('missing destination receipt does not mutate either inventory', async () => {
  const f = fixture()
  const task = f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' })
  f.acknowledge({ includeDestination: false })
  await assert.rejects(task, { code: 'EQUIPMENT_RECEIPT_UNCONFIRMED' })
  assert.equal(f.bag[5].count, 1)
  assert.equal(f.offhand[0].count, 0)
  assert.equal(f.uncertain.length, 1)
})
test('occupied offhand or stale life cannot run a confirmed transfer', async () => {
  const f = fixture(); f.offhand[0] = raw(1, 40)
  await assert.rejects(f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' }), { code: 'EQUIPMENT_SOURCE_MISMATCH' })
  f.offhand[0] = raw()
  const task = f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' })
  f.state.lifecycle.deathId++
  f.equipment.applyPacket('move_player', {})
  await assert.rejects(task, { code: 'EQUIPMENT_SCOPE_CHANGED' })
  assert.equal(f.commands.length, 1)
})