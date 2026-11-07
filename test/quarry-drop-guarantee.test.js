'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveDropGuarantee, checkDropGuarantees } = require('../src/quarry-drop-guarantee')

const target = (name, x = 0, tool) => ({ name: 'minecraft:' + name, position: { x, y: 60, z: 0 }, runtimeId: 8, tool })
const item = (name, count, slot = 0) => ({ name: 'minecraft:' + name, slot, count })
const pick = { kind: 'pickaxe', tier: 3, silk: false }
const hand = { kind: 'hand' }
const shovel = { kind: 'shovel', tier: 3, silk: false }
const verify = (targets, tool, beforeItems = [], afterItems = []) => checkDropGuarantees(targets, tool, { beforeItems, afterItems })

test('dirt and logs require a net main gain after confirmed block destruction', () => {
  for (const name of ['dirt', 'oak_log', 'stripped_spruce_log', 'crimson_stem']) {
    const targets = [target(name)]
    assert.equal(verify(targets, hand).reason, 'DROP_GAIN_MISSING')
    assert.equal(verify(targets, hand, [item(name, 64)], [item(name, 64, 5)]).ok, false)
    assert.equal(verify(targets, hand, [], [item('apple', 5)]).ok, false)
    assert.equal(verify(targets, hand, [], [item(name, 1)]).ok, true)
  }
})

test('a full snow block needs four snowballs or the silk-preserved block, from the correct tool', () => {
  const t = [target('snow')]
  for (const count of [1, 2, 3]) assert.equal(verify(t, shovel, [], [item('snowball', count)]).ok, false)
  assert.equal(verify(t, shovel, [item('snowball', 4)], [item('snowball', 8)]).ok, true)
  assert.equal(verify(t, hand, [], [item('snowball', 4)]).ok, false)
  assert.equal(verify(t, { ...shovel, silk: true }, [], [item('snow', 1)]).ok, true)
  const unknownSilk = { kind: 'shovel', tier: 3 }
  assert.equal(verify(t, unknownSilk, [], [item('snowball', 1)]).ok, false)
  assert.deepEqual(deriveDropGuarantee(t[0], unknownSilk).capacityAlternatives, [[{ name: 'snowball', count: 4 }], [{ name: 'snow', count: 1 }]])
})

test('one increment cannot be shared between targets, even if the total grew elsewhere', () => {
  const t = [target('dirt'), target('grass_block', 1)]
  assert.equal(verify(t, hand, [], [item('dirt', 1), item('grass_block', 7, 2)]).ok, false)
  const result = verify(t, hand, [], [item('dirt', 2)])
  assert.deepEqual(result.allocation, [[{ name: 'dirt', count: 1 }], [{ name: 'dirt', count: 1 }]])
})

test('unknown silk backtracks to preserve the only stack a second target can use', () => {
  const t = [target('grass_block', 0, { kind: 'shovel' }), target('dirt', 1)]
  const result = verify(t, shovel, [], [item('dirt', 1), item('grass_block', 1, 2)])
  assert.equal(result.ok, true)
  assert.deepEqual(result.allocation.map(bundle => bundle[0].name), ['grass_block', 'dirt'])
})

test('silk and tool eligibility determine the required name and upper bound', () => {
  for (const [block, normalName, count, tool] of [
    ['stone', 'cobblestone', 1, pick], ['deepslate', 'cobbled_deepslate', 1, pick],
    ['podzol', 'dirt', 1, shovel], ['mycelium', 'dirt', 1, shovel], ['clay', 'clay_ball', 4, shovel]
  ]) {
    assert.deepEqual(deriveDropGuarantee(target(block), tool).capacityAlternatives, [[{ name: normalName, count }]])
    assert.deepEqual(deriveDropGuarantee(target(block), { ...tool, silk: true }).alternatives, [[{ name: block, count: 1 }]])
    assert.equal(verify([target(block)], tool, [], [item(block, 1)]).ok, false)
  }
  assert.equal(deriveDropGuarantee(target('obsidian'), { ...pick, tier: 2 }).ok, false)
})

