'use strict'

const { createPhysics } = require('./physics')
const { buildStationaryInput } = require('./input')
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const WATER = new Set(['minecraft:water', 'minecraft:flowing_water'])
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))

// This temporary input is scoped to an acknowledged reconnect respawn. It
// never changes the authoritative pose; a server movement correction must do
// that. If terrain or actors are uncertain no input is sent.
function createRespawnSwim ({ world, client, getState, getLife, getActors, getShared, meta, now = Date.now, monotonic = () => performance.now(), interval = setInterval, clear = clearInterval }) {
  let timer = null
  function stop () { if (timer !== null) clear(timer); timer = null }
  function actorsClear (point) {
    const actors = getActors()
    return Array.isArray(actors) && actors.every(a => !a.hostile || !a.alive || a.positionKnown && finite(a.position) && Math.hypot(a.position.x - point.x, a.position.y - point.y, a.position.z - point.z) >= 16)
  }
  function cell (x, y, z) {
    const b = world.getBlock(x, y, z)
    if (!b?.known || b.extra?.some(layer => !AIR.has(layer.name))) throw new Error('unknown or mixed terrain')
    if (AIR.has(b.name)) return 'air'
    if (WATER.has(b.name) && b.properties?.liquid_depth === 0) return 'water'
    throw new Error('obstructed or unsupported terrain')
  }
  function clearBody (feet, dry = false) {
    for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) for (let y = Math.floor(feet.y + 1e-6); y <= Math.floor(feet.y + 1.8 - 1e-6); y++) if (cell(x, y, z) === 'water' && dry) throw new Error('water in dry trajectory')
  }
  function prepare () {
    const state = getState(), life = getLife(), shared = getShared(), point = life.readyPosition
    if (meta.version !== '1.26.60' || meta.startGame?.server_authoritative_block_breaking !== true || shared.safetyWanted !== true || !shared.loadingScreenEnded || !life.spawnPending || !life.pending || !life.actionSent || !finite(point) || !(state.health > 10) || state.gameMode !== 'survival' && state.gameMode !== 0 || !actorsClear(point)) return null
    const feet = { x: point.x, y: point.y - 1.62, z: point.z }
    try {
      const medium = cell(Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z))
      const physics = createPhysics({ world, version: meta.version, allowWater: true })
      if (medium === 'air') {
        if (Math.abs(feet.y - Math.round(feet.y)) > 0.001) return null
        const allowed = new Set(['stone', 'dirt', 'grass_block', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff'])
        for (let x = Math.floor(feet.x - 0.3 + 1e-6); x <= Math.floor(feet.x + 0.3 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-6); z <= Math.floor(feet.z + 0.3 - 1e-6); z++) {
          const support = physics.blockAt({ x, y: Math.floor(feet.y - 1e-4), z })
          if (!allowed.has(support.name) || support.shapes.length !== 1 || !support.shapes[0].every((v, i) => Math.abs(v - [0, 0, 0, 1, 1, 1][i]) < 1e-9)) return null
        }
        let predicted = physics.fromServer({ ...state, position: point, positionSource: 'server_post_move', predicted: null })
        let rose = false
        for (let i = 0; i < 40; i++) {
          clearBody(predicted.position, true)
          predicted = physics.step(predicted, { jump: true })
          clearBody(predicted.position, true)
          if (Math.hypot(predicted.position.x - feet.x, predicted.position.z - feet.z) > 0.1 || predicted.position.y < feet.y - 0.1 || predicted.position.y > feet.y + 1.4) return null
          if (predicted.position.y > feet.y + 0.2) { rose = true; break }
        }
        if (!rose) return null
        return { point: { ...point }, initialHealth: state.health, physics, dry: true, predicted: physics.fromServer({ ...state, position: point, positionSource: 'server_post_move', predicted: null }) }
      }
      if (medium !== 'water') return null
      const observedAt = Date.parse(state.breath?.currentUpdatedAt)
      if (!(state.breath?.current >= 80) || !Number.isFinite(observedAt) || now() - observedAt < 0 || now() - observedAt > 5000) return null
      let surface = null
      for (let y = Math.floor(feet.y); y <= Math.floor(feet.y) + 4; y++) if (cell(Math.floor(feet.x), y, Math.floor(feet.z)) === 'air') { surface = y; break }
      if (surface === null || point.y >= surface) return null
      let predicted = physics.fromServer({ ...state, position: point, positionSource: 'server_post_move', predicted: null })
      let reachesAir = false
      for (let i = 0; i < 40; i++) {
        clearBody(predicted.position)
        predicted = physics.step(predicted, { jump: true })
        if (Math.hypot(predicted.position.x - feet.x, predicted.position.z - feet.z) > 0.1 || predicted.position.y < feet.y - 0.1 || predicted.position.y > surface + 1) return null
        clearBody(predicted.position)
        if (predicted.position.y + 1.62 >= surface + 0.05) { reachesAir = true; break }
      }
      if (!reachesAir) return null
      return { point: { ...point }, initialHealth: state.health, physics, predicted: physics.fromServer({ ...state, position: point, positionSource: 'server_post_move', predicted: null }) }
    } catch { return null }
  }
  function start () {
    if (timer !== null) return false
    const plan = prepare()
    if (!plan) return false
    let count = 0
    timer = interval(() => {
      try {
        const life = getLife(), state = getState(), shared = getShared()
        if (!life.spawnPending || !life.pending || !life.actionSent || shared.safetyWanted !== true || !shared.loadingScreenEnded || !finite(life.readyPosition) || Math.hypot(life.readyPosition.x - plan.point.x, life.readyPosition.y - plan.point.y, life.readyPosition.z - plan.point.z) > 0.01 || !(state.health >= plan.initialHealth) || !plan.dry && !(state.breath?.current >= 40) || !actorsClear(plan.point) || count >= 40) return stop()
        clearBody(plan.predicted.position, plan.dry)
        plan.predicted = plan.physics.step(plan.predicted, { jump: true })
        clearBody(plan.predicted.position, plan.dry)
        const rotation = state.rotation
        if (!Number.isFinite(rotation?.yaw) || !Number.isFinite(rotation?.pitch)) return stop()
        const tick = BigInt(meta.startGame.current_tick) + BigInt(Math.floor(Math.max(0, monotonic() - meta.startGameReceivedAt) / 50) + ++count)
        const packet = buildStationaryInput({ position: plan.physics.toServerPosition(plan.predicted), yaw: rotation.yaw, pitch: rotation.pitch, tick })
        packet.delta = plan.predicted.velocity
        packet.input_data = ['jumping', 'want_up', ...(count === 1 ? ['start_jumping'] : [])]
        client.queue('player_auth_input', packet)
      } catch { stop() }
    }, 50)
    return true
  }
  return { start, stop }
}

module.exports = { createRespawnSwim }
