'use strict'

const { Physics: PhysicsEngine, PlayerState } = require('prismarine-physics')
const { Vec3 } = require('vec3')

// Prediction only. The dependency is pinned to the MIT-licensed experimental
// Bedrock branch e6181bf79c19db3eafc8a589e984f7ba623556f6 (PR #152).
// The 1.26.60 ground-speed profile is calibrated against same-tick grounded
// walk/sprint evidence from local strict BDS 1.26.60.6. Collision/gravity still
// use the experimental shared model; this is not complete Bedrock parity or
// a claim that a Realm has accepted a predicted position.
const GROUND_CALIBRATION = Object.freeze({ tag: 'bedrock-1.26.60-bds-strict-ground-v1', playerSpeed: 0.1, sprintSpeed: 0.3 })
const EYE_HEIGHT = 1.62
const CONTACT_TOLERANCE = 1e-4
const HALF_WIDTH = 0.3
const HEIGHT = 1.8
const CONTROL_NAMES = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const FLAG_NAMES = ['onGround', 'isInWater', 'isInLava', 'isInWeb', 'isCollidedHorizontally', 'isCollidedVertically']
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const isWater = name => ['water', 'flowing_water'].includes(name)
const isLava = name => ['lava', 'flowing_lava'].includes(name)

function vector (value, label) {
  if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))) throw new Error(`${label} must have finite x/y/z`)
  return new Vec3(value.x, value.y, value.z)
}

function plainVector (value) { return { x: value.x, y: value.y, z: value.z } }

function stateKey (name, properties) {
  return `${name}:${JSON.stringify(Object.keys(properties).sort().map(key => [key, properties[key]]))}`
}

function canonicalProperties (states) {
  return Object.fromEntries(Object.entries(states ?? {}).map(([key, value]) => [key, value?.value ?? value]))
}

function controlsForStep (controls = {}) {
  for (const [key, value] of Object.entries(controls)) {
    if (!CONTROL_NAMES.includes(key) || typeof value !== 'boolean') throw new Error(`Unsupported control: ${key}`)
  }
  return Object.fromEntries(CONTROL_NAMES.map(key => [key, controls[key] ?? false]))
}

