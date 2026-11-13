'use strict'

const { createNavigator } = require('./navigation')
const { evaluateThreats } = require('./threats')

const LEAVES = new Set([...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'azalea', 'orange_poplar', 'red_poplar', 'yellow_poplar'].map(name => `minecraft:${name}_leaves`), 'minecraft:azalea_leaves_flowered'])
const SOIL = new Set(['minecraft:grass_block', 'minecraft:dirt'])
const SWORD = /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/
const { finitePoint: finite } = require('./vec3')
const { distance3: distance } = require('./vec3')
// The host marks requested/predicted equipment false; an absent flag is its
// normal received-inventory representation. Never infer a selected hand from
// a requested slot or from heldItem alone.
function clearanceHandKey (state) {
  const slot = state?.rawServerSelectedSlot ?? state?.rawSelectedSlot
  if (state?.inventory?.known !== true || state.inventory.uncertain || !Array.isArray(state.inventory.items) || state.equipmentServerConfirmed === false || state.crafting?.authority === false || state.crafting?.openContainer || state.inventoryConfidence?.known === false || state.inventoryConfidence?.unresolved || !Number.isInteger(slot) || slot < 0 || slot > 8 || state.selectedSlot != null && state.selectedSlot !== slot) return null
  const items = state.inventory.items.filter(item => item.slot === slot)
  if (items.length > 1) return null
  const item = items[0] ?? null; const held = state.heldItem ?? null
  if (!item && held || item && (!['minecraft:rotten_flesh', 'minecraft:porkchop'].includes(item.name) || !Number.isInteger(item.count) || item.count < 1 || item.count > 64 || held?.name !== item.name || held.count !== item.count || held.slot != null && held.slot !== slot)) return null
  if (item && ['networkId', 'metadata', 'stackId'].some(key => item[key] != null && held[key] != null && item[key] !== held[key])) return null
  return JSON.stringify([slot, item, held])
}
function clearanceEquipmentKey (state) {
  if (state?.inventory?.known !== true || state.inventory.uncertain || state.equipmentServerConfirmed === false || state.crafting?.openContainer) return null
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
  const sword = state.inventory.items?.find(item => item.slot === slot && item.count === 1 && SWORD.test(item.name))
  if (sword && state.heldItem?.name === sword.name && state.heldItem?.count === 1) return JSON.stringify([slot, sword, state.heldItem])
  return clearanceHandKey(state)
}
function clearanceTargetAllowed (plan, block) {
  if (!block?.known || block.name !== plan?.name || block.protected || block.protectionSource || block.extra?.length || block.diggable === false) return false
  if (plan.kind === 'soil') return SOIL.has(block.name) && block.boundingBox === 'block' && block.natural !== false && block.playerPlaced !== true && (block.hardness == null || Number.isFinite(block.hardness) && block.hardness >= 0 && block.hardness <= 0.6)
  return LEAVES.has(block.name) && block.properties?.persistent_bit === 0
}
// This is a bounded emergency risk decision, not a guarantee against a fast
// mob or network delay. Use the actor's feet as well as our eye-distance policy:
// otherwise vertical eye offset makes a dangerously close creeper appear far.
function clearanceDistanceAllowed (state, threat) {
  if (!finite(state?.position) || !finite(threat?.position) || threat.name !== 'minecraft:creeper' || threat.dangerRadius !== 8 || !Number.isFinite(threat.distance) || threat.distance < 4.4) return false
  return distance({ ...state.position, y: state.position.y - 1.62 }, threat.position) >= 3.6
}
const segment = (point, from, to) => {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }; const length = d.x ** 2 + d.y ** 2 + d.z ** 2
  const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * d.x + (point.y - from.y) * d.y + (point.z - from.z) * d.z) / length)) : 0
  return distance(point, { x: from.x + t * d.x, y: from.y + t * d.y, z: from.z + t * d.z })
}