test('reject missing required harvest evidence and unread terrain, handle known soil variants', () => {
  for (const tool of [null, { kind: 'pickaxe' }, { kind: 'hand', tier: 1 }, { kind: 'pickaxe', tier: NaN }]) {
    assert.equal(deriveDropGuarantee(target('stone'), tool).reason, 'DROP_TOOL_NOT_CONFIRMED')
  }
  assert.equal(deriveDropGuarantee({ ...target('dirt'), known: false }, hand).ok, false)
  assert.equal(verify([target('rooted_dirt')], hand, [], [item('rooted_dirt', 1)]).ok, true)
  for (const name of ['dirt_path', 'grass_path']) {
    assert.equal(verify([target(name)], hand, [], [item('dirt', 1)]).ok, true)
    assert.equal(verify([target(name)], { ...shovel, silk: true }, [], [item('grass_path', 1)]).ok, true)
  }
})

test('optional ordinary leaves budget all possible item types, silk and shears require a leaf', () => {
  const t = target('oak_leaves')
  assert.equal(verify([t], hand).ok, true)
  assert.deepEqual(deriveDropGuarantee(t, hand).capacityAlternatives[0].map(x => x.name), ['stick', 'apple', 'oak_sapling'])
  for (const tool of [{ kind: 'shears' }, { kind: 'hoe', silk: true }]) {
    assert.equal(verify([t], tool).ok, false)
    assert.equal(verify([t], tool, [], [item('oak_leaves', 1)]).ok, true)
  }
  for (const block of ['fern', 'short_grass', 'dead_bush', 'vine']) assert.equal(verify([target(block)], hand).ok, true)
})

test('observed Bedrock two-cell grass and fern permit zero seeds and reserve a conservative seed bound', () => {
  for (const name of ['tall_grass', 'large_fern']) {
    const lower = { ...target(name), properties: { upper_block_bit: 0 } }
    const upper = { ...target(name), position: { x: 0, y: 61, z: 0 }, properties: { upper_block_bit: 1 } }
    assert.equal(verify([upper], hand).ok, true)
    assert.deepEqual(deriveDropGuarantee(upper, hand).capacityAlternatives, [[{ name: 'wheat_seeds', count: 2 }]])
    assert.deepEqual(verify([lower, upper], hand, [], [item('wheat_seeds', 1)]).allocation, [[], []])
    assert.equal(deriveDropGuarantee(upper, { kind: 'hoe', tier: 1, silk: false }).ok, false)
  }
  for (const name of ['tallgrass', 'leaf_litter']) assert.equal(deriveDropGuarantee(target(name), hand).ok, false)
})

test('reject protected or unclassified blocks, invalid inventory and invalid target batches', () => {
  for (const name of ['diamond_ore', 'chest', 'unknown_thing', 'unknown_leaves', 'snow_layer', 'red_mushroom_block']) {
    assert.equal(deriveDropGuarantee(target(name), hand).ok, false)
  }
  for (const count of [-1, 0, 0.5, 65, NaN, '2']) assert.equal(verify([target('dirt')], hand, [], [item('dirt', count)]).ok, false)
  assert.equal(verify([target('dirt')], hand, [], [item('dirt', 2), item('gravel', 1)]).ok, false)
  assert.equal(verify([target('dirt')], hand, [], [item('dirt', 1, 36)]).ok, false)
  assert.equal(verify([target('oak_leaves')], hand, null, []).ok, false)
  assert.equal(verify([target('dirt'), target('dirt')], hand, [], [item('dirt', 2)]).ok, false)
  assert.equal(verify(Array.from({ length: 9 }, (_, i) => target('dirt', i)), hand, [], [item('dirt', 9)]).ok, false)
})
