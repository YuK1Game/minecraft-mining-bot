'use strict'

const { createPhysics } = require('./physics')
const { knownSurfaceBody } = require('./low-health-water')
const { planBoundedJump, createBoundedJumpStepper } = require('./bounded-jump')

const HALF_WIDTH = 0.3
const HEIGHT = 1.8
const EPSILON = 1e-6
const CONTACT_EPSILON = 1e-4
const EYE_HEIGHT = 1.62
const HAZARD = /(?:lava|fire|cactus|magma|campfire|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone)/
const key = position => `${Math.floor(position.x)},${position.y},${Math.floor(position.z)}`
const copy = position => ({ x: position.x, y: position.y, z: position.z })
const isWater = block => block.name === 'water' || block.name === 'flowing_water'
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function segmentDistance (point, from, to) {
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
  const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
  const ratio = length ? Math.max(0, Math.min(1, ((point.x - from.x) * delta.x + (point.y - from.y) * delta.y + (point.z - from.z) * delta.z) / length)) : 0
  return distance(point, { x: from.x + delta.x * ratio, y: from.y + delta.y * ratio, z: from.z + delta.z * ratio })
}

function finite (position) {
  return position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))
}

function createNavigator ({ world, version = '1.26.60', allowWater = false, physics, planningDistanceLimit = 24 } = {}) {
  if (!Number.isInteger(planningDistanceLimit) || planningDistanceLimit < 24 || planningDistanceLimit > 48) throw new Error('Invalid trusted planning distance limit')
  physics ??= createPhysics({ world, version, allowWater })
  if (physics.capabilities.version !== version) throw new Error('Navigation physics version mismatch')
  if (allowWater && physics.capabilities.water === 'disabled') throw new Error('Water navigation requires explicit water prediction')

  let planGeometry = null
  function geometryBlockAt (position) {
    if (!planGeometry) return physics.blockAt(position)
    const id = [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)].join(',')
    if (planGeometry.has(id)) {
      const entry = planGeometry.get(id)
      if (entry.error) throw entry.error
      return entry.block
    }
    try {
      const block = physics.blockAt(position)
      if (planGeometry.size < 32768) planGeometry.set(id, { block })
      return block
    } catch (error) {
      if (planGeometry.size < 32768) planGeometry.set(id, { error })
      throw error
    }
  }
  function plan (initialState, target, options) {
    const previous = planGeometry
    planGeometry = new Map()
    try {
      const route = planWithoutCache(initialState, target, options)
      if (planningDistanceLimit > 24) route.planningOnly = true
      const first = route.waypoints?.[0]
      let partial = false
      try { partial = route.ready && !allowWater && !route.partialRecenter && !route.partialDrop && !route.controlledDrop && !route.boundedJump && first?.medium === 'land' && first.action === 'walk' && Math.abs(first.position.y - initialState.position.y) <= CONTACT_EPSILON && horizontalDistance(initialState.position, first.position) >= 0.2 && horizontalDistance(initialState.position, first.position) <= 1.2 && !fullFootprintSupport(initialState.position) && verifyOrigin(initialState, { stablePartialOrigin: true }) } catch { /* Unknown origins cannot borrow a connector proof. */ }
      if (!partial) return route
      const connector = planWithoutCache(initialState, first.position, { partialRecenter: true, maxDistance: 2, maxExpanded: 64, avoidance: route.avoidance })
      // Keep the existing validated primitive as a real prefix, not a larger
      // waypoint tolerance or an assumption that recentering already happened.
      return connector.ready ? { ...route, originRecenter: connector } : { ...connector, origin: route.origin, target: route.target }
    } finally { planGeometry = previous }
  }

  function bodyFree (position, horizontalSkin = EPSILON) {
    for (let x = Math.floor(position.x - HALF_WIDTH + EPSILON); x <= Math.floor(position.x + HALF_WIDTH - EPSILON); x++) {
      for (let z = Math.floor(position.z - HALF_WIDTH + EPSILON); z <= Math.floor(position.z + HALF_WIDTH - EPSILON); z++) {
        for (let y = Math.floor(position.y + EPSILON); y <= Math.floor(position.y + HEIGHT - EPSILON); y++) {
          const block = geometryBlockAt({ x, y, z })
          if (HAZARD.test(block.name)) {
            // The received harmless plant is not fire. Require its exact raw
            // identity, no secondary layer, and the native empty shape.
            const raw = block.name === 'firefly_bush' && world.getBlock(x, y, z)
            if (!(block.name === 'firefly_bush' && block.shapes.length === 0 && raw?.known === true && String(raw.name).replace(/^minecraft:/, '') === 'firefly_bush' && raw.boundingBox === 'empty' && !raw.extra?.length)) return false
          }
          for (const shape of block.shapes) {
            if (position.x + HALF_WIDTH > x + shape[0] + horizontalSkin && position.x - HALF_WIDTH < x + shape[3] - horizontalSkin &&
                position.y + HEIGHT > y + shape[1] + EPSILON && position.y < y + shape[4] - EPSILON &&
                position.z + HALF_WIDTH > z + shape[2] + horizontalSkin && position.z - HALF_WIDTH < z + shape[5] - horizontalSkin) return false
          }
        }
      }
    }
    return true
  }

  function fullFootprintSupport (position) {
    const minX = position.x - HALF_WIDTH
    const maxX = position.x + HALF_WIDTH
    const minZ = position.z - HALF_WIDTH
    const maxZ = position.z + HALF_WIDTH
    const y = Math.floor(position.y - CONTACT_EPSILON)
    for (let x = Math.floor(minX + 1e-9); x <= Math.floor(maxX - 1e-9); x++) for (let z = Math.floor(minZ + 1e-9); z <= Math.floor(maxZ - 1e-9); z++) {
      const support = geometryBlockAt({ x, y, z })
      if (HAZARD.test(support.name)) return false
      const x0 = Math.max(minX, x)
      const x1 = Math.min(maxX, x + 1)
      const z0 = Math.max(minZ, z)
      const z1 = Math.min(maxZ, z + 1)
      if (!support.shapes.some(shape => Math.abs(y + shape[4] - position.y) <= CONTACT_EPSILON && x + shape[0] <= x0 + 1e-9 && x + shape[3] >= x1 - 1e-9 && z + shape[2] <= z0 + 1e-9 && z + shape[5] >= z1 - 1e-9)) return false
    }
    return true
  }

  function knownUnitSupportOrAir (position, shore = false) {
    const y = Math.floor(position.y - CONTACT_EPSILON)
    let contact = false
    for (let x = Math.floor(position.x - HALF_WIDTH + 1e-9); x <= Math.floor(position.x + HALF_WIDTH - 1e-9); x++) for (let z = Math.floor(position.z - HALF_WIDTH + 1e-9); z <= Math.floor(position.z + HALF_WIDTH - 1e-9); z++) {
      const support = geometryBlockAt({ x, y, z })
      if (HAZARD.test(support.name)) return false
      if (isWater(support)) { if (shore && support.shapes.length === 0) continue; return false }
      if (/(?:sand$|gravel$|concrete_powder$|anvil$|dragon_egg)/.test(support.name)) {
        if (!shore || !/^(?:sand|red_sand|gravel)$/.test(support.name)) return false
        // Falling blocks must rest on a known stable full cube, with every
        // intervening granular block accounted for. Water cannot support them.
        let stable = false
        for (let depth = 1; depth <= 8; depth++) {
          const below = geometryBlockAt({ x, y: y - depth, z })
          const cube = below.shapes.length === 1 && below.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
          if (!cube || HAZARD.test(below.name) || isWater(below)) return false
          if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
        }
        if (!stable) return false
      }
      // Received, dry short grass is empty space beside a ledge, never the
      // contact holding the player up. Real cube contact is still required.
      if (['air', 'cave_air', 'void_air', 'leaf_litter', 'short_grass'].includes(support.name) && support.shapes.length === 0) continue
      if (support.name === 'short_grass') return false
      // Partial initial contact is restricted to ordinary complete cubes.
      // Slabs, stairs and unreceived geometry cannot authorize this skin.
      if (support.shapes.length !== 1 || !support.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9) || Math.abs(y + 1 - position.y) > CONTACT_EPSILON) return false
      contact = true
    }
    return contact
  }

  function standAt (position) {
    if (!bodyFree(position)) return null
    // A collision-free water block is not dry land. Without this check the
    // water-enabled search can classify the floor beneath a lake as a walking
    // node, then try to route the player below the breathable surface.
    if (allowWater) for (let x = Math.floor(position.x - HALF_WIDTH + EPSILON); x <= Math.floor(position.x + HALF_WIDTH - EPSILON); x++) for (let z = Math.floor(position.z - HALF_WIDTH + EPSILON); z <= Math.floor(position.z + HALF_WIDTH - EPSILON); z++) for (let y = Math.floor(position.y + EPSILON); y <= Math.floor(position.y + HEIGHT - EPSILON); y++) if (isWater(geometryBlockAt({ x, y, z }))) return null
    // Five footprint samples need support at this height, keeping planned routes
    // off cliff edges and narrow supports even when a single point would collide.
    for (const [dx, dz] of [[0, 0], [-0.28, -0.28], [-0.28, 0.28], [0.28, -0.28], [0.28, 0.28]]) {
      const x = Math.floor(position.x + dx)
      const y = Math.floor(position.y - CONTACT_EPSILON)
      const z = Math.floor(position.z + dz)
      const support = geometryBlockAt({ x, y, z })
      if (HAZARD.test(support.name)) return null
      const onTop = support.shapes.some(shape => Math.abs(y + shape[4] - position.y) < 1e-4 && position.x + dx >= x + shape[0] - EPSILON && position.x + dx <= x + shape[3] + EPSILON && position.z + dz >= z + shape[2] - EPSILON && position.z + dz <= z + shape[5] + EPSILON)
      if (!onTop) return null
    }
    return { position: copy(position), medium: 'land' }
  }

  function waterAt (position) {
    if (!allowWater || !bodyFree(position)) return null
    const surface = physics.waterSurface(position)
    if (!surface) return null
    return { position: copy(position), medium: 'water', surfaceY: surface.surfaceY }
  }

  function classify (position) {
    return standAt(position) ?? waterAt(position)
  }

  function settledPose (state, medium = 'land') {
    if (Math.hypot(state.velocity.x, state.velocity.z) >= 0.006) return false
    if (medium === 'water') return Math.abs(state.velocity.y) < 0.08 && waterAt(state.position) !== null
    return state.onGround === true && state.isInWater !== true && bodyFree(state.position) && physics.hasSupport(state.position)
  }

  function verifyOrigin (initialState, { stablePartialOrigin = false } = {}) {
    try {
      if (typeof stablePartialOrigin !== 'boolean' || !finite(initialState?.position) || !finite(initialState.velocity) || !['survival', 0].includes(initialState.gameMode) || initialState.onGround !== true || initialState.isInWater || initialState.isInLava || initialState.velocity.y > 0.05 || initialState.velocity.y < -0.12) return false
      const origin = initialState.position
      const dryBody = point => {
        if (!bodyFree(point, CONTACT_EPSILON)) return false
        for (let x = Math.floor(point.x - HALF_WIDTH + EPSILON); x <= Math.floor(point.x + HALF_WIDTH - EPSILON); x++) for (let z = Math.floor(point.z - HALF_WIDTH + EPSILON); z <= Math.floor(point.z + HALF_WIDTH - EPSILON); z++) for (let y = Math.floor(point.y + EPSILON); y <= Math.floor(point.y + HEIGHT - EPSILON); y++) if (isWater(geometryBlockAt({ x, y, z }))) return false
        return true
      }
      if (!dryBody(origin) || !physics.hasSupport(origin)) return false
      if (fullFootprintSupport(origin)) return true
      if (!stablePartialOrigin || !knownUnitSupportOrAir(origin)) return false
      // A grounded partial ledge can remain motionless indefinitely. Prove
      // that neutral input preserves its actual contact rather than treating
      // it as an airborne pose that still needs a landing.
      let probe = structuredClone(initialState); let stable = 0
      for (let tick = 0; tick < 8; tick++) {
        probe = physics.step(probe, {})
        if (probe.onGround !== true || probe.isInWater || probe.isInLava || Math.abs(probe.position.y - origin.y) > CONTACT_EPSILON || horizontalDistance(probe.position, origin) > 0.15 || !dryBody(probe.position) || !knownUnitSupportOrAir(probe.position) || !physics.hasSupport(probe.position)) return false
        stable = Math.hypot(probe.velocity.x, probe.velocity.z) < 0.006 ? stable + 1 : 0
        if (stable >= 2) return true
      }
      return false
    } catch { return false }
  }

  function edgeClear (from, to, action) {
    const count = Math.max(1, Math.ceil(horizontalDistance(from.position, to.position) / 0.15))
    for (let index = 0; index <= count; index++) {
      const ratio = index / count
      const position = {
        x: from.position.x + (to.position.x - from.position.x) * ratio,
        // Three-high excavated stairs leave 1.2 blocks above the standing
        // feet after accounting for the 1.8-block body. The shared collision
        // model clips a normal jump there and still clears a one-block riser.
        y: action === 'jump' ? Math.max(from.position.y, to.position.y) + 0.2 : Math.max(from.position.y, to.position.y),
        z: from.position.z + (to.position.z - from.position.z) * ratio
      }
      if (!bodyFree(position)) return false
    }
    if (action === 'jump' && !bodyFree({ ...from.position, y: from.position.y + 1.2 })) return false
    return true
  }

  function planWithoutCache (initialState, target, { maxDistance = 12, maxExpanded = 1500, avoidance = [], directFlat = false, directSurface = false, exactGoal = false, partialDrop = false, partialRecenter = false, controlledDrop = false, controlledDropMax = 3, shoreRecenter = false, stablePartialOrigin = false, boundedJump = null } = {}) {
    const planningStarted = planningDistanceLimit > 24 ? performance.now() : null
    const unknown = new Map()
    const empty = reason => ({ ready: false, reason, waypoints: [], unknownFrontier: [...unknown.values()].slice(0, 32), predictionOnly: true, serverConfirmed: false })
    if (!finite(initialState?.position) || !(boundedJump !== null && target == null) && (!Number.isFinite(target?.x) || !Number.isFinite(target?.z) || (target.y != null && !Number.isFinite(target.y)))) return empty('Invalid navigation coordinates')
    if (!Number.isInteger(maxDistance) || maxDistance < 1 || maxDistance > planningDistanceLimit || !Number.isInteger(maxExpanded) || maxExpanded < 1 || maxExpanded > 5000) return empty('Invalid navigation search bounds')
    if (typeof directFlat !== 'boolean' || typeof directSurface !== 'boolean' || directSurface && (!allowWater || !exactGoal) || typeof exactGoal !== 'boolean' || typeof partialDrop !== 'boolean' || typeof partialRecenter !== 'boolean' || typeof controlledDrop !== 'boolean' || typeof shoreRecenter !== 'boolean' || typeof stablePartialOrigin !== 'boolean' || shoreRecenter && (!partialRecenter || !allowWater) || Number(partialDrop) + Number(partialRecenter) + Number(controlledDrop) > 1 || !Number.isInteger(controlledDropMax) || controlledDropMax < 3 || controlledDropMax > 20) return empty('Invalid direct movement policy')
    if (!Array.isArray(avoidance) || avoidance.length > 64 || avoidance.some(circle => typeof circle?.id !== 'string' || !circle.id.length || circle.id.length > 80 || !finite(circle.position) || ['x', 'y', 'z'].some(axis => Math.abs(circle.position[axis]) > 30000000) || !Number.isFinite(circle.minDistance) || circle.minDistance < 0 || circle.minDistance > 64 || !Number.isFinite(circle.padding ?? 0) || (circle.padding ?? 0) < 0 || (circle.padding ?? 0) > 0.5) || new Set(avoidance.map(circle => circle.id)).size !== avoidance.length) return empty('Invalid navigation avoidance policy')
    const circles = avoidance.map(circle => ({ id: circle.id, position: copy(circle.position), minDistance: circle.minDistance, padding: circle.padding ?? 0 }))
    function policyEdge (fromFeet, toFeet, initialConnector = false) {
      const from = { ...fromFeet, y: fromFeet.y + EYE_HEIGHT }
      const to = { ...toFeet, y: toFeet.y + EYE_HEIGHT }
      for (const circle of circles) {
        const padded = circle.minDistance + circle.padding
        const fromDistance = distance(circle.position, from)
        const leaving = fromDistance < padded - CONTACT_EPSILON
        // The true-origin connector keeps its observed hard floor. Subsequent
        // steps may leave planning padding gradually, but every swept segment
        // must preserve the separation already gained. Once outside, the full
        // padded boundary applies and cannot be crossed again.
        const required = leaving ? initialConnector ? circle.minDistance : Math.max(circle.minDistance, fromDistance) : padded
        if (segmentDistance(circle.position, from, to) < required - CONTACT_EPSILON) return false
      }
      return true
    }
    const origin = copy(initialState.position)
    if (boundedJump !== null) {
      if (allowWater || directSurface || partialDrop || partialRecenter || controlledDrop || shoreRecenter || !stablePartialOrigin) return empty('Bounded jump needs an explicit dry stable-origin policy')
      const route = planBoundedJump({ physics, initial: initialState, descriptor: boundedJump, target, originSafe: state => verifyOrigin(state, { stablePartialOrigin: true }), landingSafe: state => verifyOrigin(state), edgeSafe: (from, to) => policyEdge(from, to, true) })
      if (route.ready && horizontalDistance(origin, route.target) > maxDistance) return empty('Target lies outside the bounded search area')
      return { ...route, avoidance: circles }
    }
    if (horizontalDistance(origin, target) > maxDistance) return empty('Target lies outside the bounded search area')
    if (partialRecenter) {
      try {
        const horizontal = horizontalDistance(origin, target)
        if (initialState.onGround !== true || initialState.isInWater || initialState.isInLava || target.y == null || Math.abs(origin.y - target.y) > CONTACT_EPSILON || horizontal < 0.2 || horizontal > 1.2 || fullFootprintSupport(origin) || !knownUnitSupportOrAir(origin, shoreRecenter) || !physics.hasSupport(origin) || !bodyFree(origin, CONTACT_EPSILON) || !standAt(target) || !fullFootprintSupport(target) || shoreRecenter && !knownUnitSupportOrAir(target, true)) return empty('Partial recenter lacks bounded known support')
        // Recenter onto a fully supported nearby point, even when reaching a
        // cell centre would violate an actor's avoidance circle. The entire
        // trajectory below is simulated and checked before any input is sent.
        const route = { ready: true, origin, target: copy(target), waypoints: [{ position: copy(target), action: 'walk', medium: 'land' }], partialRecenter: true, shoreRecenter, predictionOnly: true, serverConfirmed: false, avoidance: circles }
        const stepper = createStepper(route, initialState, { maxTicks: 40, sprint: false }); const trace = [copy(origin)]
        for (let index = 0; index < 40; index++) {
          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
          if (!finite(next) || frame.predictedState.isInWater || frame.predictedState.isInLava || frame.predictedState.onGround !== true || Math.abs(next.y - origin.y) > CONTACT_EPSILON || horizontalDistance(origin, next) > 1.5 || !bodyFree(next, CONTACT_EPSILON) || !knownUnitSupportOrAir(next, shoreRecenter) || !physics.hasSupport(next) || !policyEdge(previous, next, true)) return empty('Partial recenter prediction is unsafe or violates avoidance')
          trace.push(copy(next))
          if (frame.phase === 'awaiting_server_confirmation' && fullFootprintSupport(next) && horizontalDistance(next, target) <= 0.35) return { ...route, partialRecenter: true, predictedTrace: trace }
          if (frame.phase !== 'moving') break
        }
        return empty('Partial recenter did not predict fully supported land')
      } catch (error) { return empty(`Partial recenter is unknown or unsupported: ${error.message}`) }
    }
    if (partialDrop) {
      try {
        const horizontal = horizontalDistance(origin, target)
        if (initialState.onGround !== true || initialState.isInWater || initialState.isInLava || target.y == null || Math.abs(origin.y - target.y - 1) > CONTACT_EPSILON || horizontal < 0.2 || horizontal > 1.2 || fullFootprintSupport(origin) || !knownUnitSupportOrAir(origin) || !physics.hasSupport(origin) || !bodyFree(origin, CONTACT_EPSILON) || !standAt(target) || !fullFootprintSupport(target)) return empty('Partial ledge descent lacks bounded known support')
        const route = { ready: true, origin, target: copy(target), waypoints: [{ position: copy(target), action: 'walk', medium: 'land' }], partialDrop: true, predictionOnly: true, serverConfirmed: false, avoidance: circles }
        const stepper = createStepper(route, initialState, { maxTicks: 40, sprint: false })
        const trace = [copy(origin)]
        for (let index = 0; index < 40; index++) {
          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
          if (!finite(next) || frame.predictedState.isInWater || frame.predictedState.isInLava || next.y < target.y - 0.05 || next.y > origin.y + 0.05 || horizontalDistance(origin, next) > 1.5 || !bodyFree(next, CONTACT_EPSILON) || !policyEdge(previous, next, true)) return empty('Partial descent prediction is unsafe or violates avoidance')
          trace.push(copy(next))
          if (frame.phase === 'awaiting_server_confirmation' && fullFootprintSupport(next) && Math.abs(next.y - target.y) <= 0.05 && horizontalDistance(next, target) <= 0.35) return { ...route, predictedTrace: trace }
          if (frame.phase !== 'moving') break
        }
        return empty('Partial descent did not predict a fully supported landing')
      } catch (error) { return empty(`Partial descent is unknown or unsupported: ${error.message}`) }
    }
    if (controlledDrop) {
      try {
        const horizontal = horizontalDistance(origin, target)
        const drop = origin.y - target.y
        if (initialState.onGround !== true || initialState.isInWater || initialState.isInLava || target.y == null || Math.abs(drop - Math.round(drop)) > CONTACT_EPSILON || drop < 2 - CONTACT_EPSILON || drop > controlledDropMax + CONTACT_EPSILON || horizontal < 0.2 || horizontal > 1.5 || !bodyFree(origin, CONTACT_EPSILON) || !fullFootprintSupport(origin) || !standAt(target) || !fullFootprintSupport(target)) return empty('Controlled descent lacks bounded known support')
        const route = { ready: true, origin, target: copy(target), waypoints: [{ position: copy(target), action: 'walk', medium: 'land' }], controlledDrop: true, predictionOnly: true, serverConfirmed: false, avoidance: circles }
        const stepper = createStepper(route, initialState, { maxTicks: 80, sprint: false }); const trace = [copy(origin)]
        for (let index = 0; index < 80; index++) {
          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
          if (!finite(next) || frame.predictedState.isInWater || frame.predictedState.isInLava || next.y < target.y - 0.05 || next.y > origin.y + 0.05 || horizontalDistance(origin, next) > 1.75 || !bodyFree(next, CONTACT_EPSILON) || !policyEdge(previous, next, true)) return empty('Controlled descent prediction is unsafe or violates avoidance')
          trace.push(copy(next))
          if (frame.phase === 'awaiting_server_confirmation' && fullFootprintSupport(next) && Math.abs(next.y - target.y) <= 0.05 && horizontalDistance(next, target) <= 0.35) return { ...route, predictedTrace: trace }
          if (frame.phase !== 'moving') break
        }
        return empty('Controlled descent did not predict a fully supported landing')
      } catch (error) { return empty(`Controlled descent is unknown or unsupported: ${error.message}`) }
    }
    const goalX = Math.floor(target.x)
    const goalZ = Math.floor(target.z)
    const noteUnknown = (position, error) => {
      if (/Unknown|incomplete|not received|unreceived/i.test(error.message)) unknown.set(key(position), { ...position, reason: error.message })
    }
    // The received world cannot change during this synchronous search. Cache
    // only this call's geometric classifications; actor policy is still checked
    // on every edge, and subsequent plans observe the world again.
    const classificationCache = new Map()
    function safeClassify (position) {
      const id = [position.x, position.y, position.z].join(',')
      if (classificationCache.has(id)) return classificationCache.get(id)
      let result = null
      try { result = classify(position) } catch (error) { noteUnknown(position, error) }
      if (classificationCache.size < 32768) classificationCache.set(id, result)
      return result
    }
    // A corrected swimmer must keep the chosen heading instead of restarting
    // an axis-first grid path after every correction. This shortcut is opt-in,
    // stays on one received surface, and proves the complete direct trajectory.
    if (directSurface && initialState.isInLava !== true && target.y != null && horizontalDistance(origin, target) <= 4.5) {
      try {
        const start = waterAt(origin)
        if (start && Math.abs(target.y - start.surfaceY) <= CONTACT_EPSILON) {
          const surfaceY = start.surfaceY
          const destination = { x: target.x, y: surfaceY, z: target.z }
          function surfaceBody (point) {
            const wet = waterAt(point)
            if (!wet || wet.surfaceY !== surfaceY) return false
            for (let x = Math.floor(point.x - HALF_WIDTH + EPSILON); x <= Math.floor(point.x + HALF_WIDTH - EPSILON); x++) for (let z = Math.floor(point.z - HALF_WIDTH + EPSILON); z <= Math.floor(point.z + HALF_WIDTH - EPSILON); z++) {
              const water = geometryBlockAt({ x, y: surfaceY - 1, z })
              const above = geometryBlockAt({ x, y: surfaceY, z })
              if (!isWater(water) || !Number.isInteger(water.metadata) || water.metadata < 0 || water.metadata >= 8 || !['air', 'cave_air', 'void_air'].includes(above.name)) return false
              for (let y = Math.floor(point.y + EPSILON); y <= Math.floor(point.y + HEIGHT - EPSILON); y++) {
                const block = geometryBlockAt({ x, y, z })
                if (isWater(block)) {
                  if (!Number.isInteger(block.metadata) || block.metadata < 0 || block.metadata >= 8) return false
                } else if (!['air', 'cave_air', 'void_air'].includes(block.name)) return false
              }
            }
            return true
          }
          function surfaceSegment (from, to) {
            if (!finite(from) || !finite(to) || !policyEdge(from, to)) return false
            const count = Math.max(1, Math.ceil(distance(from, to) / 0.1))
            for (let index = 0; index <= count; index++) {
              const t = index / count
              if (!surfaceBody({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t })) return false
            }
            return true
          }
          if (surfaceSegment(origin, destination)) {
            const route = { ready: true, origin, target: destination, waypoints: [{ position: destination, action: 'swim', medium: 'water', waterSurfaceY: surfaceY }], expanded: 0, unknownFrontier: [], avoidance: circles, directSurface: true, predictionOnly: true, serverConfirmed: false, water: 'experimental-unverified' }
            const stepper = createStepper(route, initialState, { maxTicks: 80, sprint: false })
            const predictedTrace = [copy(origin)]
            for (let index = 0; index < 80; index++) {
              const frame = stepper.next(); const next = frame.predictedState.position
              if (frame.predictedState.isInLava || !surfaceSegment(predictedTrace.at(-1), next)) break
              predictedTrace.push(copy(next))
              if (frame.phase === 'awaiting_server_confirmation' && frame.predictedState.isInWater === true) return { ...route, predictedTrace }
              if (frame.phase !== 'moving') break
            }
          }
        }
      } catch (error) { noteUnknown(origin, error) }
    }
    // Explicit bounded shore-to-surface shortcut. The caller must still
    // simulate the complete trajectory and monitor moving actors. Every
    // sampled footprint rests over known full cubes or known surface water.
    if (directSurface && initialState.onGround === true && !initialState.isInWater && !initialState.isInLava && target.y != null && Math.abs(origin.y - target.y) <= CONTACT_EPSILON && horizontalDistance(origin, target) <= 4.5) {
      try {
        const destination = { x: target.x, y: origin.y, z: target.z }
        let clear = standAt(origin) && waterAt(destination) && policyEdge(origin, destination)
        const count = Math.max(1, Math.ceil(horizontalDistance(origin, destination) / 0.1))
        for (let index = 0; clear && index <= count; index++) {
          const t = index / count
          const point = { x: origin.x + (destination.x - origin.x) * t, y: origin.y, z: origin.z + (destination.z - origin.z) * t }
          if (!bodyFree(point)) { clear = false; break }
          for (let x = Math.floor(point.x - HALF_WIDTH + EPSILON); x <= Math.floor(point.x + HALF_WIDTH - EPSILON) && clear; x++) for (let z = Math.floor(point.z - HALF_WIDTH + EPSILON); z <= Math.floor(point.z + HALF_WIDTH - EPSILON) && clear; z++) {
            const floor = geometryBlockAt({ x, y: Math.floor(point.y - CONTACT_EPSILON), z })
            const full = floor.shapes.length === 1 && floor.shapes[0].every((value, i) => Math.abs(value - [0, 0, 0, 1, 1, 1][i]) <= 1e-9)
            if (HAZARD.test(floor.name) || !(isWater(floor) && Number.isInteger(floor.metadata) && floor.metadata >= 0 && floor.metadata < 8 || full)) { clear = false; break }
            if (isWater(floor)) {
              let bottom = false
              for (let depth = 1; depth <= 4; depth++) {
                const below = geometryBlockAt({ x, y: Math.floor(point.y - CONTACT_EPSILON) - depth, z })
                if (isWater(below)) { if (!Number.isInteger(below.metadata) || below.metadata < 0 || below.metadata >= 8) break; continue }
                if (!HAZARD.test(below.name) && below.shapes.length === 1 && below.shapes[0].every((value, i) => Math.abs(value - [0, 0, 0, 1, 1, 1][i]) <= 1e-9)) {
                  if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) bottom = true
                  else for (let deeper = 1; deeper <= 8; deeper++) {
                    const support = geometryBlockAt({ x, y: Math.floor(point.y - CONTACT_EPSILON) - depth - deeper, z })
                    if (HAZARD.test(support.name) || support.shapes.length !== 1 || !support.shapes[0].every((value, i) => Math.abs(value - [0, 0, 0, 1, 1, 1][i]) <= 1e-9)) break
                    if (!/^(?:sand|red_sand|gravel)$/.test(support.name)) { bottom = true; break }
                  }
                }
                break
              }
              if (!bottom) { clear = false; break }
            }
            if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
              let stable = false
              for (let depth = 1; depth <= 8; depth++) {
                const below = geometryBlockAt({ x, y: Math.floor(point.y - CONTACT_EPSILON) - depth, z })
                if (HAZARD.test(below.name) || below.shapes.length !== 1 || !below.shapes[0].every((value, i) => Math.abs(value - [0, 0, 0, 1, 1, 1][i]) <= 1e-9)) break
                if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
              }
              if (!stable) { clear = false; break }
            }
            for (const y of [Math.floor(point.y + EPSILON), Math.floor(point.y + HEIGHT - EPSILON)]) if (isWater(geometryBlockAt({ x, y, z }))) clear = false
          }
        }
        if (clear) {
          const route = { ready: true, origin, target: destination, waypoints: [{ position: destination, action: 'swim', medium: 'water', waterSurfaceY: origin.y }], expanded: 0, unknownFrontier: [], avoidance: circles, directSurface: true, predictionOnly: true, serverConfirmed: false, water: 'experimental-unverified' }
          const stepper = createStepper(route, initialState, { maxTicks: 80, sprint: false })
          let prior = origin; const predictedTrace = [copy(origin)]
          for (let index = 0; index < 80; index++) {
            const frame = stepper.next(); const next = frame.predictedState.position
            if (!finite(next) || frame.predictedState.isInLava || next.y < origin.y - 1.6 || next.y > origin.y + 0.6 || !bodyFree(next) || !policyEdge(prior, next)) break
            prior = copy(next); predictedTrace.push(prior)
            if (frame.phase === 'awaiting_server_confirmation' && frame.predictedState.isInWater === true) return { ...route, predictedTrace }
            if (frame.phase !== 'moving') break
          }
        }
      } catch (error) { noteUnknown(origin, error) }
    }
    // Escape can use a straight, possibly diagonal path without visiting grid
    // centres, but only when the complete body and footprint remain known and
    // supported for the entire segment. Actor circles are still enforced.
    if (directFlat && target.y != null && initialState.onGround === true && initialState.isInWater !== true && initialState.isInLava !== true && Math.abs(origin.y - target.y) <= CONTACT_EPSILON) {
      const destination = { x: target.x, y: origin.y, z: target.z }
      try {
        const count = Math.max(1, Math.ceil(horizontalDistance(origin, destination) / 0.1))
        let clear = safeClassify(destination)?.medium === 'land' && policyEdge(origin, destination, false)
        for (let i = 0; clear && i <= count; i++) {
          const t = i / count
          const point = { x: origin.x + (destination.x - origin.x) * t, y: origin.y, z: origin.z + (destination.z - origin.z) * t }
          clear = bodyFree(point) && fullFootprintSupport(point)
        }
        if (clear) return { ready: true, origin, target: destination, waypoints: [{ position: destination, action: 'walk', medium: 'land' }], expanded: 0, unknownFrontier: [], avoidance: circles, directFlat: true, predictionOnly: true, serverConfirmed: false, water: allowWater ? 'experimental-unverified' : 'disabled' }
      } catch (error) { noteUnknown(origin, error) }
    }
    let originWater = null
    try { originWater = waterAt(origin) } catch (error) { noteUnknown(origin, error) }
    // The graph uses the observed water-cell top; the physics state keeps its
    // actual floating/falling height and must reach the shore by simulation.
    const roundedY = originWater?.surfaceY ?? Math.round(origin.y * 2) / 2
    if (Math.abs(origin.y - roundedY) > CONTACT_EPSILON) {
      if (!originWater) return empty('Wait for a supported landing before planning')
    }
    let start
    const roundedOrigin = { ...origin, y: roundedY }
    const originClass = safeClassify(roundedOrigin)
    let initialContactSkin = false
    let initialPartialSkin = false
    try {
      const originFree = bodyFree(roundedOrigin)
      if (stablePartialOrigin && !fullFootprintSupport(roundedOrigin)) {
        if (!verifyOrigin(initialState, { stablePartialOrigin: true }) || !policyEdge(origin, roundedOrigin, true)) return empty('The partial origin has no known stable dry contact')
        start = { position: copy(roundedOrigin), medium: 'land', stablePartialOrigin: true }
      }
      // Float32 contact with a known wall may overlap by a few microns. Only
      // the initial connector can tolerate it. A grounded partial ledge also
      // qualifies when every under-foot cell is a known complete cube or air,
      // with real contact somewhere; no received position is moved.
      if (!originFree && bodyFree(roundedOrigin, CONTACT_EPSILON)) {
        const full = fullFootprintSupport(roundedOrigin)
        initialPartialSkin = !full && initialState.onGround === true && initialState.isInWater !== true && initialState.isInLava !== true && knownUnitSupportOrAir(roundedOrigin)
        initialContactSkin = full || initialPartialSkin
      }
      if (!originClass && ((!originFree && !initialContactSkin) || !physics.hasSupport(roundedOrigin))) return empty('The current footprint has no known safe support')
      // A real jump can land with only part of the footprint on a ledge. Start
      // from a nearby fully supported node only if every point of the short
      // connector remains physically supported; never cross a gap this way.
      const candidates = []
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const candidate = safeClassify({ x: Math.floor(origin.x) + dx + 0.5, y: roundedY, z: Math.floor(origin.z) + dz + 0.5 })
        if (candidate) candidates.push(candidate)
      }
      candidates.sort((a, b) => horizontalDistance(a.position, origin) - horizontalDistance(b.position, origin))
      for (const candidate of candidates) {
        if (start) break
        try {
          if (!policyEdge(origin, candidate.position, true)) continue
          if (initialPartialSkin && (!fullFootprintSupport(candidate.position) || !knownUnitSupportOrAir(candidate.position))) continue
          const count = Math.max(1, Math.ceil(horizontalDistance(origin, candidate.position) / 0.1))
          let safe = true
          for (let index = 0; index <= count; index++) {
            const ratio = index / count
            const point = { x: origin.x + (candidate.position.x - origin.x) * ratio, y: roundedY, z: origin.z + (candidate.position.z - origin.z) * ratio }
            if (initialPartialSkin && !knownUnitSupportOrAir(point)) { safe = false; break }
            const free = bodyFree(point) || (initialContactSkin && (initialPartialSkin || fullFootprintSupport(point)) && bodyFree(point, CONTACT_EPSILON))
            if (!free || (candidate.medium === 'water' ? !waterAt(point) : !physics.hasSupport(point))) { safe = false; break }
          }
          if (safe) { start = candidate; break }
        } catch (error) { noteUnknown(candidate.position, error) }
      }
      // With actor avoidance, recentering by even a few centimetres can move
      // toward a nearby threat. If the actual grounded footprint is fully
      // known and supported, use it as the first graph node instead of forcing
      // that unnecessary connector. No received position is changed.
      if (!start && circles.length && originClass?.medium === 'land' && initialState.onGround === true && initialState.isInWater !== true && initialState.isInLava !== true && bodyFree(roundedOrigin) && fullFootprintSupport(roundedOrigin) && policyEdge(origin, roundedOrigin, true)) start = { ...originClass, position: copy(roundedOrigin) }
      // On the surface, a grid-centre connector can point toward a threat even
      // though the received water pose itself is valid. Seed the graph from
      // that pose; all subsequent edges retain their normal terrain and actor
      // checks, and the actual water trajectory is still simulated by callers.
      if (!start && circles.length && originClass?.medium === 'water' && initialState.isInLava !== true && bodyFree(roundedOrigin) && policyEdge(origin, roundedOrigin, true)) start = { ...originClass, position: copy(roundedOrigin) }
    } catch (error) { noteUnknown(roundedOrigin, error) }
    if (!start) return empty('The starting footprint has no known safe support')
    const heuristic = node => Math.abs(Math.floor(node.position.x) - goalX) + Math.abs(Math.floor(node.position.z) - goalZ) + (target.y == null ? 0 : Math.abs(node.position.y - target.y))
    const firstKey = key(start.position)
    const records = new Map([[firstKey, { ...start, g: 0, f: heuristic(start), parent: null, action: start.medium === 'water' ? 'swim' : 'walk', waterSurfaceY: start.surfaceY }]])
    const open = new Set([firstKey])
    const closed = new Set()
    let expanded = 0
    let found = null
    while (open.size && expanded < maxExpanded) {
      if (planningStarted !== null && performance.now() - planningStarted >= 120) return empty('The trusted planning time limit was reached')
      let currentKey
      for (const candidate of open) if (currentKey === undefined || records.get(candidate).f < records.get(currentKey).f) currentKey = candidate
      const current = records.get(currentKey)
      open.delete(currentKey)
      if (Math.floor(current.position.x) === goalX && Math.floor(current.position.z) === goalZ && (target.y == null || Math.abs(current.position.y - target.y) <= 0.26)) {
        found = currentKey
        break
      }
      closed.add(currentKey)
      expanded++
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = current.position.x + dx
        const z = current.position.z + dz
        if (horizontalDistance(origin, { x, z }) > maxDistance + 0.01) continue
        for (const dy of [0, 0.5, -0.5, 1, -1]) {
          // A bounded caller may request its exact safe landing point in the
          // neighbouring goal cell. The ordinary cell-centre route remains the
          // default; all body, footing and actor checks still apply.
          const useExact = exactGoal && Math.floor(x) === goalX && Math.floor(z) === goalZ && target.y != null && Math.abs(current.position.y + dy - target.y) <= 0.001
          const candidate = safeClassify({ x: useExact ? target.x : x, y: current.position.y + dy, z: useExact ? target.z : z })
          if (!candidate) continue
          // The surface-buoyancy model cannot mount a full-block high bank.
          // Preserve half-height exits; reach lower shore before a land jump.
          if (current.medium === 'water' && candidate.medium === 'land' && candidate.position.y > current.surfaceY + 0.5 + CONTACT_EPSILON) continue
          const candidateKey = key(candidate.position)
          if (closed.has(candidateKey)) continue
          const action = candidate.medium === 'water' || current.medium === 'water' ? 'swim' : dy > 0.6 ? 'jump' : 'walk'
          if (!policyEdge(current.position, candidate.position)) continue
          try { if (!edgeClear(current, candidate, action)) continue } catch (error) { noteUnknown(candidate.position, error); continue }
          if (current.stablePartialOrigin) {
            const drop = origin.y - candidate.position.y
            const partialDrop = Math.abs(drop - 1) <= CONTACT_EPSILON
            const partialRecenter = Math.abs(drop) <= CONTACT_EPSILON
            // Reuse the existing bounded, fully simulated one-block descent
            // or level recenter. Later graph nodes and final arrivals still
            // require complete support; no airborne/gap start is synthesized.
            if ((!partialDrop && !partialRecenter) || candidate.medium !== 'land' || !fullFootprintSupport(candidate.position) || !plan(initialState, candidate.position, { maxDistance: 2, maxExpanded: 64, avoidance: circles, partialDrop, partialRecenter }).ready) continue
          }
          const g = current.g + 1 + Math.abs(dy) * 0.3 + (action === 'jump' ? 0.8 : action === 'swim' ? 3 : 0)
          const previous = records.get(candidateKey)
          if (previous && previous.g <= g) continue
          const surfaces = [current.surfaceY, candidate.surfaceY].filter(Number.isFinite)
          records.set(candidateKey, { ...candidate, g, f: g + heuristic(candidate), parent: currentKey, action, waterSurfaceY: action === 'swim' ? Math.min(...surfaces) : undefined })
          open.add(candidateKey)
        }
      }
    }
    if (!found) return empty(expanded >= maxExpanded ? 'Navigation search limit reached' : unknown.size ? 'No route through the known safe terrain' : 'No safe route found')
    const reversed = []
    for (let cursor = found; cursor !== null; cursor = records.get(cursor).parent) {
      const record = records.get(cursor)
      reversed.push({ position: copy(record.position), action: record.action, medium: record.medium, ...(Number.isFinite(record.waterSurfaceY) ? { waterSurfaceY: record.waterSurfaceY } : {}) })
    }
    const waypoints = reversed.reverse()
    const directFlatStart = () => {
      const first = waypoints[0]; const next = waypoints[1]
      if (!next || initialState.onGround !== true || initialState.isInWater === true || initialState.isInLava === true || first.medium !== 'land' || next.medium !== 'land' || first.action !== 'walk' || next.action !== 'walk' || Math.abs(first.position.y - origin.y) > CONTACT_EPSILON || Math.abs(next.position.y - origin.y) > CONTACT_EPSILON) return false
      if (!policyEdge(origin, next.position, true)) return false
      const count = Math.max(1, Math.ceil(horizontalDistance(origin, next.position) / 0.1))
      try {
        for (let index = 0; index <= count; index++) {
          const ratio = index / count
          const point = { x: origin.x + (next.position.x - origin.x) * ratio, y: origin.y + (next.position.y - origin.y) * ratio, z: origin.z + (next.position.z - origin.z) * ratio }
          if (!bodyFree(point) || !fullFootprintSupport(point)) return false
        }
        return true
      } catch (error) { noteUnknown(origin, error); return false }
    }
    const directWaterStart = () => {
      const first = waypoints[0]; const next = waypoints[1]
      if (!originWater || initialState.isInLava || !next || first.medium !== 'water' || next.medium !== 'water' || first.action !== 'swim' || next.action !== 'swim' || next.waterSurfaceY !== originWater.surfaceY || !policyEdge(origin, next.position, true)) return false
      // Grid recentering can send a swimming player backwards immediately
      // after a server correction. Skip that node only when the direct
      // connector has known water and clear body space all the way across.
      const count = Math.max(1, Math.ceil(horizontalDistance(origin, next.position) / 0.1))
      try {
        for (let index = 0; index <= count; index++) {
          const ratio = index / count
          const point = { x: origin.x + (next.position.x - origin.x) * ratio, y: originWater.surfaceY, z: origin.z + (next.position.z - origin.z) * ratio }
          const wet = waterAt(point)
          if (!wet || wet.surfaceY !== originWater.surfaceY) return false
        }
        return true
      } catch (error) { noteUnknown(origin, error); return false }
    }
    if (horizontalDistance(origin, waypoints[0].position) < 0.2 || directFlatStart() || directWaterStart()) waypoints.shift()
    const goal = records.get(found)
    const exactTarget = { x: target.x, y: goal.position.y, z: target.z }
    if (!safeClassify(exactTarget)) return empty('The exact target footprint is unsafe or unknown')
    if (!policyEdge(goal.position, exactTarget)) return empty('The exact target connector violates navigation avoidance')
    if (horizontalDistance(exactTarget, goal.position) > 0.15) waypoints.push({ position: exactTarget, action: goal.medium === 'water' ? 'swim' : 'walk', medium: goal.medium })
    return { ready: true, origin, target: exactTarget, waypoints, expanded, unknownFrontier: [...unknown.values()].slice(0, 32), avoidance: circles, ...(start.stablePartialOrigin ? { stablePartialOrigin: true } : {}), predictionOnly: true, serverConfirmed: false, water: allowWater ? 'experimental-unverified' : 'disabled' }
  }

  function createStepper (route, initialState, { maxTicks = 400, sprint = false } = {}) {
    if (route?.planningOnly) throw new Error('A planning-only route requires a fresh ordinary short preview')
    if (!route?.ready || !Array.isArray(route.waypoints) || !finite(initialState?.position)) throw new Error('A valid navigation plan and physics state are required')
    if (typeof sprint !== 'boolean') throw new Error('sprint must be an explicit boolean')
    if (route.boundedJump) {
      if (!sprint || !Array.isArray(route.jumpFrames) || route.jumpFrames.length > Math.min(maxTicks, 40)) throw new Error('Bounded jump needs its explicit proven sprint tape')
      const frameSafe = (from, to) => {
        const count = Math.max(1, Math.ceil(distance(from, to) / 0.1))
        for (let index = 0; index <= count; index++) {
          const ratio = index / count
          const position = { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio, z: from.z + (to.z - from.z) * ratio }
          if (!bodyFree(position, CONTACT_EPSILON)) return false
          for (let x = Math.floor(position.x - HALF_WIDTH + EPSILON); x <= Math.floor(position.x + HALF_WIDTH - EPSILON); x++) for (let z = Math.floor(position.z - HALF_WIDTH + EPSILON); z <= Math.floor(position.z + HALF_WIDTH - EPSILON); z++) for (let y = Math.floor(position.y + EPSILON); y <= Math.floor(position.y + HEIGHT - EPSILON); y++) if (isWater(geometryBlockAt({ x, y, z }))) return false
        }
        return true
      }
      return createBoundedJumpStepper({ route, initial: initialState, physics, landingSafe: state => verifyOrigin(state), frameSafe })
    }
    let sprintEnabled = sprint
    let predicted = structuredClone(initialState)
    let index = 0
    let steps = 0
    let phase = 'moving'
    let reason = null
    let jumpedIndex = -1
    let lastImprovement = 0
    let bestDistance = Infinity
    let lastAuthoritative = null
    let settledFrames = 0
    let settled = false
    let waterFloatCompletion = false
    const waypoints = structuredClone(route.waypoints)
    let originStepper = null
    if (route.originRecenter) {
      const connector = route.originRecenter
      if (connector.partialRecenter !== true || !finite(connector.origin) || !['x', 'y', 'z'].every(axis => connector.origin[axis] === initialState.position[axis]) || waypoints[0]?.medium !== 'land' || waypoints[0].action !== 'walk') throw new Error('The partial origin connector changed; replan from the current pose')
      const fresh = plan(initialState, waypoints[0].position, { partialRecenter: true, maxDistance: 2, maxExpanded: 64, avoidance: route.avoidance })
      if (!fresh.ready) throw new Error(fresh.reason ?? 'The partial origin connector is no longer safe')
      originStepper = createStepper(fresh, initialState, { maxTicks: Math.min(40, maxTicks), sprint: false })
    }

    function snapshot (controls = {}) {
      return { phase, predictedState: structuredClone(predicted), controls: { ...controls }, packetPosition: physics.toServerPosition(predicted), waypointIndex: index, waypoint: waypoints[index] ?? null, steps, reason, settled, sprintEnabled, lastAuthoritative: lastAuthoritative ? structuredClone(lastAuthoritative) : null, serverConfirmed: false, requiresServerConfirmation: true }
    }

    function canSprint (waypoint) {
      if (!sprintEnabled || !predicted.onGround || predicted.isInWater || predicted.isInLava || waypoint.medium !== 'land' || waypoint.action !== 'walk' || Math.abs(waypoint.position.y - predicted.position.y) > CONTACT_EPSILON) return false
      const goal = waypoints.at(-1)?.position ?? route.target
      if (!goal || horizontalDistance(predicted.position, goal) <= 2.5) return false
      const direction = { x: waypoint.position.x - predicted.position.x, z: waypoint.position.z - predicted.position.z }
      const length = Math.hypot(direction.x, direction.z)
      if (length < 1e-6) return false
      const aligned = (a, b) => (a.x * b.x + a.z * b.z) / (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z)) >= Math.cos(25 * Math.PI / 180)
      const facing = { x: -Math.sin(predicted.yaw * Math.PI / 180), z: Math.cos(predicted.yaw * Math.PI / 180) }
      if (!aligned(direction, facing)) return false
      if (Math.hypot(predicted.velocity.x, predicted.velocity.z) > 0.025 && !aligned(direction, predicted.velocity)) return false
      let prior = waypoint.position
      let travelled = length
      for (let next = index + 1; next < waypoints.length && travelled < 3; next++) {
        const candidate = waypoints[next]
        const segment = { x: candidate.position.x - prior.x, z: candidate.position.z - prior.z }
        if (candidate.medium !== 'land' || candidate.action !== 'walk' || Math.abs(candidate.position.y - prior.y) > CONTACT_EPSILON || !aligned(direction, segment)) return false
        travelled += Math.hypot(segment.x, segment.z)
        prior = candidate.position
      }
      return fullFootprintSupport(predicted.position)
    }

    function stop (message = 'Navigation stopped') { originStepper?.stop(message); originStepper = null; phase = 'stopped'; reason = message; return snapshot() }

    function next () {
      if (phase !== 'moving') return snapshot()
      try {
        if (++steps > maxTicks) throw new Error('Navigation tick limit reached')
        if (originStepper) {
          const from = copy(predicted.position), frame = originStepper.next()
          predicted = structuredClone(frame.predictedState)
          const next = predicted.position
          if (!finite(next) || predicted.isInWater || predicted.isInLava || predicted.onGround !== true || Math.abs(next.y - route.origin.y) > CONTACT_EPSILON || horizontalDistance(route.origin, next) > 1.5 || !bodyFree(next, CONTACT_EPSILON) || !knownUnitSupportOrAir(next) || !physics.hasSupport(next)) throw new Error('The partial origin connector lost known dry support')
          for (const circle of route.avoidance ?? []) {
            const a = { ...from, y: from.y + EYE_HEIGHT }, b = { ...next, y: next.y + EYE_HEIGHT }
            const padded = circle.minDistance + (circle.padding ?? 0)
            const required = distance(circle.position, a) < padded - CONTACT_EPSILON ? circle.minDistance : padded
            if (segmentDistance(circle.position, a, b) < required - CONTACT_EPSILON) throw new Error('The partial origin connector violated actor avoidance')
          }
          if (frame.phase === 'awaiting_server_confirmation') {
            if (!fullFootprintSupport(next)) throw new Error('The partial origin connector has no full landing')
            originStepper = null
          } else if (frame.phase !== 'moving') throw new Error(frame.reason ?? 'The partial origin connector stopped')
          // Every prefix frame consumes this route's original tick budget.
          // Reaching its local stance is not arrival at the ordinary goal.
          settled = false
          return snapshot(frame.controls)
        }
        while (index < waypoints.length) {
          const waypoint = waypoints[index]
          const horizontal = horizontalDistance(predicted.position, waypoint.position)
          const height = Math.abs(predicted.position.y - waypoint.position.y)
          if (horizontal > 0.2 || height > (waypoint.medium === 'water' ? 0.8 : 0.14) || (waypoint.medium !== 'water' && !predicted.onGround) || (route.partialRecenter && !fullFootprintSupport(predicted.position))) break
          index++
          bestDistance = Infinity
          lastImprovement = steps
        }
        if (index === waypoints.length) {
          const final = waypoints.at(-1) ?? { position: route.target ?? route.origin, medium: 'land' }
          const controls = final.medium === 'water' ? { jump: predicted.position.y < final.position.y + 0.15 } : {}
          const beforeFloat = copy(predicted.position)
          predicted = physics.step(predicted, controls)
          const atTarget = horizontalDistance(predicted.position, final.position) <= 0.35 && Math.abs(predicted.position.y - final.position.y) <= (final.medium === 'water' ? 0.8 : 0.14)
          settledFrames = settledPose(predicted, final.medium) ? settledFrames + 1 : 0
          settled = settledFrames >= 2
          // A buoyancy turning point can be slow before the existing height
          // arrival band is reached. Continue the same native float input,
          // never synthesize a surface Y, flags, or an early arrival.
          const needsWaterHeight = final.medium === 'water' && controls.jump === true && horizontalDistance(predicted.position, final.position) <= 0.35 && predicted.position.y < final.position.y - 0.8
          if (settled && !atTarget && needsWaterHeight) waterFloatCompletion = true
          if (waterFloatCompletion) {
            if (predicted.isInWater !== true || waterAt(predicted.position)?.surfaceY !== final.position.y || !knownSurfaceBody(physics, predicted.position, final.position.y)) throw new Error('Water float completion lost known surface, body or clear headroom')
            const from = { ...beforeFloat, y: beforeFloat.y + EYE_HEIGHT }, to = { ...predicted.position, y: predicted.position.y + EYE_HEIGHT }
            for (const circle of route.avoidance ?? []) {
              const padded = circle.minDistance + (circle.padding ?? 0), fromDistance = Math.hypot(circle.position.x - from.x, circle.position.y - from.y, circle.position.z - from.z)
              const required = fromDistance < padded - CONTACT_EPSILON ? Math.max(circle.minDistance, fromDistance) : padded
              if (segmentDistance(circle.position, from, to) < required - CONTACT_EPSILON) throw new Error('Water float completion violated actor avoidance')
            }
          }
          if (waterFloatCompletion && !needsWaterHeight && !atTarget) waterFloatCompletion = false
          if (settled && atTarget) {
            phase = 'awaiting_server_confirmation'
            reason = 'Predicted route finished on supported, settled terrain; server verification remains pending'
          } else if (settled && !atTarget && !waterFloatCompletion) {
            phase = 'replan_required'
            reason = 'Landed away from the target; replan from this supported predicted position'
          }
          return snapshot(controls)
        }
        const waypoint = waypoints[index]
        if (!classify(waypoint.position)) throw new Error('The next waypoint is no longer safe')
        const waypointDistance = horizontalDistance(predicted.position, waypoint.position)
        if (waypointDistance < bestDistance - 0.03) { bestDistance = waypointDistance; lastImprovement = steps }
        if (steps - lastImprovement > 50) throw new Error('Navigation made no progress')
        const oriented = { ...predicted, yaw: Math.atan2(waypoint.position.x - predicted.position.x, waypoint.position.z - predicted.position.z) * -180 / Math.PI, pitch: 0 }
        const jump = waypoint.action === 'jump' && jumpedIndex !== index && predicted.onGround && waypointDistance < 1.5
        const immersedOnSupport = waypoint.action === 'swim' && predicted.onGround && isWater(geometryBlockAt({ ...predicted.position, y: predicted.position.y + 0.401 }))
        const waterRise = waypoint.action === 'swim' && predicted.position.y < waypoint.position.y + 0.15 && (!predicted.onGround || immersedOnSupport)
        let sprintCandidate = false
        try { sprintCandidate = canSprint(waypoint) } catch { /* An unproven footprint keeps normal speed. */ }
        const nearDryPulse = !allowWater && !route.partialRecenter && !route.partialDrop && !route.controlledDrop && waypoint.medium === 'land' && waypoint.action === 'walk' && predicted.onGround === true && !predicted.isInWater && !predicted.isInLava && Math.abs(predicted.position.y - waypoint.position.y) <= CONTACT_EPSILON && waypointDistance <= 0.6 && fullFootprintSupport(predicted.position)
        const releaseForecast = route.partialRecenter || nearDryPulse
        const candidates = [...(sprintCandidate ? [{ forward: true, sprint: true }] : []), { forward: true }, {}, { back: true }]
        let selected
        for (const candidate of candidates) {
          const controls = { ...candidate, jump: jump || waterRise }
          let future = oriented
          let first
          try {
            for (let ahead = 0; ahead < (releaseForecast ? 9 : 3); ahead++) {
              // At a ledge, choose a one-tick input by where it will settle
              // after release. Holding that input throughout a lookahead can
              // overshoot the tiny supported landing and discourage movement.
              const projectedControls = releaseForecast && ahead > 0 ? {} : { ...controls, jump: waterRise || (jump && ahead === 0) }
              const previousFuture = future
              future = physics.step(future, projectedControls)
              if (nearDryPulse) {
                if (future.onGround !== true || future.isInWater || future.isInLava || Math.abs(future.position.y - predicted.position.y) > CONTACT_EPSILON || !bodyFree(future.position, CONTACT_EPSILON) || !fullFootprintSupport(future.position)) throw new Error('Near-waypoint pulse lost known dry support')
                const from = { ...previousFuture.position, y: previousFuture.position.y + EYE_HEIGHT }, to = { ...future.position, y: future.position.y + EYE_HEIGHT }
                for (const circle of route.avoidance ?? []) {
                  const padded = circle.minDistance + (circle.padding ?? 0), fromDistance = Math.hypot(circle.position.x - from.x, circle.position.y - from.y, circle.position.z - from.z)
                  const leaving = fromDistance < padded - CONTACT_EPSILON
                  const required = leaving ? steps === 1 && ahead === 0 ? circle.minDistance : Math.max(circle.minDistance, fromDistance) : padded
                  if (segmentDistance(circle.position, from, to) < required - CONTACT_EPSILON) throw new Error('Near-waypoint pulse violated actor avoidance')
                }
              }
              if (controls.sprint && (!future.onGround || future.isInWater || future.isInLava || future.isCollidedHorizontally || !fullFootprintSupport(future.position))) throw new Error('Sprint prediction left known level ground')
              // The shared liquid model starts water contact about 0.4 blocks
              // below the cell top. An air seed above it needs a bounded known
              // descent before buoyancy can arrest the initial downward speed.
              const minimumHeight = waypoint.action === 'swim'
                ? (waypoint.waterSurfaceY ?? waypoint.position.y) - 2
                : Math.min(predicted.position.y, waypoint.position.y) - 0.05
              if (future.position.y < minimumHeight) throw new Error('Prediction would fall below the planned support')
              if (ahead === 0) first = future
            }
          } catch { continue }
          const finalLeg = index === waypoints.length - 1
          const remaining = horizontalDistance(future.position, waypoint.position)
          const score = remaining ** 2 + Math.min(2, Math.abs(future.position.y - waypoint.position.y)) * 0.1 + (finalLeg ? Math.hypot(future.velocity.x, future.velocity.z) * 0.15 : 0) + (route.partialRecenter && !fullFootprintSupport(future.position) ? 0.2 + 2 * remaining : 0)
          if (!selected || score < selected.score) selected = { controls, next: first, score }
        }
        if (!selected) throw new Error('No safe one-tick prediction is available')
        predicted = selected.next
        if (jump) jumpedIndex = index
        return snapshot(selected.controls)
      } catch (error) { phase = 'failed'; reason = error.message; return snapshot() }
    }

    function reconcile (authoritativeState) {
      if (!finite(authoritativeState?.position)) throw new Error('Authoritative physics state is required')
      originStepper?.stop('Authoritative correction requires replan'); originStepper = null
      lastAuthoritative = structuredClone(authoritativeState)
      predicted = structuredClone(authoritativeState)
      phase = 'replan_required'
      reason = 'Server state received; replan from the authoritative position'
      return snapshot()
    }

    function resumeReplay (correctedState) {
      const reject = reason => ({ accepted: false, reason })
      const waypoint = waypoints[index]
      if (phase !== 'moving' || route.directSurface !== true || waypoints.length !== 1 || index !== 0 || waypoint?.action !== 'swim' || waypoint.medium !== 'water' || !Number.isFinite(waypoint.waterSurfaceY)) return reject('Only an unfinished direct surface swim can resume')
      if (!finite(correctedState?.position) || !finite(correctedState.velocity) || correctedState.isInLava || correctedState.riding || correctedState.flying || correctedState.elytraFlying || correctedState.swimmingPose) return reject('The replay is not a supported water pose')
      if (horizontalDistance(predicted.position, correctedState.position) > 0.5 || Math.abs(predicted.position.y - correctedState.position.y) > 0.5) return reject('The replay moved outside the correction allowance')
      const surfaceY = waypoint.waterSurfaceY
      const horizontal = point => ({ x: point.x, y: 0, z: point.z })
      if (segmentDistance(horizontal(correctedState.position), horizontal(route.origin), horizontal(waypoint.position)) > 0.5) return reject('The replay left the original swimming corridor')
      try {
        const from = correctedState.position; const to = waypoint.position
        const eye = point => ({ ...point, y: point.y + EYE_HEIGHT })
        if ((route.avoidance ?? []).some(circle => segmentDistance(circle.position, eye(from), eye(to)) < circle.minDistance + (circle.padding ?? 0) - CONTACT_EPSILON)) return reject('The corrected remaining route violates avoidance')
        const count = Math.max(1, Math.ceil(distance(from, to) / 0.1))
        for (let n = 0; n <= count; n++) {
          const ratio = n / count
          const point = { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio, z: from.z + (to.z - from.z) * ratio }
          if (waterAt(point)?.surfaceY !== surfaceY) return reject('The corrected route no longer shares its known water surface')
          for (let x = Math.floor(point.x - HALF_WIDTH + EPSILON); x <= Math.floor(point.x + HALF_WIDTH - EPSILON); x++) for (let z = Math.floor(point.z - HALF_WIDTH + EPSILON); z <= Math.floor(point.z + HALF_WIDTH - EPSILON); z++) {
            const water = geometryBlockAt({ x, y: surfaceY - 1, z })
            const above = geometryBlockAt({ x, y: surfaceY, z })
            if (!isWater(water) || !Number.isInteger(water.metadata) || water.metadata < 0 || water.metadata >= 8 || !['air', 'cave_air', 'void_air'].includes(above.name)) return reject('The corrected corridor has unknown or changed water geometry')
          }
        }
      } catch { return reject('The corrected swimming corridor is unknown or unsupported') }
      // Rebase the present prediction only. Keep waypoint, tick budget, jump
      // lifecycle and no-progress counters; corrections cannot renew a route.
      predicted = structuredClone(correctedState)
      return { accepted: true, frame: snapshot() }
    }

    function setSprint (enabled) { if (typeof enabled !== 'boolean') throw new Error('sprint must be an explicit boolean'); sprintEnabled = enabled }

    return { next, snapshot, stop, reconcile, resumeReplay, setSprint }
  }

  function createSettler (initialState, { maxTicks = 80, maxDrop = 3, maxHorizontal = 1 } = {}) {
    if (!finite(initialState?.position) || !Number.isInteger(maxTicks) || maxTicks < 2 || maxTicks > 200 || !Number.isFinite(maxDrop) || maxDrop < 0 || maxDrop > 3 || !Number.isFinite(maxHorizontal) || maxHorizontal <= 0 || maxHorizontal > 2) throw new Error('Invalid bounded settling request')
    const origin = copy(initialState.position)
    function advanceState (state) {
      const next = physics.step(state, {})
      if (next.isInWater || next.isInLava) throw new Error('Land settling cannot enter water or lava')
      if (origin.y - next.position.y > maxDrop + 1e-5 || next.position.y - origin.y > 1.5) throw new Error('Settling exceeds the bounded vertical displacement')
      if (horizontalDistance(origin, next.position) > maxHorizontal) throw new Error('Settling exceeds the bounded horizontal displacement')
      return next
    }
    // Inspect the complete neutral trajectory before sending any input. Unknown
    // terrain or an unsafe fall must not become a live downward probe.
    let probe = structuredClone(initialState)
    let stable = 0
    let landing = null
    for (let index = 0; index < maxTicks; index++) {
      probe = advanceState(probe)
      stable = settledPose(probe) ? stable + 1 : 0
      if (stable >= 2) { landing = copy(probe.position); break }
    }
    if (!landing) throw new Error('No fully known supported landing within the settling bounds')
    let predicted = structuredClone(initialState)
    let phase = 'settling'
    let reason = null
    let steps = 0
    let settledFrames = 0
    let settled = false
    function snapshot () { return { phase, predictedState: structuredClone(predicted), controls: {}, packetPosition: physics.toServerPosition(predicted), waypointIndex: 0, waypoint: { position: copy(landing), action: 'settle', medium: 'land' }, steps, reason, settled, target: copy(landing), serverConfirmed: false, requiresServerConfirmation: true } }
    function next () {
      if (phase !== 'settling') return snapshot()
      try {
        if (++steps > maxTicks) throw new Error('Settling tick limit reached')
        predicted = advanceState(predicted)
        settledFrames = settledPose(predicted) ? settledFrames + 1 : 0
        settled = settledFrames >= 2
        if (settled) { phase = 'awaiting_server_confirmation'; reason = 'Neutral prediction reached known supported ground; server verification remains pending' }
      } catch (error) { phase = 'failed'; reason = error.message }
      return snapshot()
    }
    function stop (message = 'Settling stopped') { phase = 'stopped'; reason = message; return snapshot() }
    function reconcile (state) { predicted = structuredClone(state); phase = 'replan_required'; reason = 'Authoritative server position received'; return snapshot() }
    return { next, snapshot, stop, reconcile }
  }

  return { plan, createStepper, createSettler, verifyOrigin, physics, capabilities: Object.freeze({ version, predictionOnly: true, serverAcceptanceVerified: false, maxSearchDistance: planningDistanceLimit, oneBlockJumpPlanning: true, water: allowWater ? 'experimental-surface-only' : 'disabled', fastSwimmingPose: false }) }
}

module.exports = { createNavigator }
