'use strict'

const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const eye = point => ({ ...point, y: point.y + 1.62 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const AIR = new Set(['air', 'cave_air', 'void_air'])
const WATER = new Set(['water', 'flowing_water'])
const PROJECTILE = /^minecraft:(?:arrow|thrown_trident|trident|fireball|small_fireball|dragon_fireball|shulker_bullet|wither_skull|wind_charge|breeze_wind_charge|snowball|egg)$/
// This is a deliberately broad local-observation boundary, not a claim that a
// distant or old projectile is embedded, stationary, or unable to return.
const PROJECTILE_OBSERVATION_RADIUS = 128
const dimensionName = value => ['overworld', 'nether', 'end'][value] ?? value

function projectileObservations (state, now) {
  const relevant = []
  let remoteCount = 0
  for (const entity of state.entities) {
    if (entity.alive === false || entity.dead || !(entity.kind === 'projectile' || PROJECTILE.test(entity.entityType))) continue
    const stamp = typeof entity.positionUpdatedAt === 'string' || typeof entity.positionUpdatedAt === 'number' ? new Date(entity.positionUpdatedAt).getTime() : NaN
    const known = entity.uniqueId != null && entity.positionKnown === true && finite(entity.position) && ['overworld', 'nether', 'end'].includes(dimensionName(state.dimension)) && dimensionName(entity.dimension) === dimensionName(state.dimension) && Number.isFinite(stamp) && stamp <= now + 1000
    if (known && distance(state.position, entity.position) > PROJECTILE_OBSERVATION_RADIUS) { remoteCount++; continue }
    relevant.push({ known, name: typeof entity.entityType === 'string' ? entity.entityType.slice(0, 80) : 'unknown_projectile' })
  }
  return { relevant, remoteCount }
}

function knownSurfaceBody (physics, point, surfaceY) {
  try {
    if (!finite(point) || !Number.isInteger(surfaceY) || point.y + 1.62 < surfaceY + 0.02) return false
    for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
      const water = physics.blockAt({ x, y: surfaceY - 1, z })
      if (!WATER.has(water.name) || water.shapes.length || !Number.isInteger(water.metadata) || water.metadata < 0 || water.metadata >= 8) return false
      const head = physics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
      if (!AIR.has(head.name) || head.shapes.length) return false
      for (let y = Math.floor(point.y + 1e-6); y <= Math.floor(point.y + 1.8 - 1e-6); y++) {
        const block = physics.blockAt({ x, y, z })
        if (block.shapes.length || !(AIR.has(block.name) || WATER.has(block.name))) return false
      }
    }
    return true
  } catch { return false }
}

function lowHealthSurfaceEligible (state, actors, physics, { starting = true, surfaceY = null, diagnostic = null, now = Date.now() } = {}) {
  const reject = reason => { if (diagnostic) diagnostic.reason = reason; return false }
  if (diagnostic) diagnostic.projectileRiskAccepted = false
  const physical = state?.predicted?.physicsState ?? state?.physicsState
  if (state?.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(Number.isFinite(state.health) && state.health > 0 && (state.threatPolicy === 'online_learning' ? state.health <= 20 : state.health < 20)) || !['survival', 0].includes(state.gameMode) || !finite(state.position) || !physical || physical.isInLava || !finite(physical.velocity) || starting && physical.isInWater !== true) return reject('not_living_water_state')
  const breath = state.breath
  if (!(Number.isFinite(breath?.current) && Number.isFinite(breath.maximum) && breath.current > 0 && breath.maximum > 0 && breath.current <= breath.maximum) || state.inventory?.known !== true || state.inventory.uncertain || !Array.isArray(state.entities) || !Array.isArray(actors) || !actors.length || actors.length > 64) return reject('breath_inventory_or_actors_unknown')
  const projectiles = projectileObservations(state, now)
  if (diagnostic) {
    diagnostic.projectileCount = Math.min(projectiles.relevant.length, 64)
    diagnostic.projectileCountTruncated = projectiles.relevant.length > 64
    diagnostic.projectileNames = [...new Set(projectiles.relevant.map(value => value.name))].slice(0, 8)
    diagnostic.remoteProjectileCount = Math.min(projectiles.remoteCount, 64)
  }
  // Explicit online learning accepts the observed projectile risk of a short
  // retreat. It must still pass knownSurfaceBody and the caller's existing
  // native route/coast proof and damage/identity/ownership fences. This is
  // neither projectile avoidance nor permission to execute an unproved route.
  const acceptsProjectileRisk = state.threatPolicy === 'online_learning' && projectiles.relevant.length > 0 && projectiles.relevant.every(value => value.known)
  if (projectiles.relevant.length && !acceptsProjectileRisk) return reject('active_projectile')
  for (const actor of actors) {
    const entity = state.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
    if (!entity || entity.uniqueId == null || entity.alive === false || entity.dead || entity.positionKnown === false || !finite(entity.position) || entity.dimension !== state.dimension || actor.category === 'boss' || ['minecraft:warden', 'minecraft:wither', 'minecraft:ender_dragon'].includes(actor.name)) return reject('actor_identity_scope_or_boss')
    if (actor.name === 'minecraft:creeper' && (entity.primed === true || entity.ignited === true || entity.exploding === true || entity.charged === true || entity.isCharged === true || entity.primed !== false && ['creeper_prime_fuse', 32].includes(entity.lastEvent?.event))) return reject('primed_or_charged_creeper')
  }
  const feet = { ...state.position, y: state.position.y - 1.62 }
  try { surfaceY ??= physics.waterSurface(feet)?.surfaceY } catch { return reject('surface_unknown') }
  if (!knownSurfaceBody(physics, feet, surfaceY)) return reject('head_body_or_water_unknown')
  if (diagnostic) { diagnostic.reason = acceptsProjectileRisk ? 'eligible_with_projectile_risk' : 'eligible'; diagnostic.projectileRiskAccepted = acceptsProjectileRisk }
  return true
}

function segmentDistance (point, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const length = dx * dx + dy * dy + dz * dz
  const ratio = length ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / length)) : 0
  return distance(point, { x: from.x + dx * ratio, y: from.y + dy * ratio, z: from.z + dz * ratio })
}

