'use strict'

const { mineWorldScope, sameWorld } = require('./mine-state')
const { at, inventory, live } = require('./mine-common')
const { supplyNeeds, builtWork } = require('./mine-needs')
const { count } = require('../dragon-supply-kit')

// Work history is used only to keep the goal watcher informed. It is never a
// certificate of present terrain, light, footing, or resource ownership.
// One monotonic mark covers all bounded sites, so a long shaft cannot exhaust
// the goal ledger's sixteen distinct auxiliary-step keys.
function constructionCount (mine, world) {
  const counts = new Map()
  for (const site of [...(mine?.sites ?? []), mine?.branch]) {
    if (!site?.plan?.id || !sameWorld(site.plan.scope, world)) continue
    const { topY, bottomY } = site.plan.shaft ?? {}, depth = site.shaft?.depth
    let count = Number.isSafeInteger(topY) && Number.isSafeInteger(bottomY) && Number.isSafeInteger(depth) && depth <= topY && depth >= bottomY ? topY - depth : 0
    for (const progress of Object.values(site.progress ?? {})) {
      const confirmed = progress?.confirmedSteps
      if (Number.isSafeInteger(confirmed) && confirmed >= 0 && Number.isSafeInteger(progress.cursor) && confirmed <= progress.cursor) count += confirmed
    }
    counts.set(site.plan.id, Math.max(counts.get(site.plan.id) ?? 0, count))
  }
  return [...counts.values()].reduce((sum, count) => sum + count, 0)
}

// Call before work to establish a baseline, then only after the received
// construction result has been saved. Revalidation, skipped segments, a new
// plan and walking back to a site cannot advance this mark.
function noteMineProgress (ctx) {
  if (!live(ctx)) return false
  const world = mineWorldScope(ctx.runtime.mineState?.() ?? ctx.runtime.raw())
  if (!world) return false
  return ctx.goal?.mark?.('mine:construction', -constructionCount(ctx.memory?.early?.mine, world), 1) ?? false
}

function noteMinePreparation (ctx, branch, layer) {
  if (!live(ctx)) return false
  const plan = branch.plan, level = plan.layers.find(p => p.id === layer)
  if (!level || branch.shaft?.depth <= level.y) return false
  const stock = inventory(ctx)
  if (!stock) return false
  const needs = supplyNeeds(plan, layer, { inventory: stock, getBlock: p => at(ctx, p), refillTorches: branch.refillTorches === true, built: builtWork(branch) })
  if (!needs) return false

  const have = name => count(name, stock.items)
  const ladders = Math.min(needs.ladder, have('ladder'))
  const sticksNeeded = Math.ceil((needs.ladder - ladders) / 3) * 7
  const wood = Math.min(sticksNeeded, have('stick') + 2 * have('planks') + 8 * have('log'))
  const other = Object.entries(needs).reduce((sum, [name, amount]) => name === 'ladder' ? sum : sum + Math.min(amount, have(name)), 0)
  // Seven sticks make three ladders. Count the received wood in stick
  // equivalents and give the actual finished ladders a small extra weight.
  return ctx.goal?.mark?.('mine:preparation', -(ladders * 8 + wood * 3 + other), 1) ?? false
}

module.exports = { constructionCount, noteMineProgress, noteMinePreparation }
