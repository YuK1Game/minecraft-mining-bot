'use strict'

// Stage-0 torch inventory reserve (docs/player-roadmap.md):
// Maintains a standing stock of 16 torches using received inventory counts.
// Keeps smelting coal (2) and next-pickaxe sticks (2), and falls back to
// smelting raw logs into charcoal when coal is scarce.

const TORCH_STOCK_TARGET = 16
const KEEP_COAL = 2
const KEEP_STICKS = 2
const LOG_RE = /_(?:log|stem)$/
const PLANK_RE = /_planks$/

function countMatching (inventory, test) {
  if (inventory?.known !== true || !Array.isArray(inventory.items)) return 0
  let total = 0
  for (const item of inventory.items) {
    if (item && item.count > 0 && test.test(String(item.name ?? ''))) total += item.count
  }
  return total
}

function planTorchRestock (inventory, { target = TORCH_STOCK_TARGET, keepCoal = KEEP_COAL, keepSticks = KEEP_STICKS } = {}) {
  if (inventory?.known !== true) return { known: false, have: 0, target, needed: 0, action: null }
  const have = countMatching(inventory, /^minecraft:torch$/)
  const needed = Math.max(0, target - have)
  if (needed === 0) return { known: true, have, target, needed: 0, action: null }

  const coal = countMatching(inventory, /^minecraft:coal$/)
  const charcoal = countMatching(inventory, /^minecraft:charcoal$/)
  const sticks = countMatching(inventory, /^minecraft:stick$/)
  const planks = countMatching(inventory, PLANK_RE)
  const logs = countMatching(inventory, LOG_RE)

  const batchesNeeded = Math.ceil(needed / 4)
  const usableFuel = charcoal + Math.max(0, coal - keepCoal)

  if (usableFuel >= 1) {
    const usableSticks = Math.max(0, sticks - keepSticks)
    if (usableSticks >= 1) {
      return {
        known: true, have, target, needed,
        action: 'craft_torch',
        batches: Math.min(batchesNeeded, usableFuel, usableSticks)
      }
    }
    if (planks >= 2 && planks !== 4) {
      return { known: true, have, target, needed, action: 'craft_sticks', batches: 1 }
    }
    if (logs >= 1) {
      return { known: true, have, target, needed, action: 'craft_planks', batches: 1 }
    }
    return { known: true, have, target, needed, action: 'need_wood' }
  }

  // Coal is below reserve and no charcoal is held: smelt raw logs into charcoal.
  if (logs >= 2) {
    return {
      known: true, have, target, needed,
      action: 'smelt_charcoal',
      logsToSmelt: Math.min(batchesNeeded, logs - 1)
    }
  }
  if (logs >= 1 && planks >= 2) {
    return { known: true, have, target, needed, action: 'smelt_charcoal', logsToSmelt: 1 }
  }
  return { known: true, have, target, needed, action: 'need_coal_or_logs' }
}

async function ensureTorchStock ({
  getInventory,
  craft = null,
  craftPlanks = null,
  smeltCharcoal = null,
  aborted = () => false,
  log = () => {},
  target = TORCH_STOCK_TARGET,
  maxSteps = 6
} = {}) {
  let crafted = 0
  for (let step = 0; step < maxSteps && !aborted(); step++) {
    const plan = planTorchRestock(getInventory(), { target })
    if (!plan.known || plan.needed === 0) return { ok: plan.known && plan.needed === 0, have: plan.have, crafted, action: null }
    if (plan.action === 'craft_torch') {
      if (typeof craft !== 'function') return { ok: false, have: plan.have, crafted, action: plan.action }
      const before = plan.have
      const ok = await craft('minecraft:torch', plan.batches)
      const after = countMatching(getInventory(), /^minecraft:torch$/)
      if (after > before) crafted += after - before
      if (!ok || after <= before) return { ok: after >= target, have: after, crafted, action: 'craft_torch_failed' }
    } else if (plan.action === 'craft_sticks') {
      if (typeof craft !== 'function' || !await craft('minecraft:stick', 1)) return { ok: false, have: plan.have, crafted, action: 'craft_sticks_failed' }
    } else if (plan.action === 'craft_planks') {
      const fn = craftPlanks ?? craft
      if (typeof fn !== 'function' || !await fn('planks', 1)) return { ok: false, have: plan.have, crafted, action: 'craft_planks_failed' }
    } else if (plan.action === 'smelt_charcoal') {
      if (typeof smeltCharcoal !== 'function') return { ok: false, have: plan.have, crafted, action: 'smelt_charcoal_unavailable' }
      const ok = await smeltCharcoal(plan.logsToSmelt)
      if (!ok) return { ok: false, have: plan.have, crafted, action: 'smelt_charcoal_failed' }
      log(`プレイヤーモード: 松明用に原木から木炭を焼きました（目標 ${target} 本）`)
    } else {
      return { ok: false, have: plan.have, crafted, action: plan.action }
    }
  }
  const finalHave = countMatching(getInventory(), /^minecraft:torch$/)
  return { ok: finalHave >= target, have: finalHave, crafted, action: finalHave >= target ? null : 'step_limit' }
}

module.exports = { TORCH_STOCK_TARGET, KEEP_COAL, KEEP_STICKS, planTorchRestock, ensureTorchStock }
