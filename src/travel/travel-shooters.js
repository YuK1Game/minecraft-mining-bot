'use strict'

// In play mode a long trip leaves skeletons and other shooters to combat while
// the bot holds a sword or axe, has at least 14 health and was not hit in the
// last 5 s. Stepping away from shooters that are not hitting it only stalls the
// trip (live 2026-11-17 20:53-21:02 JST: full diamond gear, 19 health and no
// hit, yet two base trips kept stepping away from skeletons 7-15 m off and the
// trips ended 330 m short of the base).
const WELL = 14

function playerArmedAndWell ({ shared, health, items, hurt }) {
  if (shared?.playerWanted !== true || hurt === true) return false
  if (!Number.isFinite(health) || health < WELL) return false
  return (items ?? []).some(item => /_sword$|_axe$/.test(String(item?.name ?? '')))
}

// A long trip keeps combat off witches (coordinator 2026-11-14: the trip walks
// round shooters). That holds only while the trip is the one answering them.
// In play with a weapon in the received inventory the trip above leaves
// shooters to combat, so combat has to take the witch as well. Live 2026-11-18
// 11:46:55-11:47:07 JST: on the way to the base, diamond armour, sword in hand,
// health 17, a witch at 5-7 m; the trip did not step away (armed and well),
// combat was refused the witch (TRAVEL_AVOID_WITCH), idle protection found no
// defence (DEFENSE_UNAVAILABLE) and its seven escapes each stopped on the
// next potion; dead in twelve seconds without one swing.
function tripKeepsCombatOffWitch ({ travelBusy, target, armedInPlay }) {
  return travelBusy === true && /witch/.test(String(target?.entityType ?? target?.name ?? '')) && armedInPlay !== true
}

module.exports = { playerArmedAndWell, tripKeepsCombatOffWitch, WELL }
