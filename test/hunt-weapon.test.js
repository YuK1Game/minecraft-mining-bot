'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { huntWeapon, huntArmed } = require('../src/survival/hunt-weapon')

const raw = { 3: { network_id: 900, count: 2, has_stack_id: true, stack_id: 31 }, 7: { network_id: 901, count: 1, has_stack_id: true, stack_id: 77 } }
const items = [{ slot: 3, name: 'minecraft:rotten_flesh', count: 2, stackId: 31 }, { slot: 7, name: 'minecraft:diamond_sword', count: 1, stackId: 77 }]
const rawItem = slot => raw[slot] ?? { network_id: 0, count: 0, has_stack_id: false }

test('with food in hand, the hunt takes the sword first (live 2026-11-17 03:00 JST: 8 fist hits on a sheep)', async () => {
  assert.equal(huntWeapon({ items, rawItem, selected: 3 }).slot, 7)
  assert.equal(huntWeapon({ items, rawItem, selected: 7 }), null)
  const calls = []
  const out = await huntArmed({ hunt: async id => { calls.push(`hunt ${id}`); return { phase: 'observed' } }, equip: async slot => { calls.push(`equip ${slot}`); return { serverConfirmed: true } }, crafting: { snapshot: () => ({ inventory: items }), rawItem }, getState: () => ({ rawServerSelectedSlot: 3 }) }, '42')
  assert.deepEqual(calls, ['equip 7', 'hunt 42'])
  assert.equal(out.phase, 'observed')
})

test('a refused switch still hits with what is held', async () => {
  const calls = []
  await huntArmed({ hunt: async id => { calls.push(`hunt ${id}`) }, equip: async () => { throw new Error('busy') }, crafting: { snapshot: () => ({ inventory: items }), rawItem }, getState: () => ({ rawServerSelectedSlot: 3 }) }, '42')
  assert.deepEqual(calls, ['hunt 42'])
})

test('the received state (host getServerState: `selectedSlot` only) still switches to the sword (live 2026-11-26 12:45 JST)', async () => {
  const calls = []
  await huntArmed({ hunt: async id => { calls.push(`hunt ${id}`); return { phase: 'observed' } }, equip: async slot => { calls.push(`equip ${slot}`); return { phase: 'completed' } }, crafting: { inventorySnapshot: () => ({ inventory: items }), rawItem }, getState: () => ({ selectedSlot: 3 }) }, '42')
  assert.deepEqual(calls, ['equip 7', 'hunt 42'])
})

test('foraging accepts weapon slot switch performed by combat.hunt without SELECTED_SLOT_CHANGED, while still rejecting external switches', async () => {
  const { createForaging } = require('../src/survival/foraging')
  let selected = 3
  let beefCount = 0
  let preyAlive = true
  const prey = () => ({ kind: 'mob', runtimeId: '50', uniqueId: '50', entityType: 'minecraft:cow', dimension: 'overworld', alive: preyAlive, hostile: false, positionKnown: true, position: { x: 1.5, y: 65, z: 0.5 } })
  const state = () => ({
    phase: 'spawned',
    gameMode: 'survival',
    dimension: 'overworld',
    health: 20,
    dead: false,
    profile: 'bot',
    realm: { id: '42' },
    connectionId: 'c1',
    startedAt: '2026-11-27T00:00:00.000Z',
    runtimeEntityId: '1',
    lifecycle: { deathId: 0 },
    position: { x: 0.5, y: 66.62, z: 0.5 },
    rawServerSelectedSlot: selected,
    rawSelectedSlot: selected,
    inventory: {
      known: true,
      uncertain: false,
      items: [
        ...items,
        ...(beefCount > 0 ? [{ slot: 4, name: 'minecraft:beef', count: beefCount }] : [])
      ]
    },
    entities: [prey()]
  })
  const world = {
    getBlock: (x, y, z) => y <= 64
      ? { known: true, name: 'minecraft:grass_block', boundingBox: 'block' }
      : { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  }
  const entities = { snapshot: () => [prey()] }
  const movement = { preview: () => ({ ready: false }), start: async () => {}, stop: async () => {} }
  const foraging = createForaging({
    getState: state,
    world,
    entities,
    movement,
    getMovement: () => ({ phase: 'idle' }),
    combat: {
      previewHunt: () => ({ ready: true, cooldownRemainingMs: 0 }),
      hunt: id => huntArmed({
        equip: async slot => {
          selected = slot
          // Span across foraging's 100ms heartbeat to ensure no race causes SELECTED_SLOT_CHANGED.
          await new Promise(resolve => setTimeout(resolve, 130))
          return { serverConfirmed: true }
        },
        hunt: async targetId => {
          preyAlive = false
          beefCount = 2
          return { phase: 'observed', targetRuntimeId: targetId, reaction: 'death_animation' }
        },
        crafting: { inventorySnapshot: () => ({ inventory: items }), rawItem },
        getState: () => ({ selectedSlot: selected })
      }, id),
      cancel: async () => {}
    }
  })

  const out = await foraging.execute({ maxSteps: 3, maxHits: 3, timeoutMs: 5000 })
  assert.equal(out.ok, true)
  assert.equal(out.collected, true)
  assert.equal(selected, 7)

  // External slot change outside combat.hunt (during cooldown pause) is still rejected.
  selected = 3
  beefCount = 0
  preyAlive = true
  let flipped = false
  const externalForaging = createForaging({
    getState: state,
    world,
    entities,
    movement,
    getMovement: () => ({ phase: 'idle' }),
    combat: {
      previewHunt: () => ({ ready: true, cooldownRemainingMs: 250 }),
      hunt: async () => ({ phase: 'observed' }),
      cancel: async () => {}
    },
    delay: async ms => {
      if (!flipped) { flipped = true; selected = 1 }
      await new Promise(resolve => setTimeout(resolve, Math.min(ms, 40)))
    }
  })
  await assert.rejects(() => externalForaging.execute({ maxSteps: 3, maxHits: 3, timeoutMs: 3000 }), err => err?.code === 'SELECTED_SLOT_CHANGED')
})
