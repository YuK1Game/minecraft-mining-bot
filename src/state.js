'use strict'

function vector (value) {
  if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))) return null
  return { x: value.x, y: value.y, z: value.z }
}

function createState (profile, clock = () => new Date().toISOString()) {
  const state = {
    phase: 'starting', profile, realm: null, playerName: null, version: null,
    runtimeEntityId: null, dimension: null, position: null, spawnPosition: null, spawnPending: false,
    positionSource: null, positionUpdatedAt: null, rotation: null, health: null, healthSource: null,
    breath: { current: null, maximum: null, currentUpdatedAt: null, maximumUpdatedAt: null },
    gameMode: null, selectedSlot: null, heldItem: null,
    inventory: { known: false, items: [] },
    startedAt: clock(), connectedAt: null, lastError: null,
    capabilities: { movement: false, mining: false }
  }
  const names = new Map()
  const slots = new Map()
  let uniqueEntityId = null
  let worldGameMode = null
  const ownEntity = id => state.runtimeEntityId !== null && id != null && String(id) === state.runtimeEntityId
  function resetBreath () {
    state.breath = { current: null, maximum: null, currentUpdatedAt: null, maximumUpdatedAt: null }
  }
  function setPosition (value, source) {
    const position = vector(value)
    if (position) {
      state.position = position
      state.positionSource = source
      state.positionUpdatedAt = clock()
    }
  }
  function updateInventory () {
    state.inventory.items = [...slots.entries()]
      .filter(([, item]) => item && item.network_id !== 0 && item.count > 0)
      .map(([slot, item]) => ({ slot, name: names.get(item.network_id) ?? null, networkId: item.network_id, count: item.count, metadata: item.metadata ?? 0 }))
      .sort((a, b) => a.slot - b.slot)
    state.heldItem = state.selectedSlot === null ? null : state.inventory.items.find(item => item.slot === state.selectedSlot) ?? null
  }
  function applyPacket (name, packet) {
    switch (name) {
      case 'start_game':
        state.healthSource = null
        state.spawnPending = false
        resetBreath()
        state.runtimeEntityId = String(packet.runtime_entity_id)
        uniqueEntityId = packet.entity_id == null ? null : String(packet.entity_id)
        worldGameMode = packet.world_gamemode
        state.dimension = packet.dimension
        state.spawnPosition = vector(packet.spawn_position)
        state.rotation = packet.rotation ? { pitch: packet.rotation.x, yaw: packet.rotation.z } : null
        state.gameMode = packet.player_gamemode === 'fallback' || packet.player_gamemode === 5 ? packet.world_gamemode : packet.player_gamemode ?? null
        setPosition(packet.player_position, name)
        for (const item of packet.itemstates ?? []) names.set(item.runtime_id, item.name)
        updateInventory()
        break
      case 'move_player':
        if (!ownEntity(packet.runtime_id)) break
        setPosition(packet.position, name)
        state.rotation = { pitch: packet.pitch, yaw: packet.yaw }
        break
      case 'correct_player_move_prediction':
      case 'server_post_move':
        setPosition(packet.position, name)
        break
      case 'change_dimension':
        resetBreath()
        state.dimension = ['overworld', 'nether', 'end'][packet.dimension] ?? packet.dimension
        setPosition(packet.position, name)
        break
      case 'respawn':
        if (ownEntity(packet.runtime_entity_id) && packet.state === 1) { resetBreath(); setPosition(packet.position, name) }
        break
      case 'set_entity_data': {
        if (!ownEntity(packet.runtime_entity_id) || !Array.isArray(packet.metadata)) break
        for (const entry of packet.metadata) {
          // These are server observations, not an assumed starting air supply.
          // Negative current values are possible once drowning has begun.
          if (entry?.type !== 'short' || !Number.isInteger(entry.value) || entry.value < -32768 || entry.value > 32767) continue
          if (entry.key === 'air') {
            state.breath.current = entry.value
            state.breath.currentUpdatedAt = clock()
          } else if (entry.key === 'max_airdata_max_air' && entry.value >= 0) {
            state.breath.maximum = entry.value
            state.breath.maximumUpdatedAt = clock()
          }
        }
        break
      }
      case 'set_health':
        if (Number.isFinite(packet.health)) {
          // set_health carries an integer. Once the server has supplied a
          // precise attribute, an equal rounded-up integer must not invent a
          // small heal followed by a false damage event on the next attribute.
          const coarseEquivalent = state.healthSource === 'update_attributes' && Number.isFinite(state.health) && state.health > 0 && Number.isInteger(packet.health) && Math.ceil(state.health) === packet.health
          if (!coarseEquivalent) { state.health = packet.health; state.healthSource = 'set_health' }
        }
        break
      case 'update_attributes':
        if (!ownEntity(packet.runtime_entity_id)) break
        for (const attribute of packet.attributes ?? []) {
          if (attribute.name === 'minecraft:health' && Number.isFinite(attribute.current)) { state.health = attribute.current; state.healthSource = 'update_attributes' }
        }
        break
      case 'mob_equipment':
        if (ownEntity(packet.runtime_entity_id) && (packet.window_id === 'inventory' || packet.window_id === 0)) {
          state.selectedSlot = Number.isInteger(packet.selected_slot) && packet.selected_slot >= 0 && packet.selected_slot <= 8 ? packet.selected_slot : null
          updateInventory()
        }
        break
      case 'player_hotbar':
        if (packet.window_id === 'inventory' || packet.window_id === 0) {
          state.selectedSlot = Number.isInteger(packet.selected_slot) && packet.selected_slot >= 0 && packet.selected_slot <= 8 ? packet.selected_slot : null
          updateInventory()
        }
        break
      case 'set_player_game_type':
        state.gameMode = packet.gamemode === 'fallback' || packet.gamemode === 5 ? worldGameMode : packet.gamemode
        break
      case 'update_player_game_type':
        if (uniqueEntityId !== null && String(packet.player_unique_id) === uniqueEntityId) {
          state.gameMode = packet.gamemode === 'fallback' || packet.gamemode === 5 ? worldGameMode : packet.gamemode
        }
        break
      case 'item_registry':
        for (const item of packet.itemstates ?? []) names.set(item.runtime_id, item.name)
        updateInventory()
        break
      case 'inventory_content':
        if (packet.window_id !== 'inventory' && packet.window_id !== 0) break
        slots.clear()
        for (const [slot, item] of (packet.input ?? []).entries()) slots.set(slot, item)
        state.inventory.known = true
        updateInventory()
        break
      case 'inventory_slot':
        if (packet.window_id !== 'inventory' && packet.window_id !== 0) break
        slots.set(packet.slot, packet.item)
        updateInventory()
        break
    }
  }
  return { state, applyPacket, snapshot: () => structuredClone(state) }
}

module.exports = { createState }
