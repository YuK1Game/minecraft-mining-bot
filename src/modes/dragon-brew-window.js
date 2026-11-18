'use strict'

// Bedrock BrewingStandContainer: 0 ingredient, 1..3 bottles, 4 powder.
// An accepted stack request schedules a fresh open/read; only the actually
// observed bottle variant in the player inventory completes a brewing goal.
const stores = new WeakMap()
const valid = raw => raw && Number.isInteger(raw.network_id) && (raw.network_id === 0 ? raw.count === 0 : raw.count > 0 && raw.stack_id > 0)
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z
const idOf = id => id === 'first' ? 1 : id === 'last' ? 100 : id
const role = slot => slot === 0 ? 'brewing_input' : slot === 4 ? 'brewing_fuel' : 'brewing_result'
const stack = (container_id, slot, raw) => ({ slot_type: { container_id, dynamic_container_id: null }, slot, stack_id: raw.network_id ? raw.stack_id : 0 })

function observeBrewing (host, name, packet) {
  if (['start_game', 'change_dimension', 'disconnect', 'close', 'respawn'].includes(name) || name === 'container_open') stores.delete(host)
  if (name === 'container_open' && ['brewing_stand', 4].includes(packet.window_type)) {
    stores.set(host, { id: idOf(packet.window_id), position: packet.coordinates, slots: new Array(5).fill(null), fuel: null, result: null, pending: null })
    return
  }
  const w = stores.get(host)
  if (!w) return
  if (name === 'item_stack_response') {
    const result = packet.responses?.find(row => row.request_id === w.pending)
    if (result) w.result = result
  }
  if (idOf(packet.window_id) !== w.id) return
  if (name === 'container_close') stores.delete(host)
  if (name === 'container_set_data' && packet.property === 1) w.fuel = packet.value
  if (name === 'inventory_content') w.slots = packet.input?.length === 5 ? packet.input.slice() : new Array(5).fill(null)
  if (name === 'inventory_slot' && Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot <= 4) w.slots[packet.slot] = packet.item
}

function windowAt (host, position) {
  const w = stores.get(host)
  return same(w?.position, position) && w.slots.every(valid) ? w : null
}

async function transferBrew ({ host, w, playerSlot, brewSlot, take, rawItem, commit, cancelled, sleep }) {
  const main = rawItem(playerSlot), vessel = w.slots[brewSlot]
  if (stores.get(host) !== w || cancelled() || !valid(main) || !valid(vessel)) return false
  const hand = stack('hotbar_and_inventory', playerSlot, main), stand = stack(role(brewSlot), brewSlot, vessel)
  const source = take ? stand : hand, destination = take ? hand : stand
  if (source.stack_id <= 0 || destination.stack_id !== 0) return false
  const id = host.allocate('craft')
  w.pending = id; w.result = null
  host.client.queue('item_stack_request', { requests: [{ request_id: id, actions: [{ type_id: take ? 'take' : 'place', legacy_type_id: take ? 0 : 1, count: 1, source, destination }], custom_names: [], cause: -1 }] })
  for (let i = 0; i < 40 && !cancelled() && stores.get(host) === w; i++) {
    if (w.result !== null) {
      const ack = w.result
      if (ack.status !== 'ok' && ack.status !== 0) return false
      const value = (ack.containers ?? []).filter(c => c.slot_type?.dynamic_container_id == null && ['hotbar_and_inventory','inventory','hotbar',12,28,29].includes(c.slot_type?.container_id))
        .flatMap(c => c.slots ?? []).find(s => s.slot === playerSlot)
      const expected = take ? 1 : main.count - 1
      if (!value || value.count !== expected || expected > 0 && !(value.item_stack_id > 0)) return false
      const observed = rawItem(playerSlot)
      if (observed?.count === expected && (expected === 0 || observed.stack_id === value.item_stack_id)) return true
      if (observed?.network_id !== main.network_id || observed?.count !== main.count || observed?.stack_id !== main.stack_id) return false
      const item = expected ? { ...(take ? vessel : main), count: expected, has_stack_id:true, stack_id:value.item_stack_id }
        : { network_id:0, count:0, metadata:0, block_runtime_id:0, has_stack_id:false, extra:{has_nbt:'false',can_place_on:[],can_destroy:[]} }
      commit({ window_id:'inventory', slot:playerSlot, item, requestId:id, source:'server_item_stack_response' })
      return true
    }
    await sleep(100)
  }
  return false
}
module.exports = { observeBrewing, windowAt, transferBrew, same }
