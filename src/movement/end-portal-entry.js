'use strict'

// The ordinary route planner requires a walkable floor. An activated End portal
// is the intended collision, so this short final step ends at contact instead.
const { createNavigator } = require('./navigation')
const portal = b => b?.known === true && b.name === 'minecraft:end_portal'
const air = b => b?.known === true && /^(?:minecraft:)(?:air|cave_air|void_air)$/.test(b.name) && !b.extra?.length

function portalEntry (world, state, cell, version, signal) {
  if (!['end', 'overworld'].includes(state.dimension) || !cell || ![cell.x, cell.y, cell.z].every(Number.isSafeInteger)) throw Error('エンドポータルの位置が不明です。')
  const read = (x, y, z) => world.getBlock(x, y, z)
  let verifyApproach = () => {}
  const check = () => {
    verifyApproach()
    if (signal?.aborted || !portal(read(cell.x, cell.y, cell.z)) || !air(read(cell.x, cell.y + 1, cell.z))) throw Error('開通したエンドポータルを再確認します。')
  }
  check()
  const candidate = createNavigator({ version, world: { getBlock (x, y, z) {
    const block = read(x, y, z)
    // The physics engine surveys neighboring cells below its feet. An active
    // End portal intercepts the player before the covered lava can be reached.
    // Limit the substitution to that exact received portal and stop at contact.
    if (y === cell.y - 1 && block?.known && /^(?:minecraft:)(?:flowing_)?lava$/.test(block.name) && portal(read(x, y + 1, z))) return { known: true, name: 'minecraft:air', extra: [] }
    return block
  } } })
  const physics = candidate.physics, initial = physics.fromServer(state)
  const feet = initial.position, start = { x: Math.floor(feet.x), z: Math.floor(feet.z) }
  const distance = Math.abs(start.x - cell.x) + Math.abs(start.z - cell.z)
  const exterior = state.dimension === 'overworld' && distance === 2 && (start.x === cell.x || start.z === cell.z)
  if ((!exterior && distance > 1) || feet.y < cell.y || feet.y > cell.y + 1.1) throw Error('ポータル直近の縁に移動します。')
  const rim = exterior ? { x: (start.x + cell.x) / 2, z: (start.z + cell.z) / 2 } : start
  const groundY = Math.floor(feet.y + 0.001) - 1
  verifyApproach = () => {
    if (!distance) return
    const frame = read(rim.x, cell.y, rim.z)
    const supported = state.dimension === 'overworld'
      ? frame?.name === 'minecraft:end_portal_frame' && [true, 1].includes(frame.properties?.end_portal_eye_bit)
      : frame?.name === 'minecraft:bedrock'
    if (!frame?.known || !supported || !air(read(rim.x, cell.y + 1, rim.z))) throw Error('受信したポータルの縁から進入します。')
    if (exterior) {
      const support = read(start.x, groundY, start.z)
      if (support?.known !== true || support.boundingBox !== 'block' || support.extra?.length ||
          /lava|water|magma|fire/.test(support.name) || !air(read(start.x, groundY + 1, start.z))) throw Error('ポータルの手前に安全な足場が必要です。')
    }
  }
  check()
  const waypoint = { position: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, action: 'enter_portal' }
  const route = { ready: true, operation: 'enter_end_portal', origin: { ...feet }, target: waypoint.position, waypoints: [waypoint] }
  function makeStepper () {
    let current = structuredClone(initial), ticks = 0, stopped = false
    return {
      next () {
        check()
        if (stopped || ++ticks > (exterior ? 36 : 22)) throw Error('入口の移動を再確認します。')
        const at = current.position
        const controls = { forward: Math.hypot(at.x - waypoint.position.x, at.z - waypoint.position.z) > 0.12 }
        if (exterior && ticks === 1 && at.y < cell.y + 0.75) controls.jump = true
        current.yaw = -Math.atan2(waypoint.position.x - at.x, waypoint.position.z - at.z) * 180 / Math.PI
        current = physics.step(current, controls)
        const p = current.position
        const inside = Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z
        const onRim = Math.floor(p.x) === rim.x && Math.floor(p.z) === rim.z
        const onStart = Math.floor(p.x) === start.x && Math.floor(p.z) === start.z
        if (p.y < cell.y || current.isInLava || !(inside || onRim || onStart)) throw Error('ポータルの進入経路が変わりました。')
        const contact = inside && p.y <= cell.y + 0.5
        return { phase: contact ? 'awaiting_server_confirmation' : 'moving', predictedState: structuredClone(current), controls, packetPosition: physics.toServerPosition(current), waypointIndex: 0, waypoint, settled: contact }
      },
      reconcile () { stopped = true }, stop () { stopped = true }, snapshot: () => ({ ticks })
    }
  }
  const probe = makeStepper()
  while (probe.next().phase !== 'awaiting_server_confirmation') {}
  return { prepared: { candidate, initial, route, state, allowWater: false, emergency: false }, stepper: makeStepper() }
}

module.exports = { portalEntry }
