'use strict'

// Hunting takes the strongest weapon first. The hunt hit uses whatever the
// server has selected, so after eating the Bot hit with food or rotten flesh in
// hand: fist damage, a chicken took four hits and a sheep eight without dying
// (real Realm 2026-11-17 03:00 JST; the diamond sword then killed in one).
// - Only a weapon that beats the selected stack (proven per-hit damage) is
//   taken; the switch uses the combat equip (a hotbar weapon is selected at once).
// - A refused switch does not stop the hunt: it hits with what is held.
const { selectMeleeWeapon } = require('../combat/melee-weapons')

function huntWeapon ({ items, rawItem, selected }) {
  if (!Number.isInteger(selected)) return null
  let best
  try { best = selectMeleeWeapon({ items, rawItem, selectedSlot: selected }) } catch { return null }
  if (!best?.ready || best.fists || best.slot === selected) return null
  const held = items.find(item => item.slot === selected && item.count > 0)
  let heldDamage = 1
  try { const now = selectMeleeWeapon({ items: held ? [held] : [], rawItem, selectedSlot: selected }); if (now?.ready && now.slot === selected) heldDamage = now.damage } catch {}
  return best.damage > heldDamage ? best : null
}

async function huntArmed ({ hunt, equip, crafting, getState, log = () => {} }, id) {
  try {
    const state = getState(), inventory = typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot()
    const weapon = huntWeapon({ items: inventory?.inventory ?? [], rawItem: crafting.rawItem, selected: state?.rawServerSelectedSlot ?? state?.rawSelectedSlot })
    if (weapon) {
      const result = await equip(weapon.slot)
      if (result?.serverConfirmed === true || result?.phase === 'completed') log(`狩りの前に ${String(weapon.name).replace('minecraft:', '')} に持ち替えました`)
    }
  } catch (error) { log(`狩りの武器に持ち替えられません ${String(error?.message ?? error).slice(0, 80)}`) }
  return hunt(id)
}

module.exports = { huntWeapon, huntArmed }
