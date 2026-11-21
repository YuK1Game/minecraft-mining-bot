'use strict'

const { blocked, interrupted } = require('../return/return-result')
const { held, bare, solid, air, confirmed } = require('./mine-observed')
const { createOpenStand } = require('../open-stand')
const { insideMine } = require('./mine-location')

// Infrastructure is prepared in bounded batches. Torches can bootstrap from
// charcoal, so preparing a coal mine never recursively starts another mine.
function createMineSupplies (ctx, actions, storage) {
  const stopped = () => ctx.cancelled() || ctx.signal?.aborted
  const wait = (code, detail = null) => blocked(code, { kind: 'supplies_changed' }, { detail })
  const have = name => held(actions.inventory(), name) ?? 0
  const item = test => actions.inventory()?.items.find(i => i.count > 0 && test(bare(i.name)))
  const openStand = createOpenStand({ getBlock: (x, y, z) => actions.block({ x, y, z }), getFeet: ctx.getFeet, walk: to => actions.walk(to) })
  async function acquire (name, amount) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    await ctx.supplies.acquire(name, amount)
    return wait('MINE_SUPPLIES_IN_PROGRESS', `${name} ${have(name)}/${amount}`)
  }
  function nearby (name) {
    const p = ctx.getFeet()
    if (!p) return []
    const found = []
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) {
      const at = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz }, b = actions.block(at)
      if (b?.known === true && (b.name === 'minecraft:' + name || name === 'furnace' && b.name === 'minecraft:lit_furnace')) found.push(at)
    }
    const far = at => Math.hypot(at.x + 0.5 - p.x, at.y - p.y, at.z + 0.5 - p.z)
    return found.sort((a, b) => far(a) - far(b)).slice(0, 4)
  }
  async function station (name) {
    const branch = ctx.memory?.early?.mine?.branch
    if (insideMine(ctx, branch)) {
      const out = await require('./mine-route').leaveMine(ctx, branch)
      if (!confirmed(out)) return { result: out }
      return { result: wait('MINE_SURFACE_SUPPLY_STATION', '採掘場の坑道を保護し、地上で作業台・かまどを使います。') }
    }
    // A nearby block may face into a sealed room. Use the same received face
    // and stand calculation as the ordinary station owner, with a finite
    // movement budget; an unusable old furnace must not hide a held one.
    let attempts = 0
    for (const seen of nearby(name)) {
      if (stopped()) return { result: interrupted('MINE_INTERRUPTED') }
      if (openStand.here(seen)) return { position: seen }
      for (const stand of openStand.stands(seen)) {
        if (attempts >= 4) break
        if (stopped()) return { result: interrupted('MINE_INTERRUPTED') }
        attempts++
        const moved = await actions.walk(stand)
        if (stopped()) return { result: interrupted('MINE_INTERRUPTED') }
        if (moved?.status === 'interrupted') return { result: moved }
        if (confirmed(moved) && openStand.here(seen)) return { position: seen }
      }
    }
    if (have(name) < 1) return { result: await acquire(name, 1) }
    const feet = ctx.getFeet()
    if (!feet) return { result: wait('MINE_POSITION_UNKNOWN') }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      const p = { x: Math.floor(feet.x) + dx, y: Math.ceil(feet.y), z: Math.floor(feet.z) + dz }
      if (branch?.plan?.shaft.columns.some(c => c.x === p.x && c.z === p.z) || branch?.plan?.shaft.approach && Math.floor(branch.plan.shaft.approach.x) === p.x && Math.floor(branch.plan.shaft.approach.z) === p.z) continue
      if (!air(actions.block(p)) || !solid(actions.block({ ...p, y: p.y - 1 })) || !air(actions.block({ ...p, y: p.y + 1 }))) continue
      const placed = await actions.place({ position: p, name, clicked: { ...p, y: p.y - 1 }, face: 1 })
      return confirmed(placed) ? { position: p } : { result: placed }
    }
    return { result: wait('MINE_STATION_SPACE_UNAVAILABLE') }
  }
  async function planks (amount) {
    const count = (actions.inventory()?.items ?? []).filter(i => /_planks$/.test(i.name) && i.count > 0).reduce((sum, i) => sum + i.count, 0)
    if (count < amount) return acquire('planks', amount)
    return null
  }
  async function craft (name, times, table = null) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    const before = have(name)
    await actions.house.craft('minecraft:' + name, times, table, { fitMaterials: true })
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    return have(name) > before ? wait('MINE_SUPPLIES_CRAFTED', `${name} ${have(name)}`) : wait('MINE_CRAFT_UNCONFIRMED', actions.house.why())
  }
  async function torches (amount) {
    const batches = Math.min(8, Math.ceil((amount - have('torch')) / 4))
    if (have('stick') < batches) { const times = Math.min(8, Math.ceil((batches - have('stick')) / 4)), missing = await planks(2 * times); return missing ?? craft('stick', times) }
    const fuel = have('coal') + have('charcoal')
    if (fuel >= batches) return craft('torch', batches)
    // Charcoal comes from a log in a received furnace, using wooden fuel.
    // Existing furnace output/input are reconciled by house.smelt first.
    const furnace = await station('furnace')
    if (furnace.result) return furnace.result
    const log = item(name => /_log$/.test(name) && !/^stripped_/.test(name))
    const plank = item(name => /_planks$/.test(name))
    const made = await actions.house.smelt(furnace.position, log?.name ?? 'minecraft:oak_log', Math.max(1, batches - fuel), plank?.name, Math.max(1, batches), 'minecraft:charcoal')
    if (made > 0) return wait('MINE_CHARCOAL_RECEIVED')
    const need = actions.house.smeltNeed()
    if (need?.input > 0 && !log) return acquire('log', Math.min(8, need.input))
    if (need?.fuel && !plank) return acquire('planks', Math.max(2, batches))
    return wait('MINE_CHARCOAL_UNCONFIRMED', actions.house.why())
  }
  async function ensure (plan, { layer = 'upper', request = null } = {}) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    if (!actions.inventory()) return blocked('MINE_INVENTORY_UNKNOWN', { kind: 'inventory_update' })
    const id = typeof layer === 'string' ? layer : layer.id
    const level = plan.layers.find(entry => entry.id === id), room = plan.storage.find(entry => entry.layer === id)
    if (!level || !room) return wait('MINE_SUPPLY_LAYER_INVALID')
    // A first request may already be for diamonds. Include the still-unbuilt
    // upper shaft as well, so spending one ladder there also reduces the
    // remaining budget instead of forcing a surface top-up every step.
    const prior = plan.shaft.topY
    let installed = 0
    for (let y = level.y; y <= prior; y++) {
      const seen = actions.block({ x: plan.shaft.ladder.x, y, z: plan.shaft.ladder.z })
      if (seen?.known === true && seen.name === 'minecraft:ladder') installed++
    }
    const ladders = Math.max(4, prior - level.y + 2 - installed)
    const remainingChests = room.pairs.reduce((sum, pair) => sum + pair.positions.filter(p => actions.block(p)?.name !== 'minecraft:chest' || actions.block(p)?.known !== true).length, 0)
    const needs = { ladder: ladders, torch: have('torch') < 8 ? 32 : 8, cobblestone_slab: have('cobblestone_slab') < 12 ? 64 : 12, cobblestone: have('cobblestone') < 16 ? 64 : 16, chest: remainingChests }
    // Only unopened deficits are withdrawn, and an existing supply pair is
    // physically read again. Stored estimates never masquerade as inventory.
    const deficits = Object.fromEntries(Object.entries(needs).map(([name, n]) => [name, Math.max(0, n - have(name))]).filter(([, n]) => n > 0))
    if (Object.keys(deficits).length && ctx.memory.early.mine.branch.storage?.pairs?.[`${id}:supply`]) {
      const out = await storage.take(plan, { layer: id, needs: deficits })
      if (!confirmed(out)) return out
    }
    if (have('torch') < needs.torch) return torches(needs.torch)
    const missing = Object.entries(needs).find(([name, amount]) => have(name) < amount)
    if (!missing) return actions.done('MINE_SUPPLIES_READY', { layer: id, request, needs })
    const [name, amount] = missing
    if (name === 'cobblestone') return acquire(name, amount)
    const table = await station('crafting_table')
    if (table.result) return table.result
    if (name === 'ladder') {
      const batches = Math.min(8, Math.ceil((amount - have(name)) / 3)), sticks = batches * 7
      if (have('stick') < sticks) { const times = Math.min(8, Math.ceil((sticks - have('stick')) / 4)), missing = await planks(2 * times); return missing ?? craft('stick', times) }
      return craft(name, batches, table.position)
    }
    if (name === 'cobblestone_slab') {
      const batches = Math.min(8, Math.ceil((amount - have(name)) / 6))
      if (have('cobblestone') < batches * 3 + needs.cobblestone) return acquire('cobblestone', batches * 3 + needs.cobblestone)
      return craft(name, batches, table.position)
    }
    if (name === 'chest') {
      const batches = Math.min(4, amount - have(name)), missing = await planks(batches * 8)
      return missing ?? craft(name, batches, table.position)
    }
    return wait('MINE_SUPPLIES_MISSING')
  }
  return { ensure }
}

module.exports = { createMineSupplies }
