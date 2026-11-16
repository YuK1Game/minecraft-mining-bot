'use strict'

// Wires the modes into the runtime's operations: adds operations.mode and makes
// a quarry start or resume refuse while player mode is selected. `runtime` holds
// functions that read the runtime's current bindings (host, autonomy, holds).
const path = require('node:path')
const { isMode, startRefusal } = require('./bot-mode')
const { modeFile, loadModeSync, saveMode } = require('./mode-store')
const { createModeControl } = require('./mode-control')
const { createPlayerMode, OBJECTIVE } = require('./player-mode')
const { createPlayerRecovery } = require('./player-recovery')
const { createPlayerShelter } = require('./player-shelter')
const { createPlayerFlee } = require('./player-flee')
const { knownUnreachable, knownReachable } = require('../combat/threat-reachability')
const { createPlayerCover } = require('./player-cover')
const { walkableCells } = require('./player-drops')
const { createCombatExposure } = require('../combat/combat-exposure')
const { createPlayerScaffold } = require('./player-scaffold')
const { createScaffoldPorts } = require('./player-scaffold-ports')
const { climbOut } = require('./player-climb')
const { sidestep } = require('./player-climb-side')
const { boxedIn, stepOut } = require('./player-pit')
const { settle, offCentre } = require('./player-settle')
const { createPlayerTorch } = require('./player-torch')
const { createTorchPorts } = require('./player-torch-ports')
const { nextObjective } = require('./player-goal')
const { playFile, createPlayerResume } = require('./player-resume')

