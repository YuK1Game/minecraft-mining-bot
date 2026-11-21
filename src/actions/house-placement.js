'use strict'

// Ordinary placement for the player's starter house (modes/house/): any face of
// a received block may be clicked, so the roof's slabs are placed against the
// side of the slab beside them (low on the face, a bottom slab) and the torches
// on the walls. The building blocks of the blueprint only.
// - The cell must be received air; a door also needs the air above it and a
//   bed the head cell it is given. The clicked block is received and not a
//   liquid; a slab or a glass block may be clicked.
// - The click point is on the face (on a side face at `clickY`, 0..1 up the
//   block); it is within 4.5 of the eye with a received clear line of sight.
// - With `alignFacing` the Bot first turns to the point (chests, furnaces, the
//   door and the bed face from the turn); the plan can be checked again.
const WOODS = '(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)'
const HOUSE = new RegExp(`^minecraft:(?:cobblestone|cobblestone_slab|ladder|glass|torch|chest|furnace|crafting_table|bed|wooden_door|${WOODS}_(?:log|stem|planks|slab|door))$`)
const { placementSupportOk } = require('../quarry/storage/storage-site-terrain')
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const LIQUID = /water|lava/
const FACE = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]
const int = point => ({ x: Math.trunc(point?.x), y: Math.trunc(point?.y), z: Math.trunc(point?.z) })
const valid = point => point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))

function createHousePlan ({ session, slotItem, crafting, world, overlapsPlayer, players, sightError }) {
  const air = block => block?.known === true && AIR.has(block.name) && !block.extra?.length
  function housePlan (options) {
    const { position, slot, clicked, face, clickY = null, head = null, alignFacing = false } = options ?? {}
    if (!valid(position) || !valid(clicked) || !Number.isInteger(face) || face < 0 || face > 5) throw new Error('設置先・クリックするブロック・面を整数で指定してください。')
    const target = int(position), click = int(clicked), normal = FACE[face]
    if (click.x + normal.x !== target.x || click.y + normal.y !== target.y || click.z + normal.z !== target.z) throw new Error('クリック面が設置先に向いていません。')
    const state = session()
    const raw = slotItem(slot)
    const observed = crafting.snapshot()
    if (observed.inventoryKnown === false || state.inventory?.known === false) throw new Error('設置前にサーバーの持ち物全体を確認してください。')
    const description = observed.inventory.find(item => item.slot === slot)
    const receivedItem = description?.name
    const expectedBlock = /^minecraft:[a-z_]+_bed$/.test(receivedItem ?? '') ? 'minecraft:bed' : receivedItem
    if (!HOUSE.test(expectedBlock ?? '') || raw.count < 1 || description.count !== raw.count || description.stackId != null && description.stackId !== raw.stack_id) throw new Error('指定スロットに拠点の家の建材がありません。')
    if (!air(world.getBlock(target.x, target.y, target.z))) throw new Error('設置先は取得済みの空気ブロックである必要があります。')
    if (/_door$/.test(expectedBlock) && !air(world.getBlock(target.x, target.y + 1, target.z))) throw new Error('ドアの上のマスが空いていません。')
    if (expectedBlock === 'minecraft:bed' && (!valid(head) || !air(world.getBlock(head.x, head.y, head.z)))) throw new Error('ベッドの枕側のマスが空いていません。')
    if (overlapsPlayer(target, state.position) || /_door$/.test(expectedBlock) && overlapsPlayer({ ...target, y: target.y + 1 }, state.position)) throw new Error('自分に重なる場所には設置できません。')
    for (const player of players.values()) if (overlapsPlayer(target, player.position, true)) throw new Error('他のプレイヤーに重なる可能性があります。')
    const support = world.getBlock(click.x, click.y, click.z)
    if (support?.known !== true || AIR.has(support.name) || LIQUID.test(support.name) || support.boundingBox === 'empty' || support.extra?.length) throw new Error('クリックするブロックは取得済みの通常ブロックである必要があります。')
    const side = normal.y === 0
    const height = side && Number.isFinite(clickY) ? Math.min(0.95, Math.max(0.05, clickY)) : 0.5 + normal.y * 0.5
    const ladder = expectedBlock === 'minecraft:ladder', bottomSlab = expectedBlock === 'minecraft:cobblestone_slab'
    if (ladder || bottomSlab) {
      if (observed.inventoryKnown !== true || state.inventory?.known !== true || state.inventory.uncertain || description.stackId !== raw.stack_id) throw new Error('坑道の建材は受信済みの持ち物・個数・スタックIDが必要です。')
      if (ladder && (!side || !placementSupportOk(support))) throw new Error('はしごには受信済みの固い横の支持壁が必要です。')
      if (bottomSlab && (face === 0 || side && height >= 0.5)) throw new Error('丸石ハーフブロックは下付きになる面を指定してください。')
    }
    const clickPos = { x: 0.5 + normal.x * 0.5, y: height, z: 0.5 + normal.z * 0.5 }
    const point = { x: click.x + clickPos.x, y: click.y + clickPos.y, z: click.z + clickPos.z }
    const eye = state.position
    if (Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z) > 4.5) throw new Error('操作対象が手の届く範囲外です。')
    const error = sightError(eye, point, click)
    if (error) throw new Error(error)
    return { target, clicked: click, face, clickPos, point, blockRuntimeId: support.runtimeId, expectedBlock, slot, raw, alignFacing: alignFacing === true, wall: expectedBlock === 'minecraft:torch' && side, ...(ladder ? { ladderFacing: face } : {}), ...(bottomSlab ? { bottomSlab: true } : {}), replan: () => housePlan(options) }
  }
  return housePlan
}

module.exports = { createHousePlan, HOUSE }
