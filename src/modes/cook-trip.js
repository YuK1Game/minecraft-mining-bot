'use strict'
// When the expedition carries raw meat home to the furnace.
// It went home after every single piece: 2026-11-19 08:24-08:54 JST real Realm, thirty minutes held two walks home
// (seven and twelve minutes) for two muttons and one chicken, and the cooked food went from 2 to 3.
// The meat is carried home when a batch is full, when no animal that can be hunted is in view, or when the Bot is
// at home anyway. Raw meat is not eaten on the way while the Bot is neither hungry nor hurt (raw-meat-keep.js).
const BATCH = 6

function cookNow ({ raw = 0, here = false, huntReady = false } = {}) {
  if (!(raw > 0)) return false
  return here === true || raw >= BATCH || huntReady !== true
}

module.exports = { cookNow, BATCH }
