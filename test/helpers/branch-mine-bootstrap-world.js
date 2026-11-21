'use strict'

// Extends the execution fixture with an empty bag, surface resources, the actual
// supplier/early reserve goal, authoritative crafting/furnace receipts and tool wear.
// The mine is an explicit upper-only short plan; this fixture does not choose a site.
const assert = require('node:assert/strict')
const { createMineWorld } = require('./branch-mine-world')
const { attachBootstrapRecipes } = require('./branch-mine-bootstrap-recipes')
const { createMineGeometry } = require('../../src/modes/mining/mine-geometry')
const { createMineState } = require('../../src/modes/mining/mine-state')
const { createMinePorts } = require('../../src/modes/mining/mine-ports')
const { createDragonSupplies } = require('../../src/modes/dragon-supplies')
const { runDragonEarly } = require('../../src/modes/dragon-early')
const { finishTree } = require('../../src/modes/dragon-tree')
const { chestOf } = require('../../src/modes/house/house-spawn')
const { chestPairs } = require('../../src/modes/house/house-large-chests')
const { placements } = require('../../src/modes/house/house-blueprint')
const { createScaffoldPorts } = require('../../src/modes/player-scaffold-ports')
const full = name => 'minecraft:' + name
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

function createBootstrapWorld (t) {
  const w = createMineWorld(t), ctx = w.ctx
  let controller = new AbortController(), bootstrapped = false
  ctx.signal = controller.signal
  ctx.cancelled = () => controller.signal.aborted
  w.items.splice(0)
  Object.assign(w.plan, createMineGeometry({ scope: w.plan.scope, anchor: { x: 0, z: 0 }, direction: 'east', surfaceY: 70, upperY: 66, lowerY: null, width: 12, length: 12 }))
  w.branch.progress = { upper: createMineState(w.plan, { layer: 'upper' }) }
  delete w.branch.request
  const origin = { x: -9, y: 69, z: -4 }, home = chestOf(origin)
  ctx.shared.playerHouse = { origin, done: true, built: true, spawn: true }
  ctx.memory.early.spawnReady = true
  ctx.runtime.armor = () => ({ known: true, worn: [] })
  ctx.runtime.raw = () => ({ ...w.raw, gameMode: 'survival', position: w.feet(), heldItem: w.items.find(i => i.slot === 0 && i.count > 0) })
  ctx.walk = p => ctx.hands.walk(p)
  ctx.where = () => ({ x: Math.floor(w.feet().x), y: Math.floor(w.feet().y), z: Math.floor(w.feet().z) })
  ctx.operations.quarry = { travelStatus: () => ({ busy: false }) }
  // This bounded ground scene uses the real short-range navigator for each
  // travel leg. Long-travel chunk loading is not part of this bootstrap test.
  ctx.travelTo = async ({ destination }) => {
    for (let i = 0; i < 5; i++) {
      const feet = w.feet(), distance = Math.hypot(destination.x + .5 - feet.x, destination.z + .5 - feet.z)
      if (distance <= 5) return
      const scale = Math.min(1, 10 / distance)
      const moved = await ctx.hands.walk({ x: feet.x + (destination.x + .5 - feet.x) * scale, y: 70, z: feet.z + (destination.z + .5 - feet.z) * scale })
      if (!moved) return
    }
  }
  // Surface grass prevents gathering stone from dismantling the future shaft's doorstep.
  for (let x = -32; x <= 32; x++) for (let z = -32; z <= 32; z++) {
    w.put({ x, y: 69, z }, 'grass_block')
    if (x < 0 || x > 12 || z < 0 || z > 11) for (let y = 65; y < 69; y++) w.put({ x, y, z }, 'dirt')
  }
  for (const x of [4, 8, 12, 16]) for (const z of [-2, -6, -10]) for (let y = 70; y < 74; y++) w.put({ x, y, z }, 'oak_log')
  for (let x = 5; x < 13; x++) for (let z = 0; z < 4; z++) for (let y = 70; y < 73; y++) w.put({ x, y, z }, 'stone')
  // Twelve received iron blocks on the fixed first main run. No helper grants ore.
  for (let x = 6; x <= 8; x++) for (const y of [66, 67]) for (const z of [5, 6]) w.put({ x, y, z }, 'iron_ore')
  const homePair = chestPairs(origin)[0].map(step => step.position)
  for (const step of placements(origin).filter(step => step.phase === 'foundation')) w.put(step.position, step.item)
  for (const p of homePair) w.put(p, 'chest')
  const homeSlots = Array.from({ length: 54 }, (_, slot) => ({ slot, known: true, count: 0, name: null }))
  let homeView = null, epoch = 0
  const chest = ctx.operations.chest, open = chest.open, snapshot = chest.snapshot, deposit = chest.depositItem
  chest.open = async position => {
    homeView = null
    if (!homePair.some(p => same(p, position))) return open(position)
    assert.ok(homePair.every(p => w.getBlock(p.x, p.y, p.z).name === full('chest')))
    assert.ok(Math.hypot(position.x + .5 - w.feet().x, position.y - w.feet().y, position.z + .5 - w.feet().z) <= 5, 'home chest needs a real ground return')
    homeView = { window: { id: 8, epoch: ++epoch, scope: 'bootstrap-home', position, slotCount: 54 }, contentsKnown: true, slots: homeSlots }
    w.opened.push('home'); return { windowId: 8 }
  }
  chest.snapshot = () => homeView ?? snapshot()
  chest.depositItem = async request => {
    if (!homeView) return deposit(request)
    const row = w.items.find(i => i.slot === request.sourceSlot && i.name === request.expectedName && i.count >= request.count)
    const slot = homeSlots.find(i => !i.count)
    assert.ok(row && slot)
    row.count -= request.count; Object.assign(slot, { name: row.name, count: request.count })
    return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count: request.count }
  }
  const placed = ctx.operations.interactions.placeHouseBlock
  ctx.operations.interactions.placeBlock = request => placed({ ...request, face: request.face ?? 1 })
  const mine = ctx.operations.mining.start, worn = [], swaps = []
  ctx.operations.mining.start = args => {
    const p = args[0], block = w.getBlock(p.x, p.y, p.z), hand = w.items.find(i => i.slot === 0 && i.count > 0)
    if (/stone$|_ore$/.test(block.name)) {
      assert.ok(/_pickaxe$/.test(hand?.name ?? ''), 'stone and ore require the actual equipped tool')
      assert.ok(hand.durabilityKnown && hand.durabilityRemaining > 2, 'do not mine with a spent tool')
      if (/iron_ore$/.test(block.name)) assert.ok(/(?:stone|iron)_pickaxe$/.test(hand.name), 'iron needs the stone tier')
    }
    const result = mine(args)
    if (/_log$/.test(block.name)) w.give(block.name.replace('minecraft:', ''))
    if (hand?.durabilityRemaining && /stone$|_ore$/.test(block.name)) {
      hand.durabilityRemaining--; hand.durabilityUsed = (hand.durabilityUsed ?? 0) + 1
      worn.push({ name: hand.name, remaining: hand.durabilityRemaining, feet: w.feet() })
    }
    return result
  }
  const equip = ctx.operations.inventory.equip
  ctx.operations.inventory.equip = async slot => {
    swaps.push({ name: w.items.find(i => i.slot === slot)?.name, feet: w.feet() })
    return equip(slot)
  }
  const recipes = attachBootstrapRecipes(w)
  ctx.hands = createScaffoldPorts({ operations: ctx.operations, getBlock: w.getBlock, getFeet: w.feet,
    getInventory: () => w.inv, getMotion: () => ({ phase: 'idle' }), getHealth: () => 20,
    getHeld: () => w.items.find(i => i.slot === 0 && i.count > 0), disposed: ctx.cancelled, sleep: ctx.sleep, now: ctx.now })
  ctx.minePorts = createMinePorts(ctx)
  ctx.supplies = createDragonSupplies(ctx)
  const history = []
  async function tick () {
    const tree = await finishTree(ctx, { now: ctx.now, sleep: ctx.sleep })
    const result = tree ?? (bootstrapped ? await runDragonEarly(ctx) : await ctx.supplies.acquire('stone_pickaxe', 1))
    if (!bootstrapped && w.items.some(i => i.name === full('stone_pickaxe') && i.count > 0 && i.durabilityRemaining > 2)) bootstrapped = true
    history.push({ ...result, feet: w.feet(), gather: ctx.memory.early.gather && { ...ctx.memory.early.gather } })
    await ctx.sleep(1000)
    return result
  }
  const restart = () => {
    controller = new AbortController(); ctx.signal = controller.signal
    ctx.minePorts = createMinePorts(ctx); ctx.supplies = createDragonSupplies(ctx)
  }
  return Object.assign(w, { recipes, home, homeSlots, history, worn, swaps, tick, cancel: () => controller.abort(), restart })
}

module.exports = { createBootstrapWorld }
