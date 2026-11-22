'use strict'

const { blocked, interrupted } = require('../return/return-result')
const { held, bare, solid, air, confirmed } = require('./mine-observed')
const { createOpenStand } = require('../open-stand')
const { insideMine } = require('./mine-location')
const { takeSupplies } = require('./mine-stock')
const { supplyNeeds } = require('./mine-needs')
const { occupied } = require('./mine-carry')
const { count } = require('../dragon-supply-kit')
const { placementTopVisible, planPlacementAccess } = require('../../actions/action-access')

// Infrastructure is prepared in bounded batches. Torches can bootstrap from
// charcoal, so preparing a coal mine never recursively starts another mine.
function createMineSupplies (ctx, actions, storage) {
  const stopped = () => ctx.cancelled() || ctx.signal?.aborted
  const wait = (code, detail = null) => blocked(code, { kind: 'supplies_changed' }, { detail })
  const have = name => name === 'planks' || name === 'log'
    ? count(name, actions.inventory()?.items ?? [])
    : held(actions.inventory(), name) ?? 0
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
  async function placeStation (name, branch) {
    const eye = () => {
      const feet = ctx.getFeet()
      return feet && { ...feet, y: feet.y + 1.62 }
    }
    const feet = ctx.getFeet()
    if (!feet) return { result: wait('MINE_POSITION_UNKNOWN') }
    const centre = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.001), z: Math.floor(feet.z) }
    const shaft = branch?.plan?.shaft
    const reserved = p => shaft?.columns.some(c => c.x === p.x && c.z === p.z) ||
      shaft?.approach && Math.floor(shaft.approach.x) === p.x && Math.floor(shaft.approach.z) === p.z
    const targets = [], ground = []
    for (let x = centre.x - 3; x <= centre.x + 3; x++) for (let z = centre.z - 3; z <= centre.z + 3; z++) {
      for (let y = centre.y - 2; y <= centre.y + 2; y++) {
        const position = { x, y, z }, floor = { x, y: y - 1, z }
        const block = actions.block(floor)
        if (!solid(block) || !air(actions.block(position)) || !air(actions.block({ x, y: y + 1, z }))) continue
        ground.push({ ...block, position: floor })
        if (!reserved(position) && Math.hypot(x + 0.5 - feet.x, z + 0.5 - feet.z) >= 1.1) targets.push(position)
      }
    }
    const distance = p => Math.hypot(p.x + 0.5 - feet.x, p.y - feet.y, p.z + 0.5 - feet.z)
    targets.sort((a, b) => distance(a) - distance(b))
    const visible = position => placementTopVisible({ state: { position: eye() }, target: position, getBlock: actions.block })
    let position = targets.find(visible)
    if (!position) {
      const access = planPlacementAccess({ state: { position: eye() }, targets, blocks: ground, getBlock: actions.block })
      if (!access) return { result: wait('MINE_STATION_SPACE_UNAVAILABLE') }
      const moved = await actions.walk(access.standpoint)
      if (stopped()) return { result: interrupted('MINE_INTERRUPTED') }
      if (!confirmed(moved)) return { result: moved }
      if (!visible(access.target)) return { result: wait('MINE_STATION_SIGHT_CHANGED') }
      position = access.target
    }
    if (stopped()) return { result: interrupted('MINE_INTERRUPTED') }
    const placed = await actions.place({ position, name, clicked: { ...position, y: position.y - 1 }, face: 1 })
    return confirmed(placed) ? { position } : { result: placed }
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
    return placeStation(name, branch)
  }
  async function planks (amount) {
    if (have('planks') < amount) return acquire('planks', amount)
    return null
  }
  async function craft (name, times, table = null) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    const before = have(name)
    await actions.house.craft('minecraft:' + name, times, table, { fitMaterials: true })
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    return have(name) > before ? wait('MINE_SUPPLIES_CRAFTED', `${name} ${have(name)}`) : wait('MINE_CRAFT_UNCONFIRMED', actions.house.why())
  }
  async function makeSticks (target) {
    const times = Math.min(8, Math.ceil((target - have('stick')) / 4))
    const availablePlanks = have('planks')
    if (availablePlanks < times * 2 && occupied(actions.inventory()) === 36) {
      // A smaller useful batch can consume stacks and give the Bot room to
      // gather. Require the normal preview to prove a usable destination.
      for (let smaller = Math.floor(availablePlanks / 2); smaller > 0; smaller--) {
        if (ctx.operations?.crafting?.preview?.('minecraft:stick', { times: smaller })?.ready === true) return craft('stick', smaller)
      }
    }
    const missing = await planks(times * 2)
    return missing ?? craft('stick', times)
  }
  async function craftAtTable (name, times) {
    const table = await station('crafting_table')
    return table.result ?? craft(name, times, table.position)
  }
  async function torches (amount) {
    const batches = Math.min(8, Math.ceil((amount - have('torch')) / 4))
    if (have('stick') < batches) return makeSticks(batches)
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
    const branch = ctx.memory.early.mine.branch
    const needs = supplyNeeds(plan, id, {
      inventory: actions.inventory(), getBlock: actions.block, refillCobblestone: branch.refillCobblestone === true
    })
    if (!needs) return wait('MINE_SUPPLY_LAYER_INVALID')
    // A refill is an outstanding request until its full target is observed.
    // Crossing the normal carry reserve must not make the Bot leave early.
    const shaftUnderway = Number.isInteger(branch.shaft?.depth) && branch.shaft.depth < plan.shaft.topY
    if (shaftUnderway && have('cobblestone') < needs.cobblestone) branch.refillCobblestone = true
    // Only unopened deficits are withdrawn, and an existing supply pair is
    // physically read again. Stored estimates never masquerade as inventory.
    const deficits = Object.fromEntries(Object.entries(needs).map(([name, n]) => [name, Math.max(0, n - have(name))]).filter(([, n]) => n > 0))
    if (Object.keys(deficits).length && branch.storage?.pairs?.[`${id}:supply`]) {
      const out = await takeSupplies(ctx, branch, id, needs, storage)
      if (!confirmed(out)) return out
    }
    if (have('torch') < needs.torch) return torches(needs.torch)
    const missing = Object.entries(needs).find(([name, amount]) => have(name) < amount)
    if (!missing) {
      delete branch.refillCobblestone
      if (branch.supplyChecked) {
        delete branch.supplyChecked
        if (!await actions.save()) return wait('MINE_CHECKPOINT_FAILED')
      }
      return actions.done('MINE_SUPPLIES_READY', { layer: id, request, needs })
    }
    const [name, amount] = missing
    if (name === 'cobblestone') return acquire(name, amount)
    if (insideMine(ctx, branch)) {
      const surface = await station('crafting_table')
      if (surface.result) return surface.result
    }
    // Collect the missing ingredients before going to the workbench. A
    // gather tick for wood can end outside and continue from there.
    if (name === 'ladder') {
      const batches = Math.min(8, Math.ceil((amount - have(name)) / 3)), sticks = batches * 7
      if (have('stick') < sticks) return makeSticks(sticks)
      return craftAtTable(name, batches)
    }
    if (name === 'cobblestone_slab') {
      const batches = Math.min(8, Math.ceil((amount - have(name)) / 6))
      if (have('cobblestone') < batches * 3 + needs.cobblestone) return acquire('cobblestone', batches * 3 + needs.cobblestone)
      return craftAtTable(name, batches)
    }
    if (name === 'chest') {
      const batches = Math.min(4, amount - have(name)), missing = await planks(batches * 8)
      return missing ?? craftAtTable(name, batches)
    }
    return wait('MINE_SUPPLIES_MISSING')
  }
  return { ensure }
}

module.exports = { createMineSupplies }