function proveLowHealthSurfaceRoute ({ navigator, initial, preview, circles, surfaceY, shallow }) {
  const empty = reason => ({ ready: false, reason })
  if (preview?.directSurface !== true || preview.waypoints?.length !== 1 || preview.waypoints[0].medium !== 'water' || !Array.isArray(circles)) return empty('explicit_surface_route_required')
  const origin = initial.position
  const safe = (from, to) => {
    if (horizontal(origin, to) > 1.5 || !shallow(to) || !knownSurfaceBody(navigator.physics, to, surfaceY) || circles.some(circle => segmentDistance(circle.position, eye(from), eye(to)) < circle.minDistance - 1e-4)) return false
    return true
  }
  try {
    const stepper = navigator.createStepper(preview, initial, { maxTicks: 40, sprint: false })
    const trace = [{ ...origin }]; let terminal = null; let ticks = 0
    for (; ticks < 40; ticks++) {
      const frame = stepper.next(), next = frame.predictedState.position
      if (ticks === 0 && next.y < origin.y) return empty('first_actual_step_not_rising')
      if (frame.predictedState.isInLava || !safe(trace.at(-1), next)) return empty('surface_arc_unsafe')
      trace.push({ ...next })
      if (frame.phase === 'awaiting_server_confirmation') { terminal = frame.predictedState; ticks++; break }
      if (frame.phase !== 'moving') return empty('surface_route_incomplete')
    }
    if (!terminal || !knownSurfaceBody(navigator.physics, terminal.position, surfaceY)) return empty('surface_route_incomplete')
    const executionTrace = trace.map(point => ({ ...point })); const coastTrace = [{ ...terminal.position }]
    let coast = terminal
    for (let tick = 0; tick < 8; tick++) {
      coast = navigator.physics.step(coast, { jump: true })
      if (coast.isInLava || !safe(trace.at(-1), coast.position)) return empty('surface_coast_unsafe')
      trace.push({ ...coast.position }); coastTrace.push({ ...coast.position })
    }
    return { ready: true, trace, executionTrace, coastTrace, ticks, terminal: structuredClone(terminal), serverConfirmed: false }
  } catch { return empty('surface_terrain_unknown') }
}

module.exports = { knownSurfaceBody, lowHealthSurfaceEligible, proveLowHealthSurfaceRoute }
