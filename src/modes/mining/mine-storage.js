'use strict'

const path = require('node:path')
const { createContainerPorts } = require('../return/container-ports')
const { createChestPairs } = require('../player-chest-pairs')
const { pairedChest } = require('../chest-pair')
const { stationWorldScope } = require('../../survival/supply-return')
const { completed, blocked, failed, interrupted } = require('../return/return-result')
const { key, air, solid, bottomSlab, confirmed, bare } = require('./mine-observed')
const CARGO = /^(?:cobblestone|cobbled_deepslate|stone|deepslate|granite|diorite|andesite|tuff|calcite|dirt|gravel|flint|raw_iron|raw_gold|raw_copper|coal|diamond|redstone|lapis_lazuli|emerald)$/
const RETAIN = { cobblestone: 64, cobbled_deepslate: 16, torch: 32, ladder: 32, cobblestone_slab: 64, stick: 16 }

function cargo (inventory, keep = {}) {
  if (inventory?.known !== true || inventory.uncertain === true) return null
  const remaining = { ...RETAIN, ...Object.fromEntries(Object.entries(keep).map(([name, n]) => [bare(name), Math.max(0, n)])) }, out = []
  for (const item of inventory.items ?? []) {
    const name = bare(item.name)
    if (!CARGO.test(name) || !(item.count > 0)) continue
    const kept = Math.min(item.count, remaining[name] ?? 0)
    remaining[name] = Math.max(0, (remaining[name] ?? 0) - kept)
    if (item.count > kept) out.push({ slot: item.slot, name: item.name, count: item.count - kept })
  }
  return out
}