// Prediction only. An actual clear requires a separately monitored break, a
// received AIR update, and a new live escape preview from the current state.
function * emergencyLeafPlans ({ state, world, version = '1.26.60', physics } = {}) {
  const denied = reason => ({ ready: false, reason, predictionOnly: true, serverConfirmed: false })
  if (!finite(state?.position) || state.phase !== 'spawned' || state.dead || !(state.health >= 9) || state.inventory?.known !== true || state.inventory.uncertain || typeof world?.getBlock !== 'function' || !Array.isArray(state.entities)) return denied('state_unavailable')
  const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
  const sword = state.inventory.items?.find(item => item.slot === slot && item.count === 1 && SWORD.test(item.name))
  const swordConfirmed = sword && state.heldItem?.name === sword.name && state.heldItem?.count === 1 && state.equipmentServerConfirmed !== false && !state.crafting?.openContainer
  const handKey = swordConfirmed ? null : clearanceHandKey(state)
  if (!swordConfirmed && handKey === null) return denied('sword_unconfirmed')
  // Leaf clearance is disabled; preserve the existing hand-only soil escape.
  if (swordConfirmed) return denied('leaf_clearance_disabled')
  const physical = state.predicted?.physicsState ?? state.physicsState
  if (physical?.onGround !== true || physical?.isInWater || physical?.isInLava) return denied('unsupported_origin')
  const evaluation = evaluateThreats(state, state.entities, { observationRadius: 32 })
  if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.length !== 1) return denied('danger_changed')
  const creeper = evaluation.threats[0]
  const entity = state.entities.find(actor => String(actor.runtimeId ?? actor.runtimeEntityId ?? actor.entityId ?? actor.id) === creeper.runtimeId)
  if (!clearanceDistanceAllowed(state, creeper) || entity?.uniqueId == null) return denied('creeper_too_close_or_primed')
  const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
  if (Math.abs(feet.y - Math.round(feet.y)) > 1e-4) return denied('unsupported_origin')
  const floorY = Math.round(feet.y); const bx = Math.floor(feet.x); const bz = Math.floor(feet.z)
  const others = evaluation.outsideDanger
  const circles = [creeper, ...others].map(actor => ({ id: actor.runtimeId, position: { ...actor.position }, minDistance: actor.runtimeId === creeper.runtimeId ? creeper.distance : actor.dangerRadius, padding: 0 }))
  if (circles.length > 64 || circles.some(circle => typeof circle.id !== 'string')) return denied('danger_unknown')
  const danger = /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|sweet_berry_bush|pointed_dripstone|sand$|gravel$|concrete_powder|anvil/
  const candidates = []
  let removedBlock = null; let navigator = null
  const overlay = { getBlock: (x, y, z) => removedBlock && x === removedBlock.x && y === removedBlock.y && z === removedBlock.z ? { known: true, name: 'minecraft:air', properties: {}, extra: [] } : world.getBlock(x, y, z) }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of swordConfirmed ? [0, 1] : [1]) {
    const block = { x: bx + dx, y: floorY + dy, z: bz + dz }
    const existing = world.getBlock(block.x, block.y, block.z)
    const kind = swordConfirmed ? 'leaf' : 'soil'
    if (!clearanceTargetAllowed({ kind, name: existing?.name }, existing)) continue
    if (kind === 'soil') {
      // This removes an upper obstruction, never the riser, the bot's own
      // footprint, or a floor underneath it. Only ordinary received soil can
      // provide the preserved one-block landing support.
      const support = world.getBlock(block.x, block.y - 1, block.z)
      if (!support?.known || !SOIL.has(support.name) || support.boundingBox !== 'block' || support.extra?.length || support.protected || support.protectionSource || block.x >= Math.floor(feet.x - 0.3 + 1e-4) && block.x <= Math.floor(feet.x + 0.3 - 1e-4) && block.z >= Math.floor(feet.z - 0.3 + 1e-4) && block.z <= Math.floor(feet.z + 0.3 - 1e-4)) continue
    }
    let neighboursSafe = true
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const neighbour = world.getBlock(block.x + x, block.y + y, block.z + z)
      if (!neighbour?.known || danger.test(neighbour.name ?? '') || neighbour.extra?.length) neighboursSafe = false
    }
    if (!neighboursSafe || state.entities.some(actor => actor.kind === 'player' && actor.positionKnown !== false && finite(actor.position) && distance(actor.position, { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 }) < 3)) continue
    yield
    removedBlock = block
    try {
      navigator ??= createNavigator({ world: overlay, version, physics: physics?.withWorld(overlay) })
      const nav = navigator
      const initial = nav.physics.fromServer(state)
      if (kind === 'soil' && !nav.verifyOrigin(initial)) continue
      const targets = []
      for (const ox of [0, -0.15, 0.15]) for (const oz of [0, -0.15, 0.15]) {
        const target = { x: bx + dx + 0.5 + ox, y: floorY + (kind === 'soil' ? 1 : 0), z: bz + dz + 0.5 + oz }; const eye = { ...target, y: target.y + 1.62 }
        const gain = distance(creeper.position, eye) - creeper.distance
        if (gain >= 0.25 && !circles.some(circle => segment(circle.position, state.position, eye) < circle.minDistance - 1e-4)) targets.push({ target, gain })
      }
      targets.sort((a, b) => b.gain - a.gain)
      for (const { target } of targets.slice(0, 4)) {
        yield
        const avoidance = kind === 'soil' ? circles.map(circle => ({ ...circle, padding: Math.min(0.5, Math.max(0, distance(circle.position, { ...target, y: target.y + 1.62 }) - circle.minDistance)) })) : circles
        const route = nav.plan(initial, target, { maxDistance: 2, maxExpanded: 128, directFlat: true, exactGoal: true, avoidance })
        if (!route.ready || route.waypoints.length !== 1 || route.waypoints[0].action !== (kind === 'soil' ? 'jump' : 'walk') || route.waypoints[0].medium !== 'land') continue
        const stepper = nav.createStepper(route, initial, { maxTicks: 40, sprint: false }); let previous = state.position; let final = null
        let finalPhysics = null
        for (let i = 0; i < 40; i++) {
          if ((i & 1) === 0) yield
          const frame = stepper.next(); const position = { ...frame.predictedState.position, y: frame.predictedState.position.y + 1.62 }
          if (frame.predictedState.isInWater || frame.predictedState.isInLava || circles.some(circle => segment(circle.position, previous, position) < circle.minDistance - 1e-4)) { final = null; break }
          previous = position
          if (frame.phase === 'awaiting_server_confirmation') { final = position; finalPhysics = frame.predictedState; break }
          if (frame.phase !== 'moving') break
        }
        if (final && distance(creeper.position, final) >= creeper.distance + 0.25 && (kind !== 'soil' || nav.verifyOrigin(finalPhysics) && distance(creeper.position, final) > creeper.dangerRadius + 0.2)) { candidates.push({ block, name: existing.name, target, kind, gain: distance(creeper.position, final) - creeper.distance }); break }
      }
    } catch { /* Unknown terrain cannot authorize clearing. */ }
  }
  candidates.sort((a, b) => b.gain - a.gain)
  return candidates.length ? { ready: true, ...candidates[0], predictionOnly: true, serverConfirmed: false, creeperId: creeper.runtimeId, creeperUniqueId: String(entity.uniqueId) } : denied('no_single_leaf_escape')
}

function planEmergencyLeaf (options) {
  const planner = emergencyLeafPlans(options)
  let step
  do { step = planner.next() } while (!step.done)
  return step.value
}

async function planEmergencyLeafAsync ({ signal, check = () => {}, onSlice = () => {}, ...options } = {}) {
  const planner = emergencyLeafPlans(options)
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Emergency clearance planning interrupted')
      check()
      const sliceStarted = performance.now()
      const step = planner.next()
      onSlice(performance.now() - sliceStarted)
      if (step.done) return step.value
      // Keep the ordinary neutral sender and received danger packets alive;
      // this is never a queued receipt or a simulation of elapsed input.
      await new Promise(resolve => setImmediate(resolve))
    }
  } finally { planner.return() }
}

module.exports = { planEmergencyLeaf, planEmergencyLeafAsync, clearanceDistanceAllowed, clearanceHandKey, clearanceEquipmentKey, clearanceTargetAllowed }
