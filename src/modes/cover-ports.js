'use strict'

// What the cover from an archer (player-cover.js) holds of the player, also
// while the expedition owns the work.
//
// The expedition ran neither the flee nor the cover, and its own retreat waits
// for 12 health: an armed Bot under a skeleton the fight could not walk up to
// stood in the arrows until it died. The cover now runs there too. It ends the
// expedition's action (and its trip) first, and walks once both have ended.
//
// Whether a fight keeps the input from the cover is the owner's rule
// (control-owner.js), not decided here.
const SETTLE_TRIES = 15, SETTLE_MS = 200

function createCoverPorts ({ expedition, cancelExpedition, agent, agentRunning, travelStatus, walk, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const tripBusy = () => travelStatus()?.busy === true
  return {
    agent: {
      stop: reason => expedition.owns() ? cancelExpedition() : agent.stop(reason),
      running: () => expedition.busy() || agentRunning()
    },
    // Somebody else's trip keeps its own guard against shooters; the expedition's trip is ended for the cover.
    tripBlocks: () => !expedition.owns() && tripBusy(),
    walk: async target => {
      for (let i = 0; i < SETTLE_TRIES && (tripBusy() || expedition.busy()); i++) await sleep(SETTLE_MS)
      return walk(target)
    }
  }
}

module.exports = { createCoverPorts }
