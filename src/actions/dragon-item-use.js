'use strict'

// Normal uses required by the expedition. Sending one is not evidence that
// the eye flew, a portal opened, farmland appeared, or a crop was planted.
const { dragonWaterPlan } = require('./dragon-water-use')
const EYE = 'minecraft:ender_eye'
const surfaces = {
  [EYE]: ['minecraft:end_portal_frame'],
  'minecraft:flint_and_steel': ['minecraft:obsidian'],
  'minecraft:stone_hoe': ['minecraft:dirt', 'minecraft:grass', 'minecraft:grass_block'],
  'minecraft:wheat_seeds': ['minecraft:farmland']
}
// Saplings are planted on the top of received soil, and bone meal is used on a received sapling (player-saplings.js):
// the wood near the house was cut out and each log was a 48 m trip (live 2026-11-28 23:00 JST).
const SAPLINGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry'].map(wood => `minecraft:${wood}_sapling`)
for (const sapling of SAPLINGS) surfaces[sapling] = ['minecraft:grass_block', 'minecraft:dirt', 'minecraft:podzol']
surfaces['minecraft:bone_meal'] = SAPLINGS

function dragonItemPlan ({ item, position, slot }, { state, raw, inventory, world, lineOfSight }) {
  if (['minecraft:bucket', 'minecraft:water_bucket', 'minecraft:glass_bottle'].includes(item)) return dragonWaterPlan({ item, position, slot }, { state, raw, inventory, world, lineOfSight })
  const stack = inventory.inventory?.find(row => row.slot === slot)
  if (!Object.hasOwn(surfaces, item) || inventory.inventoryKnown !== true || state.inventory?.known !== true || state.inventory.uncertain || !stack || stack.name !== item || stack.count !== raw.count || stack.stackId !== raw.stack_id) throw Error('使用するアイテムの受信を確認できません。')
  if (state.dimension !== 'overworld' && !(item === 'minecraft:flint_and_steel' && state.dimension === 'nether')) throw Error('この次元では使用できません。')
  if (position == null && item === EYE) {
    const zero = { x: 0, y: 0, z: 0 }
    return { airUse: true, target: zero, clicked: zero, clickPos: zero, face: 0, point: { ...state.position, z: state.position.z + 1 }, blockRuntimeId: 0, slot, raw }
  }
  if (!position || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis]))) throw Error('対象の座標が必要です。')
  const { x, y, z } = position
  const block = world.getBlock(x, y, z)
  if (block?.known !== true || !surfaces[item].includes(block.name) || block.extra?.length) throw Error('対象ブロックが変わりました。')
  if (item === EYE && ![false, 0].includes(block.properties?.end_portal_eye_bit)) throw Error('空のポータル枠を確認できません。')
  const above = world.getBlock(x, y + 1, z)
  if (above?.known !== true || !/^minecraft:(?:air|cave_air|void_air)$/.test(above.name) || above.extra?.length) throw Error('上面が空いていません。')
  const top = item === EYE ? 13 / 16 : block.name === 'minecraft:farmland' ? 15 / 16 : SAPLINGS.includes(block.name) ? 0.5 : 1
  const clickPos = { x: 0.5, y: top, z: 0.5 }
  const point = { x: x + 0.5, y: y + top, z: z + 0.5 }
  if (state.position.y <= point.y) throw Error('対象の上面が見えていません。')
  lineOfSight(point, position)
  return { target: position, clicked: position, blockRuntimeId: block.runtimeId, clickPos, point, expectedBlock: block.name, face: 1, raw, slot }
}

module.exports = { dragonItemPlan, SAPLINGS }
