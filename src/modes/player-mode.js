'use strict'

// Player mode: the Bot plays like a survival player. Its work today is the
// survival autonomy (objective: diamond) with idle protection switched on.
// Later stages are added behind this same start/stop pair.
const { startRefusal } = require('./bot-mode')
const { playerStages } = require('./player-stages')

// threatWaitMs: a hostile that only stands near holds the work this long at most.
// skipFailedDrops: a drop whose pickup keeps failing is left, the run goes on.
const OBJECTIVE = Object.freeze({ objective: 'diamond', diamondCount: 1, threatWaitMs: 20000, skipFailedDrops: true, deferOptionalShelter: true })
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 240)

const safely = read => { try { return read() } catch { return null } }

function createPlayerMode ({ getMode, agent, safety, recovery = null, shelter = null, flee = null, scaffold = null, shared = {}, getInventory = () => null, getWorn = () => null, log = () => {} }) {
  const worn = () => safely(getWorn)
  // Kept outside this runtime so a hot reload does not forget that the player is playing.
  const want = value => { shared.playerWanted = value }
  function start () {
    const refused = startRefusal(getMode(), 'player')
    if (refused) throw Object.assign(new Error(refused.message), { code: refused.code })
    want(true)
    recovery?.cancel()
    // Idle protection belongs to player mode: a waiting player defends, eats and retreats.
    safety.start()
    const result = agent.start({ ...OBJECTIVE })
    void Promise.resolve(result).catch(error => log(`プレイヤーモード: 開始に失敗 ${text(error?.message)}`))
    log('プレイヤーモード: 開始')
    return status()
  }
  async function stop (reason = 'プレイヤーモードを停止しました。') {
    want(false)
    recovery?.cancel()
    agent.stop(reason)
    log('プレイヤーモード: 停止')
    return status()
  }
  function status () {
    const value = agent.snapshot?.() ?? {}
    // While recovery owns the pause or the far move, the player is still playing.
    const wanted = shared.playerWanted === true
    const fleeing = flee?.status() ?? { active: false }
    if (fleeing.active) return { wanted, running: true, phase: 'fleeing', reason: text(fleeing.reason), ...playerStages(getInventory(), worn()) }
    const sheltering = shelter?.status() ?? { active: false }
    if (sheltering.active) return { wanted, running: true, phase: 'sheltering', reason: text(sheltering.reason), ...playerStages(getInventory(), worn()) }
    const scaffolding = scaffold?.status() ?? { active: false }
    if (scaffolding.active) return { wanted, running: true, phase: 'working', reason: text(scaffolding.reason), ...playerStages(getInventory(), worn()) }
    const recovering = recovery?.status() ?? { active: false }
    if (recovering.active) return { wanted, running: true, phase: 'recovering', reason: text(recovering.reason), ...playerStages(getInventory(), worn()) }
    // A run whose current decision is a wait is waiting, whatever its phase says between ticks.
    const phase = value.running === true && value.lastDecision?.type === 'wait' ? 'waiting' : value.phase
    return { wanted, running: value.running === true, phase: text(phase), reason: text(value.reason), ...playerStages(getInventory(), worn()) }
  }
  return { start, stop, status }
}

module.exports = { createPlayerMode, OBJECTIVE }
