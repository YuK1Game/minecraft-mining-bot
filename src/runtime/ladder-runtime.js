'use strict'

const { createLadderMovement } = require('../actions/ladder')

// The adapter borrows the current Runtime Input stream. Runtime retains all
// combat/operation admission policy; this module retains the per-call token.
function createLadderRuntime ({ getState, getBlock, getPhysics, getInput, currentGeneration, requireIdle, canAcquire, taskOwnsInput, setTaskOwner, confirmPosition, onPrediction, guard, ...timing } = {}) {
  if ([currentGeneration, requireIdle, canAcquire, taskOwnsInput, setTaskOwner, guard].some(fn => typeof fn !== 'function')) throw new Error('Ladder runtime needs explicit generation and input admission ports')
  let token = null
  const owns = (expected, input) => currentGeneration() && token === expected && input === getInput() && taskOwnsInput() === true
  const ladder = createLadderMovement({ getState, getBlock, getPhysics, getInput, confirmPosition, onPrediction, guard, ...timing,
    acquireInput: ({ token: next }) => {
      if (!currentGeneration() || token || canAcquire() !== true) throw new Error('LADDER_INPUT_BUSY')
      requireIdle()
      if (!currentGeneration() || token || canAcquire() !== true) throw new Error('LADDER_INPUT_BUSY')
      token = next; setTaskOwner()
    },
    ownsInput: owns,
    releaseInput: (expected, input) => {
      if (token !== expected) return
      const owned = owns(expected, input)
      token = null
      if (owned) input.stop()
    }
  })
  return { ...ladder, hasInput: () => token !== null }
}

module.exports = { createLadderRuntime }
