'use strict'

// The two walks that take the Bot's input from the work when enemies are near
// (the flee, player-flee.js, and the cover, player-cover.js), wired to the one
// owner of that input (control-owner.js) and to the operations they call.
// mode-runtime.js builds them through here, and so do the tests, so that what
// is tested from the start decision to the operation is what runs.
const { createControlOwner } = require('./control-owner')
const { createPlayerFlee } = require('./player-flee')
const { fleeThreats } = require('./player-flee-threats')
const { createPlayerCover } = require('./player-cover')
const { createCoverPorts } = require('./cover-ports')
const { healing } = require('./flee-healing')
const { hasFood } = require('./player-food')
const { normalizeMode } = require('./bot-mode')

function createDefenseWalks ({ shared, getMode, log, disposed, runtime, agent, agentStatus, quarry, where, hunger, expedition, cancelExpedition, hands, stopMotion, scope = () => null, unreachable, exposure, cells, blocked = () => false, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  // Who holds the input near enemies: the fight, a walk away, or the work (control-owner.js).
  // A lease is of this code generation, this play and this connection, dimension and life.
  const active = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const owner = createControlOwner({ shared, fight: () => runtime.combatFight?.() ?? null, held: () => runtime.combatOwns?.() === true, scope, active, now, sleep })
  // A movement in flight, whoever started it, and the ordinary stop of it.
  const motion = { moving: () => ['moving', 'settling'].includes(runtime.motion?.()?.phase), stop: reason => stopMotion(reason) }
  const flee = createPlayerFlee({
    getMode, shared, log, disposed, owner, motion, now, sleep,
    agent: { stop: reason => agent.stop(reason), running: () => agentStatus().running === true },
    travel: { status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory, totem: () => runtime.totem(), healing: healing({ hunger: hunger(), inventory: shared.inventoryUncertain ? null : runtime.inventory(), hasFood }) } },
    // A hostile with fresh evidence that it cannot walk to the Bot (shut in a
    // deep pit, no route) is not run from; creepers always are.
    // Nor is a shooter or a flyer behind received blocks (player-flee-threats.js).
    hostiles: () => { const state = runtime.raw(), at = where(), seen = exposure({ solidCover: true }); return fleeThreats({ hostiles: runtime.hostiles(), unreachable: actor => unreachable(state, actor), sight: actor => at && actor?.position ? seen.evaluate(actor, { position: at }).evidence.sight : null }) },
    // The step is sent only by the run that holds the input, and stops planning once it does not.
    retreat: lease => lease.send(() => runtime.travel().retreatFromHostiles(lease.signal()))
  })
  // Shot by an archer it cannot walk to: behind the nearest block (player-cover.js), under the expedition too (cover-ports.js).
  const coverHold = createCoverPorts({ expedition: { owns: () => expedition()?.owns() === true, sending: () => expedition()?.sending() === true }, cancelExpedition, agent, agentRunning: () => agentStatus().running === true, travelStatus: () => quarry.travelStatus(), cancelTrip: () => quarry.cancelTravel(), motion, held: () => owner.held() })
  const cover = createPlayerCover({
    getMode, shared, log, disposed, owner, now, sleep,
    hold: coverHold.hold,
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory } },
    hostiles: () => runtime.hostiles(),
    sight: (from, to) => exposure().sight(from, to),
    cells,
    // Every operation of the walk is checked against the lease where it is called.
    walk: (target, lease) => hands(lease).walk(target),
    // Whether the flee holds the input is the owner's answer (acquire), not asked here.
    blocked: () => blocked() || coverHold.tripBlocks()
  })
  return { owner, flee, cover }
}

module.exports = { createDefenseWalks }
