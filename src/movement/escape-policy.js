'use strict'

function selectConstrainedPrimary (threats, health) {
  if (!Array.isArray(threats) || !threats.length) return null
  if (health > 10 && threats.length === 2) {
    const creeper = threats.find(actor => actor.name === 'minecraft:creeper' && actor.dangerRadius === 8 && actor.distance >= 5.5)
    const spider = threats.find(actor => actor.name === 'minecraft:spider' && actor.distance >= 5.25 && actor.distance < 8.25)
    if (creeper && spider) return creeper
  }
  return threats.reduce((closest, actor) => !closest || actor.distance < closest.distance ? actor : closest, null)
}

// A short emergency route can give up a bounded amount of distance from an
// identified secondary enemy while increasing distance from the primary.
function constrainedSecondaryFloor (actor, primary, threats, health) {
  if (!actor || !primary || !Array.isArray(threats) || !Number.isFinite(actor.distance) || !Number.isFinite(health)) return null
  const zombie = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)
  const ranged = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)
  if (actor.name === 'minecraft:spider' && actor.distance < 8.25 && health > 10 && threats.length === 2 && primary.name === 'minecraft:creeper' && primary.dangerRadius === 8 && actor.distance >= 5.25) return Math.max(5, actor.distance - 0.4)
  // Mojang's Bedrock sample gives witches a 10-block ranged attack radius;
  // retain at least eight blocks of additional margin for short retreats.
  const floor = zombie ? (health >= 10 ? 7.5 : 8) : actor.name === 'minecraft:spider' ? 8 : ranged || actor.name === 'minecraft:witch' ? 18 : null
  return floor !== null && actor.distance >= floor + 0.25 ? Math.max(floor, actor.distance - 1.5) : null
}

// A previously observed skeleton just outside the broad avoidance boundary may
// be tracked during one short constrained retreat, with a fixed larger margin
// than its sample ranged attack and no more than 0.75 blocks of approach.
function outsideSkeletonFloor (actor) {
  if (!['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor?.name) || !Number.isFinite(actor.distance) || actor.distance < 24.25 || actor.distance > 25) return null
  return Math.max(23.5, actor.distance - 0.75)
}

// A narrow unarmed exception for one ordinary creeper and distant zombies or spiders.
// A lone creeper is accepted only when the caller explicitly enables it.
function unarmedCreeperZombie (state, threats, { creeperMinimum = 5.5, zombieMinimum = 9.5, allowSingle = false, allowCloseZombie = false } = {}) {
  if (state?.health !== 20 || state.inventory?.known !== true || state.inventory.uncertain || state.equipmentServerConfirmed === false || !Array.isArray(state.inventory.items) || !Array.isArray(state.entities) || !Array.isArray(threats) || threats.length < (allowSingle ? 1 : 2) || threats.length > 4 || !state.position) return false
  if (state.inventory.items.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))) return false
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
  if (!Number.isInteger(slot) || slot < 0 || slot > 8) return false
  const held = state.inventory.items.find(item => item.slot === slot && item.count > 0)
  if (held ? held.name !== 'minecraft:rotten_flesh' || state.heldItem?.name !== held.name || state.heldItem?.count !== held.count : state.heldItem != null) return false
  const closeZombiePair = allowCloseZombie && threats.length === 2 && threats.some(actor => actor.name === 'minecraft:zombie') && threats.some(actor => actor.name === 'minecraft:creeper')
  const minimumAllowed = allowSingle && threats.length === 1 || closeZombiePair ? 4 : 5
  if (!Number.isFinite(creeperMinimum) || creeperMinimum < minimumAllowed || creeperMinimum > 5.5) return false
  if (!Number.isFinite(zombieMinimum) || zombieMinimum < (closeZombiePair ? 9 : 9.5) || zombieMinimum > 9.5) return false
  const creeper = threats.find(actor => actor.name === 'minecraft:creeper' && actor.dangerRadius === 8 && actor.distance >= creeperMinimum)
  const zombie = threats.find(actor => actor.name === 'minecraft:zombie' && actor.distance >= zombieMinimum && actor.position && Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z) >= 7.5)
  const entity = creeper && state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === creeper.runtimeId)
  const zombieEntity = zombie && state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === zombie.runtimeId)
  const extras = threats.filter(actor => actor !== creeper && actor !== zombie)
  const extraSpidersKnown = extras.every(actor => actor.name === 'minecraft:spider' && actor.dangerRadius === 12 && actor.distance >= 11.25 && state.entities.some(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId && item.uniqueId != null))
  const horizontalMinimum = Math.max(minimumAllowed, Math.min(5, creeperMinimum))
  return !!(creeper?.position && (allowSingle || zombie?.position || extras.length) && (!zombie || zombieEntity?.uniqueId != null && creeper.distance < zombie.distance) && extras.every(actor => actor.distance > creeper.distance) && extraSpidersKnown && Math.hypot(creeper.position.x - state.position.x, creeper.position.z - state.position.z) >= horizontalMinimum && entity?.uniqueId != null && entity.primed === false && entity.charged === false)
}

