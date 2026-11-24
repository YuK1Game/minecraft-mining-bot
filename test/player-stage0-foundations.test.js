'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { baseLightGrid, findDarkBaseSpot, isNightClock, shouldLightSurface } = require('../src/modes/player-base-lighting')
const { planTorchRestock, ensureTorchStock, TORCH_STOCK_TARGET } = require('../src/modes/player-torch-supply')
const { createFieldChestLedger, fieldChestsFile } = require('../src/modes/player-field-chests')
const { createPlayerTorch, torchNear } = require('../src/modes/player-torch')
const { createWorkDispatcher } = require('../src/modes/work-dispatcher')

test('player-base-lighting: generates radius-16 / 8-block spacing grid and lights dark base perimeter', async () => {
  const origin = { x: 0, y: 64, z: 0 }
  const grid = baseLightGrid(origin)
  assert.ok(grid.length >= 8)
  for (const pt of grid) {
    assert.ok(Math.hypot(pt.x - 3, pt.z - 3) <= 16.01)
    assert.equal(Math.abs((pt.x - 3) % 8), 0)
    assert.equal(Math.abs((pt.z - 3) % 8), 0)
  }
  assert.equal(isNightClock({ timeOfDay: 14000 }), true)
  assert.equal(isNightClock({ timeOfDay: 6000 }), false)
  assert.equal(shouldLightSurface({ feet: { x: 11, y: 64, z: 3 }, origin }), true)

  const blocks = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  for (let x = -20; x <= 24; x++) for (let z = -20; z <= 24; z++) {
    blocks.set(key(x, 63, z), { known: true, name: 'minecraft:grass_block', boundingBox: 'block' })
    blocks.set(key(x, 64, z), { known: true, name: 'minecraft:air', boundingBox: 'empty' })
    blocks.set(key(x, 65, z), { known: true, name: 'minecraft:air', boundingBox: 'empty' })
  }
  const getBlock = (x, y, z) => blocks.get(key(x, y, z)) ?? { known: false }
  const spot = findDarkBaseSpot({ getBlock, origin, feet: { x: 11.5, y: 64, z: 3.5 }, torchNear })
  assert.deepEqual(spot, { x: 11, y: 64, z: 3 })

  // Verify player-torch places on the dark base perimeter even on the open surface.
  const placed = []
  let torchesLeft = 4
  const torch = createPlayerTorch({
    getMode: () => 'player',
    shared: { playerWanted: true, playerHouse: { origin } },
    agent: { objective: {}, start: async () => {}, stop: () => {}, running: () => true, settled: () => true },
    getBlock,
    getFeet: () => ({ x: 11.5, y: 64, z: 3.5 }),
    getInventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:torch', count: torchesLeft }] }),
    hands: {
      craft: async () => false,
      place: async cell => {
        placed.push(cell)
        torchesLeft--
        blocks.set(key(cell.x, cell.y, cell.z), { known: true, name: 'minecraft:torch', boundingBox: 'empty' })
        return true
      }
    },
    sleep: async () => {}
  })
  const ok = await torch.tick()
  assert.equal(ok, true)
  assert.deepEqual(placed[0], { x: 11, y: 64, z: 3 })
})

test('player-torch-supply: targets 16 torches and falls back to charcoal smelting when coal is short', async () => {
  const noCoal = { known: true, items: [{ slot: 0, name: 'minecraft:oak_log', count: 4 }, { slot: 1, name: 'minecraft:stick', count: 6 }] }
  const smeltPlan = planTorchRestock(noCoal)
  assert.equal(smeltPlan.action, 'smelt_charcoal')
  assert.equal(smeltPlan.target, TORCH_STOCK_TARGET)

  let inv = { known: true, items: [{ slot: 0, name: 'minecraft:torch', count: 4 }, { slot: 1, name: 'minecraft:oak_log', count: 5 }, { slot: 2, name: 'minecraft:stick', count: 8 }] }
  let smelted = 0
  const result = await ensureTorchStock({
    getInventory: () => inv,
    smeltCharcoal: async count => {
      smelted += count
      inv.items.find(i => i.name === 'minecraft:oak_log').count -= count
      inv.items.push({ slot: 3, name: 'minecraft:charcoal', count })
      return true
    },
    craft: async (output, batches) => {
      if (output !== 'minecraft:torch') return false
      const char = inv.items.find(i => i.name === 'minecraft:charcoal')
      const sticks = inv.items.find(i => i.name === 'minecraft:stick')
      const n = Math.min(batches, char.count, sticks.count - 2)
      char.count -= n; sticks.count -= n
      inv.items.find(i => i.name === 'minecraft:torch').count += n * 4
      return true
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.have, 16)
  assert.ok(smelted >= 3)
})

test('player-field-chests: remembers non-home field chests and consolidates verified contents', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmb-fchest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const shared = { playerBase: { x: 0, y: 64, z: 0 } }
  const ledger = createFieldChestLedger({ shared, file: fieldChestsFile(root), worldScope: () => 'w1' })

  // Home chest (within 10m) is ignored; distant field chest is remembered.
  assert.equal(ledger.remember({ x: 2, y: 64, z: 1 }, { itemsMoved: 10 }), false)
  assert.equal(ledger.remember({ x: 60, y: 40, z: -20 }, { itemsMoved: 32 }), true)
  assert.equal(ledger.pending().length, 1)

  let slots = [{ slot: 0, name: 'minecraft:cobblestone', count: 32 }]
  const out = await ledger.consolidateNext({
    getFeet: () => ({ x: 58, y: 40, z: -20 }),
    getInventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1 }] }),
    walk: async () => true,
    inspect: async () => ({ status: 'completed', evidence: { slots: [...slots] } }),
    withdraw: async () => { slots = []; return 32 }
  })
  assert.equal(out.status, 'completed')
  assert.equal(out.code, 'FIELD_CHEST_CONSOLIDATED')
  assert.equal(ledger.pending().length, 0)
})

test('work-dispatcher: arbitrates active task names and isolates tick errors', () => {
  let activeA = false, tickedB = 0
  const dispatcher = createWorkDispatcher([
    { id: 'a', label: 'タスクA', task: { status: () => ({ active: activeA }), tick: () => { throw new Error('fail') } } },
    { id: 'b', label: 'タスクB', task: { status: () => ({ active: false }), tick: () => { tickedB++ } } }
  ])
  assert.equal(dispatcher.anyActive(), false)
  activeA = true
  assert.equal(dispatcher.activeName(), 'タスクA')
  assert.equal(dispatcher.blockedFor('b'), true)
  assert.equal(dispatcher.blockedFor('a'), false)
  const errors = []
  dispatcher.tickMany(['a', 'b'], { onError: (entry, err) => errors.push([entry.id, err.message]) })
  assert.deepEqual(errors, [['a', 'fail']])
  assert.equal(tickedB, 1)
})
