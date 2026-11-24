'use strict'

const { createMineActions } = require('./mine-actions')
const { createMineLighting } = require('./mine-lighting')
const { createMineStorage } = require('./mine-storage')
const { createMineSupplies } = require('./mine-supplies')
const { createMineTools } = require('./mine-tools')
const { mineSteps, stepCells } = require('./mine-geometry')
const { sameWorld, mineWorldScope } = require('./mine-state')
const { air, fillMaterial, scopeOf } = require('./mine-observed')
const { solid } = require('./mine-common')
const { createVeinFillStand } = require('./mine-vein-fill')

// Created with the ordinary expedition context. memory/supplies/saveMine are
// attached by DragonRuntime before the first method runs, so all operations
// share that run's cancellation and checkpoint fence.
function createMinePorts (ctx) {
  const actions = createMineActions(ctx), lighting = createMineLighting(ctx, actions), storage = createMineStorage(ctx, actions)
  const supplies = createMineSupplies(ctx, actions, storage), tools = createMineTools(ctx, actions)
  async function approachLadderSupport (request) {
    const branch = ctx.memory.early.mine.branch, shaft = branch.plan.shaft, depth = branch.shaft.depth
    const stands = depth === shaft.topY ? [...shaft.columns, shaft.approach, shaft.topLanding].filter(Boolean) : shaft.columns
    return lighting.placementStand(request, feet => {
      if (!feet || Math.abs(feet.y - depth) > 1) return false
      const x = Math.floor(feet.x), z = Math.floor(feet.z)
      return stands.some(p => Math.floor(p.x) === x && Math.floor(p.z) === z) &&
        solid(actions.block({ x, y: Math.floor(feet.y - 0.01), z }))
    })
  }
  const approachVeinFill = createVeinFillStand(ctx, lighting, actions)
  async function recoverFinishStand () {
    const branch = ctx.memory?.early?.mine?.branch, intent = branch?.intent, task = branch?.segmentTask
    const scope = scopeOf(ctx)
    if (!intent || !scope || branch.pendingAction || intent.liveScope !== scope ||
      !sameWorld(branch.plan?.scope, mineWorldScope(ctx.runtime.mineState?.() ?? ctx.runtime.raw()))) return false
    if (intent.kind === 'fill' && intent.purpose === 'ladder_support') {
      const target = intent.target, support = branch.plan.shaft?.ladder?.support, depth = branch.shaft?.depth
      const name = fillMaterial(actions.inventory())
      if (!target || !support || !Number.isSafeInteger(depth) || target.x !== support.x || target.z !== support.z ||
        ![depth, depth - 1].includes(target.y) || !name || !air(actions.block(target))) return false
      const stand = await approachLadderSupport({ position: target, name, supportPurpose: intent.purpose })
      return stand.reached?.code === 'MINE_POSITION_RECEIVED' && stand.reached.serverConfirmed === true
    }
    if (!task || intent.kind !== 'finish' || intent.step !== task.stepId ||
      branch.progress?.[task.layer]?.cursor !== task.cursor) return false
    const step = mineSteps(branch.plan, { layer: task.layer })[task.cursor]
    return step?.id === task.stepId && await lighting.recoverFloorStand(stepCells(branch.plan, step))
  }
  return { mine: actions.mine, place: actions.place, walk: actions.walk, confirmPosition: actions.confirmPosition, ladderMove: actions.ladderMove, observe: actions.observe,
    reconcilePlacement: actions.reconcilePlacement,
    recoverFinishStand, approachLadderSupport, approachVeinFill,
    ensureSupplies: async (plan, options = {}) => {
      const ready = await tools(options)
      return ready.serverConfirmed === true ? supplies.ensure(plan, options) : ready
    }, ensureSegment: (plan, segment) => lighting.finish(plan, segment.clear ? segment : stepCells(plan, segment)),
    storage, lighting, scope: () => scopeOf(ctx), inventory: actions.inventory }
}

module.exports = { createMinePorts }
