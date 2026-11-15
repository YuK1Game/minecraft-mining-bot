'use strict'

// 1.26.60 codec: WindowType.container=0; ContainerSlotType.container=7,
// ContainerSlotType.shulker=30. These are different protocol enums.
// Geyser ShulkerInventoryTranslator uses CONTAINER + SHULKER_BOX (27 slots).
// https://github.com/GeyserMC/Geyser/blob/master/core/src/main/java/org/geysermc/geyser/translator/inventory/ShulkerInventoryTranslator.java
const SHULKER_COLORS = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'])
const SHULKER_BLOCKS = Object.freeze(['minecraft:undyed_shulker_box', ...SHULKER_COLORS.map(color => `minecraft:${color}_shulker_box`)])
const shulkers = new Set(SHULKER_BLOCKS)
const canonical = name => typeof name === 'string' ? name.includes(':') ? name : `minecraft:${name}` : null
const isShulkerBox = name => shulkers.has(canonical(name)) || canonical(name) === 'minecraft:shulker_box'
const isShulkerBlock = name => shulkers.has(canonical(name))
const CHEST = Object.freeze({ kind: 'chest', windowType: 'container', windowTypeId: 0, slotType: 'container', slotTypeId: 7, sizes: Object.freeze([27, 54]) })
const SHULKER = Object.freeze({ kind: 'shulker', windowType: 'container', windowTypeId: 0, slotType: 'shulker', slotTypeId: 30, sizes: Object.freeze([27]) })
const storageContainerType = blockName => canonical(blockName) === 'minecraft:chest' ? CHEST : isShulkerBlock(blockName) ? SHULKER : null
const storageWindowMatches = (type, descriptor) => !!descriptor && (type === descriptor.windowType || type === descriptor.windowTypeId)
const canonicalWindowId = value => value === 'inventory' ? 0 : value === 'first' ? 1 : value === 'last' ? 100 : Number.isInteger(value) ? value : null
const sameWindowId = (a, b) => canonicalWindowId(a) !== null && canonicalWindowId(a) === canonicalWindowId(b)

module.exports = { SHULKER_COLORS, SHULKER_BLOCKS, isShulkerBox, isShulkerBlock, storageContainerType, storageWindowMatches, canonicalWindowId, sameWindowId }
