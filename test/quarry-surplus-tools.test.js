'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { toolOf } = require('../src/quarry-rules')
const { surplusToolSlots } = require('../src/quarry-surplus-tools')

function tool (name, slot, remaining, extra = {}) {
  const max = toolOf(name).maxDurability
  return { name: `minecraft:${name}`, slot, stackId: 100 + slot, count: 1, metadata: 0, durabilityKnown: true, maxDurability: max, durabilityUsed: max - remaining, durabilityRemaining: remaining, enchantmentsKnown: true, enchantments: [], surplusToolMetadataKnown: true, ...extra }
}
function fixture (kind = 'shovel') {
  const box = { name: 'minecraft:undyed_shulker_box', count: 1, slot: 20, stackId: 120 }
  return { items: [tool(`iron_${kind}`, 1, 200), tool(`diamond_${kind}`, 2, 1000), box], options: { enabled: true, toolPolicy: { reserveMinUses: 1, reserveFraction: 0, returnUses: 0 }, supplyBoxes: [{ role: kind, itemName: `minecraft:diamond_${kind}`, boxName: box.name, stackId: box.stackId, key: 'undyed_shulker_box:stack:120' }] } }
}

test('classification is opt-in, pure and keeps all actual superior tools', () => {
  const { items, options } = fixture(), before = structuredClone({ items, options })
  assert.deepEqual([...surplusToolSlots(items)], [])
  assert.deepEqual([...surplusToolSlots(items, { ...options, enabled: false })], [])
  assert.deepEqual([...surplusToolSlots(items, options)], [1])
  assert.deepEqual({ items, options }, before)
})

test('pickaxes and shovels require their own exact carried binding and usable superior kind', () => {
  for (const kind of ['pickaxe', 'shovel']) {
    const { items, options } = fixture(kind)
    assert.deepEqual([...surplusToolSlots(items, options)], [1])
    for (const mutation of [b => { b.stackId++ }, b => { b.key += ':old' }, b => { b.role = 'food' }, b => { b.itemName = 'minecraft:diamond_sword' }, b => { b.boxName = 'minecraft:red_shulker_box' }]) {
      const broken = structuredClone(options); mutation(broken.supplyBoxes[0])
      assert.deepEqual([...surplusToolSlots(items, broken)], [])
    }
    assert.deepEqual([...surplusToolSlots(items.slice(0, 2), options)], [])
    assert.deepEqual([...surplusToolSlots([items[0], tool(kind === 'shovel' ? 'diamond_pickaxe' : 'diamond_shovel', 2, 1000), items[2]], options)], [])
  }
})

test('only lower-tier unenchanted pickaxes/shovels are candidates; weapons, armor and other kinds stay', () => {
  const { items, options } = fixture()
  items.push(tool('netherite_shovel', 3, 1500), tool('iron_sword', 4, 200), tool('iron_axe', 5, 200), tool('iron_hoe', 6, 200), { name: 'minecraft:bow', count: 1, slot: 7, stackId: 107 }, { name: 'minecraft:iron_helmet', count: 1, slot: 8, stackId: 108 })
  assert.deepEqual([...surplusToolSlots(items, options)], [1])
  items[0].enchantments = [{ name: 'efficiency', level: 1 }]
  assert.deepEqual([...surplusToolSlots(items, options)], [])
})

test('known durability, consistent maximum/wear/remaining and metadata knowledge are required on both sides', () => {
  const changes = [{ durabilityKnown: false }, { durabilityRemaining: null }, { durabilityRemaining: 1.5 }, { maxDurability: 99 }, { durabilityUsed: -1 }, { durabilityUsed: 1 }, { enchantmentsKnown: false }, { enchantments: undefined }, { surplusToolMetadataKnown: false }, { surplusToolMetadataKnown: undefined }, { metadata: undefined }, { metadata: 1 }, { known: false }]
  for (const side of [0, 1]) for (const change of changes) {
    const { items, options } = fixture(); Object.assign(items[side], change)
    assert.deepEqual([...surplusToolSlots(items, options)], [], JSON.stringify({ side, change }))
  }
})

test('stack/slot identities must be unique and valid across the complete inventory', () => {
  for (const change of [{ count: 2 }, { slot: -1 }, { slot: 36 }, { stackId: 0 }, { stackId: 2147483648 }]) {
    const { items, options } = fixture(); Object.assign(items[0], change)
    assert.deepEqual([...surplusToolSlots(items, options)], [])
  }
  for (const side of [0, 1, 2]) for (const duplicate of ['slot', 'stackId']) {
    const { items, options } = fixture()
    items.push({ name: 'minecraft:dirt', count: 1, slot: duplicate === 'slot' ? items[side].slot : 30, stackId: duplicate === 'stackId' ? items[side].stackId : 999 })
    assert.deepEqual([...surplusToolSlots(items, options)], [])
  }
})

