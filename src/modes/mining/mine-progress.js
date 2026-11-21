'use strict'

const { mineWorldScope, sameWorld } = require('./mine-state')
const { live } = require('./mine-common')

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

module.exports = { constructionCount, noteMineProgress }
