'use strict'

// The home kit step remembers the one item it is fetching (`early.gather`) so that it does not walk home between
// every hunt. The memory is saved to disk, so it outlived the kit it was made for: a food target of 64 from the
// old kit (32 food, held twice) stayed after the kit became "armour and sword first, 8 food", and the Bot hunted
// for hours with no armour (live 2026-11-19 16:34 JST: gather {food, 64}, cooked food 9, iron 0, no armour).
// A remembered item is kept only while the current kit could still ask for it, and for a bounded time;
// after that the chest is read again and the kit decides.
const PIN_MS = 15 * 60000

function pinned (gather, kit, now = Date.now()) {
  if (!gather?.name || !Number.isSafeInteger(gather.count) || gather.count < 1) return false
  const row = kit.find(([name]) => name === gather.name)
  // The kit is held twice: one in the chest, one carried.
  if (!row || gather.count > row[1] * 2) return false
  return Number.isFinite(gather.since) && now - gather.since >= 0 && now - gather.since < PIN_MS
}

module.exports = { pinned, PIN_MS }
