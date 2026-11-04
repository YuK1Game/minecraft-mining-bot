'use strict'

const { resourceMinHealth } = require('./learning-health')

// Authoritative inventory requests only. Recipe and stack network IDs always
// come from the current connection; no recipe IDs survive a reconnect.
const VERSION = '1.26.60'
const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo', 'crimson', 'warped'])
// Vanilla Bedrock's stone_tool_materials and stone_crafting_materials share
// these three item values; intact stone/deepslate are not crafting materials.
const STONE_MATERIALS = new Set(['cobblestone', 'cobbled_deepslate', 'blackstone'])
const RECIPE_OUTPUTS = new Set(['minecraft:crafting_table', 'minecraft:stick', 'minecraft:wooden_pickaxe', 'minecraft:wooden_sword', 'minecraft:stone_pickaxe', 'minecraft:iron_pickaxe', 'minecraft:furnace', 'minecraft:chest', 'minecraft:torch', 'minecraft:stone_sword'])
const EMPTY_EXTRA = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const nameOf = name => String(name).includes(':') ? String(name) : `minecraft:${name}`
const copy = value => structuredClone(value)
const inventoryWindow = id => id === 'inventory' || id === 0
const fullName = container => ({ container_id: container, dynamic_container_id: null })
const slotInfo = (container, slot, stackId) => ({ slot_type: fullName(container), slot, stack_id: stackId })
// Cereal's variant list omits legacy container actions 7/8. Keep the full
// Action enum separately, rather than copying the variant index into the byte.
const LEGACY_ACTION = { take: 0, consume: 5, craft_recipe_auto: 13, results_deprecated: 20 }
function action (type, data) {
  if (!Object.hasOwn(LEGACY_ACTION, type)) throw new Error('未対応のクラフト操作です。')
  return { type_id: type, legacy_type_id: LEGACY_ACTION[type], ...data }
}

