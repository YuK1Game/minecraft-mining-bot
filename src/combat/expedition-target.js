'use strict'

const crystal = type => ['minecraft:ender_crystal', 'minecraft:end_crystal'].includes(type)
function permittedTarget (actor, dimension, weapon) {
  if (actor?.alive !== true || actor.dimension !== dimension || actor.positionKnown !== true ||
      ![actor.position?.x, actor.position?.y, actor.position?.z].every(Number.isFinite) ||
      actor.runtimeId == null || actor.uniqueId == null || !['bow', 'melee'].includes(weapon)) return false
  if (dimension === 'end') return actor.kind === 'mob' && actor.entityType === 'minecraft:ender_dragon' ||
    actor.kind === 'entity' && crystal(actor.entityType) && weapon === 'bow'
  if (actor.kind !== 'mob') return false
  if (dimension === 'nether' && ['minecraft:blaze', 'minecraft:magma_cube'].includes(actor.entityType)) return true
  if (dimension === 'overworld' && actor.entityType === 'minecraft:phantom') return true
  return ['overworld', 'nether'].includes(dimension) && actor.entityType === 'minecraft:enderman' && weapon === 'melee'
}

module.exports = { permittedTarget, crystal }