test('explicit reserved names and custom/protected tools never supply surplus or replacement budgets', () => {
  for (const name of ['iron_shovel', 'minecraft:iron_shovel', 'diamond_shovel', 'minecraft:diamond_shovel']) {
    const { items, options } = fixture(); options.toolPolicy.reservedTools = [name]
    assert.deepEqual([...surplusToolSlots(items, options)], [])
  }
  for (const side of [0, 1]) for (const special of [{ custom: true }, { protected: true }, { protectionSource: 'owned' }, { unbreakable: true }, { displayName: 'keep me' }, { lore: ['special'] }, { repairCost: 1 }, { canDestroy: ['stone'] }]) {
    const { items, options } = fixture(); Object.assign(items[side], special)
    assert.deepEqual([...surplusToolSlots(items, options)], [])
  }
})

test('actual reserve policy controls superior usability and the exact replacement budget', () => {
  const f = fixture(); f.items[1] = tool('diamond_shovel', 2, 201)
  assert.deepEqual([...surplusToolSlots(f.items, f.options)], [1])
  for (const policy of [{ reserveMinUses: 2 }, { reserveFraction: 0.1 }, { returnUses: 2 }]) {
    assert.deepEqual([...surplusToolSlots(f.items, { ...f.options, toolPolicy: policy })], [])
  }
  f.items[1] = tool('diamond_shovel', 2, 1)
  assert.deepEqual([...surplusToolSlots(f.items, f.options)], [])
})

test('several lower tools cannot reuse one superior budget; deterministic worn-first selection respects the sum', () => {
  const { items, options } = fixture(); items[0] = tool('iron_shovel', 1, 150); items[1] = tool('diamond_shovel', 2, 251)
  items.push(tool('iron_shovel', 3, 100), tool('iron_shovel', 4, 100))
  assert.deepEqual([...surplusToolSlots(items, options)], [3, 4])
  assert.deepEqual([...surplusToolSlots([...items].reverse(), options)], [3, 4])
  items[0] = tool('iron_shovel', 1, 50)
  assert.deepEqual([...surplusToolSlots(items, options)], [1, 3, 4])
})

test('separate superior tools have separate budgets without ever returning a superior slot', () => {
  const { items, options } = fixture(); items[0] = tool('iron_shovel', 1, 200); items[1] = tool('diamond_shovel', 2, 251)
  items.push(tool('iron_shovel', 3, 200), tool('netherite_shovel', 4, 251), tool('iron_shovel', 5, 200))
  assert.deepEqual([...surplusToolSlots(items, options)], [1, 3])
})

test('known enchanted superiors are retained and budgeted without multiplying durability', () => {
  const { items, options } = fixture(); items[1] = tool('diamond_shovel', 2, 200, { enchantments: [{ name: 'unbreaking', level: 3 }, { name: 'mending', level: 1 }] })
  assert.deepEqual([...surplusToolSlots(items, options)], [])
  items[1] = tool('diamond_shovel', 2, 201, { enchantments: [{ name: 'unbreaking', level: 3 }] })
  assert.deepEqual([...surplusToolSlots(items, options)], [1])
  items[1].enchantments = [{ name: 'id_900', level: 1 }]
  assert.deepEqual([...surplusToolSlots(items, options)], [])
})

test('raw observations, when supplied, must agree with summary and contain only validated plain tool metadata', () => {
  const { items, options } = fixture(), item = items[0]
  item.raw = { network_id: 1000, count: 1, has_stack_id: true, stack_id: item.stackId, metadata: 0, extra: { has_nbt: true, can_place_on: [], can_destroy: [], nbt: { nbt: { type: 'compound', value: { Damage: { type: 'int', value: item.durabilityUsed } } } } } }
  assert.deepEqual([...surplusToolSlots(items, options)], [1])
  for (const mutate of [raw => { raw.stack_id++ }, raw => { raw.extra.can_destroy.push('stone') }, raw => { raw.extra.nbt.nbt.value.display = { type: 'compound', value: {} } }, raw => { raw.extra.nbt.nbt.value.Damage.value++ }, raw => { raw.extra.nbt.nbt.value.ench = { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: 15 }, lvl: { type: 'short', value: 1 } }] } } }]) {
    const changed = structuredClone(items); mutate(changed[0].raw)
    assert.deepEqual([...surplusToolSlots(changed, options)], [])
  }
})

test('ambiguous binding roles and invalid policies fail closed', () => {
  const { items, options } = fixture()
  assert.deepEqual([...surplusToolSlots(items, { ...options, supplyBoxes: [...options.supplyBoxes, ...options.supplyBoxes] })], [])
  for (const toolPolicy of [{ reserveFraction: NaN }, { reserveFraction: 2 }, { returnUses: -1 }, { reservedTools: 'iron_shovel' }]) assert.deepEqual([...surplusToolSlots(items, { ...options, toolPolicy })], [])
  assert.deepEqual([...surplusToolSlots(null, options)], [])
})
