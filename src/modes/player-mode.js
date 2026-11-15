'use strict'

// Player mode: the Bot plays like a survival player. Its work today is the
// survival autonomy (objective: diamond) with idle protection switched on.
// Later stages are added behind this same start/stop pair.
const { startRefusal } = require('./bot-mode')
const { playerStages } = require('./player-stages')

const OBJECTIVE = Object.freeze({ objective: 'diamond', diamondCount: 1 })
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 240)

function createPlayerMode ({ getMode, agent, safety, getInventory = () => null, log = () => {} }) {
  let wanted = false
  function start () {
    const refused = startRefusal(getMode(), 'player')
    if (refused) throw Object.assign(new Error(refused.message), { code: refused.code })
    wanted = true
    // Idle protection belongs to player mode: a waiting player defends, eats and retreats.
    safety.start()
    const result = agent.start({ ...OBJECTIVE })
    void Promise.resolve(result).catch(error => log(`プレイヤーモード: 開始に失敗 ${text(error?.message)}`))
    log('プレイヤーモード: 開始')
    return status()
  }
  async function stop (reason = 'プレイヤーモードを停止しました。') {
    wanted = false
    agent.stop(reason)
    log('プレイヤーモード: 停止')
    return status()
  }
  function status () {
    const value = agent.snapshot?.() ?? {}
    return { wanted, running: value.running === true, phase: text(value.phase), reason: text(value.reason), ...playerStages(getInventory()) }
  }
  return { start, stop, status }
}

module.exports = { createPlayerMode, OBJECTIVE }
