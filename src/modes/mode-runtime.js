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

function attachModeOperations (operations, runtime, { root = path.resolve(__dirname, '..', '..') } = {}) {
  const shared = runtime.host().shared, file = modeFile(root), log = text => runtime.host().log(text)
  // First runtime of this process: `npm run auto` means player mode, otherwise the saved choice.
  if (!isMode(shared.botMode)) shared.botMode = shared.autoWanted === true ? 'player' : loadModeSync(file)
  const quarry = operations.quarry, agent = operations.agent
  const agentStatus = () => runtime.autonomy()?.snapshot() ?? { running: false }
  const control = createModeControl({
    shared, save: mode => saveMode(file, mode), log,
    getQuarryStatus: () => quarry.status(), getAgentStatus: () => recovery.status().active ? { running: true } : agentStatus(),
    isBusy: () => runtime.chunkMoveHeld() || runtime.manualChestStorage()?.isBusy() === true || runtime.resetHeld()
  })
  const recovery = createPlayerRecovery({
    getMode: control.get, shared, log, disposed: () => runtime.disposed?.() === true,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason) },
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getPosition: () => runtime.raw().position ?? null
  })
  shared.onAutonomyProgress = snapshot => recovery.onProgress(snapshot)
  // The previous runtime was reloaded in the middle of a recovery: play on.
  if (shared.playerRecovering === true) { shared.playerRecovering = false; if (control.get() === 'player') shared.autoWanted = true }
  const player = createPlayerMode({
    getMode: control.get, log, safety: operations.safety, recovery,
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
