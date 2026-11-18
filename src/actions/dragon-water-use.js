'use strict'

// The source and the supporting top face must be visible and in normal player
// reach. In particular, a bucket may not remove a flowing or waterlogged cell.
function dragonWaterPlan ({ item, position, slot }, { state, raw, inventory, world, lineOfSight }) {
  const stack = inventory.inventory?.find(row => row.slot === slot)
  const valid = ['overworld', 'end'].includes(state.dimension) && state.inventory?.known === true && !state.inventory.uncertain &&
    inventory.inventoryKnown === true && stack?.name === item && stack.count === raw?.count && stack.stackId === raw?.stack_id
  if (!valid || !position || !['x', 'y', 'z'].every(key => Number.isSafeInteger(position[key]))) throw Error('水と手持ち道具の受信を待ちます。')
  const { x, y, z } = position
  const source = world.getBlock(x, y, z), above = world.getBlock(x, y + 1, z)
  const sourceWater = source?.name === 'minecraft:water' && source.properties?.liquid_depth === 0
  const placing = item === 'minecraft:water_bucket'
  if (source?.known !== true || source.extra?.length || !(placing ? source.boundingBox === 'block' : sourceWater) ||
      above?.known !== true || !/^minecraft:(?:air|cave_air|void_air)$/.test(above.name) || above.extra?.length) throw Error('水源または注水先の上面を確認できません。')
  const clickPos = { x: 0.5, y: placing ? 1 : 0.875, z: 0.5 }
  const point = { x: x + clickPos.x, y: y + clickPos.y, z: z + clickPos.z }
  if (!state.position || state.position.y < point.y || Math.hypot(state.position.x - point.x, state.position.y - point.y, state.position.z - point.z) > 4.5) throw Error('水源の上面に手が届きません。')
  lineOfSight(point, position)
  return { target: position, clicked: position, expectedBlock: source.name, blockRuntimeId: source.runtimeId, clickPos, point, face: 1, raw, slot }
}
module.exports = { dragonWaterPlan }
