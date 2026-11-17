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

module.exports = { playerArmedAndWell, WELL }