function createMineStorage (ctx, actions) {
  const stopped = () => ctx.cancelled() || ctx.signal?.aborted
  const box = createContainerPorts({ operations: ctx.operations, getBlock: ctx.getBlock, getFeet: ctx.getFeet, getInventory: actions.inventory,
    held: stopped, disposed: stopped, memory: ctx.shared.playerChestMemory ??= { seen: new Map() }, ...(ctx.sleep ? { sleep: ctx.sleep, now: ctx.now } : {}) })
  const pairs = createChestPairs({ shared: ctx.shared, worldScope: () => stationWorldScope(ctx.runtime.raw()), getBlock: ctx.getBlock,
    file: path.join(ctx.root, '.local', 'player-chest-pairs.json'), say: text => ctx.log?.('採掘場: ' + text) })
  const wait = (code, kind = 'terrain_received', extra = {}) => blocked(code, { kind }, extra)
  const layerOf = layer => typeof layer === 'string' ? layer : layer?.id
  const roomOf = (plan, layer) => plan.storage.find(room => room.layer === layerOf(layer))
  const stoppedResult = () => interrupted('MINE_STORAGE_INTERRUPTED')
  const registry = () => ctx.memory.early.mine.branch.storage ??= { pairs: {} }
  async function stand (pair) {
    const p = pair.positions[0], facing = pair.facing
    for (const offset of [1, 2]) {
      const x = p.x + facing.x * offset, z = p.z + facing.z * offset, floor = actions.block({ x, y: p.y - 1, z })
      if (!solid(floor) || !air(actions.block({ x, y: p.y, z })) || !air(actions.block({ x, y: p.y + 1, z }))) continue
      const out = await actions.walk({ x: x + 0.5, y: p.y - (bottomSlab(floor) ? 0.5 : 0), z: z + 0.5 })
      if (confirmed(out)) return out
      if (stopped()) return stoppedResult()
    }
    return wait('MINE_CHEST_ACCESS_UNCONFIRMED', 'position_changed')
  }
  async function inspect (pair) {
    if (stopped()) return stoppedResult()
    const moved = await stand(pair)
    if (!confirmed(moved)) return moved
    const received = await box.inspect(pair.positions[0], { aborted: stopped })
    if (stopped()) return stoppedResult()
    if (received.status !== 'completed') return received
    const mate = pairedChest(ctx.getBlock, pair.positions[0], box.contents)
    if (received.evidence?.slotCount !== 54 || !mate || key(mate) !== key(pair.positions[1])) return failed('MINE_CHEST_NOT_DOUBLE', { evidence: { pair: pair.id, slots: received.evidence?.slotCount ?? null } })
    return actions.done('MINE_CHEST_54_RECEIVED', { pair: pair.id, slots: 54, room: received.evidence.room })
  }
  async function ensure (plan, layer) {
    const room = roomOf(plan, layer)
    if (!room) return failed('MINE_STORAGE_LAYER_INVALID')
    if (!pairs.ready()) return wait('MINE_CHEST_REGISTRY_UNAVAILABLE', 'owner_released')
    for (const pair of room.pairs) {
      if (stopped()) return stoppedResult()
      const validRoom = pair.positions.every(p => solid(actions.block({ ...p, y: p.y - 1 })) && air(actions.block({ ...p, y: p.y + 1 })) && (air(actions.block(p)) || actions.block(p)?.name === 'minecraft:chest'))
      if (!validRoom) return wait('MINE_STORAGE_ROOM_UNREADY')
      if (!await pairs.begin(pair.positions) || stopped()) return wait('MINE_CHEST_RESERVATION_FAILED', 'owner_released')
      for (const p of pair.positions) {
        if (stopped()) return stoppedResult()
        if (actions.block(p)?.known === true && actions.block(p).name === 'minecraft:chest') { await pairs.received(p); continue }
        await pairs.observe()
        if (!pairs.canAttempt(p)) return wait('MINE_CHEST_PLACEMENT_PENDING', 'inventory_update')
        const moved = await stand({ ...pair, positions: [p, p] })
        if (!confirmed(moved)) return moved
        if (!await pairs.attempt(p) || stopped()) return wait('MINE_CHEST_RESERVATION_FAILED', 'owner_released')
        const out = await actions.place({ position: p, name: 'chest', clicked: { ...p, y: p.y - 1 }, face: 1, alignFacing: true })
        if (!confirmed(out)) {
          if (!ctx.memory.early.mine.branch.pendingAction) await pairs.retry(p)
          return out
        }
        if (!await pairs.received(p)) return wait('MINE_CHEST_RESERVATION_FAILED', 'owner_released')
      }
      const result = await inspect(pair)
      if (!confirmed(result)) return result
      registry().pairs[pair.id] = { positions: pair.positions, purpose: pair.purpose, slots: 54 }
      if (!await actions.save() || !await pairs.complete(pair.positions[0])) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
    }
    return actions.done('MINE_STORAGE_READY', { pairs: room.pairs.length })
  }
  async function deposit (plan, { layer, keep = {} } = {}) {
    const room = roomOf(plan, layer)
    if (!room) return failed('MINE_STORAGE_LAYER_INVALID')
    const stacks = () => cargo(actions.inventory(), keep)
    if (stacks() == null) return wait('MINE_INVENTORY_UNKNOWN', 'inventory_update')
    if (!stacks().length) return actions.done('MINE_CARGO_EMPTY')
    let transferred = 0
    for (const pair of room.pairs.filter(pair => pair.purpose === 'cargo')) {
      if (stopped()) return stoppedResult()
      const received = await inspect(pair)
      if (!confirmed(received)) return received
      const out = await box.deposit(pair.positions[0], () => stacks() ?? [], { aborted: stopped })
      transferred += out.progress?.confirmedTransferred ?? 0
      if (stopped()) return stoppedResult()
      if (!actions.inventory()) return wait('MINE_INVENTORY_UNKNOWN', 'inventory_update')
      if (!stacks().length) {
        registry().lastDeposit = { layer: room.layer, confirmedTransferred: transferred, revision: (registry().lastDeposit?.revision ?? 0) + 1 }
        if (!await actions.save()) return wait('MINE_CHECKPOINT_FAILED', 'owner_released')
        return actions.done('MINE_CARGO_STORED', { confirmedTransferred: transferred })
      }
      if (out.code !== 'CONTAINER_FULL' && !['completed', 'partial'].includes(out.status)) return out
    }
    return wait('MINE_STORAGE_FULL', 'container_update', { progress: { confirmedTransferred: transferred }, remaining: { items: stacks()?.reduce((sum, s) => sum + s.count, 0) ?? null } })
  }
  async function take (plan, { layer, needs = {} } = {}) {
    const room = roomOf(plan, layer)
    if (!room) return failed('MINE_STORAGE_LAYER_INVALID')
    const target = Object.fromEntries(Object.entries(needs).map(([name, n]) => [bare(name), n + (actions.inventory()?.items ?? []).filter(i => bare(i.name) === bare(name)).reduce((sum, i) => sum + i.count, 0)]))
    for (const pair of room.pairs.filter(pair => pair.purpose === 'supply' && registry().pairs[pair.id])) {
      const received = await inspect(pair)
      if (!confirmed(received)) return received
      const out = await box.withdraw(pair.positions[0], slots => {
        const needed = Object.fromEntries(Object.entries(target).map(([name, n]) => [name, Math.max(0, n - (actions.inventory()?.items ?? []).filter(i => bare(i.name) === name).reduce((sum, i) => sum + i.count, 0))])), picks = []
        for (const slot of slots) {
          const name = bare(slot.name), count = Math.min(slot.count ?? 0, needed[name] ?? 0)
          if (count > 0) { picks.push({ chestSlot: slot.slot, name: slot.name, count }); needed[name] -= count }
        }
        return picks
      }, { aborted: stopped })
      if (out.status !== 'completed') return out
    }
    return actions.done('MINE_SUPPLY_CHESTS_READ')
  }
  async function depositHome ({ keep = {} } = {}) {
    const origin = ctx.shared.playerHouse?.origin
    if (!origin) return wait('MINE_HOME_STORAGE_UNAVAILABLE', 'container_update')
    const { chestOf } = require('../house/house-spawn')
    const { approachHome } = require('../dragon-early-home')
    const { baseChests } = require('../base-chests')
    const anchor = chestOf(origin), stacks = () => cargo(actions.inventory(), keep)
    if (stacks() == null) return wait('MINE_INVENTORY_UNKNOWN', 'inventory_update')
    if (!stacks().length) return actions.done('MINE_CARGO_EMPTY')
    if (!await approachHome(ctx, anchor, { open: true })) return wait('MINE_HOME_ACCESS_UNCONFIRMED', 'position_changed')
    if (stopped()) return stoppedResult()
    const visited = new Set()
    for (const position of baseChests(ctx.getBlock, [ctx.shared.playerBase, anchor], { contents: box.contents })) {
      if (stopped()) return stoppedResult()
      if (visited.has(key(position)) || pairs.pending(position)) continue
      if (!await approachHome(ctx, position, { open: true })) continue
      const location = await actions.confirmPosition(ctx.getFeet())
      if (!confirmed(location)) return location
      const read = await box.inspect(position, { aborted: stopped })
      if (stopped()) return stoppedResult()
      if (read.status !== 'completed') return read
      if (read.evidence?.slotCount !== 54) continue
      const mate = pairedChest(ctx.getBlock, position, box.contents)
      if (!mate) continue
      visited.add(key(position)); visited.add(key(mate))
      const out = await box.deposit(position, () => stacks() ?? [], { aborted: stopped })
      if (stopped()) return stoppedResult()
      if (stacks() && !stacks().length) return actions.done('MINE_HOME_CARGO_STORED', { chest: position, confirmedTransferred: out.progress?.confirmedTransferred ?? 0 })
      if (out.code !== 'CONTAINER_FULL' && !['completed', 'partial'].includes(out.status)) return out
    }
    return wait('MINE_HOME_STORAGE_FULL_OR_UNKNOWN', 'container_update')
  }
  async function withdraw (plan, { layer, resource, targetHeld } = {}) {
    const room = roomOf(plan, layer), name = 'minecraft:' + bare(resource)
    if (!room || !Number.isSafeInteger(targetHeld) || targetHeld < 1) return failed('MINE_STOCK_REQUEST_INVALID')
    const held = () => actions.inventory()?.items.filter(i => i.name === name && i.count > 0).reduce((sum, i) => sum + i.count, 0) ?? null
    if (held() == null) return wait('MINE_INVENTORY_UNKNOWN', 'inventory_update')
    for (const pair of room.pairs) {
      if (held() >= targetHeld) break
      if (!registry().pairs[pair.id]) continue
      const receipt = await inspect(pair)
      if (!confirmed(receipt)) return receipt
      const pick = slots => {
        let need = Math.max(0, targetHeld - (held() ?? targetHeld))
        return slots.flatMap(slot => {
          if (slot.known !== true || slot.name !== name || slot.count <= 0 || !need) return []
          const count = Math.min(need, slot.count); need -= count
          return [{ chestSlot: slot.slot, name, count }]
        })
      }
      const out = await box.withdraw(pair.positions[0], pick, { aborted: stopped })
      if (stopped()) return stoppedResult()
      if (!actions.inventory()) return wait('MINE_INVENTORY_UNKNOWN', 'inventory_update')
      if (!['completed', 'partial'].includes(out.status)) return out
    }
    return actions.done(held() >= targetHeld ? 'MINE_STOCK_RECEIVED' : 'MINE_STOCK_CHECKED', { resource: bare(resource), held: held(), missing: Math.max(0, targetHeld - held()) })
  }
  const needsRoom = () => { const inv = actions.inventory(); return !inv || inv.items.filter(i => i.count > 0).length >= 28 }
  return { ensure, deposit, depositHome, take, withdraw, inspect, needsRoom, contents: box.contents, room: box.room }
}

module.exports = { createMineStorage, cargo, RETAIN }