// Surface retreat with a lone observed ordinary zombie and no usable sword.
function unarmedWaterZombie (state, threats) {
  if (state?.health !== 20 || state.inventory?.known !== true || state.inventory.uncertain || state.equipmentServerConfirmed === false || !Array.isArray(state.inventory.items) || !Array.isArray(state.entities) || !state.position || !Array.isArray(threats) || threats.length !== 1) return false
  if (state.inventory.items.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))) return false
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
  if (!Number.isInteger(slot) || slot < 0 || slot > 8) return false
  const held = state.inventory.items.find(item => item.slot === slot && item.count > 0)
  if (held ? held.name !== 'minecraft:rotten_flesh' || state.heldItem?.name !== held.name || state.heldItem?.count !== held.count : state.heldItem != null) return false
  const actor = threats[0]
  const entity = state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
  return !!(actor.name === 'minecraft:zombie' && actor.dangerRadius === 12 && actor.distance >= 9 && actor.position && Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z) >= 7.5 && entity?.uniqueId != null)
}

// A distant submerged drowned can shoot a trident and can swim upward. The
// Bedrock sample's ranged_attack has max 10 blocks; require 10.75 at planning,
// track the actor throughout the route, and do not infer its equipment.
// https://github.com/Mojang/bedrock-samples/blob/main/behavior_pack/entities/drowned.json
function unarmedCreeperDrowned (state, threats) {
  if (state?.health !== 20 || state.inventory?.known !== true || state.inventory.uncertain || state.equipmentServerConfirmed === false || !Array.isArray(state.inventory.items) || !Array.isArray(state.entities) || !state.position || !Array.isArray(threats) || threats.length < 2 || threats.length > 3) return false
  if (state.inventory.items.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))) return false
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
  if (!Number.isInteger(slot) || slot < 0 || slot > 8) return false
  const held = state.inventory.items.find(item => item.slot === slot && item.count > 0)
  if (held ? held.name !== 'minecraft:rotten_flesh' || state.heldItem?.name !== held.name || state.heldItem?.count !== held.count : state.heldItem != null) return false
  const creeper = threats.find(actor => actor.name === 'minecraft:creeper' && actor.dangerRadius === 8 && actor.distance >= 5.5 && actor.position && Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z) >= 5.5)
  const entity = creeper && state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === creeper.runtimeId)
  if (!creeper || entity?.uniqueId == null || entity.primed !== false || entity.charged !== false) return false
  const others = threats.filter(actor => actor !== creeper)
  return others.length >= 1 && others.every(actor => actor.name === 'minecraft:drowned' && actor.dangerRadius === 14 && actor.distance >= 10.75 && actor.position && state.position.y - actor.position.y >= 8 && state.entities.some(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId && item.uniqueId != null))
}

function unarmedWaterDrowned (state, threats) {
  if (state?.health !== 20 || state.inventory?.known !== true || state.inventory.uncertain || state.equipmentServerConfirmed === false || !Array.isArray(state.inventory.items) || !Array.isArray(state.entities) || !state.position || !Array.isArray(threats) || threats.length < 1 || threats.length > 2) return false
  if (state.inventory.items.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))) return false
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
  if (!Number.isInteger(slot) || slot < 0 || slot > 8) return false
  const held = state.inventory.items.find(item => item.slot === slot && item.count > 0)
  if (held ? held.name !== 'minecraft:rotten_flesh' || state.heldItem?.name !== held.name || state.heldItem?.count !== held.count : state.heldItem != null) return false
  return threats.every(actor => actor.name === 'minecraft:drowned' && actor.dangerRadius === 14 && actor.distance >= 10.75 && actor.position && state.position.y - actor.position.y >= 8 && state.entities.some(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId && item.uniqueId != null))
}

function unarmedZombieFloor (actor) { return actor.distance >= 10.75 ? Math.max(10, actor.distance - 1) : Math.max(8.75, actor.distance - 0.75) }

// Track an identified outside spider near its broad avoidance boundary. It
// must remain well beyond melee reach on every segment and can approach by
// at most 0.75 blocks during this one short route.
function outsideUnarmedSpiderFloor (actor) {
  if (actor?.name !== 'minecraft:spider' || actor.dangerRadius !== 12 || !Number.isFinite(actor.distance) || actor.distance < 12 || actor.distance > 13) return null
  return Math.max(10.5, actor.distance - 0.75)
}
function activeUnarmedSpiderFloor (actor) { return Math.max(10.5, actor.distance - 0.75) }

module.exports = { constrainedSecondaryFloor, selectConstrainedPrimary, outsideSkeletonFloor, unarmedCreeperZombie, unarmedWaterZombie, unarmedCreeperDrowned, unarmedWaterDrowned, unarmedZombieFloor, outsideUnarmedSpiderFloor, activeUnarmedSpiderFloor }
