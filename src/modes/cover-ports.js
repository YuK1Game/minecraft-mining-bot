'use strict'

// What the cover from an archer (player-cover.js) holds of the player, also
// while the expedition owns the work.
//
// The expedition ran neither the flee nor the cover, and its own retreat waits
// for 12 health: an armed Bot under a skeleton the fight could not walk up to
// stood in the arrows until it died. The cover now runs there too. It ends the
// expedition's action (and its trip) first, and walks once both have ended.
//
// An archer the Bot can walk to is left to the fight only while the fight is
// really on: it held the input within the last two seconds. A route on paper
// with a fight that ended on "no stance" is nobody's enemy.
const FOUGHT_MS = 2000, SETTLE_TRIES = 15, SETTLE_MS = 200

function createCoverPorts ({ expedition, cancelExpedition, agent, agentRunning, travelStatus, walk, reachable, combatOwns, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let foughtAt = -Infinity
  const sample = () => { if (combatOwns() === true) foughtAt = now() }
  const fought = () => { sample(); return now() - foughtAt <= FOUGHT_MS }
  const tripBusy = () => travelStatus()?.busy === true
  return {
    sample,
    agent: {
      stop: reason => expedition.owns() ? cancelExpedition() : agent.stop(reason),
      running: () => expedition.busy() || agentRunning()
    },
    reachable: actor => reachable(actor) === true && fought(),
    // Somebody else's trip keeps its own guard against shooters; the expedition's trip is ended for the cover.
    tripBlocks: () => !expedition.owns() && tripBusy(),
    walk: async target => {
      for (let i = 0; i < SETTLE_TRIES && (tripBusy() || expedition.busy()); i++) await sleep(SETTLE_MS)
      return walk(target)
    }
  }
}

module.exports = { createCoverPorts }
