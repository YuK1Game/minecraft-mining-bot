'use strict'

// A small voxel world and adapter for quarry tests. It enforces normal-player
// limits the job must respect: reach, held tool tier, standing support,
// inventory capacity and own-footing protection. Not a physics simulation.

const { blockRule, nameOf, toolOf, AIR } = require('../../src/quarry-rules')
const { maxStack } = require('../../src/quarry-inventory')

const SOLID_EMPTY = /^(short_grass|tallgrass|fern|dandelion|poppy|torch|snow_layer|vine)$/

function createSim ({ loaded = { xMin: -40, xMax: 60, yMin: -64, yMax: 140, zMin: -40, zMax: 60 }, chestSlots = 27 } = {}) {
  const blocks = new Map()
  const k = (x, y, z) => `${x},${y},${z}`
  let runtime = 1
  const world = {
    set (x, y, z, name) { if (!name || AIR.has(nameOf(name))) blocks.delete(k(x, y, z)); else blocks.set(k(x, y, z), nameOf(name)) },
    fill (x1, y1, z1, x2, y2, z2, name) { for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) world.set(x, y, z, name) },
    name (x, y, z) { return blocks.get(k(x, y, z)) ?? 'air' }
  }
  const unknown = new Set()
  function getBlock (x, y, z) {
    if (x < loaded.xMin || x > loaded.xMax || y < loaded.yMin || y > loaded.yMax || z < loaded.zMin || z > loaded.zMax || unknown.has(k(x, y, z))) return { known: false }
    const n = blocks.get(k(x, y, z)) ?? 'air'
    const fluid = /water|lava/.test(n)
    return { known: true, name: `minecraft:${n}`, runtimeId: n.length * 7 + 3, boundingBox: AIR.has(n) || fluid || SOLID_EMPTY.test(n) ? 'empty' : 'block', extra: [] }
  }

  const state = {
    phase: 'spawned', gameMode: 'survival', dimension: 'overworld', profile: 'bot', realm: { id: '1' }, connectionId: 'c1', startedAt: 't0', runtimeEntityId: '7', lifecycle: { deathId: 0 },
    health: 20, maxHealth: 20, food: 20, position: { x: 0.5, y: 0, z: 0.5 }, selectedSlot: 0, heldItem: null,
    inventory: { known: true, items: [] }
  }
  // Chest contents by position; `chest` is the first chest's list (older tests).
  const chest = []
  const chests = new Map()
  const chestAt = p => { const key = p ? `${p.x},${p.y},${p.z}` : 'first'; if (!chests.size) chests.set(key, chest); if (!chests.has(key)) chests.set(key, []); return chests.get(key) }
  const entities = []
  let entityId = 100
  let combat = false
  const log = []
  const stats = { mined: 0, moves: 0, deposits: 0, placements: 0, eats: 0, mineCalls: 0 }
  const hooks = { beforeMine: null, afterMine: null, afterMove: null }

  const eye = () => state.position
  const feet = () => ({ x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 1e-3), z: Math.floor(state.position.z) })
  function setFeet (p) { state.position = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 } }
  function held () { return state.inventory.items.find(i => i.slot === state.selectedSlot) ?? null }
  function refreshHeld () { const h = held(); state.heldItem = h ? { name: h.name, slot: h.slot } : null }
  function give (name, count = 1, extra = {}) {
    const n = `minecraft:${nameOf(name)}`
    let left = count
    const tool = toolOf(n)
    if (!tool) for (const i of state.inventory.items) if (i.name === n && !i.durabilityKnown && i.count < maxStack(n)) { const t = Math.min(left, maxStack(n) - i.count); i.count += t; left -= t; if (!left) break }
    while (left > 0) {
      const used = new Set(state.inventory.items.map(i => i.slot))
      const slot = [...Array(36).keys()].find(s => !used.has(s))
      if (slot == null) return count - left
      const take = tool ? 1 : Math.min(left, maxStack(n))
      state.inventory.items.push({ slot, name: n, count: take, ...(tool ? { durabilityKnown: true, maxDurability: tool.maxDurability, durabilityUsed: 0, durabilityRemaining: tool.maxDurability } : {}), ...extra })
      left -= take
    }
    refreshHeld()
    return count
  }
  function take (slot, count) {
    const i = state.inventory.items.find(x => x.slot === slot)
    if (!i || i.count < count) throw new Error('take: not enough')
    i.count -= count
    if (!i.count) state.inventory.items = state.inventory.items.filter(x => x !== i)
    refreshHeld()
  }
  function pickup () {
    for (const e of [...entities]) {
      if (e.stuck) continue // test hook: an item the server never lets us pick up
      const p = state.position
      if (Math.abs(e.position.x - p.x) <= 1.5 && Math.abs(e.position.z - p.z) <= 1.5 && e.position.y >= p.y - 1.62 - 1.2 && e.position.y <= p.y + 0.5) {
        const got = give(e.name, e.count)
        if (got === e.count) entities.splice(entities.indexOf(e), 1)
        else if (got > 0) e.count -= got
      }
    }
  }
  function settleItem (x, y, z) { let yy = y; while (yy > loaded.yMin && getBlock(x, yy - 1, z).boundingBox !== 'block') yy--; return yy }
  function standable (p) { const a = getBlock(p.x, p.y, p.z); const b = getBlock(p.x, p.y + 1, p.z); const f = getBlock(p.x, p.y - 1, p.z); return a.known && b.known && f.known && a.boundingBox === 'empty' && !/water|lava/.test(a.name) && b.boundingBox === 'empty' && !/water|lava/.test(b.name) && f.boundingBox === 'block' }

  const adapter = {
    getState () { pickup(); return structuredClone(state) },
    getBlock,
    entities () { return structuredClone(entities.map(e => ({ kind: 'item', runtimeId: String(e.id), name: e.name, count: e.count, position: e.position }))) },
    async mine (targets, { signal } = {}) {
      stats.mineCalls++
      const f = feet()
      for (const t of targets) {
        if (signal?.aborted) throw new Error('aborted')
        if (hooks.beforeMine) await hooks.beforeMine(t)
        if (combat) throw new Error('stopped by combat')
        const n = world.name(t.x, t.y, t.z)
        if (`minecraft:${n}` !== t.expectedName) throw new Error(`expected ${t.expectedName} got ${n}`)
        if (t.x === f.x && t.z === f.z && t.y < f.y) throw new Error('own footing')
        const e = eye(); const d = Math.hypot(t.x + 0.5 - e.x, t.y + 0.5 - e.y, t.z + 0.5 - e.z)
        if (d > 5.3) throw new Error(`out of reach ${d.toFixed(2)}`)
        const rule = blockRule(n)
        const h = held(); const tool = h ? toolOf(h.name) : null
        if (rule.needs && !(tool && tool.kind === rule.needs && tool.tier >= rule.tier)) throw new Error(`wrong tool for ${n}: ${h?.name}`)
        world.set(t.x, t.y, t.z, 'air')
        stats.mined++
        if (tool) { h.durabilityUsed++; h.durabilityRemaining--; if (h.durabilityRemaining <= 0) throw new Error('TOOL BROKE') }
        const drop = rule.drops?.[0]
        if (drop && !rule.plant) entities.push({ id: entityId++, name: `minecraft:${drop}`, count: 1, position: { x: t.x + 0.5, y: settleItem(t.x, t.y, t.z), z: t.z + 0.5 } })
        // Gravity: blocks above fall.
        for (let y = t.y + 1; blockRule(world.name(t.x, y, t.z)).gravity; y++) { world.set(t.x, y - 1, t.z, world.name(t.x, y, t.z)); world.set(t.x, y, t.z, 'air') }
        if (hooks.afterMine) await hooks.afterMine(t)
      }
      pickup()
      return { phase: 'completed' }
    },
    async moveTo (stance) {
      if (!standable(stance)) throw new Error(`not standable ${JSON.stringify(stance)}`)
      setFeet(stance); stats.moves++; pickup()
      if (hooks.afterMove) await hooks.afterMove(stance)
      return { phase: 'completed' }
    },
    async escape (cell) { setFeet(cell) },
    async equip (slot) {
      // Like the runtime: equipping an empty slot is refused.
      if (!state.inventory.items.some(x => x.slot === slot && x.count > 0)) throw new Error('持ち替え元にアイテムがありません。')
      if (slot > 8) {
        const i = state.inventory.items.find(x => x.slot === slot); const free = [...Array(9).keys()].find(s => !state.inventory.items.some(x => x.slot === s))
        const target = free ?? 8
        const other = state.inventory.items.find(x => x.slot === target)
        if (other) other.slot = slot
        i.slot = target; slot = target
      }
      state.selectedSlot = slot; refreshHeld(); return { phase: 'completed' }
    },
    async place ({ position, slot, expectedBlock }) {
      const i = state.inventory.items.find(x => x.slot === slot)
      if (!i || i.name !== expectedBlock) throw new Error('place: wrong item')
      const cur = world.name(position.x, position.y, position.z)
      if (!AIR.has(cur) && !/water|lava/.test(cur)) throw new Error('place: occupied')
      world.set(position.x, position.y, position.z, expectedBlock); take(slot, 1); stats.placements++
      return { phase: 'completed' }
    },
    async eat () { const f = state.inventory.items.find(i => /bread|cooked/.test(i.name)); if (!f) throw new Error('no food'); take(f.slot, 1); state.food = 20; state.health = Math.min(20, state.health + 4); stats.eats++ },
    async goToStorage (st) { setFeet(st.stand ?? { x: st.position.x + 1, y: st.position.y, z: st.position.z }); stats.moves++ },
    async deposit (storage, deposits) {
      const deposited = []; let full = false
      const chest = chestAt(storage?.[0]?.position)
      for (const d of deposits) {
        const i = state.inventory.items.find(x => x.slot === d.slot)
        if (!i) continue
        let left = Math.min(d.count, i.count)
        for (const c of chest) if (c.name === i.name && c.count < maxStack(i.name) && left) { const t = Math.min(left, maxStack(i.name) - c.count); c.count += t; left -= t; take(i.slot, t); deposited.push({ name: i.name, count: t }) }
        while (left > 0) {
          if (chest.length >= chestSlots) { full = true; break }
          const t = Math.min(left, maxStack(i.name)); chest.push({ name: i.name, count: t }); left -= t; take(i.slot, t); deposited.push({ name: i.name, count: t })
        }
      }
      stats.deposits++
      return { deposited, full }
    },
    // A carried chest is placed; otherwise 2 logs are "crafted" into one.
    async addChest (candidates) {
      const c = candidates.find(p => getBlock(p.x, p.y, p.z).known && blocks.get(k(p.x, p.y, p.z)) === undefined)
      if (!c) return { ok: false, reason: 'NO_PLACEABLE_CELL' }
      const carried = state.inventory.items.find(i => i.name === 'minecraft:chest')
      const logs = state.inventory.items.filter(i => /_log$/.test(i.name)).reduce((n, i) => n + i.count, 0)
      if (carried) take(carried.slot, 1)
      else if (logs >= 2) { let left = 2; for (const i of [...state.inventory.items].filter(x => /_log$/.test(x.name))) { const t = Math.min(left, i.count); take(i.slot, t); left -= t; if (!left) break } }
      else return { ok: false, reason: 'NO_CHEST_MATERIAL', needs: { logs: 2 } }
      world.set(c.x, c.y, c.z, 'chest'); chestAt(c); stats.chestsAdded = (stats.chestsAdded ?? 0) + 1
      return { ok: true, position: { ...c }, crafted: carried ? [] : ['minecraft:chest'] }
    },
    combatActive: () => combat,
    async stopAll () {},
    recentDamageAt: () => null
  }
  return { world, getBlock, unknown, state, chest, chests, entities, adapter, give, setFeet, feet, stats, log, hooks, setCombat: v => { combat = v } }
}

// Flat test terrain: stone to `stoneTop`, dirt above, grass on top.
function flatTerrain (sim, { x1 = -40, x2 = 60, z1 = -40, z2 = 60, bedrock = -64, stoneTop = 60, top = 62 } = {}) {
  sim.world.fill(x1, bedrock, z1, x2, bedrock, z2, 'bedrock')
  sim.world.fill(x1, bedrock + 1, z1, x2, stoneTop, z2, 'stone')
  if (top - 1 > stoneTop) sim.world.fill(x1, stoneTop + 1, z1, x2, top - 1, z2, 'dirt')
  sim.world.fill(x1, top, z1, x2, top, z2, 'grass_block')
}

module.exports = { createSim, flatTerrain }
