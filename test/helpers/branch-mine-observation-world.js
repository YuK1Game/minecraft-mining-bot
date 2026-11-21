'use strict'

// Real Host World, terrain requester, navigator/physics, scaffold hands and
// mine action ports. Only the peer's terrain and position receipts are local.
const { plannerWorld } = require('./branch-mine-planner-world')
const { createNavigator } = require('../../src/movement/navigation')
const { createScaffoldPorts } = require('../../src/modes/player-scaffold-ports')
const { createMinePorts } = require('../../src/modes/mining/mine-ports')
const { createQuarryTerrainRequester } = require('../../src/quarry/quarry-terrain')
const { observeMineRuntime } = require('../../src/modes/mining/mine-runtime-observe')
const { mineLiveScope } = require('../../src/modes/mining/mine-state')
const { createServerPositionVerifier } = require('../../src/movement/server-position-verifier')

function observationWorld ({ index = 1 } = {}) {
  const f = plannerWorld({ minSection: 5 }), packets = [], walks = [], proofs = [], positionPackets = [], pendingBeforeReply = [], saves = [], controller = new AbortController()
  let clock = 10000, responding = false, onWalk = () => {}, onRequest = null, correction = null, saveOK = true, stopped = false, autoPosition = true
  const announce = (x, z) => f.world.applyPacket('level_chunk', { dimension: 0, x, z, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  for (let x = 0; x <= 1; x++) for (let z = -1; z <= 1; z++) { announce(x, z); f.section(x, 3, z, 'stone'); f.section(x, 4, z, 'air') }
  const navigator = createNavigator({ world: f.world })
  let pose = navigator.physics.fromServer({ position: { x: 0.5, y: 65.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  for (let i = 0; i < 20; i++) pose = navigator.physics.step(pose, {})
  const feet = () => ({ ...pose.position }), setFeet = p => { pose = navigator.physics.fromServer({ position: { ...p, y: p.y + 1.62 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' }) }
  const replyPosition = (patch = {}) => {
    const packet = positionPackets.at(-1).packet, match = /x=([^,]+),y=([^,]+),z=([^,]+),rm=([^\]]+)/.exec(packet.command)
    if (correction) setFeet(correction)
    const inside = Math.hypot(feet().x - Number(match[1]), feet().y - Number(match[2]), feet().z - Number(match[3])) < Number(match[4])
    return verifier.applyPacket('command_output', { origin: structuredClone(packet.origin), output_type: 'all_output', success_count: inside ? 0 : 1,
      output: [{ message_id: inside ? 'commands.generic.noTargetMatch' : 'commands.testfor.success', success: !inside, parameters: inside ? [] : ['Bot'] }], has_data: false, ...patch })
  }
  const verifier = createServerPositionVerifier({ client: { queue (name, packet) {
    positionPackets.push({ name, packet }); pendingBeforeReply.push(verifier.snapshot()); if (autoPosition) replyPosition()
  } }, getState: () => ({ ...f.getState(), playerName: 'Bot' }), now: () => clock, timeoutMs: 1000 })
  const inv = { known: true, items: [] }
  const rt = { host: { world: f.world }, quarryState: f.getState }
  const requester = createQuarryTerrainRequester({ client: { queue (name, packet) {
    packets.push({ name, packet }); onRequest?.(packet)
    if (responding) for (const offset of packet.requests) {
      const x = packet.origin.x + offset.x, y = packet.origin.y + offset.y, z = packet.origin.z + offset.z
      f.section(x, y, z, y >= 4 ? 'air' : y < 0 ? 'deepslate' : 'stone')
    }
  } }, getState: f.getState, world: f.world, now: () => clock, sleep: async ms => { clock += ms } })
  rt.requestQuarryTerrain = requester.request
  const operations = { movement: { start (target, options = {}) {
    const route = navigator.plan(pose, target, { maxDistance: 16, ...options })
    if (!route.ready) throw new Error(route.reason)
    const stepper = navigator.createStepper(route, pose)
    for (let i = 0; i < 500; i++) { const frame = stepper.next(); pose = frame.predictedState; if (frame.phase !== 'moving') break }
    walks.push({ target: { ...target }, actual: feet(), route: route.path })
    onWalk(walks.length)
  } } }
  const ctx = { root: require('node:path').resolve(__dirname, '../..'), shared: {}, memory: { early: { mine: { search: { index, requestKey: JSON.stringify(['raw_iron', 1, mineLiveScope(f.current)]) } } } }, signal: controller.signal,
    cancelled: () => stopped || controller.signal.aborted, getFeet: feet, getBlock: f.world.getBlock, now: () => clock, sleep: async ms => { clock += ms }, operations,
    runtime: { mineState: f.getState, raw: f.getState, inventory: () => inv, host: () => ({ world: f.world }),
      mineObserve: (request, options) => observeMineRuntime(rt, request, options), mineConfirmPosition: (target, options) => {
        proofs.push({ ...target }); return verifier.confirm(target, options)
      } }, saveMine: async () => { saves.push(structuredClone(ctx.memory.early.mine)); return saveOK } }
  ctx.hands = createScaffoldPorts({ operations, getBlock: ctx.getBlock, getFeet: feet, getInventory: () => inv, getMotion: () => ({ phase: 'idle' }), disposed: ctx.cancelled, sleep: ctx.sleep, now: ctx.now })
  ctx.minePorts = createMinePorts(ctx)
  const receiveSite = (cx, cz) => {
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) {
      announce(x, z)
      for (let y = 0; y <= 5; y++) f.section(x, y, z, y >= 4 ? 'air' : 'stone')
    }
    for (let x = cx * 16 - 8; x <= cx * 16 + 8; x++) for (let z = cz * 16 - 8; z <= cz * 16 + 8; z++) f.put({ x, y: 48, z }, 'iron_ore')
  }
  return { ...f, ctx, rt, packets, walks, proofs, positionPackets, pendingBeforeReply, verifier, replyPosition, saves, feet, setFeet, announce, receiveSite, requester,
    respond: value => { responding = value }, onWalk: fn => { onWalk = fn }, onRequest: fn => { onRequest = fn },
    correct: p => { correction = p }, autoPosition: value => { autoPosition = value }, saveOK: value => { saveOK = value }, stop: () => { stopped = true }, abort: () => controller.abort(), advance: ms => { clock += ms } }
}

module.exports = { observationWorld }
