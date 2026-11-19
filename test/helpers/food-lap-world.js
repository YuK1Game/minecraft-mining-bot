'use strict'

// One lap of the home kit's food, through the real expedition runtime (dragon-runtime.js): the expedition and its
// saved record, the goal ledger, the early step (dragon-early.js), the reserve (dragon-supplies.js with the real
// chest window ports), the food step (dragon-early-food.js), the walk into the house (dragon-early-home.js), the
// use of the house's things (dragon-home-use.js) and the cook (house/house-ports.js `smelt`).
//
// Stand-ins, and only these: the block world (the starter house standing, helpers/house-world.js), the walk (it
// arrives where it was sent), the long trip (it arrives at its destination), the animals, the chest window and the
// furnace window (each a small model of what the server answers). Their success is not the game's.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createDragonRuntime } = require('../../src/modes/dragon-runtime')
const { createDragonState } = require('../../src/modes/dragon-state')
const { earlyObjective } = require('../../src/modes/dragon-early')
const { chestOf } = require('../../src/modes/house/house-spawn')
const { home } = require('../../src/modes/dragon-supply-kit')
const { createHouseWorld, ORIGIN } = require('./house-world')

const full = name => 'minecraft:' + name
const COOKED = /^minecraft:cooked_/
const RAW = /^minecraft:(?:beef|porkchop|chicken|mutton)$/
const total = (rows, test) => rows.reduce((sum, row) => sum + (row?.name && test.test(row.name) ? row.count : 0), 0)

