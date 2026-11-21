'use strict'

const { createMineActions } = require('./mine-actions')
const { createMineLighting } = require('./mine-lighting')
const { createMineStorage } = require('./mine-storage')
const { createMineSupplies } = require('./mine-supplies')
const { createMineTools } = require('./mine-tools')
const { stepCells } = require('./mine-geometry')
const { scopeOf } = require('./mine-observed')

// Created with the ordinary expedition context. memory/supplies/saveMine are
// attached by DragonRuntime before the first method runs, so all operations
// share that run's cancellation and checkpoint fence.
function createMinePorts (ctx) {
  const actions = createMineActions(ctx), lighting = createMineLighting(ctx, actions), storage = createMineStorage(ctx, actions)
  const supplies = createMineSupplies(ctx, actions, storage), tools = createMineTools(ctx, actions)
  return { mine: actions.mine, place: actions.place, walk: actions.walk, confirmPosition: actions.confirmPosition, ladderMove: actions.ladderMove, observe: actions.observe,
    ensureSupplies: async (plan, options = {}) => {
      const ready = await tools(options)
      return ready.serverConfirmed === true ? supplies.ensure(plan, options) : ready
    }, ensureSegment: (plan, segment) => lighting.finish(plan, segment.clear ? segment : stepCells(plan, segment)),
    storage, lighting, scope: () => scopeOf(ctx), inventory: actions.inventory }
}

module.exports = { createMinePorts }
