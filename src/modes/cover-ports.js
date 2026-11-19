'use strict'

// What the cover from an archer (player-cover.js) holds of the player, also
// while the expedition owns the work.
//
// The expedition ran neither the flee nor the cover, and its own retreat waits
// for 12 health: an armed Bot under a skeleton the fight could not walk up to
// stood in the arrows until it died. The cover now runs there too. It ends the
// expedition's action (and its trip) first, and walks once neither can send.
//
// "Neither can send" is seen, not waited out (control-owner.js handoff). The
// walk used to start after fifteen waits of 200 ms whether or not the trip and
// the expedition had ended. Now the parts that can still send are named:
// - work: the autonomy, or an expedition step that runs and was not aborted.
//   A step that only saves or cleans up sends nothing and holds nothing back.
// - trip: a long trip whose loop still runs (it walks its own legs); cancelled.
// - motion: a movement in flight, whoever started it; stopped by the ordinary
//   movement stop.
// While one of them is left at the deadline, the cover gets
// HANDOFF_INCOMPLETE and does not walk.
//
// Whether a fight keeps the input from the cover is the owner's rule
// (control-owner.js), not decided here.
const { holdOf } = require('./control-owner')

function createCoverPorts ({ expedition, cancelExpedition, agent, agentRunning, travelStatus, cancelTrip = null, motion = null, held = () => false }) {
  const tripBusy = () => travelStatus()?.busy === true
  return {
    // Somebody else's trip keeps its own guard against shooters; the expedition's trip is ended for the cover.
    tripBlocks: () => !expedition.owns() && tripBusy(),
    hold: holdOf({
      work: { on: () => expedition.sending() || agentRunning(), stop: reason => expedition.owns() ? cancelExpedition() : agent.stop(reason) },
      // Reached only under the expedition (tripBlocks): a trip nobody watches any more is ended like the step's own.
      trip: { on: tripBusy, stop: () => cancelTrip?.() },
      motion: { on: () => motion?.moving() === true, stop: reason => motion.stop(reason) },
      fight: { on: () => held() === true }
    })
  }
}

module.exports = { createCoverPorts }
