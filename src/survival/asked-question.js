'use strict'

// A question the observation already had the chance to answer is not what a
// run ends with.
// The diamond plan asks the runtime for a prepared place for a held crafting
// table (capability_required: known_safe_workbench_placement). The runtime
// answers inside the same observation: it runs the plan once to see the
// question and adds a place or a step (runtime.js, observePortableWorksite).
// The autonomy ends a run as blocked on every capability_required, and a new
// run starts with no last decision, so the plan's own rule "asked once and no
// answer came: put the table down by the ordinary placement" never applied.
// Real Realm 2026-11-18 16:40-17:03 JST: a worksite memo from an earlier
// descent (table and furnace at y=41, 70 m away) kept the runtime from
// preparing a place; with a table in hand the run ended with
// 「作業台を置ける既知の準備場所を確認します。」 245 times in 23 minutes, and the
// answers to the repeated stop (another place, then a far place) walked the Bot
// 150 m north into a lake.
// So: when the plan still asks after the observation, it is asked again as
// "already asked", and its ordinary continuation is the decision. The question
// stays only if the plan has no other answer.
const ANSWERED_IN_OBSERVATION = new Set(['known_safe_workbench_placement'])

function planWithoutOpenQuestion (plan, state, observations, options) {
  const first = plan(state, observations, options)
  if (first?.type !== 'capability_required' || !ANSWERED_IN_OBSERVATION.has(first.capability)) return first
  const again = plan(state, { ...observations, lastDecision: { type: 'capability_required', capability: first.capability } }, options)
  return !again || (again.type === 'capability_required' && again.capability === first.capability) ? first : again
}

module.exports = { planWithoutOpenQuestion, ANSWERED_IN_OBSERVATION }
