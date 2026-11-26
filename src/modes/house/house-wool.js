'use strict'

// Player mode: starter house wool acquisition with structured result codes and
// bounded failure memory (`supply-task-runner.js`).
const { normalizeMode } = require('../bot-mode')
const { pending, needsNow } = require('./house-supply')
const { createSupplyOutcomeTracker } = require('../supply-task-runner')

const NEAR_M = 24, AGAIN_MS = 120000, FAILED_MS = 600000, RUN_MS = 120000
const short = name => String(name ?? '').replace(/^minecraft:/, '')
const wool = inventory => (inventory?.items ?? []).filter(item => /_wool$/.test(short(item?.name))).reduce((sum, item) => sum + (item.count ?? 0), 0)

function createHouseWool ({ getMode, shared, agent, gather, scope = () => null, inBranchMine = () => false, getState, getBlock, actors, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0
  const tracker = createSupplyOutcomeTracker({ taskId: 'wool', shared, scope, now })
  const R = tracker.result
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  function sheepNear (position) {
    return (actors() ?? []).some(actor => actor?.entityType === 'minecraft:sheep' && actor.alive !== false && actor.baby !== true && actor.isBaby !== true && actor.position && Math.hypot(actor.position.x - position.x, actor.position.z - position.z) <= NEAR_M)
  }

  async function runStep () {
    if (!live() || busy || blocked() || now() < waitUntil || inBranchMine()) return null
    const state = getState()
    if (!state?.position || !pending({ mode: getMode(), playing: shared.playerWanted === true, shared, state })) return null
    const needs = needsNow({ shared, state, getBlock })
    if (!needs || needs.need.wool <= 0 || !sheepNear(state.position)) return null
    const areaKey = `${Math.floor(state.position.x / 16)},${Math.floor(state.position.z / 16)}`
    if (tracker.isExhausted({ stage: 'gather', target: areaKey, code: 'WOOL_NONE_GAINED' })) return null
    busy = true
    const before = wool(state.inventory)
    let gained = 0
    try {
      log(`プレイヤーモード: 拠点の家のベッドにする羊毛を集めます（あと${needs.need.wool}個）`)
      agent.stop('拠点の家の羊毛を集めます。')
      await settle()
      await gather({ logs: 0, wool: before + needs.need.wool, maxMs: RUN_MS })
      gained = wool(getState()?.inventory) - before
      log(`プレイヤーモード: 羊毛 ${gained > 0 ? `${gained} 個を得ました` : 'を得られませんでした'}（手元 ${before + Math.max(0, gained)} 個）`)
      const outcome = gained > 0
        ? R.completed('WOOL_GAINED', { progress: { gained }, remaining: { wool: Math.max(0, needs.need.wool - gained) } })
        : R.failed('WOOL_NONE_GAINED', { detail: '羊毛を得られませんでした', retry: { kind: 'position_changed' } })
      tracker.record(outcome, { stage: 'gather', target: areaKey })
      return outcome
    } catch (error) {
      const msg = String(error?.message ?? error).slice(0, 100)
      log(`プレイヤーモード: 羊毛を集められません ${msg}`)
      const outcome = R.failed('WOOL_GATHER_ERROR', { detail: msg })
      tracker.record(outcome, { stage: 'gather', target: areaKey })
      return outcome
    } finally {
      waitUntil = now() + (gained > 0 ? AGAIN_MS : FAILED_MS)
      busy = false
      await restart()
    }
  }

  async function tick () {
    const outcome = await runStep()
    return tracker.toTickBoolean(outcome)
  }

  return {
    tick,
    runStep,
    status: () => ({ active: busy, reason: busy ? '拠点の家の羊毛を集めています。' : null, lastOutcome: tracker.last() })
  }
}

module.exports = { createHouseWool }