function createCrafting ({ client, getState, version = VERSION, timeoutMs = 8000, onInventory = () => {}, allocateRequestId, onUncertain = () => {}, onContainerClose = () => {} }) {
  if (version !== VERSION) throw new Error(`クラフト入力は${VERSION}専用です。`)
  if (typeof client?.queue !== 'function' || typeof getState !== 'function') throw new Error('クラフトには接続と状態取得関数が必要です。')
  if (allocateRequestId !== undefined && typeof allocateRequestId !== 'function') throw new Error('allocateRequestIdは関数で指定してください。')
  if (typeof onUncertain !== 'function') throw new Error('onUncertainは関数で指定してください。')
  if (typeof onContainerClose !== 'function') throw new Error('onContainerCloseは関数で指定してください。')
  const names = new Map()
  const inventory = new Map()
  const recipes = new Map()
  let inventoryKnown = false
  let authority = false
  let openContainer = null
  let nextRequestId = -1
  let pending = null
  let opening = null
  let lastResult = null

  function itemName (item) { return item?.network_id ? names.get(item.network_id) ?? null : null }
  function empty (item) { return !item || item.network_id === 0 || item.count === 0 }
  function rawItem (slot) { return inventory.has(slot) ? copy(inventory.get(slot)) : null }
  function inventoryPacket () {
    return { window_id: 'inventory', input: Array.from({ length: 36 }, (_, slot) => copy(inventory.get(slot) ?? { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: EMPTY_EXTRA })), container: fullName('inventory'), storage_item: { network_id: 0 } }
  }
  function rejectPending (message) {
    if (!pending) return
    const request = pending
    pending = null
    clearTimeout(request.timer)
    if (request.wireSent && !request.serverRejected && !request.serverConfirmed && !request.uncertaintyNotified) {
      request.uncertaintyNotified = true
      inventoryKnown = false
      try { onUncertain({ requestId: request.id, reason: String(message) }) } catch { /* Reporting cannot prevent promise cleanup. */ }
    }
    lastResult = { phase: 'failed', requestId: request.id, reason: message }
    request.reject(new Error(message))
  }
  function reset () {
    rejectPending('接続が切り替わったためクラフトを中止しました。')
    if (opening) {
      const request = opening; opening = null; clearTimeout(request.timer)
      request.reject(new Error('接続が切り替わったためインベントリ表示を中止しました。'))
    }
    names.clear(); inventory.clear(); recipes.clear()
    inventoryKnown = false
    authority = false
    openContainer = null
    nextRequestId = -1
    lastResult = null
  }

  function matches (ingredient, item) {
    const name = itemName(item)
    if (!name || empty(item)) return false
    if (ingredient.descriptor_type === 'name') return name === nameOf(ingredient.name) && (ingredient.metadata == null || ingredient.metadata < 0 || ingredient.metadata === 32767 || ingredient.metadata === item.metadata)
    if (ingredient.descriptor_type === 'item_tag') {
      // Only known vanilla material tags needed for the bootstrap recipes.
      // Unknown/custom tags are not guessed; the server still validates all requests.
      const tag = String(ingredient.tag).replace(/^minecraft:/, '')
      const local = name.replace(/^minecraft:/, '')
      if (tag === 'planks') return local.endsWith('_planks') && WOODS.has(local.slice(0, -7))
      if (tag === 'logs' || tag === 'logs_that_burn') return local.endsWith('_log') && WOODS.has(local.slice(0, -4))
      if (tag === 'stone_tool_materials' || tag === 'stone_crafting_materials') return STONE_MATERIALS.has(local)
    }
    return false
  }

  function validateSession ({ inventoryRequired = true } = {}) {
    const state = getState()
    if (state.dead === true || state.isDead === true || state.health === 0 || state.phase === 'dead') throw new Error('死亡状態ではクラフトできません。')
    if (state.phase !== 'spawned') throw new Error('ワールドへの参加が必要です。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('サバイバルモードでのみクラフトします。')
    if (!Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new Error('体力を確認できないか、体力が少ないためクラフトを停止します。')
    if (!authority) throw new Error('サーバー権威のインベントリが確認できません。')
    if (inventoryRequired && !inventoryKnown) throw new Error('スタックID付きの持ち物をまだ取得できていません。')
    return state
  }

  function planRecipe (recipe, outputName, times) {
    const output = recipe.output?.[0]
    if (recipe.output?.length !== 1 || !output || output.count < 1) throw new Error('単一の結果を返すレシピだけに対応しています。')
    const count = output.count * times
    if (count > 64) throw new Error('1回のリクエストで作る個数は64個以下にしてください。')
    const tableRequired = recipe.kind === 'shaped' ? recipe.width > 2 || recipe.height > 2 : recipe.input.filter(ingredient => ingredient.type !== 'invalid' && ingredient.count > 0).length > 4
    if (tableRequired && openContainer?.type !== 'workbench' && openContainer?.type !== 1) {
      const error = new Error('このレシピには設置した作業台を開く必要があります。')
      error.needsCraftingTable = true
      throw error
    }
    const available = new Map([...inventory].map(([slot, item]) => [slot, item.count ?? 0]))
    const allocations = new Map()
    const consumptions = []
    for (const [ingredientIndex, ingredient] of recipe.input.entries()) {
      if (ingredient.type === 'invalid' || ingredient.count === 0 || ingredient.descriptor_type === 'empty') continue
      if (!Number.isInteger(ingredient.count) || ingredient.count < 1) throw new Error('レシピの材料数を解釈できません。')
      let remaining = ingredient.count * times
      for (const [slot, item] of inventory) {
        if (!matches(ingredient, item)) continue
        const taken = Math.min(available.get(slot), remaining)
        if (!taken) continue
        if (item.has_stack_id !== true || !Number.isInteger(item.stack_id) || item.stack_id <= 0) throw new Error('材料の有効なスタックIDがありません。')
        allocations.set(slot, (allocations.get(slot) ?? 0) + taken)
        // Auto-crafting consumes each nonempty recipe input separately. The
        // same inventory stack can supply several grid inputs, but combining
        // them into one larger Consume action exceeds one input's quantity.
        consumptions.push({ slot, count: taken, ingredientIndex })
        available.set(slot, available.get(slot) - taken)
        remaining -= taken
        if (!remaining) break
      }
      if (remaining) throw new Error(`材料が不足しています: ${ingredient.name ?? ingredient.tag ?? ingredient.descriptor_type}`)
    }
    const destination = Array.from({ length: 36 }, (_, slot) => slot).find(slot => empty(inventory.get(slot)))
    if (destination === undefined) throw new Error('クラフト結果を置く空きスロットがありません。')
    const ingredients = []
    for (let ingredientIndex = 0; ingredientIndex < recipe.input.length; ingredientIndex++) {
      const concrete = new Map()
      for (const { slot, count } of consumptions.filter(value => value.ingredientIndex === ingredientIndex)) {
        const item = inventory.get(slot)
        const name = itemName(item)
        const key = `${name}|${item.metadata ?? 0}`
        const previous = concrete.get(key)
        concrete.set(key, { type: 'name', legacy_type: 1, name, metadata: item.metadata ?? 0, count: (previous?.count ?? 0) + count })
      }
      for (const ingredient of concrete.values()) {
        ingredient.count /= times
        if (!Number.isInteger(ingredient.count)) throw new Error('材料の種類が混在しています。1回ずつクラフトしてください。')
        ingredients.push(ingredient)
      }
    }
    return { recipe, outputName, output: copy(output), outputCount: count, times, destination, allocations, consumptions, before: new Map([...allocations.keys()].map(slot => [slot, copy(inventory.get(slot))])), ingredients, tableRequired }
  }

  function findPlan (outputName, { times = 1 } = {}) {
    outputName = nameOf(outputName)
    validateSession()
    if (!Number.isInteger(times) || times < 1 || times > 16) throw new Error('timesは1〜16の整数で指定してください。')
    const candidates = [...recipes.values()].filter(recipe => recipe.block === 'crafting_table' && recipe.output?.length === 1 && itemName(recipe.output[0]) === outputName)
    if (!candidates.length) throw new Error(`サーバーから受信したレシピがありません: ${outputName}`)
    const errors = []
    for (const recipe of candidates) {
      try { return planRecipe(recipe, outputName, times) } catch (error) { errors.push(error) }
    }
    const error = new Error([...new Set(errors.map(error => error.message))].join('\n'))
    error.needsCraftingTable = errors.some(error => error.needsCraftingTable)
    throw error
  }
  function summarizePlan (plan) {
    return { ready: true, output: { name: plan.outputName, count: plan.outputCount }, recipeNetworkId: plan.recipe.network_id, recipeId: plan.recipe.recipe_id, times: plan.times, destination: plan.destination, needsCraftingTable: plan.tableRequired, materials: [...plan.allocations].map(([slot, count]) => ({ slot, name: itemName(inventory.get(slot)), count })) }
  }
  function preview (outputName, options) {
    try { return summarizePlan(findPlan(outputName, options)) } catch (error) { return { ready: false, errors: [error.message], needsCraftingTable: error.needsCraftingTable === true } }
  }

  function buildRequest (plan, requestId) {
    const result = { type: 'name', legacy_type: 1, name: plan.outputName, metadata: plan.output.metadata ?? 0, count: plan.output.count, block_runtime_id: (plan.output.block_runtime_id ?? 0) >>> 0, extra: copy(plan.output.extra ?? EMPTY_EXTRA) }
    return {
      request_id: requestId,
      actions: [
        // The variant index omits legacy action IDs 7 and 8. The following byte
        // still carries the full legacy enum: auto-craft is variant 11 / type 13.
        action('craft_recipe_auto', { recipe_network_id: plan.recipe.network_id, times_crafted: plan.times, ingredients: plan.ingredients }),
        // Compatibility result descriptor: it is derived from the received recipe,
        // not from a locally invented recipe or client-only result.
        action('results_deprecated', { result_items: [result], times_crafted: plan.times }),
        ...plan.consumptions.map(({ slot, count }) => action('consume', { count, source: slotInfo('hotbar_and_inventory', slot, inventory.get(slot).stack_id) })),
        // Wire enum 60 is CreatedOutputContainer; minecraft-data names it creative_output.
        action('take', { count: plan.outputCount, source: slotInfo('creative_output', 50, requestId), destination: slotInfo('hotbar_and_inventory', plan.destination, 0) })
      ],
      custom_names: [], cause: -1
    }
  }

  function finishIfConfirmed () {
    if (!pending?.accepted) return
    try { validateSession() } catch (error) { cancel(error.message); return }
    const request = pending
    const item = inventory.get(request.plan.destination)
    if (itemName(item) !== request.plan.outputName || item.count !== request.plan.outputCount || item.has_stack_id !== true || item.stack_id <= 0) return
    for (const [slot, used] of request.plan.allocations) {
      const before = request.plan.before.get(slot)
      const after = inventory.get(slot)
      const expectedCount = before.count - used
      if (expectedCount === 0 ? !empty(after) : !after || after.network_id !== before.network_id || after.count !== expectedCount || !after.has_stack_id || after.stack_id <= 0) return
    }
    request.serverConfirmed = true
    pending = null
    clearTimeout(request.timer)
    lastResult = { phase: 'completed', requestId: request.id, output: { name: request.plan.outputName, count: request.plan.outputCount }, confirmedBy: request.confirmedBy }
    onInventory(inventoryPacket())
    request.resolve(copy(lastResult))
  }
  function applyResponse (response) {
    if (!pending || response.request_id !== pending.id) return
    if (response.status !== 'ok' && response.status !== 0) { pending.serverRejected = true; rejectPending('サーバーがクラフト要求を拒否しました。'); return }
    pending.accepted = true
    pending.confirmedBy = 'item_stack_response'
    const updates = []
    for (const container of response.containers ?? []) {
      if (!['inventory', 'hotbar_and_inventory', 'hotbar', 12, 28, 29].includes(container.slot_type?.container_id)) continue
      for (const slot of container.slots ?? []) {
        if (slot.slot < 0 || slot.slot >= 36) continue
        updates.push(slot)
      }
    }
    const destination = updates.find(update => update.slot === pending.plan.destination && update.count === pending.plan.outputCount && Number.isInteger(update.item_stack_id) && update.item_stack_id > 0)
    if (destination && [...pending.plan.allocations].every(([slot, used]) => {
      const update = updates.find(update => update.slot === slot)
      const expectedCount = pending.plan.before.get(slot).count - used
      return update && update.count === expectedCount && (expectedCount === 0 || Number.isInteger(update.item_stack_id) && update.item_stack_id > 0)
    })) {
      // Commit a prediction only after the server accepts this exact request and
      // supplies the destination count and its authoritative new stack ID.
      const { plan } = pending
      for (const [slot, used] of plan.allocations) {
        const item = plan.before.get(slot)
        const update = updates.find(update => update.slot === slot)
        if (update) {
          const count = update.count
          inventory.set(slot, count ? { ...item, count, stack_id: update.item_stack_id ?? item.stack_id, has_stack_id: true } : { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: copy(EMPTY_EXTRA) })
        }
      }
      inventory.set(plan.destination, { ...copy(plan.output), count: destination.count, has_stack_id: true, stack_id: destination.item_stack_id, block_runtime_id: (plan.output.block_runtime_id ?? 0) >>> 0 })
    }
    finishIfConfirmed()
  }

  function applyPacket (name, packet) {
    if (name === 'change_dimension' || name === 'disconnect') {
      cancel('接続・次元が変わったためクラフトを中止しました。')
      openContainer = null
      return
    }
    if ((pending || opening) && name !== 'start_game') {
      try { validateSession({ inventoryRequired: pending !== null }) } catch (error) {
        cancel(error.message)
        // A delayed accepted response must not resurrect death-dropped items
        // into the current inventory. Wait for a new full server snapshot.
        if (getState().health === 0 || getState().dead === true || getState().isDead === true) inventoryKnown = false
      }
    }
    if (name === 'start_game') {
      reset()
      authority = packet.server_authoritative_inventory === true
      for (const item of packet.itemstates ?? []) names.set(item.runtime_id, nameOf(item.name))
    } else if (name === 'item_registry') {
      for (const item of packet.itemstates ?? []) names.set(item.runtime_id, nameOf(item.name))
    } else if (name === 'crafting_data') {
      if (packet.clear_recipes) recipes.clear()
      for (const kind of ['shaped', 'shapeless']) {
        for (const recipe of packet[`${kind}_recipes`] ?? []) {
          if (Number.isInteger(recipe.network_id) && recipe.network_id > 0) recipes.set(recipe.network_id, { ...copy(recipe), kind })
        }
      }
    } else if (name === 'inventory_content' && inventoryWindow(packet.window_id)) {
      inventory.clear()
      for (const [slot, item] of (packet.input ?? []).entries()) if (slot < 36) inventory.set(slot, copy(item))
      inventoryKnown = true
      finishIfConfirmed()
    } else if (name === 'inventory_slot' && inventoryWindow(packet.window_id)) {
      if (packet.slot >= 0 && packet.slot < 36) inventory.set(packet.slot, copy(packet.item))
      finishIfConfirmed()
    } else if (name === 'item_stack_response') {
      for (const response of packet.responses ?? []) applyResponse(response)
    } else if (name === 'container_open') {
      openContainer = { id: packet.window_id, type: packet.window_type, coordinates: copy(packet.coordinates) }
      if (opening) {
        const request = opening; opening = null; clearTimeout(request.timer)
        request.resolve(copy(openContainer))
      }
    } else if (name === 'container_close' && openContainer?.id === packet.window_id) {
      openContainer = null
      rejectPending('クラフト画面が閉じられました。')
    }
  }

  function openInventory () {
    const state = validateSession({ inventoryRequired: false })
    if (openContainer) return Promise.resolve(copy(openContainer))
    if (opening) throw new Error('インベントリ画面を開いています。')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { opening = null; reject(new Error('インベントリ画面を開けませんでした。')) }, timeoutMs)
      opening = { resolve, reject, timer }
      try { client.queue('interact', { action_id: 'open_inventory', target_entity_id: BigInt(state.runtimeEntityId), has_position: false }) } catch (error) { clearTimeout(timer); opening = null; reject(error) }
    })
  }
  function craft (outputName, options) {
    if (pending) throw new Error('前のクラフト結果を待っています。')
    const plan = findPlan(outputName, options)
    if (!openContainer) throw new Error('先にopenInventory()でインベントリを開いてください。')
    if (!['inventory', 'workbench', -1, 1].includes(openContainer.type)) throw new Error('インベントリまたは作業台の画面を開いてください。')
    const id = allocateRequestId ? allocateRequestId() : nextRequestId
    if (!Number.isInteger(id) || id >= 0 || id < -2147483647 || Math.abs(id % 2) !== 1) throw new Error('クラフト要求IDは32ビット範囲の負の奇数である必要があります。')
    if (!allocateRequestId) nextRequestId -= 2
    const request = buildRequest(plan, id)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { inventoryKnown = false; rejectPending('クラフト結果を確認できませんでした。持ち物の再取得が必要です。') }, timeoutMs)
      const attempt = pending = { id, plan, resolve, reject, timer, accepted: false, confirmedBy: null, wireSent: false, serverRejected: false, serverConfirmed: false, uncertaintyNotified: false }
      lastResult = { phase: 'requesting', requestId: id, output: { name: plan.outputName, count: plan.outputCount } }
      try { client.queue('item_stack_request', { requests: [request] }); attempt.wireSent = true } catch (error) { rejectPending(error.message) }
    })
  }
  function closeContainer () {
    if (pending) throw new Error('クラフト結果を待っている間は画面を閉じられません。')
    if (!openContainer) return
    const packet = { window_id: openContainer.id, window_type: openContainer.type, server: false }
    client.queue('container_close', packet)
    openContainer = null
    // Journal our sent request so a new behaviour generation cannot replay the
    // previous open screen. This is not a server-confirmed close observation.
    onContainerClose(copy(packet))
  }
  function cancel (reason = 'クラフトを停止しました。') {
    rejectPending(reason)
    if (opening) {
      const request = opening; opening = null; clearTimeout(request.timer); request.reject(new Error(reason))
    }
  }
  function snapshot () {
    return { version, authority, inventoryKnown, openContainer: copy(openContainer), recipes: recipes.size, pendingRequestId: pending?.id ?? null, lastResult: copy(lastResult), inventory: [...inventory].filter(([, item]) => !empty(item)).map(([slot, item]) => ({ slot, name: itemName(item), count: item.count, stackId: item.has_stack_id ? item.stack_id : null })), availableRecipes: [...recipes.values()].filter(recipe => recipe.output?.some(item => { const name = itemName(item); return RECIPE_OUTPUTS.has(name) || name?.startsWith('minecraft:') && name.endsWith('_planks') && WOODS.has(name.slice(10, -7)) })).map(recipe => ({ id: recipe.recipe_id, networkId: recipe.network_id, output: recipe.output.map(item => ({ name: itemName(item), count: item.count })), width: recipe.width ?? null, height: recipe.height ?? null })) }
  }
  function describeRecipes (outputName) {
    outputName = nameOf(outputName)
    return [...recipes.values()].filter(recipe => recipe.output?.length === 1 && itemName(recipe.output[0]) === outputName).map(recipe => ({ kind: recipe.kind, id: recipe.recipe_id, networkId: recipe.network_id, block: recipe.block, width: recipe.width, height: recipe.height, input: copy(recipe.input), output: recipe.output.map(item => ({ name: itemName(item), count: item.count })) }))
  }
  return { applyPacket, preview, craft, openInventory, closeContainer, rawItem, snapshot, describeRecipes, cancel, itemNameOf: networkId => names.get(networkId) ?? null }
}

module.exports = { createCrafting }
