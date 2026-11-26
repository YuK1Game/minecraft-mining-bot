'use strict'

// Bare while the house reserve already holds iron gear: the death recovery is opened once to take it back.
//
// A death while the reserve was still being stocked ended the recovery at once (it used the reserve only when ready),
// and the Bot went on with a wooden sword while an iron sword and four iron armour pieces sat in the reserve chest
// (live 2026-11-26 22:40 JST). The recovery now takes from a partial reserve (dragon-recovery.js `partial`); this opens
// it for a Bot that is already past its death with the gear still in the chest. At most once every ten minutes.
const { reserveCounts } = require('./dragon-reserve-seen')

const GEAR = ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const AGAIN_MS = 10 * 60000

function rearmWanted (ctx, record, now = Date.now()) {
  // Live only, with the other live player rules (mode-runtime.js sets the armed-entry rule for the running Bot).
  if (ctx.shared.mineArmedEntry !== true) return false
  if (now - (ctx.shared.dragonRearmAt ?? -Infinity) < AGAIN_MS) return false
  const items = ctx.runtime.inventory?.()?.items ?? []
  const worn = ctx.runtime.armor?.()
  if (!Array.isArray(items) || worn?.known !== true) return false
  const ironWeapon = items.some(item => item.count > 0 && /^minecraft:(?:iron|diamond|netherite)_(?:sword|axe)$/.test(item.name))
  const armour = (worn.worn ?? []).some(item => item?.name)
  if (ironWeapon && armour) return false
  // After a restart the reserve's last look is gone; the chest memory (read back from .local/chest-index/) still has it.
  let inChest = reserveCounts(ctx.shared)
  if (!inChest && ctx.shared.playerHouse?.origin) {
    const { chestOf } = require('./house/house-spawn'), at = record.early?.reserveAt ?? chestOf(ctx.shared.playerHouse.origin)
    ctx.shared.playerChestMemory?.ensure?.()
    const slots = ctx.shared.playerChestMemory?.seen?.get(`${at.x},${at.y},${at.z}`)
    if (slots) inChest = Object.fromEntries(GEAR.map(name => [name, slots.filter(slot => slot.name === 'minecraft:' + name).reduce((sum, slot) => sum + slot.count, 0)]))
  }
  if (!inChest || !GEAR.some(name => (inChest[name] ?? 0) > 0)) return false
  ctx.shared.dragonRearmAt = now
  ctx.log?.('プレイヤーモード: 予備チェストに鉄の装備があり、持っていないため、取り出して装備します')
  return true
}

module.exports = { rearmWanted, GEAR, AGAIN_MS }