// chestFood / handFood: cooked food in the reserve chest and in hand at the start. Everything else of the home kit
// is complete in both. rubble: the chest's other slots are full of stone. animals: [{ at: { x, z } (metres from the porch), drops }].
async function createFoodLap (t, { chestFood = 7, chestFoodName = 'cooked_beef', rubble = false, handFood = 8, fuel = 4, animals = [{ at: { x: 30, z: 40 }, drops: 2 }] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'food-lap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const world = createHouseWorld()
  const chest = chestOf(ORIGIN)
  const kit = home.filter(([name]) => name !== 'food')
  const items = kit.map(([name, count], slot) => ({ slot, name: full(name), count }))
  if (handFood > 0) items.push({ slot: items.length, name: full('cooked_beef'), count: handFood })
  if (fuel > 0) items.push({ slot: items.length, name: full('coal'), count: fuel })
  const slots = Array.from({ length: 54 }, (_, slot) => ({ slot, known: true, count: 0, name: null }))
  kit.forEach(([name, count], slot) => { slots[slot] = { slot, known: true, name: full(name), count } })
  if (chestFood > 0) slots[kit.length] = { slot: kit.length, known: true, name: full(chestFoodName), count: chestFood }
  // The live base: every other slot holds stone (one smaller stack among them).
  if (rubble) for (const slot of slots) if (!slot.name) Object.assign(slot, { name: full('cobblestone'), count: slot.slot === 30 ? 12 : 64 })
  const porch = world.porch()
  const w = {
    root, world, chest, at: 1e9, lines: [], trace: [], transfers: [], opened: [], cooks: [], hunts: 0, trips: [], life: 'a/0', worn: [],
    herd: animals.map((animal, index) => ({ runtimeId: String(100 + index), name: 'minecraft:cow', position: { x: porch.x + animal.at.x, y: porch.y, z: porch.z + animal.at.z }, drops: animal.drops })),
    slots, furnace: [0, 1, 2].map(slot => ({ slot, name: null, count: 0 })),
    raw: { profile: 'bot', realm: { id: 'r' }, connectionId: 'a', startedAt: 't', dimension: 'overworld', health: 20, phase: 'spawned', lifecycle: { deathId: 0 },
      position: { ...porch }, inventory: { known: true, items } }
  }
  const rows = () => w.raw.inventory.items
  const give = (name, count) => {
    const row = rows().find(item => item.name === name && item.count > 0 && item.count + count <= 64)
    if (row) row.count += count
    else { let slot = 0; while (rows().some(item => item.slot === slot && item.count > 0)) slot++; rows().push({ slot, name, count }) }
  }
  const take = (slot, name, count) => {
    const row = rows().find(item => item.slot === slot && item.name === name)
    if (!row || row.count < count) throw new Error('持ち物にありません: ' + name)
    row.count -= count
    w.raw.inventory = { known: true, items: rows().filter(item => item.count > 0) }
  }
  w.hand = test => total(rows(), test)
  w.chestCount = test => total(w.slots, test)
  w.cooked = () => w.hand(COOKED)
  w.rawMeat = () => w.hand(RAW)
  // A meal on the way: the server takes cooked food out of the hand.
  w.eat = (count = 1) => { const row = rows().find(item => COOKED.test(item.name) && item.count >= count); take(row.slot, row.name, count) }
  const goto = at => { w.raw.position = { x: Number.isInteger(at.x) ? at.x + 0.5 : at.x, y: at.y ?? porch.y, z: Number.isInteger(at.z) ? at.z + 0.5 : at.z } }
  const open = (x, y, z) => { const found = world.getBlock(x, y, z); return found.known === true && found.boundingBox !== 'block' }
  const hands = {
    why: () => null,
    walk: async to => { goto(to); return true },
    // Beside the target: a free cell next to it (inside the room when the target is), else the target's own cell.
    approach: async target => {
      const inRoom = cell => cell.x > ORIGIN.x && cell.x < ORIGIN.x + 6 && cell.z > ORIGIN.z && cell.z < ORIGIN.z + 6
      const around = []
      for (const dz of [1, 0, -1]) for (const dx of [0, -1, 1]) if (dx || dz) around.push({ x: target.x + dx, y: target.y, z: target.z + dz })
      const free = around.filter(cell => open(cell.x, cell.y, cell.z) && open(cell.x, cell.y + 1, cell.z))
      goto((inRoom(target) ? free.find(inRoom) : free[0]) ?? target)
      return true
    }
  }
  const receipt = count => ({ serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count })
  const window = { id: 3, epoch: 1, scope: 'home', position: chest, slotCount: 54 }
  let windowOpen = false
  const operations = {
    armor: { equipBest: async () => {} }, inventory: { equip: async slot => ({ phase: 'completed', slot }) },
    crafting: { closeContainer () { windowOpen = false } },
    quarry: { travelStatus: () => ({ busy: false }), pickupNear: async () => {} },
    perception: { entities: () => [] },
    interactions: {
      useDoor: async () => {},
      openFurnace: async at => { w.opened.push(['furnace', at.x, at.y, at.z]) }
    },
    chest: {
      open: async position => {
        if (position.x !== chest.x || position.y !== chest.y || position.z !== chest.z) throw new Error('このチェストは用意していません。')
        w.opened.push(['chest', position.x, position.y, position.z]); windowOpen = true
        return { windowId: window.id }
      },
      snapshot: () => ({ window: windowOpen ? window : null, slots: w.slots, contentsKnown: windowOpen }),
      depositItem: async ({ sourceSlot, count, expectedName }) => {
        const into = w.slots.find(slot => slot.name === expectedName && slot.count + count <= 64) ?? w.slots.find(slot => !slot.name)
        if (!into) throw Object.assign(new Error('チェストが満杯です。'), { code: 'CONTAINER_FULL' })
        take(sourceSlot, expectedName, count)
        Object.assign(into, { name: expectedName, count: into.count + count })
        w.transfers.push(['in', expectedName, count])
        return receipt(count)
      },
      withdrawItem: async ({ chestSlot, count, expectedName }) => {
        const from = w.slots[chestSlot]
        if (from.name !== expectedName || from.count < count) throw new Error('チェストの枠が違います。')
        from.count -= count; if (!from.count) from.name = null
        give(expectedName, count)
        w.transfers.push(['out', expectedName, count])
        return receipt(count)
      }
    },
    // A furnace: what is put in comes out cooked, ten seconds an item, one piece of fuel for the batch.
    furnace: {
      snapshot: () => ({ contentsKnown: true, slots: w.furnace }),
      putInput: async (slot, count) => { const row = rows().find(item => item.slot === slot); const name = row.name; take(slot, name, count); Object.assign(w.furnace[0], { name, count: w.furnace[0].count + count }) },
      putFuel: async (slot, count) => { const row = rows().find(item => item.slot === slot); const name = row.name; take(slot, name, count); Object.assign(w.furnace[1], { name, count: w.furnace[1].count + count }) },
      waitOutput: async (output, count) => {
        const [input, burn, out] = w.furnace
        if (!input.count || !burn.count) throw new Error('焼けません。')
        w.at += input.count * 10000
        Object.assign(out, { name: output, count: out.count + input.count })
        w.cooks.push([input.name, input.count, burn.name])
        Object.assign(input, { name: null, count: 0 }); burn.count -= 1; if (!burn.count) burn.name = null
        void count
      },
      takeOutput: async ({ count }) => { const out = w.furnace[2]; give(out.name, count); out.count -= count; if (!out.count) out.name = null }
    },
    // The hunt: the nearest animal of the herd is walked to and killed; its meat is in the hand when the hunt returns.
    foraging: {
      preview: () => w.herd.length ? { ready: true, target: w.herd[0], distance: Math.hypot(w.herd[0].position.x - w.raw.position.x, w.herd[0].position.z - w.raw.position.z) } : { ready: false, code: 'NO_KNOWN_FOOD_SOURCE', errors: ['食料源がありません。'] },
      execute: async () => {
        const animal = w.herd.shift()
        goto(animal.position); w.hunts++; w.at += 8000
        give(full('beef'), animal.drops)
        return { target: animal, steps: 1, hits: 2, foodGained: animal.drops }
      },
      stop: () => {}
    }
  }
  const runtime = { raw: () => w.raw, host: () => ({ getLife: () => w.raw.lifecycle, meta: { startGame: { seed: 1 } } }), armor: () => ({ known: true, worn: w.worn }), inventory: () => w.raw.inventory }
  // The saved record of a Bot whose house stands and whose bed is confirmed: the goal is the kit at home.
  const seed = createDragonState({ root, shared: {}, getState: () => w.raw, getLife: () => w.raw.lifecycle, getWorldId: () => 1 })
  const record = seed.record()
  record.early.spawnReady = true
  await seed.save(record)
  // shared given: a reload of the behaviour code (the same shared state). None: the first start.
  w.boot = (shared = { playerHouse: { origin: ORIGIN, done: true, built: true, spawn: true } }) => {
    w.shared = shared
    w.rt = createDragonRuntime({ now: () => w.at, shared, root, getBlock: world.getBlock, log: line => w.lines.push(line), operations, runtime,
      active: () => true, legacyBusy: () => false, legacyIdle: () => true, stopLegacy: () => {}, lifeKey: () => w.life, loading: () => false, threatened: () => false,
      stepPorts: signal => {
        const cancelled = () => signal.aborted
        return { operations, runtime, shared, root, log: line => w.lines.push(line), getBlock: world.getBlock, getFeet: () => w.raw.position, where: () => w.raw.position, hands, walk: hands.walk, cancelled, signal,
          now: () => w.at, sleep: async ms => { w.at += ms },
          travelTo: async input => { const to = input.destination ?? input; w.trips.push({ x: to.x, z: to.z }); goto({ x: to.x, y: porch.y, z: to.z }); w.at += 30000 } }
      } })
    return w.rt
  }
  w.record = () => w.rt.record()
  w.objective = () => earlyObjective({ inventory: w.raw.inventory, worn: runtime.armor(), house: w.shared.playerHouse, memory: w.record() })
  // One look of the two-second timer and the step it starts. each(w): called before every look.
  w.look = async () => {
    const owned = w.rt.tick()
    await w.rt.settled()
    w.at += 2000
    const shown = w.rt.status()
    if (owned && shown?.reason && w.trace[w.trace.length - 1] !== shown.reason) w.trace.push(shown.reason)
    return owned
  }
  // Looks until the expedition gives the player back (the next objective is the ordinary work's), or `limit` looks.
  w.lap = async ({ limit = 80, each = null } = {}) => {
    for (let n = 0; n < limit; n++) {
      each?.(w, n)
      if (!await w.look()) return n
    }
    return -1
  }
  w.said = pattern => w.lines.filter(line => pattern.test(line))
  w.boot()
  return w
}

module.exports = { createFoodLap, COOKED, RAW }
