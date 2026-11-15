'use strict'

// Connection-owned observations. Behaviour modules may be recreated; raw
// server recipe/stack IDs and open-container state belong to this connection.
function createSessionCache () {
  let startGame = null
  let registry = null
  let recipes = []
  let inventory = null
  let container = null
  let hotbar = null
  let revision = 0
  function observe (name, packet) {
    revision++
    if (name === 'start_game') {
      startGame = packet
      registry = null; recipes = []; inventory = null; container = null; hotbar = null
    } else if (name === 'item_registry') registry = packet
    else if (name === 'crafting_data') {
      if (packet.clear_recipes) recipes = []
      if (recipes.length >= 32) throw new Error('レシピの更新数が多すぎるため行動の再読み込みを停止します。')
      recipes.push(packet)
    } else if (name === 'inventory_content' && (packet.window_id === 0 || packet.window_id === 'inventory')) {
      inventory = { ...packet, input: [...packet.input] }
    } else if (name === 'inventory_slot' && (packet.window_id === 0 || packet.window_id === 'inventory')) {
      if (inventory && Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot < 36) inventory.input[packet.slot] = packet.item
    } else if (name === 'container_open') container = packet
    else if (name === 'container_close' && container?.window_id === packet.window_id) container = null
    else if (name === 'player_hotbar') hotbar = packet
  }
  function replay (receive) {
    if (startGame) receive('start_game', startGame)
    if (registry) receive('item_registry', registry)
    for (const recipe of recipes) receive('crafting_data', recipe)
    if (inventory) receive('inventory_content', { ...inventory, input: [...inventory.input] })
    if (hotbar) receive('player_hotbar', hotbar)
    if (container) receive('container_open', container)
  }
  return { observe, replay, snapshot: () => ({ revision, startGameKnown: startGame !== null, registryKnown: registry !== null, recipePackets: recipes.length, inventoryKnown: inventory !== null, openContainer: container ? { id: container.window_id, type: container.window_type } : null }) }
}

module.exports = { createSessionCache }
