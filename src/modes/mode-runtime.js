'use strict'

// Wires the modes into the runtime's operations: adds operations.mode and makes
// a quarry start or resume refuse while player mode is selected. `rt` is the
// accessor object runtime-operations.js receives from runtime.js.
const path = require('node:path')
const { isMode, startRefusal } = require('./bot-mode')
const { modeFile, loadModeSync, saveMode } = require('./mode-store')
const { createModeControl } = require('./mode-control')
const { createPlayerMode } = require('./player-mode')

function attachModeOperations (operations, rt, { root = path.resolve(__dirname, '..', '..') } = {}) {
  const shared = rt.host.shared, file = modeFile(root), log = text => rt.host.log(text)
  // First runtime of this process: `npm run auto` means player mode, otherwise the saved choice.
  if (!isMode(shared.botMode)) shared.botMode = shared.autoWanted === true ? 'player' : loadModeSync(file)
  const quarry = operations.quarry, agent = operations.agent
  const agentStatus = () => rt.autonomy?.snapshot() ?? { running: false }
  const control = createModeControl({
    shared, save: mode => saveMode(file, mode), log,
    getQuarryStatus: () => quarry.status(), getAgentStatus: agentStatus,
    isBusy: () => rt.chunkMoveHeld() || rt.manualChestStorage?.isBusy() === true || rt.resetHeld()
  })
  const player = createPlayerMode({
    getMode: control.get, log, safety: operations.safety,
    agent: { start: options => agent.start(options), stop: reason => agent.stop(reason), snapshot: agentStatus },
    getInventory: () => shared.inventoryUncertain ? null : rt.raw().inventory
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