function attachModeOperations (operations, runtime, { root = path.resolve(__dirname, '..', '..') } = {}) {
  const shared = runtime.host().shared, file = modeFile(root), log = text => runtime.host().log(text)
  // First runtime of this process: `npm run auto` means player mode, otherwise the saved choice.
  if (!isMode(shared.botMode)) shared.botMode = shared.autoWanted === true ? 'player' : loadModeSync(file)
  const resume = createPlayerResume({ file: playFile(root), shared, getMode: () => shared.botMode, log })
  resume.restore()
  const quarry = operations.quarry
  // The modes start and stop the autonomy through these. Anyone else (the /stop
  // and /agent commands, the local API) goes through operations.agent, where a
  // stop also means "the player stops playing".
  const inner = operations.agent, agent = { start: options => { if (flee.status().active) throw Error('敵から離れている間は始めません。'); return inner.start(aimed(options)) }, stop: reason => inner.stop(reason) }
  // In player mode every start plays for the next goal (player-goal.js).
  let aim = null
  const aimed = options => {
    if (control.get() !== 'player') return options
    const next = nextObjective(options, shared.inventoryUncertain ? null : runtime.raw().inventory)
    if (next?.diamondCount > 1 && next.diamondCount !== aim) log(`プレイヤーモード: 次の目標はダイヤモンド ${next.diamondCount} 個です`)
    aim = next?.diamondCount ?? aim
    return next
  }
  operations.agent = { ...inner, start: options => { if (control.get() === 'player') shared.playerWanted = true; return inner.start(aimed(options)) }, stop: reason => { shared.playerWanted = false; recovery.cancel(); return inner.stop(reason) } }
  const agentStatus = () => runtime.autonomy()?.snapshot() ?? { running: false }
  const disposed = () => runtime.disposed?.() === true
  const idle = () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true }
  const control = createModeControl({
    shared, save: mode => saveMode(file, mode), log,
    getQuarryStatus: () => quarry.status(), getAgentStatus: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active ? { running: true } : agentStatus(),
    isBusy: () => runtime.chunkMoveHeld() || runtime.manualChestStorage()?.isBusy() === true || runtime.resetHeld()
  })
  // Where the Bot is: the working position. The last received position can be
  // minutes old on this Realm (live 2026-11-15 21:24-21:42 JST: every walk
  // looked like "got nowhere", so the search turned 60 degrees each time and
  // circled a hexagon around the stale point).
  const where = () => { const position = runtime.position?.(); return position && [position.x, position.y, position.z].every(Number.isFinite) ? position : runtime.raw().position ?? null }
  // Ordinary walking, mining, placement and the pillar step, shared by the scaffold and the climb out of a tunnel.
  const hands = createScaffoldPorts({
    operations, disposed, pillarStep: (step, settings) => runtime.pillarStep(step, settings),
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(), getMotion: () => runtime.motion(),
    getFeet: () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }
  })
  const recovery = createPlayerRecovery({
    getMode: control.get, shared, log, disposed, held: () => !!shared.travelNight?.cover,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason) },
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getPosition: where,
    prey: () => operations.foraging?.snapshot()?.target?.position ?? null,
    pit: {
      boxed: () => boxedIn((x, y, z) => runtime.host().world.getBlock(x, y, z), where()),
      out: async aborted => {
        for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
        return stepOut({ ports: hands, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), log, aborted: () => aborted() || flee.status().active || shelter.status().active })
      }
    },
    settle: {
      needed: () => !!offCentre((x, y, z) => runtime.host().world.getBlock(x, y, z), hands.feet()),
      run: async aborted => {
        for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
        return settle({ ports: hands, aborted: () => aborted() || flee.status().active || shelter.status().active })
      }
    },
    climb: async aborted => {
      for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
      const stop = () => aborted() || flee.status().active || shelter.status().active
      // Under water, gravel or leaves the shaft moves sideways and goes on (player-climb-side.js).
      let out = await climbOut({ ports: hands, log, aborted: stop })
      for (let i = 0; i < 3 && !out.ok && (out.reason === 'CANNOT_MINE' || out.reason === 'LEAVES_ABOVE') && !stop(); i++) {
        if (!(await sidestep({ ports: hands, log, aborted: stop })).ok) break
        out = await climbOut({ ports: hands, log, aborted: stop })
      }
      return out
    }
  })
  // The runtime restarts a finished run from shared.autoOptions without passing
  // through the starts above (real Realm 2026-11-16 08:11-08:34 JST: with one
  // diamond held, 3,510 runs started and completed at once): the goal there is
  // kept current, with every progress snapshot and every two seconds.
  const keepAim = () => {
    const options = shared.autoOptions
    if (control.get() !== 'player' || options?.objective !== 'diamond') return
    const next = aimed(options).diamondCount
    if (Number.isSafeInteger(next) && next !== options.diamondCount) options.diamondCount = next
  }
  shared.onAutonomyProgress = snapshot => { keepAim(); return recovery.onProgress(snapshot) }
  const air = cell => { const block = runtime.host().world.getBlock(cell.x, cell.y, cell.z); return block?.known === true && /^minecraft:(?:air|cave_air)$/.test(block.name ?? '') }
  const hunger = () => { const value = shared.vitals?.hunger; return Number.isFinite(value) ? value : Number.isFinite(value?.value) ? value.value : null }
  const shelter = createPlayerShelter({
    getMode: control.get, shared, log, disposed, recovery,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agentStatus().running === true, settled: () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true } },
    getClock: () => runtime.travel().travelClock(), getVitals: () => ({ health: runtime.raw().health, hunger: hunger() }),
    hostileDistance: () => runtime.nearestHostile(), travelBusy: () => quarry.travelStatus().busy === true,
    dig: () => runtime.travel().travelNightPit(),
    // The cover is mined by the ordinary mining and counts once the received block is air.
    uncover: async cover => {
      if (air(cover)) return true
      operations.mining.start([cover])
      for (let i = 0; i < 175 && !air(cover) && !disposed(); i++) await new Promise(resolve => setTimeout(resolve, 200))
      return air(cover)
    }
  })
  const flee = createPlayerFlee({
    getMode: control.get, shared, log, disposed,
    agent: { stop: reason => agent.stop(reason), running: () => agentStatus().running === true },
    travel: { status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory, totem: () => runtime.totem() } },
    // A hostile with fresh evidence that it cannot walk to the Bot (shut in a
    // deep pit, no route) is not run from; creepers always are.
    hostiles: () => { const state = runtime.raw(); return (runtime.hostiles() ?? []).filter(actor => /creeper/.test(String(actor?.entityType ?? '')) || !knownUnreachable(state, actor)) },
    retreat: () => runtime.travel().retreatFromHostiles()
  })
  // Shot by an archer it cannot walk to: behind the nearest block (player-cover.js).
  const cover = createPlayerCover({
    getMode: control.get, shared, log, disposed,
    agent: { stop: reason => agent.stop(reason), running: () => agentStatus().running === true },
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory } },
    hostiles: () => runtime.hostiles(), reachable: actor => knownReachable(runtime.raw(), actor),
    sight: (from, to) => createCombatExposure({ world: runtime.host().world, entities: {}, scopeOf: () => null }).sight(from, to),
    cells: position => walkableCells(position, (x, y, z) => runtime.host().world.getBlock(x, y, z)).values(),
    walk: target => hands.walk(target),
    blocked: () => shelter.status().active || flee.status().active || scaffold.status().active || quarry.travelStatus().busy === true
  })
  // Logs out of reach: a dirt pillar in the trunk's place, taken down again afterwards.
  const scaffold = createPlayerScaffold({
    getMode: control.get, shared, log, disposed,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true } },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || quarry.travelStatus().busy === true,
    ports: hands
  })
  // Underground, a torch every eight blocks (player-torch.js).
  const feetNow = () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }
  const torch = createPlayerTorch({
    getMode: control.get, shared, log, disposed, getFeet: feetNow,
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agentStatus().running === true, settled: idle },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || quarry.travelStatus().busy === true || runtime.nearestHostile() < 12,
    hands: createTorchPorts({ operations, disposed, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory() })
  })
  const fleeTimer = setInterval(require('../common/work-spans').wrap('player-flee.tick', () => { if (disposed()) clearInterval(fleeTimer); else { void flee.tick().catch(() => {}); void cover.tick().catch(() => {}) } }), 500)
  fleeTimer.unref?.()
  // The shelter is checked every two seconds; a reloaded runtime's timer ends itself.
  const timer = setInterval(require('../common/work-spans').wrap('player-mode.tick', () => {
    if (disposed()) return clearInterval(timer)
    void resume.note()
    keepAim()
    void shelter.tick()
    void scaffold.tick().catch(() => {})
    void torch.tick().catch(() => {})
    try { recovery.keepPlaying({ running: agentStatus().running === true, resting: shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active }) } catch { /* The next tick retries. */ }
  }), 2000)
  timer.unref?.()
  // The previous runtime was reloaded in the middle of a recovery: play on.
  if (shared.playerRecovering === true) { shared.playerRecovering = false; if (control.get() === 'player') shared.autoWanted = true }
  const player = createPlayerMode({
    getMode: control.get, log, safety: operations.safety, recovery, shelter, flee, scaffold: { status: () => torch.status().active ? torch.status() : scaffold.status() }, shared,
    agent: { start: options => agent.start(options), stop: reason => agent.stop(reason), snapshot: agentStatus },
    getInventory: () => shared.inventoryUncertain ? null : runtime.raw().inventory
  })
  for (const name of ['start', 'resume']) {
    const inner = quarry[name]
    quarry[name] = (...args) => {
      const refused = startRefusal(control.get(), 'quarry')
      if (refused) throw Object.assign(new Error(refused.message), { code: refused.code })
      return inner(...args)
    }
  }
  operations.mode = {
    get: control.get,
    set: mode => control.set(mode),
    status: () => ({ mode: control.get(), player: player.status() }),
    startPlayer: () => player.start(),
    stopPlayer: reason => player.stop(reason)
  }
  return operations.mode
}

module.exports = { attachModeOperations }
