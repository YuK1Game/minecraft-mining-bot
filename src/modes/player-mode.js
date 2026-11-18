'use strict'

// One start/stop pair owns survival preparation and the expedition to the End.
const { startRefusal } = require('./bot-mode')
const { playerStages } = require('./player-stages')

// threatWaitMs: a hostile that only stands near holds the work this long at most.
// skipFailedDrops: a drop whose pickup keeps failing is left, the run goes on.
const OBJECTIVE = Object.freeze({ objective: 'diamond', diamondCount: 1, threatWaitMs: 20000, skipFailedDrops: true, deferOptionalShelter: true, nearThreatDistance: 8 })
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 240)

const safely = read => { try { return read() } catch { return null } }

function createPlayerMode ({ getMode, agent, safety, expedition = null, recovery = null, shelter = null, flee = null, scaffold = null, shared = {}, getInventory = () => null, getWorn = () => null, log = () => {} }) {
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
    const record = safely(() => expedition?.record())
    const stages = playerStages(getInventory(), worn(), shared.playerHouse, record)
    const quest = expedition?.status()
    if (record?.stage === 'complete') return { wanted, running: false, phase: 'completed', reason: record.end.preexisting ? '開通済みのエンドから帰還しました。今回の討伐は未確認です。' : 'ドラゴン討伐後の現世への帰還を確認しました。', ...stages }
    if (wanted && expedition?.owns()) return { wanted, running: true, phase: quest?.phase ?? 'working', reason: text(quest?.reason ?? '次の遠征に向けて状態を確認しています。'), ...stages }
    const fleeing = flee?.status() ?? { active: false }
    if (fleeing.active) return { wanted, running: true, phase: 'fleeing', reason: text(fleeing.reason), ...stages }
    const sheltering = shelter?.status() ?? { active: false }
    if (sheltering.active) return { wanted, running: true, phase: 'sheltering', reason: text(sheltering.reason), ...stages }
    const scaffolding = scaffold?.status() ?? { active: false }
    if (scaffolding.active) return { wanted, running: true, phase: 'working', reason: text(scaffolding.reason), ...stages }
    const recovering = recovery?.status() ?? { active: false }
    if (recovering.active) return { wanted, running: true, phase: 'recovering', reason: text(recovering.reason), ...stages }
    // A run whose current decision is a wait is waiting, whatever its phase says between ticks.
    const phase = value.running === true && value.lastDecision?.type === 'wait' ? 'waiting' : value.phase
    return { wanted, running: value.running === true, phase: text(phase), reason: text(value.reason), ...stages }
  }
  return { start, stop, status }
}

module.exports = { createPlayerMode, OBJECTIVE }
