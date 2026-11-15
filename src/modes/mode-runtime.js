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

function attachModeOperations (operations, runtime, { root = path.resolve(__dirname, '..', '..') } = {}) {
  const shared = runtime.host().shared, file = modeFile(root), log = text => runtime.host().log(text)
  // First runtime of this process: `npm run auto` means player mode, otherwise the saved choice.
  if (!isMode(shared.botMode)) shared.botMode = shared.autoWanted === true ? 'player' : loadModeSync(file)
  const quarry = operations.quarry
  // The modes start and stop the autonomy through these. Anyone else (the /stop
  // and /agent commands, the local API) goes through operations.agent, where a
  // stop also means "the player stops playing".
  const inner = operations.agent, agent = { start: options => inner.start(options), stop: reason => inner.stop(reason) }
  operations.agent = { ...inner, start: options => { if (control.get() === 'player') shared.playerWanted = true; return inner.start(options) }, stop: reason => { shared.playerWanted = false; recovery.cancel(); return inner.stop(reason) } }
  const agentStatus = () => runtime.autonomy()?.snapshot() ?? { running: false }
  const disposed = () => runtime.disposed?.() === true
  const control = createModeControl({
    shared, save: mode => saveMode(file, mode), log,
    getQuarryStatus: () => quarry.status(), getAgentStatus: () => recovery.status().active || shelter.status().active || flee.status().active ? { running: true } : agentStatus(),
    isBusy: () => runtime.chunkMoveHeld() || runtime.manualChestStorage()?.isBusy() === true || runtime.resetHeld()
  })
  const recovery = createPlayerRecovery({
    getMode: control.get, shared, log, disposed, held: () => !!shared.travelNight?.cover,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason) },
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getPosition: () => runtime.raw().position ?? null
  })
  shared.onAutonomyProgress = snapshot => recovery.onProgress(snapshot)
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
    getState: () => { const state = runtime.raw(); return { health: state.health, position: state.position, totem: state.health <= 8 && runtime.totem() } },
    hostiles: () => runtime.hostiles(), retreat: () => runtime.travel().retreatFromHostiles()
  })
  const fleeTimer = setInterval(() => { if (disposed()) clearInterval(fleeTimer); else void flee.tick().catch(() => {}) }, 500)
  fleeTimer.unref?.()
  // The shelter is checked every two seconds; a reloaded runtime's timer ends itself.
  const timer = setInterval(() => {
    if (disposed()) return clearInterval(timer)
    void shelter.tick()
    try { recovery.keepPlaying({ running: agentStatus().running === true, resting: shelter.status().active || flee.status().active }) } catch { /* The next tick retries. */ }
  }, 2000)
  timer.unref?.()
  // The previous runtime was reloaded in the middle of a recovery: play on.
  if (shared.playerRecovering === true) { shared.playerRecovering = false; if (control.get() === 'player') shared.autoWanted = true }
  const player = createPlayerMode({
    getMode: control.get, log, safety: operations.safety, recovery, shelter, flee, shared,
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