function createPhysics ({ world, version = '1.26.60', registry, allowWater = false } = {}, prepared = null) {
  if (version !== '1.26.60') throw new Error('Experimental physics is restricted to Bedrock 1.26.60')
  if (typeof world?.getBlock !== 'function') throw new Error('Physics requires a known-block world reader')
  registry ??= require('prismarine-registry')(`bedrock_${version}`)
  if (registry.type !== 'bedrock' || registry.version.minecraftVersion !== version) throw new Error('Physics registry version mismatch')
  const definitions = prepared?.definitions ?? new Map()
  for (let stateId = 0; !prepared && stateId < registry.blockStates.length; stateId++) {
    const state = registry.blockStates[stateId]
    if (!state) continue
    definitions.set(stateKey(nameOf(state), canonicalProperties(state.states)), stateId)
  }
  const templates = prepared?.templates ?? new Map()

  function templateFor (raw, waterEnabled) {
    if (!raw?.known) throw new Error(`Unknown terrain: ${raw?.reason ?? 'block not received'}`)
    const name = nameOf(raw)
    if (isLava(name)) throw new Error('Lava traversal is unsupported')
    if (isWater(name) && !waterEnabled) throw new Error('Water prediction is experimental and disabled')
    const properties = raw.properties ?? {}
    const key = stateKey(name, properties)
    if (templates.has(key)) return templates.get(key)
    const definition = registry.blocksByName[name]
    const stateId = definitions.get(key)
    if (!definition || stateId == null) throw new Error(`Unknown or incomplete block state: ${name}`)
    const shapeMapping = registry.blockCollisionShapes?.blocks?.[name]
    const offset = stateId - definition.minStateId
    const shapeId = Array.isArray(shapeMapping) ? shapeMapping[offset] : shapeMapping
    const shapes = registry.blockCollisionShapes?.shapes?.[shapeId]
    if (shapeId == null || !Array.isArray(shapes)) throw new Error(`Unknown collision shape: ${name}`)
    for (const box of shapes) {
      if (!Array.isArray(box) || box.length !== 6 || !box.every(Number.isFinite) || box[0] > box[3] || box[1] > box[4] || box[2] > box[5]) {
        throw new Error(`Invalid collision shape: ${name}`)
      }
    }
    const template = {
      type: definition.id,
      name,
      stateId,
      metadata: isWater(name) ? properties.liquid_depth : offset,
      shapes: shapes.map(box => [...box]),
      properties: { ...properties }
    }
    if (!Number.isInteger(template.metadata)) throw new Error(`Missing block metadata: ${name}`)
    templates.set(key, template)
    return template
  }

  function readBlock (position, waterEnabled) {
    const point = vector(position, 'Block position').floored()
    const raw = world.getBlock(point.x, point.y, point.z)
    let template = templateFor(raw, waterEnabled)
    if ((raw.extra ?? []).some(layer => layer?.known === false)) throw new Error('Unknown terrain: secondary collision layer not received')
    const extras = (raw.extra ?? []).filter(layer => !['air', 'cave_air', 'void_air'].includes(nameOf(layer)))
    if (extras.length) {
      if (extras.length !== 1 || !isWater(nameOf(extras[0])) || template.shapes.length) throw new Error('Waterlogged/secondary collision layers are unsupported')
      // Non-solid sea plants can share a cell with water. Preserve fluid physics
      // when the primary layer contributes no collision surface.
      template = templateFor({ ...extras[0], known: true }, waterEnabled)
    }
    const properties = { ...template.properties }
    return {
      type: template.type,
      name: template.name,
      stateId: template.stateId,
      metadata: template.metadata,
      shapes: template.shapes.map(box => [...box]),
      position: point,
      _properties: properties,
      getProperties: () => ({ ...properties })
    }
  }

  const blockAt = position => readBlock(position, allowWater)
  // The engine's collision broadphase also reads below a solid floor. Reading
  // the empty shape of known water there does not mean the player entered it.
  // Public terrain/navigation queries retain their explicit water opt-in.
  const engineWorld = { getBlock: position => readBlock(position, true) }
  const engine = PhysicsEngine(registry, engineWorld)
  // The pinned dependency applies an older Bedrock fit at factory creation.
  // These public constants feed its ground attribute calculation each tick;
  // sprintSpeed is an operation-2 additive multiplier (+30%), not velocity.
  engine.playerSpeed = GROUND_CALIBRATION.playerSpeed
  engine.sprintSpeed = GROUND_CALIBRATION.sprintSpeed
  const capabilities = Object.freeze({
    version,
    model: 'experimental-fitted-bedrock-prismarine-physics',
    calibration: GROUND_CALIBRATION.tag,
    predictionOnly: true,
    serverAcceptanceVerified: false,
    walking: true,
    gravity: true,
    jumping: true,
    collisionShapes: true,
    stepUp: true,
    water: allowWater ? 'experimental-basic-buoyancy-unverified' : 'disabled',
    fastSwimmingPose: false,
    waterloggedSolids: false,
    gearEnchantments: false,
    riding: false,
    elytra: false
  })

  function grounded (feet) {
    // Determine the initial contact geometrically. Never infer it from a blank
    // collision shape or an unreceived neighbouring cell.
    let contact = false
    for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) {
      for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
        const block = blockAt({ x, y: Math.floor(feet.y - 1e-4), z })
        if (block.shapes.some(box => Math.abs(block.position.y + box[4] - feet.y) < 1e-4 && feet.x + 0.3 > x + box[0] && feet.x - 0.3 < x + box[3] && feet.z + 0.3 > z + box[2] && feet.z - 0.3 < z + box[5])) contact = true
      }
    }
    return contact
  }

  function supportedContactAdjustment (feet) {
    // Network float32 eye coordinates can put the derived feet a few microns
    // below a real floor. Prismarine's swept AABB does not resolve an initial
    // overlap, so seed its private collision position at the proven surface.
    // This is not a grid snap: every part of the 0.6-wide footprint must have
    // an actual collision shape with the same top, within the contact tolerance.
    const minX = feet.x - HALF_WIDTH
    const maxX = feet.x + HALF_WIDTH
    const minZ = feet.z - HALF_WIDTH
    const maxZ = feet.z + HALF_WIDTH
    const y = Math.floor(feet.y - CONTACT_TOLERANCE)
    let surface = null
    for (let x = Math.floor(minX + 1e-9); x <= Math.floor(maxX - 1e-9); x++) {
      for (let z = Math.floor(minZ + 1e-9); z <= Math.floor(maxZ - 1e-9); z++) {
        const support = blockAt({ x, y, z })
        const x0 = Math.max(minX, x); const x1 = Math.min(maxX, x + 1)
        const z0 = Math.max(minZ, z); const z1 = Math.min(maxZ, z + 1)
        const shape = support.shapes.find(box => {
          const top = y + box[4]
          return top > feet.y && top - feet.y <= CONTACT_TOLERANCE &&
            x + box[0] <= x0 + 1e-9 && x + box[3] >= x1 - 1e-9 &&
            z + box[2] <= z0 + 1e-9 && z + box[5] >= z1 - 1e-9
        })
        if (!shape) return null
        const top = y + shape[4]
        if (surface !== null && Math.abs(surface - top) > 1e-9) return null
        surface = top
      }
    }
    return surface === null ? null : { fromY: feet.y, toY: surface, deltaY: surface - feet.y, source: 'known_full_footprint_shape_contact', tolerance: CONTACT_TOLERANCE }
  }

  function bodyGeometry (feet, padding = 0, dry = false) {
    const shapes = []
    for (let x = Math.floor(feet.x - HALF_WIDTH - padding + 1e-9); x <= Math.floor(feet.x + HALF_WIDTH + padding - 1e-9); x++) {
      for (let z = Math.floor(feet.z - HALF_WIDTH - padding + 1e-9); z <= Math.floor(feet.z + HALF_WIDTH + padding - 1e-9); z++) {
        for (let y = Math.floor(feet.y + 1e-9); y <= Math.floor(feet.y + HEIGHT - 1e-9); y++) {
          const block = blockAt({ x, y, z })
          if (dry && isWater(block.name)) throw new Error('Horizontal contact repair requires dry geometry')
          for (const [shapeIndex, box] of block.shapes.entries()) shapes.push({ key: `${x},${y},${z}:${block.stateId}:${shapeIndex}`, position: { x, y, z }, shapeIndex, box: [x + box[0], y + box[1], z + box[2], x + box[3], y + box[4], z + box[5]] })
        }
      }
    }
    return shapes
  }
  function intersectsBody (feet, { box }) {
    return feet.x + HALF_WIDTH > box[0] + 1e-9 && feet.x - HALF_WIDTH < box[3] - 1e-9 && feet.y + HEIGHT > box[1] + 1e-9 && feet.y < box[4] - 1e-9 && feet.z + HALF_WIDTH > box[2] + 1e-9 && feet.z - HALF_WIDTH < box[5] - 1e-9
  }
  function horizontalFaces (feet, shape, tolerance, overlapOnly = false) {
    const { box } = shape
    if (Math.min(feet.y + HEIGHT, box[4]) - Math.max(feet.y, box[1]) <= CONTACT_TOLERANCE) return []
    const faces = []
    for (const [axis, low, high, tangent, tangentLow, tangentHigh] of [['x', 0, 3, 'z', 2, 5], ['z', 2, 5, 'x', 0, 3]]) {
      if (feet[tangent] + HALF_WIDTH <= box[tangentLow] + 1e-9 || feet[tangent] - HALF_WIDTH >= box[tangentHigh] - 1e-9) continue
      for (const sign of [-1, 1]) {
        const face = box[sign > 0 ? high : low]
        const target = face + sign * HALF_WIDTH
        const penetration = sign * (target - feet[axis])
        if (Math.abs(penetration) > tolerance + 1e-12 || overlapOnly && penetration <= 1e-9) continue
        faces.push({ ...shape, axis, sign, face, target, penetration })
      }
    }
    return faces
  }
  function horizontalContactAdjustment (feet) {
    const collisions = bodyGeometry(feet).filter(shape => intersectsBody(feet, shape))
    if (!collisions.length) return null
    const projected = plainVector(feet)
    const targets = new Map()
    for (const shape of collisions) {
      const face = horizontalFaces(feet, shape, CONTACT_TOLERANCE, true).sort((a, b) => a.penetration - b.penetration)[0]
      if (!face || targets.has(face.axis) && Math.abs(targets.get(face.axis) - face.target) > 1e-9) return null
      targets.set(face.axis, face.target)
      projected[face.axis] = face.target
    }
    const delta = { x: projected.x - feet.x, z: projected.z - feet.z }
    if (Math.hypot(delta.x, delta.z) > CONTACT_TOLERANCE || bodyGeometry(projected).some(shape => intersectsBody(projected, shape))) return null
    return { from: { x: feet.x, z: feet.z }, to: { x: projected.x, z: projected.z }, delta, source: 'known_horizontal_shape_contact', tolerance: CONTACT_TOLERANCE }
  }

  function repairHorizontalContact (modelState, rawState, options = {}) {
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) return null
      const { maxNormalAdjustment = 0.05, maxDistance = 0.75 } = options
      if (!Number.isFinite(maxNormalAdjustment) || maxNormalAdjustment <= 0 || maxNormalAdjustment > 0.05 || !Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 0.75) return null
      const model = vector(modelState.position, 'Model feet position')
      const raw = vector(rawState.position, 'Raw feet position')
      vector(modelState.velocity, 'Model velocity')
      if (Math.hypot(model.x - raw.x, model.y - raw.y, model.z - raw.z) > maxDistance) return null
      const rawShapes = bodyGeometry(raw, CONTACT_TOLERANCE, true)
      const rawCollisions = rawShapes.filter(shape => intersectsBody(raw, shape))
      if (rawCollisions.some(shape => !horizontalFaces(raw, shape, CONTACT_TOLERANCE, true).length)) return null
      const modelCollisions = bodyGeometry(model, 0, true).filter(shape => intersectsBody(model, shape))
      if (!modelCollisions.length) return null
      const faces = rawShapes.flatMap(shape => horizontalFaces(raw, shape, CONTACT_TOLERANCE)).sort((a, b) => Math.abs(a.penetration) - Math.abs(b.penetration))
      for (const contact of faces) {
        if (!modelCollisions.some(shape => shape.key === contact.key)) continue
        const penetration = contact.sign * (contact.target - model[contact.axis])
        if (penetration <= 1e-9 || penetration > maxNormalAdjustment) continue
        const position = plainVector(model)
        position[contact.axis] = contact.target
        if (bodyGeometry(position, 0, true).some(shape => intersectsBody(position, shape))) continue
        const physicsState = structuredClone(modelState)
        physicsState.position = position
        if (physicsState.velocity[contact.axis] * contact.sign < 0) physicsState.velocity[contact.axis] = 0
        const delta = { x: position.x - model.x, y: 0, z: position.z - model.z }
        return { physicsState, adjustment: { axis: contact.axis, sign: contact.sign, from: plainVector(model), to: { ...position }, delta, source: 'matching_known_raw_wall_contact', rawContact: plainVector(raw), wall: { position: { ...contact.position }, shapeIndex: contact.shapeIndex, face: contact.face }, maxNormalAdjustment, maxDistance } }
      }
      return null
    } catch { return null }
  }

  function waterSurface (position) {
    if (!allowWater) return null
    const feet = vector(position, 'Feet position')
    const head = blockAt({ x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z })
    if (!['air', 'cave_air', 'void_air'].includes(head.name)) return null
    // A player can be a fraction above the water while bobbing or falling.
    // This is route classification only: never lower the real/predicted feet or
    // force isInWater. The dependency recomputes fluid contact each tick.
    for (let y = Math.floor(feet.y + EYE_HEIGHT); y >= Math.floor(feet.y - 0.5); y--) {
      const block = blockAt({ x: feet.x, y, z: feet.z })
      if (!isWater(block.name)) continue
      if (block.metadata < 0 || block.metadata >= 8) return null
      const surfaceY = y + 1
      if (feet.y > surfaceY + 0.5 + 1e-4 || feet.y < surfaceY - EYE_HEIGHT) return null
      const above = blockAt({ x: feet.x, y: surfaceY, z: feet.z })
      if (!['air', 'cave_air', 'void_air'].includes(above.name)) return null
      return { surfaceY, waterY: y, position: plainVector(feet), aboveSurface: feet.y > surfaceY }
    }
    return null
  }

  function fromServer (snapshot, { velocity, onGround } = {}) {
    const position = vector(snapshot.position, 'Server eye position')
    position.y -= EYE_HEIGHT
    const prediction = snapshot.positionSource === 'client_prediction' ? snapshot.predicted ?? snapshot.workingPrediction : null
    const candidate = prediction?.physicsState ?? prediction
    const candidateFeet = candidate?.feetPosition ?? candidate?.position
    const matches = prediction?.position && ['x', 'y', 'z'].every(axis => Number.isFinite(prediction.position[axis]) && Math.abs(prediction.position[axis] - snapshot.position[axis]) < 1e-4)
    const seed = velocity === undefined && onGround === undefined && matches && candidate?.velocity && ['x', 'y', 'z'].every(axis => Number.isFinite(candidate.velocity[axis])) ? candidate : null
    if (seed && prediction.physicsState && (!candidateFeet || !['x', 'y', 'z'].every(axis => Number.isFinite(candidateFeet[axis]) && Math.abs(candidateFeet[axis] - position[axis]) < 1e-3))) throw new Error('Prediction metadata does not match its working position')
    const yaw = seed?.yaw ?? snapshot.rotation?.yaw ?? 0
    const pitch = seed?.pitch ?? snapshot.rotation?.pitch ?? 0
    if (![yaw, pitch].every(Number.isFinite)) throw new Error('Invalid server rotation')
    const contact = onGround ?? (typeof seed?.onGround === 'boolean' ? seed.onGround : grounded(position))
    // A standing simulation ends each tick with gravity already applied to its
    // next velocity. This is a model seed when no velocity was received.
    const initialVelocity = velocity ?? seed?.velocity ?? { x: 0, y: contact ? -engine.gravity * engine.airdrag : 0, z: 0 }
    const result = {
      position: plainVector(position),
      velocity: plainVector(vector(initialVelocity, 'Velocity')),
      velocitySource: velocity ? 'supplied' : seed ? 'client_prediction' : 'model-initialized',
      yaw,
      pitch,
      gameMode: snapshot.gameMode,
      onGround: contact,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      jumpTicks: 0,
      jumpQueued: false,
      controls: controlsForStep(seed?.controls),
      effects: structuredClone(seed?.effects ?? {}),
      attributes: structuredClone(seed?.attributes ?? {})
    }
    for (const flag of FLAG_NAMES) if (flag !== 'onGround' && typeof seed?.[flag] === 'boolean') result[flag] = seed[flag]
    result.jumpTicks = Number.isInteger(seed?.jumpTicks) ? seed.jumpTicks : 0
    result.jumpQueued = seed?.jumpQueued === true
    return result
  }

  function step (input, controls = {}) {
    if (input.gameMode !== 'survival' && input.gameMode !== 0) throw new Error('Only survival prediction is supported')
    if (input.riding || input.elytraFlying || input.flying || input.swimmingPose) throw new Error('Unsupported movement pose')
    const position = vector(input.position, 'Feet position')
    const velocity = vector(input.velocity, 'Velocity')
    if (![input.yaw, input.pitch].every(Number.isFinite)) throw new Error('Invalid player rotation')
    const control = controlsForStep(controls)
    // Keep received observations and the caller's physics state unchanged.
    // A rising trajectory is already leaving contact and needs no adjustment.
    const contactAdjustment = velocity.y <= 0 ? supportedContactAdjustment(position) : null
    if (contactAdjustment) position.y = contactAdjustment.toY
    const horizontalAdjustment = horizontalContactAdjustment(position)
    if (horizontalAdjustment) { position.x = horizontalAdjustment.to.x; position.z = horizontalAdjustment.to.z }
    const bot = {
      version: `bedrock_${version}`,
      registry,
      entity: {
        position,
        velocity,
        // Engine uses Mineflayer radians; public inputs use Bedrock degrees.
        yaw: Math.PI - input.yaw * Math.PI / 180,
        pitch: -input.pitch * Math.PI / 180,
        effects: structuredClone(input.effects ?? {}),
        attributes: structuredClone(input.attributes ?? {}),
        elytraFlying: false
      },
      jumpTicks: Number.isInteger(input.jumpTicks) ? input.jumpTicks : 0,
      jumpQueued: !!input.jumpQueued || (control.jump && !input.controls?.jump),
      fireworkRocketDuration: 0,
      inventory: { slots: new Array(46).fill(null) },
      game: { gameMode: 'survival' }
    }
    for (const name of FLAG_NAMES) bot.entity[name] = !!input[name]
    const simulated = engine.simulatePlayer(new PlayerState(bot, control), engineWorld)
    if (![simulated.pos.x, simulated.pos.y, simulated.pos.z, simulated.vel.x, simulated.vel.y, simulated.vel.z].every(Number.isFinite)) throw new Error('Physics produced a non-finite prediction')
    if (simulated.isInLava) throw new Error('Lava prediction is unsupported')
    if (simulated.isInWater && !allowWater) throw new Error('Water prediction is experimental and disabled')
    const output = {
      ...structuredClone(input),
      position: plainVector(simulated.pos),
      velocity: plainVector(simulated.vel),
      jumpTicks: simulated.jumpTicks,
      jumpQueued: simulated.jumpQueued,
      controls: control,
      contactAdjustment,
      horizontalContactAdjustment: horizontalAdjustment
    }
    for (const name of FLAG_NAMES) output[name] = !!simulated[name]
    return output
  }

  function toServerPosition (state) {
    const position = vector(state.position, 'Feet position')
    position.y += EYE_HEIGHT
    return plainVector(position)
  }

  return {
    step, fromServer, toServerPosition, blockAt, waterSurface, repairHorizontalContact, hasSupport: position => grounded(vector(position, 'Feet position')), capabilities,
    // A planning overlay needs its own block reader and engine, while registry
    // definitions and immutable collision templates remain the same model.
    withWorld: (nextWorld, options = {}) => createPhysics({ world: nextWorld, version, registry, allowWater: options.allowWater ?? allowWater }, { definitions, templates }),
    constants: Object.freeze({ gravity: engine.gravity, playerSpeed: engine.playerSpeed, sprintSpeed: engine.sprintSpeed, stepHeight: engine.stepHeight, waterGravity: engine.waterGravity, waterInertia: engine.waterInertia })
  }
}

module.exports = { createPhysics }
