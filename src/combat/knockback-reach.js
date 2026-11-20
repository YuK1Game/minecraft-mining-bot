'use strict'

// "In reach" across a knockback.
//
// A hit throws its target about a block back, and a hit taken throws the Bot back; a mob that chases is in reach
// again within the half second a hurt mob takes no damage anyway. A rule that asks "is something in reach now"
// at that instant gets the wrong answer:
// - the sword burst ended OUT_OF_REACH on its own hit (melee-combat.js waits KNOCKBACK_MS within KNOCKBACK_M;
//   live 2026-11-19 18:39 JST);
// - the low-health rule of the fight (combat-coordinator.js `crowdedLowHp`: among two or more close hostiles the
//   fight ends unless one is in reach, because one in reach keeps pace and running only gives it free hits) ended
//   the fight on every hit (live 2026-11-20 15:39:56-15:40:00 JST: a skeleton and two zombies, stone sword, health
//   5.9; 「HP_DISENGAGE」 59-332 ms after the first hit of three bursts at 2.3-2.9 m, and once 40 ms after the hit
//   the Bot took at 2.6 m; three hits in 3.4 s, health 5.9 → 0.64, dead nine seconds later).
// Both read the same two numbers. A hostile seen in reach stays "in reach" for KNOCKBACK_MS while it is within
// KNOCKBACK_M beyond reach; longer or farther, it is out of reach as before.
const KNOCKBACK_MS = 600, KNOCKBACK_M = 1.5

// reach: metres. clock: the caller's milliseconds.
function createContactHold ({ reach, clock, holdMs = KNOCKBACK_MS, slackM = KNOCKBACK_M }) {
  let at = -Infinity
  // distances: of every hostile that counts, now. Each look is also the sample: it is asked at every poll.
  function touching (distances) {
    const now = clock()
    let nearest = Infinity
    for (const d of distances) if (d < nearest) nearest = d
    if (nearest <= reach) { at = now; return true }
    return now - at >= 0 && now - at <= holdMs && nearest <= reach + slackM
  }
  // The sword swung: it does so only at a target in real reach, also between two looks (a mob that walks in is
  // hit and thrown back within one poll).
  function swung () { at = clock() }
  return { touching, swung }
}

module.exports = { KNOCKBACK_MS, KNOCKBACK_M, createContactHold }
